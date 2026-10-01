import { roomFor } from "./classification.ts";
import type {
  MemoryGraph,
  ParsedMemoryQuery,
  StoredEdge,
  StoredEvidence,
  StoredIdentity,
  StoredState,
} from "./types.ts";

function boundsOf(
  query: ParsedMemoryQuery,
  maximumChapter: number,
): { lower: number; upper: number } {
  switch (query.mode) {
    case "chapter": return { lower: query.chapter!, upper: query.chapter! };
    case "range_strict": return { lower: query.from!, upper: query.to! };
    case "range_with_prior": return { lower: 1, upper: query.to! };
    case "current": return { lower: 1, upper: query.chapter ?? maximumChapter };
    case "entity_timeline": return { lower: 1, upper: maximumChapter };
    case "multi_entity_relationships": return { lower: query.from!, upper: query.to! };
  }
}

function clampQueryToMaximum(query: ParsedMemoryQuery, maximumChapter: number): ParsedMemoryQuery {
  switch (query.mode) {
    case "chapter": return { ...query, chapter: Math.min(query.chapter!, maximumChapter) };
    case "range_strict":
    case "range_with_prior":
    case "multi_entity_relationships": return {
      ...query,
      from: Math.min(query.from!, maximumChapter),
      to: Math.min(query.to!, maximumChapter),
    };
    case "current": return query.chapter === undefined ? query : { ...query, chapter: Math.min(query.chapter, maximumChapter) };
    case "entity_timeline": return query;
  }
}

function latestStates(states: StoredState[]): StoredState[] {
  const latest = new Map<string, StoredState>();
  for (const state of states) {
    const key = `${state.identityId}\0${state.key}`;
    const current = latest.get(key);
    if (current === undefined || current.chapterNumber <= state.chapterNumber) latest.set(key, state);
  }
  return [...latest.values()];
}

export function projectMemoryGraph(input: {
  query: ParsedMemoryQuery;
  identities: StoredIdentity[];
  states: StoredState[];
  edges: StoredEdge[];
  evidence: StoredEvidence[];
  revision: string;
  maximumChapter?: number;
}): MemoryGraph {
  const availableMaximumChapter = Math.max(
    1,
    ...input.identities.map(({ chapterNumber }) => chapterNumber),
    ...input.states.map(({ chapterNumber }) => chapterNumber),
    ...input.edges.map(({ chapterNumber }) => chapterNumber),
  );
  const maximumChapter = Math.min(availableMaximumChapter, input.maximumChapter ?? availableMaximumChapter);
  const query = clampQueryToMaximum(input.query, maximumChapter);
  const { lower, upper } = boundsOf(query, maximumChapter);
  const requested = new Set(query.identities);
  const identityAllowed = (identityId: string) => requested.size === 0 || requested.has(identityId);

  // Every semantic collection is bounded before any adjacency or node projection is built.
  const evidence = input.evidence.filter((item) => (
    item.confirmed
    && item.workId === input.query.workId
    && item.chapterNumber >= lower
    && item.chapterNumber <= upper
  ));
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const identities = input.identities.filter((identity) => (
    identity.confirmed
    && identity.workId === input.query.workId
    && identity.chapterNumber >= lower
    && identity.chapterNumber <= upper
    && identityAllowed(identity.id)
  ));
  let states = input.states.filter((state) => (
    state.confirmed
    && state.workId === input.query.workId
    && state.chapterNumber >= lower
    && state.chapterNumber <= upper
    && identityAllowed(state.identityId)
  ));
  if (query.mode === "current") states = latestStates(states);
  const edges = input.edges.filter((edge) => {
    const edgeIdentityMatch = requested.size === 0
      || (query.mode === "entity_timeline"
        ? requested.has(edge.from) || requested.has(edge.to)
        : requested.has(edge.from) && requested.has(edge.to));
    return edge.confirmed
      && edge.workId === input.query.workId
      && edge.chapterNumber >= lower
      && edge.chapterNumber <= upper
      && edgeIdentityMatch
      && evidenceById.has(edge.evidenceId);
  });
  const latestIdentity = new Map<string, StoredIdentity>();
  const identityEvidence = new Map<string, Set<string>>();
  for (const identity of identities) {
    const evidenceIds = identityEvidence.get(identity.id) ?? new Set<string>();
    identity.evidenceIds.forEach((evidenceId) => evidenceIds.add(evidenceId));
    identityEvidence.set(identity.id, evidenceIds);
    const current = latestIdentity.get(identity.id);
    if (current === undefined || current.chapterNumber <= identity.chapterNumber) latestIdentity.set(identity.id, identity);
  }
  const usedEvidence = new Set(edges.map(({ evidenceId }) => evidenceId));
  identities.forEach(({ evidenceIds }) => evidenceIds.forEach((evidenceId) => usedEvidence.add(evidenceId)));
  states.forEach(({ evidenceIds }) => evidenceIds.forEach((evidenceId) => usedEvidence.add(evidenceId)));

  return {
    query,
    revision: input.revision,
    bounds: { from: lower, to: upper },
    nodes: [...latestIdentity.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((identity) => ({
        id: identity.id,
        identityId: identity.id,
        name: identity.name,
        kind: identity.kind,
        room: roomFor(identity.kind),
        chapterNumber: identity.chapterNumber,
        evidenceIds: [...(identityEvidence.get(identity.id) ?? [])].filter((evidenceId) => evidenceById.has(evidenceId)),
      })),
    states: states.sort((left, right) => left.chapterNumber - right.chapterNumber || left.id.localeCompare(right.id)),
    edges: edges
      .sort((left, right) => left.chapterNumber - right.chapterNumber || left.id.localeCompare(right.id))
      .map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        type: edge.type,
        chapterNumber: edge.chapterNumber,
        evidenceId: edge.evidenceId,
        evidenceChapter: evidenceById.get(edge.evidenceId)!.chapterNumber,
      })),
    evidence: evidence
      .filter((item) => usedEvidence.has(item.id))
      .sort((left, right) => left.chapterNumber - right.chapterNumber || left.id.localeCompare(right.id)),
  };
}
