import { withMemoryLock } from "./lock.ts";
import { access, mkdir, readFile, readdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { JizuoError } from "@jizuo/contracts";
import { FileTransaction, resolveWithin, sha256Text, WatchedReadCache } from "@jizuo/work-domain";
import { parse, stringify } from "yaml";
import { z } from "zod";

import {
  MemoryEpisodeCandidate,
  StoredEdge,
  StoredEvidence,
  StoredIdentity,
  StoredState,
  type EpisodeCommitResult,
  type MemorySuggestionSummary,
} from "./types.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readYamlTree<T>(root: string, schema: z.ZodType<T>): Promise<T[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const values: T[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolveWithin(root, entry.name);
    if (entry.isDirectory()) values.push(...await readYamlTree(path, schema));
    else if (entry.isFile() && entry.name.endsWith(".yaml")) {
      values.push(schema.parse(parse(await readFile(path, "utf8"))));
    }
  }
  return values;
}

const ConfirmedEpisodeFile = z.object({
  schemaVersion: z.literal(1),
  episodeKey: z.string().regex(/^[a-f0-9]{64}$/),
}).passthrough();

type ConfirmedEpisode = {
  episodeKey: string;
  candidate: z.output<typeof MemoryEpisodeCandidate>;
};

type ParsedEpisode = z.output<typeof MemoryEpisodeCandidate>;

export interface MemoryReadSnapshot {
  identities: StoredIdentity[]; states: StoredState[]; edges: StoredEdge[]; evidence: StoredEvidence[];
  episodes: ConfirmedEpisode[]; revision: string;
}
const snapshots = new WatchedReadCache<MemoryReadSnapshot>((file) => /^memory\/(identities|states|edges|evidence|episodes|current)(\/|$)/.test(file));

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function conflict(collection: string, id: string): never {
  throw new JizuoError("revision_conflict", "同一章节记忆 ID 的内容发生冲突，请使用新的稳定 ID", {
    collection,
    id,
  });
}

function mergeRecordsById<T extends { id: string }>(
  existing: T[],
  incoming: T[],
  mergeSameId: (left: T, right: T) => T,
): T[] {
  const records = new Map(existing.map((record) => [record.id, record]));
  for (const record of incoming) {
    const current = records.get(record.id);
    records.set(record.id, current === undefined ? record : mergeSameId(current, record));
  }
  return [...records.values()];
}

function mergeCandidate(existing: ParsedEpisode, incoming: ParsedEpisode): ParsedEpisode {
  const metadata = ["workId", "chapterId", "chapterNumber", "contentHash", "source", "confirmation"] as const;
  for (const key of metadata) {
    if (existing[key] !== incoming[key]) conflict("episode", String(key));
  }

  const identities = mergeRecordsById(existing.identities, incoming.identities, (left, right) => {
    if (left.kind !== right.kind) conflict("identities", left.id);
    return {
      ...left,
      aliases: unique([
        ...left.aliases,
        ...right.aliases,
        ...(left.name === right.name ? [] : [right.name]),
      ]).filter((alias) => alias !== left.name),
      evidenceIds: unique([...left.evidenceIds, ...right.evidenceIds]),
    };
  });
  const states = mergeRecordsById(existing.states, incoming.states, (left, right) => {
    const { evidenceIds: _leftEvidence, ...leftFact } = left;
    const { evidenceIds: _rightEvidence, ...rightFact } = right;
    if (!isDeepStrictEqual(leftFact, rightFact)) conflict("states", left.id);
    return { ...left, evidenceIds: unique([...left.evidenceIds, ...right.evidenceIds]) };
  });
  const edges = mergeRecordsById(existing.edges, incoming.edges, (left, right) => {
    if (!isDeepStrictEqual(left, right)) conflict("edges", left.id);
    return left;
  });
  const evidence = mergeRecordsById(existing.evidence, incoming.evidence, (left, right) => {
    if (!isDeepStrictEqual(left, right)) conflict("evidence", left.id);
    return left;
  });

  return MemoryEpisodeCandidate.parse({ ...existing, identities, states, edges, evidence });
}

