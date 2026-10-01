import { StableId } from "@jizuo/contracts";
import { z } from "zod";

export const MemoryKind = z.enum([
  "character",
  "rule",
  "organization",
  "worldbuilding",
  "clue",
  "location",
  "object",
  "event",
  "style",
]);

export const MemoryRoom = z.enum(["characters", "world", "clues", "plot", "style"]);

export const DreamModelSelectionSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
}).strict();
export type DreamModelSelection = z.infer<typeof DreamModelSelectionSchema>;
export const DreamModelOptionSchema = DreamModelSelectionSchema.extend({
  providerName: z.string(), modelName: z.string(), available: z.boolean(), unavailableReason: z.string().optional(),
});
export type DreamModelOption = z.infer<typeof DreamModelOptionSchema>;

export const DreamSettingsSchema = z.object({
  enabled: z.boolean(),
  dailyTokenLimit: z.number().int().positive(),
  paused: z.boolean(),
  skipUntil: z.string().datetime().optional(),
  modelSelection: DreamModelSelectionSchema.optional(),
}).strict();

export const DreamCommandSchema = z.enum(["run_now", "pause", "resume", "skip_tonight", "stop_before_exit"]);
export type DreamCommand = z.infer<typeof DreamCommandSchema>;
export const DreamStatusSchema = z.object({
  state: z.enum(["disabled", "waiting", "running", "paused", "paused_budget", "needs_model", "error"]),
  pendingChapters: z.number().int().nonnegative(),
  completedChapters: z.number().int().nonnegative(),
  currentChapter: z.string().optional(),
  usedTokens: z.number().int().nonnegative(),
  reservedTokens: z.number().int().nonnegative(),
  dailyTokenLimit: z.number().int().positive(),
  lastError: z.string().optional(),
  waitingReason: z.string().optional(),
}).strict();
export type DreamStatus = z.infer<typeof DreamStatusSchema>;

export type DreamSettings = z.infer<typeof DreamSettingsSchema>;

export const DreamChapterStateSchema = z.enum(["graphed", "graph_outdated", "pending", "running", "partial", "awaiting_review", "rejected", "no_facts", "failed", "empty", "editing", "busy", "capacity_exceeded", "capacity_unknown"]);
export type DreamChapterState = z.infer<typeof DreamChapterStateSchema>;
export const DreamActivityPhaseSchema = z.enum(["preparing", "reading", "waiting_model", "generating", "validating", "saving_segment", "saving_memory"]);
export type DreamActivityPhase = z.infer<typeof DreamActivityPhaseSchema>;
/** Live operational metadata only. Saved progress remains the durable source of truth. */
export const DreamChapterActivitySchema = z.object({
  processingMode: z.literal("chapter").optional(),
  phase: DreamActivityPhaseSchema,
  startedAt: z.string().datetime(), phaseStartedAt: z.string().datetime(), lastActivityAt: z.string().datetime(),
  part: z.number().int().positive(), from: z.number().int().nonnegative(), to: z.number().int().nonnegative(),
  receivedChars: z.number().int().nonnegative(), modelSelection: DreamModelSelectionSchema.optional(),
  events: z.array(z.object({ phase: DreamActivityPhaseSchema, part: z.number().int().positive(), at: z.string().datetime() }).strict()).max(12),
}).strict();
export type DreamChapterActivity = z.infer<typeof DreamChapterActivitySchema>;
export const DreamModelConversationSchema = z.object({
  processingMode: z.literal("chapter").optional(),
  id: z.string().uuid(), part: z.number().int().positive(), from: z.number().int().nonnegative(), to: z.number().int().nonnegative(),
  modelSelection: DreamModelSelectionSchema, startedAt: z.string().datetime(), updatedAt: z.string().datetime(), finishedAt: z.string().datetime().optional(),
  state: z.enum(["running", "completed", "failed", "cancelled", "interrupted"]),
  request: z.object({ system: z.string(), content: z.string(), maxOutputTokens: z.number().int().positive().optional() }).strict(),
  output: z.string(), reasoning: z.string(), usedTokens: z.number().int().nonnegative().optional(), error: z.string().optional(),
}).strict();
export type DreamModelConversation = z.infer<typeof DreamModelConversationSchema>;
export const DreamChapterConversationsSchema = z.object({
  chapterId: StableId, conversations: z.array(DreamModelConversationSchema),
}).strict();
export type DreamChapterConversations = z.infer<typeof DreamChapterConversationsSchema>;
export const DreamChapterProgressSchema = z.object({
  processingMode: z.literal("chapter").optional(),
  volumeId: StableId, volumeTitle: z.string(), chapterId: StableId, chapterTitle: z.string(), chapterNumber: z.number().int().positive(),
  state: DreamChapterStateSchema, processedChars: z.number().int().nonnegative(), totalChars: z.number().int().nonnegative(),
  completedParts: z.number().int().nonnegative(), totalParts: z.number().int().nonnegative(),
  updatedAt: z.string().datetime().optional(), lastError: z.string().optional(),
  nextRetryAt: z.string().datetime().optional(),
  activity: DreamChapterActivitySchema.optional(), waitingReason: z.string().optional(),
  modelSegments: z.array(z.object({
    from: z.number().int().nonnegative(), to: z.number().int().nonnegative(),
    modelSelection: DreamModelSelectionSchema.optional(), completedAt: z.string().datetime().optional(),
  }).strict()).optional(),
}).strict();
export type DreamChapterProgress = z.infer<typeof DreamChapterProgressSchema>;
export const DreamWorkReportSchema = z.object({
  workId: StableId, generatedAt: z.string().datetime(), status: DreamStatusSchema, totalChapters: z.number().int().nonnegative(),
  counts: z.record(DreamChapterStateSchema, z.number().int().nonnegative()), chapters: z.array(DreamChapterProgressSchema),
}).strict();
export type DreamWorkReport = z.infer<typeof DreamWorkReportSchema>;

