import { createHash } from "node:crypto";
import type { MemoryEpisodeCandidate, MemoryKind } from "@jizuo/memory-domain";
import { ChapterMemoryOutputSchemaV2, type ChapterMemoryV2 } from "../../../workflow-runtime/src/outputSchemas.ts";

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

const MAX_MEMORY_FACTS = 50;
const truncate = (value: string, maximum: number) => value.trim().slice(0, maximum);

/**
 * Narrows permissive extractor output to the stricter durable memory schema.
 * The cap is deliberately 50: at worst every fact introduces two identities,
 * which remains within the episode's 100 identity limit.
 */
export function mapChapterMemoryFacts(applied: {
  workId: string; volumeId: string; chapterId: string; chapterNumber: number; appliedRevision: string;
}, extracted: { facts: readonly { subject: string; predicate: string; object: string; evidence: string }[] }): MemoryEpisodeCandidate {
  const facts = [...extracted.facts]
    .map((fact) => ({
      subject: truncate(fact.subject, 120), predicate: truncate(fact.predicate, 80),
      object: truncate(fact.object, 500), evidence: truncate(fact.evidence, 500),
    }))
    .filter((fact) => fact.subject !== "" && fact.predicate !== "" && fact.object !== "" && fact.evidence !== "")
    .filter((fact, index, all) => all.findIndex((candidate) => candidate.subject === fact.subject && candidate.predicate === fact.predicate && candidate.object === fact.object && candidate.evidence === fact.evidence) === index)
    .slice(0, MAX_MEMORY_FACTS);
  if (facts.length === 0) {
    return {
      workId: applied.workId, chapterId: applied.chapterId, chapterNumber: applied.chapterNumber,
      contentHash: applied.appliedRevision, source: "chapter", confirmation: "suggested",
      identities: [], states: [], edges: [], evidence: [],
    };
  }
  const identities = new Map<string, { id: string; name: string; kind: "character"; aliases: string[]; evidenceIds: string[] }>();
  const states: Array<{ id: string; identityId: string; chapterNumber: number; key: string; value: string; confirmed: boolean; evidenceIds: string[] }> = [];
  const edges: Array<{ id: string; from: string; to: string; type: string; chapterNumber: number; evidenceId: string; confirmed: boolean }> = [];
  const evidence: Array<{ id: string; chapterId: string; chapterNumber: number; excerpt: string; contentHash: string }> = [];
  for (const fact of facts) {
    const suffix = hash(`${fact.subject}:${fact.predicate}:${fact.object}:${fact.evidence}`).slice(0, 16);
    const evidenceId = `evidence_${suffix}`;
    const identity = (name: string) => {
      const key = name.trim();
      const existing = identities.get(key);
      if (existing) { existing.evidenceIds.push(evidenceId); return existing.id; }
      const id = `identity_${hash(key).slice(0, 16)}`;
      identities.set(key, { id, name: key, kind: "character", aliases: [], evidenceIds: [evidenceId] });
      return id;
    };
    const subjectId = identity(fact.subject);
    const objectId = identity(fact.object);
    evidence.push({ id: evidenceId, chapterId: applied.chapterId, chapterNumber: applied.chapterNumber, excerpt: fact.evidence, contentHash: applied.appliedRevision });
    states.push({ id: `state_${suffix}`, identityId: subjectId, chapterNumber: applied.chapterNumber, key: fact.predicate, value: fact.object, confirmed: true, evidenceIds: [evidenceId] });
    edges.push({ id: `edge_${suffix}`, from: subjectId, to: objectId, type: fact.predicate, chapterNumber: applied.chapterNumber, evidenceId, confirmed: true });
  }
  return {
    workId: applied.workId, chapterId: applied.chapterId, chapterNumber: applied.chapterNumber,
    contentHash: applied.appliedRevision, source: "chapter", confirmation: "confirmed",
    identities: [...identities.values()], states, edges, evidence,
  };
}

/** Maps typed extraction facts to the existing multi-palace memory graph. */
export function mapTypedChapterMemoryFacts(applied: {
  workId: string; volumeId: string; chapterId: string; chapterNumber: number; appliedRevision: string;
}, extracted: ChapterMemoryV2, maxFacts = MAX_MEMORY_FACTS): MemoryEpisodeCandidate {
  const facts = ChapterMemoryOutputSchemaV2.parse(extracted).facts
    .filter((fact, index, all) => all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(fact)) === index)
    .slice(0, maxFacts);
  if (facts.length === 0) {
    return {
      workId: applied.workId, chapterId: applied.chapterId, chapterNumber: applied.chapterNumber,
      contentHash: applied.appliedRevision, source: "chapter", confirmation: "suggested",
      identities: [], states: [], edges: [], evidence: [],
    };
  }
  type Identity = { id: string; name: string; kind: MemoryKind; aliases: string[]; evidenceIds: string[] };
  const identities = new Map<string, Identity>();
  const states: Array<{ id: string; identityId: string; chapterNumber: number; key: string; value: string; confirmed: boolean; evidenceIds: string[] }> = [];
  const edges: Array<{ id: string; from: string; to: string; type: string; chapterNumber: number; evidenceId: string; confirmed: boolean }> = [];
  const evidence: Array<{ id: string; chapterId: string; chapterNumber: number; excerpt: string; contentHash: string }> = [];
  const addIdentity = (identity: ChapterMemoryV2["facts"][number]["subject"], evidenceId: string) => {
    const key = `${identity.kind}\0${identity.name}`;
    const existing = identities.get(key);
    if (existing) {
      existing.aliases = [...new Set([...existing.aliases, ...identity.aliases])];
      existing.evidenceIds = [...new Set([...existing.evidenceIds, evidenceId])];
      return existing.id;
    }
    const stableKey = identity.kind === "character" ? identity.name : `${identity.kind}:${identity.name}`;
    const next: Identity = {
      id: `identity_${hash(stableKey).slice(0, 16)}`,
      name: identity.name,
      kind: identity.kind,
      aliases: [...new Set(identity.aliases)],
      evidenceIds: [evidenceId],
    };
    identities.set(key, next);
    return next.id;
  };
  for (const fact of facts) {
    const objectKey = fact.factKind === "state" ? fact.value : `${fact.object.kind}:${fact.object.name}`;
    const suffix = hash(`${fact.factKind}:${fact.subject.kind}:${fact.subject.name}:${fact.predicate}:${objectKey}:${fact.evidence}`).slice(0, 16);
    const evidenceId = `evidence_${suffix}`;
    const subjectId = addIdentity(fact.subject, evidenceId);
    evidence.push({ id: evidenceId, chapterId: applied.chapterId, chapterNumber: applied.chapterNumber, excerpt: fact.evidence, contentHash: applied.appliedRevision });
    if (fact.factKind === "state") {
      states.push({ id: `state_${suffix}`, identityId: subjectId, chapterNumber: applied.chapterNumber, key: fact.predicate, value: fact.value, confirmed: true, evidenceIds: [evidenceId] });
      continue;
    }
    const objectId = addIdentity(fact.object, evidenceId);
    edges.push({ id: `edge_${suffix}`, from: subjectId, to: objectId, type: fact.predicate, chapterNumber: applied.chapterNumber, evidenceId, confirmed: true });
  }
  return {
    workId: applied.workId, chapterId: applied.chapterId, chapterNumber: applied.chapterNumber,
    contentHash: applied.appliedRevision, source: "chapter", confirmation: "confirmed",
    identities: [...identities.values()], states, edges, evidence,
  };
}