function commitResult(candidate: ParsedEpisode, episodeKey: string): EpisodeCommitResult {
  const confirmed = candidate.confirmation === "confirmed";
  return {
    status: confirmed ? "committed" : "suggested",
    episodeKey,
    workId: candidate.workId,
    chapterId: candidate.chapterId,
    chapterNumber: candidate.chapterNumber,
    identityCount: confirmed ? candidate.identities.length : 0,
    stateCount: confirmed ? candidate.states.length : 0,
    edgeCount: confirmed ? candidate.edges.length : 0,
    evidenceCount: confirmed ? candidate.evidence.length : 0,
  };
}

async function readConfirmedEpisodeTree(root: string): Promise<ConfirmedEpisode[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const episodes: ConfirmedEpisode[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolveWithin(root, entry.name);
    if (entry.isDirectory()) {
      episodes.push(...await readConfirmedEpisodeTree(path));
    } else if (entry.isFile() && entry.name.endsWith(".yaml")) {
      const raw = parse(await readFile(path, "utf8"));
      const { episodeKey } = ConfirmedEpisodeFile.parse(raw);
      const candidate = MemoryEpisodeCandidate.parse(raw);
      if (candidate.confirmation === "confirmed") episodes.push({ episodeKey, candidate });
    }
  }
  return episodes;
}

function mergeEpisodeRecords<T extends { id: string; episodeKey: string }>(
  indexed: T[],
  recovered: T[],
): T[] {
  const records = new Map(indexed.map((record) => [`${record.id}\0${record.episodeKey}`, record]));
  for (const record of recovered) {
    const key = `${record.id}\0${record.episodeKey}`;
    if (!records.has(key)) records.set(key, record);
  }
  return [...records.values()];
}

export class MemoryRepository {
  readonly workRoot: string;

  constructor(options: { workRoot: string }) {
    this.workRoot = resolve(options.workRoot);
  }

  async commitEpisode(rawCandidate: unknown): Promise<EpisodeCommitResult> {
    return withMemoryLock(`${this.workRoot}:episodes`, () => this.commitEpisodeLocked(rawCandidate)).finally(() => snapshots.invalidate(this.workRoot));
  }

  async commitDreamEpisodeIfUncovered(rawCandidate: unknown, beforeCommit?: () => Promise<void>): Promise<EpisodeCommitResult | { status: "skipped_graph_present" } | { status: "skipped_already_processed" }> {
    const candidate = MemoryEpisodeCandidate.parse(rawCandidate);
    return withMemoryLock(`${this.workRoot}:episodes`, async () => {
      const coverage = (await this.getChapterMemoryIndex(candidate.workId, true)).get(candidate.chapterId);
      if (coverage && coverage.formalEpisodeKeys.size > 0) return { status: "skipped_graph_present" as const };
      if (coverage?.attempts.has(this.episodeKey(candidate.chapterId, candidate.contentHash))) return { status: "skipped_already_processed" as const };
      await beforeCommit?.();
      return this.commitEpisodeLocked(candidate);
    }).finally(() => snapshots.invalidate(this.workRoot));
  }

  /** Reads chapter provenance before graph projection merges identities across chapters. */
  async getChapterMemoryIndex(workId?: string, fresh = false): Promise<Map<string, ChapterMemoryIndexEntry>> {
    const index = new Map<string, ChapterMemoryIndexEntry>();
    const entry = (chapterId: string) => {
      let item = index.get(chapterId);
      if (!item) { item = { formalEpisodeKeys: new Set(), attempts: new Map() }; index.set(chapterId, item); }
      return item;
    };
    const [snapshot, suggestions, rejected] = await Promise.all([
      fresh ? this.loadSnapshot() : this.readSnapshot(),
      this.readPendingCandidates(),
      readYamlTree(resolveWithin(this.workRoot, "memory", "dream", "suggestions", "rejected"), MemoryEpisodeCandidate),
    ]);
    const { identities, states, edges, evidence, episodes } = snapshot;
    const allowed = (item: { workId: string; confirmed: boolean }) => item.confirmed && (workId === undefined || item.workId === workId);
    const evidenceIds = new Set(evidence.filter(allowed).map((item) => `${item.episodeKey}:${item.id}`));
    for (const item of [...identities.filter(allowed), ...states.filter(allowed), ...edges.filter((item) => allowed(item) && evidenceIds.has(`${item.episodeKey}:${item.evidenceId}`))]) {
      entry(item.chapterId).formalEpisodeKeys.add(item.episodeKey);
    }
    for (const { candidate, episodeKey } of episodes) {
      if (workId !== undefined && candidate.workId !== workId) continue;
      if (candidate.identities.length + candidate.states.length + candidate.edges.length !== 0) continue;
      const current = await this.currentEpisodeKey(candidate.chapterId);
      if (current === undefined || current === episodeKey) entry(candidate.chapterId).attempts.set(episodeKey, "no_facts");
    }
    for (const candidate of rejected) {
      if (workId === undefined || candidate.workId === workId) entry(candidate.chapterId).attempts.set(this.episodeKey(candidate.chapterId, candidate.contentHash), "rejected");
    }
    for (const candidate of suggestions) {
      if (workId === undefined || candidate.workId === workId) entry(candidate.chapterId).attempts.set(this.episodeKey(candidate.chapterId, candidate.contentHash), "awaiting_review");
    }
    return index;
  }