export const MemoryIdentityCandidate = z.object({
  id: StableId,
  name: z.string().trim().min(1).max(120),
  kind: MemoryKind,
  aliases: z.array(z.string().trim().min(1).max(120)).default([]),
  evidenceIds: z.array(StableId).default([]),
});

export const MemoryStateCandidate = z.object({
  id: StableId,
  identityId: StableId,
  chapterNumber: z.number().int().positive(),
  key: z.string().trim().min(1).max(80),
  value: z.string().max(500),
  confirmed: z.boolean(),
  evidenceIds: z.array(StableId).default([]),
});

export const MemoryEdgeCandidate = z.object({
  id: StableId,
  from: StableId,
  to: StableId,
  type: z.string().trim().min(1).max(80),
  chapterNumber: z.number().int().positive(),
  evidenceId: StableId,
  confirmed: z.boolean(),
});

export const MemoryEvidenceCandidate = z.object({
  id: StableId,
  chapterId: StableId,
  chapterNumber: z.number().int().positive(),
  excerpt: z.string().min(1).max(500),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const MemoryEpisodeCandidate = z.object({
  workId: StableId,
  chapterId: StableId,
  chapterNumber: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.enum(["chapter", "setting", "decision"]),
  confirmation: z.enum(["confirmed", "suggested"]),
  identities: z.array(MemoryIdentityCandidate).max(100),
  states: z.array(MemoryStateCandidate).max(200),
  edges: z.array(MemoryEdgeCandidate).max(200),
  evidence: z.array(MemoryEvidenceCandidate).max(200),
}).superRefine((candidate, context) => {
  for (const collection of ["identities", "states", "edges", "evidence"] as const) {
    const seen = new Set<string>();
    candidate[collection].forEach(({ id }, index) => {
      if (seen.has(id)) {
        context.addIssue({ code: "custom", path: [collection, index, "id"], message: `duplicate ${collection} id` });
      }
      seen.add(id);
    });
  }
  const identities = new Set(candidate.identities.map(({ id }) => id));
  const evidence = new Set(candidate.evidence.map(({ id }) => id));
  for (const state of candidate.states) {
    if (!identities.has(state.identityId)) {
      context.addIssue({ code: "custom", path: ["states", state.id], message: "state identity missing" });
    }
    if (state.chapterNumber !== candidate.chapterNumber) {
      context.addIssue({ code: "custom", path: ["states", state.id], message: "state chapter mismatch" });
    }
    for (const evidenceId of state.evidenceIds) {
      if (!evidence.has(evidenceId)) {
        context.addIssue({ code: "custom", path: ["states", state.id, "evidenceIds"], message: "state evidence missing" });
      }
    }
  }
  for (const identity of candidate.identities) {
    for (const evidenceId of identity.evidenceIds) {
      if (!evidence.has(evidenceId)) {
        context.addIssue({ code: "custom", path: ["identities", identity.id, "evidenceIds"], message: "identity evidence missing" });
      }
    }
  }
  for (const edge of candidate.edges) {
    if (!identities.has(edge.from) || !identities.has(edge.to)) {
      context.addIssue({ code: "custom", path: ["edges", edge.id], message: "edge identity missing" });
    }
    if (!evidence.has(edge.evidenceId)) {
      context.addIssue({ code: "custom", path: ["edges", edge.id], message: "edge evidence missing" });
    }
  }
  for (const item of candidate.evidence) {
    if (
      item.chapterId !== candidate.chapterId
      || item.chapterNumber !== candidate.chapterNumber
      || item.contentHash !== candidate.contentHash
    ) {
      context.addIssue({ code: "custom", path: ["evidence", item.id], message: "evidence source mismatch" });
    }
  }
});

export type MemoryKind = z.infer<typeof MemoryKind>;
export type MemoryRoom = z.infer<typeof MemoryRoom>;
export type MemoryEpisodeCandidate = z.input<typeof MemoryEpisodeCandidate>;

export const StoredIdentity = MemoryIdentityCandidate.extend({
  workId: StableId,
  chapterId: StableId,
  chapterNumber: z.number().int().positive(),
  episodeKey: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.boolean(),
});

export const StoredState = MemoryStateCandidate.extend({
  workId: StableId,
  chapterId: StableId,
  episodeKey: z.string().regex(/^[a-f0-9]{64}$/),
});

export const StoredEdge = MemoryEdgeCandidate.extend({
  workId: StableId,
  chapterId: StableId,
  episodeKey: z.string().regex(/^[a-f0-9]{64}$/),
});

export const StoredEvidence = MemoryEvidenceCandidate.extend({
  workId: StableId,
  episodeKey: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.boolean(),
});

export type StoredIdentity = z.infer<typeof StoredIdentity>;
export type StoredState = z.infer<typeof StoredState>;
export type StoredEdge = z.infer<typeof StoredEdge>;
export type StoredEvidence = z.infer<typeof StoredEvidence>;

export interface EpisodeCommitResult {
  status: "committed" | "suggested";
  episodeKey: string;
  workId: string;
  chapterId: string;
  chapterNumber: number;
  identityCount: number;
  stateCount: number;
  edgeCount: number;
  evidenceCount: number;
}

export const MemorySuggestionSummary = z.object({
  details: z.string().optional(),
  episodeKey: z.string().regex(/^[a-f0-9]{64}$/),
  chapterNumber: z.number().int().positive(),
  summary: z.string().min(1).max(500),
  chapterId: StableId.optional(),
  chapterTitle: z.string().optional(),
  volumeTitle: z.string().optional(),
  identityCount: z.number().int().nonnegative().optional(),
  stateCount: z.number().int().nonnegative().optional(),
  edgeCount: z.number().int().nonnegative().optional(),
}).strict();

export type MemorySuggestionSummary = z.infer<typeof MemorySuggestionSummary>;

export const MemorySuggestionDetailSchema = z.object({
  episodeKey: z.string().regex(/^[a-f0-9]{64}$/), chapterTitle: z.string().optional(), volumeTitle: z.string().optional(),
  sourceState: z.enum(["current", "changed", "missing"]), candidate: MemoryEpisodeCandidate,
}).strict();
export type MemorySuggestionDetail = z.infer<typeof MemorySuggestionDetailSchema>;

export const MemoryQuery = z.object({
  workId: StableId,
  mode: z.enum([
    "chapter",
    "range_strict",
    "range_with_prior",
    "current",
    "entity_timeline",
    "multi_entity_relationships",
  ]),
  chapter: z.number().int().positive().optional(),
  from: z.number().int().positive().optional(),
  to: z.number().int().positive().optional(),
  identities: z.array(StableId).default([]),
}).superRefine((query, context) => {
  if (query.mode === "chapter" && query.chapter === undefined) {
    context.addIssue({ code: "custom", path: ["chapter"], message: "chapter mode requires chapter" });
  }
  if (["range_strict", "range_with_prior", "multi_entity_relationships"].includes(query.mode)) {
    if (query.from === undefined || query.to === undefined || query.from > query.to) {
      context.addIssue({ code: "custom", path: ["from", "to"], message: "valid range required" });
    }
  }
  if (query.mode === "entity_timeline" && query.identities.length !== 1) {
    context.addIssue({ code: "custom", path: ["identities"], message: "timeline requires one identity" });
  }
  if (query.mode === "multi_entity_relationships" && query.identities.length < 2) {
    context.addIssue({ code: "custom", path: ["identities"], message: "relationships require multiple identities" });
  }
});

export type MemoryQueryInput = z.input<typeof MemoryQuery>;
export type ParsedMemoryQuery = z.output<typeof MemoryQuery>;

export interface MemoryGraphNode {
  id: string;
  identityId: string;
  name: string;
  kind: MemoryKind;
  room: MemoryRoom;
  chapterNumber: number;
  evidenceIds: string[];
}

export interface MemoryGraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  chapterNumber: number;
  evidenceId: string;
  evidenceChapter: number;
}

export interface MemoryGraph {
  query: ParsedMemoryQuery;
  revision: string;
  bounds: { from: number; to: number };
  nodes: MemoryGraphNode[];
  states: StoredState[];
  edges: MemoryGraphEdge[];
  evidence: StoredEvidence[];
}