  private async readPendingCandidates(): Promise<ParsedEpisode[]> {
    const root = resolveWithin(this.workRoot, "memory", "dream", "suggestions");
    const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    return Promise.all(entries.filter((item) => item.isFile() && item.name.endsWith(".yaml")).map(async (item) => MemoryEpisodeCandidate.parse(parse(await readFile(resolveWithin(root, item.name), "utf8")))));
  }

  private async commitEpisodeLocked(rawCandidate: unknown): Promise<EpisodeCommitResult> {
    const parsed = MemoryEpisodeCandidate.safeParse(rawCandidate);
    if (!parsed.success) {
      throw new JizuoError("validation_error", "记忆候选不完整或证据越界", {
        cause: parsed.error.flatten(),
      });
    }
    const candidate = parsed.data;
    const episodeKey = this.episodeKey(candidate.chapterId, candidate.contentHash);
    const episodeRelative = candidate.confirmation === "confirmed"
      ? `memory/episodes/${candidate.source}/${episodeKey}.yaml`
      : `memory/dream/suggestions/${episodeKey}.yaml`;
    const episodePath = resolveWithin(this.workRoot, episodeRelative);
    let candidateToCommit = candidate;
    if (await exists(episodePath)) {
      const raw = parse(await readFile(episodePath, "utf8"));
      const stored = MemoryEpisodeCandidate.parse(raw);
      candidateToCommit = mergeCandidate(stored, candidate);
      if (isDeepStrictEqual(stored, candidateToCommit) && (candidate.confirmation !== "confirmed" || await this.currentEpisodeKey(candidate.chapterId) === episodeKey)) return commitResult(stored, episodeKey);
    }

    const transaction = await FileTransaction.begin({
      workRoot: this.workRoot,
      id: `memory_${episodeKey.slice(0, 24)}`,
    });
    await transaction.stage(episodeRelative, stringify({
      schemaVersion: 1,
      episodeKey,
      ...candidateToCommit,
    }, { lineWidth: 0 }));
    if (candidateToCommit.confirmation === "confirmed") {
      await transaction.stage(`memory/current/${candidateToCommit.chapterId}.yaml`, stringify({ chapterId: candidateToCommit.chapterId, episodeKey }));
      for (const identity of candidateToCommit.identities) {
        await transaction.stage(`memory/identities/${identity.id}/${episodeKey}.yaml`, stringify({
          ...identity,
          workId: candidateToCommit.workId,
          chapterId: candidateToCommit.chapterId,
          chapterNumber: candidateToCommit.chapterNumber,
          episodeKey,
          confirmed: true,
        }, { lineWidth: 0 }));
      }
      for (const state of candidateToCommit.states) {
        await transaction.stage(`memory/states/${state.identityId}/${state.id}--${episodeKey}.yaml`, stringify({
          ...state,
          workId: candidateToCommit.workId,
          chapterId: candidateToCommit.chapterId,
          episodeKey,
        }, { lineWidth: 0 }));
      }
      for (const edge of candidateToCommit.edges) {
        await transaction.stage(`memory/edges/${edge.id}--${episodeKey}.yaml`, stringify({
          ...edge,
          workId: candidateToCommit.workId,
          chapterId: candidateToCommit.chapterId,
          episodeKey,
        }, { lineWidth: 0 }));
      }
      for (const evidence of candidateToCommit.evidence) {
        await transaction.stage(`memory/evidence/${evidence.id}--${episodeKey}.yaml`, stringify({
          ...evidence,
          workId: candidateToCommit.workId,
          episodeKey,
          confirmed: true,
        }, { lineWidth: 0 }));
      }
    }
    await transaction.commit();
    return commitResult(candidateToCommit, episodeKey);
  }

  readSnapshot(): Promise<MemoryReadSnapshot> {
    return snapshots.get(this.workRoot, () => withMemoryLock(`${this.workRoot}:episodes`, () => this.loadSnapshot()));
  }

  invalidateReadSnapshot(): void { snapshots.invalidate(this.workRoot); }

  private async loadSnapshot(): Promise<MemoryReadSnapshot> {
    const [identities, states, indexedEdges, indexedEvidence, episodes] = await Promise.all([
      readYamlTree(resolveWithin(this.workRoot, "memory", "identities"), StoredIdentity),
      readYamlTree(resolveWithin(this.workRoot, "memory", "states"), StoredState),
      readYamlTree(resolveWithin(this.workRoot, "memory", "edges"), StoredEdge),
      readYamlTree(resolveWithin(this.workRoot, "memory", "evidence"), StoredEvidence),
      readConfirmedEpisodeTree(resolveWithin(this.workRoot, "memory", "episodes")),
    ]);
    const edges = mergeEpisodeRecords(indexedEdges, episodes.flatMap(({ episodeKey, candidate }) => candidate.edges.map((edge) =>
      StoredEdge.parse({ ...edge, workId: candidate.workId, chapterId: candidate.chapterId, episodeKey }))));
    const evidence = mergeEpisodeRecords(indexedEvidence, episodes.flatMap(({ episodeKey, candidate }) => candidate.evidence.map((item) =>
      StoredEvidence.parse({ ...item, workId: candidate.workId, episodeKey, confirmed: true }))));
    const chapterIds = new Set([...identities, ...states, ...edges, ...evidence].map((item) => item.chapterId));
    const keys = new Map(await Promise.all([...chapterIds].map(async (id) => [id, await this.currentEpisodeKey(id)] as const)));
    const current = <T extends { chapterId: string; episodeKey: string }>(records: T[]) => records.filter((item) => keys.get(item.chapterId) === undefined || keys.get(item.chapterId) === item.episodeKey);
    const data = { identities: current(identities), states: current(states), edges: current(edges), evidence: current(evidence) };
    return { ...data, episodes, revision: sha256Text(JSON.stringify(data)) };
  }

  async loadIdentities(): Promise<StoredIdentity[]> { return (await this.readSnapshot()).identities; }
  async loadStates(): Promise<StoredState[]> { return (await this.readSnapshot()).states; }
  async loadEdges(): Promise<StoredEdge[]> { return (await this.readSnapshot()).edges; }
  async loadEvidence(): Promise<StoredEvidence[]> { return (await this.readSnapshot()).evidence; }

  private async currentEpisodeKey(chapterId: string): Promise<string | undefined> {
    try {
      const value = parse(await readFile(resolveWithin(this.workRoot, "memory", "current", `${chapterId}.yaml`), "utf8"));
      return z.object({ chapterId: z.string(), episodeKey: z.string().regex(/^[a-f0-9]{64}$/) }).parse(value).episodeKey;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async getSuggestion(episodeKey: string) { return (await this.readSuggestion(episodeKey)).candidate; }

  async listSuggestions(): Promise<MemorySuggestionSummary[]> {
    const root = resolveWithin(this.workRoot, "memory", "dream", "suggestions");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const suggestions: MemorySuggestionSummary[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
      const raw = parse(await readFile(resolveWithin(root, entry.name), "utf8")) as Record<string, unknown>;
      const episodeKey = String(raw.episodeKey ?? entry.name.slice(0, -5));
      const { schemaVersion: _schemaVersion, episodeKey: _storedKey, ...candidateValue } = raw;
      const candidate = MemoryEpisodeCandidate.parse(candidateValue);
      const names = candidate.identities.map(({ name }) => name);
      const subject = names.length === 0 ? `第 ${candidate.chapterNumber} 章` : names.slice(0, 3).join("、");
      const relationship = candidate.edges[0]?.type;
      const state = candidate.states[0];
      const summary = relationship !== undefined
        ? `${subject}：${relationship}`
        : state !== undefined
          ? `${subject}：${state.key} = ${state.value}`
          : `${subject}的待确认记忆`;
      const identityName = (id: string) => candidate.identities.find((item) => item.id === id)?.name ?? "未命名";
      const evidenceText = (id: string | undefined) => candidate.evidence.find((item) => item.id === id)?.excerpt ?? "";
      const details = [
        ...candidate.states.map((item) => `${identityName(item.identityId)} · ${item.key}：${item.value}\n原文：${evidenceText(item.evidenceIds[0])}`),
        ...candidate.edges.map((item) => `${identityName(item.from)} → ${identityName(item.to)}：${item.type}\n原文：${evidenceText(item.evidenceId)}`),
      ].join("\n\n");
      suggestions.push({ episodeKey, chapterNumber: candidate.chapterNumber, chapterId: candidate.chapterId, summary, details,
        identityCount: candidate.identities.length, stateCount: candidate.states.length, edgeCount: candidate.edges.length });
    }
    return suggestions.sort((left, right) => left.chapterNumber - right.chapterNumber);
  }

  episodeKey(chapterId: string, contentHash: string): string {
    return sha256Text(`${chapterId}\0${contentHash}`);
  }

  async hasProcessedEpisode(chapterId: string, contentHash: string): Promise<boolean> {
    const key = this.episodeKey(chapterId, contentHash);
    const current = await this.currentEpisodeKey(chapterId);
    if (current !== undefined && current !== key) {
      return await exists(resolveWithin(this.workRoot, "memory", "dream", "suggestions", `${key}.yaml`))
        || await exists(resolveWithin(this.workRoot, "memory", "dream", "suggestions", "rejected", `${key}.yaml`));
    }
    const roots = [
      resolveWithin(this.workRoot, "memory", "episodes", "chapter", `${key}.yaml`),
      resolveWithin(this.workRoot, "memory", "episodes", "setting", `${key}.yaml`),
      resolveWithin(this.workRoot, "memory", "episodes", "decision", `${key}.yaml`),
      resolveWithin(this.workRoot, "memory", "dream", "suggestions", `${key}.yaml`),
      resolveWithin(this.workRoot, "memory", "dream", "suggestions", "accepted", `${key}.yaml`),
      resolveWithin(this.workRoot, "memory", "dream", "suggestions", "rejected", `${key}.yaml`),
    ];
    for (const path of roots) if (await exists(path)) return true;
    return false;
  }

  async acceptSuggestion(episodeKey: string, validate?: (candidate: ParsedEpisode) => Promise<void>): Promise<EpisodeCommitResult> {
    return withMemoryLock(`${this.workRoot}:episodes`, async () => {
      const { candidate, path } = await this.readSuggestion(episodeKey);
      await validate?.(candidate);
      const promoted = {
        ...candidate,
        confirmation: "confirmed" as const,
        states: candidate.states.map((state) => ({ ...state, confirmed: true })),
        edges: candidate.edges.map((edge) => ({ ...edge, confirmed: true })),
      };
      const result = await this.commitEpisodeLocked(promoted);
      await this.archiveSuggestion(path, episodeKey, "accepted");
      return result;
    }).finally(() => snapshots.invalidate(this.workRoot));
  }

  async rejectSuggestion(episodeKey: string): Promise<void> {
    return withMemoryLock(`${this.workRoot}:episodes`, async () => {
      const { path } = await this.readSuggestion(episodeKey);
      await this.archiveSuggestion(path, episodeKey, "rejected");
    });
  }

  private async readSuggestion(episodeKey: string) {
    if (!/^[a-f0-9]{64}$/.test(episodeKey)) {
      throw new JizuoError("validation_error", "梦境建议 ID 无效", { episodeKey });
    }
    const path = resolveWithin(this.workRoot, "memory", "dream", "suggestions", `${episodeKey}.yaml`);
    try {
      const raw = parse(await readFile(path, "utf8")) as Record<string, unknown>;
      const { schemaVersion: _schemaVersion, episodeKey: _storedKey, ...candidate } = raw;
      return { path, candidate: MemoryEpisodeCandidate.parse(candidate) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new JizuoError("validation_error", "梦境建议不存在或已处理", { episodeKey });
    }
  }

  private async archiveSuggestion(path: string, episodeKey: string, status: "accepted" | "rejected"): Promise<void> {
    const directory = resolveWithin(this.workRoot, "memory", "dream", "suggestions", status);
    await mkdir(directory, { recursive: true });
    await rename(path, resolveWithin(directory, `${episodeKey}.yaml`));
  }
}

export interface ChapterMemoryIndexEntry {
  formalEpisodeKeys: Set<string>;
  attempts: Map<string, "awaiting_review" | "rejected" | "no_facts">;
}
