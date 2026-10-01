import { ChapterWorkflowTarget, WorkflowRunStatus, type ChapterWorkflowTarget as ChapterWorkflowTargetValue, type WorkflowRunStatus as WorkflowRunStatusValue } from "@jizuo/contracts";
import { ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

import { ChapterReviewOutputSchema, RequiredReviewKinds } from "./registry.ts";
import { ReviewStageIds, type ReviewStageId } from "./definition.ts";

const ArtifactReferenceSchema = z.object({
  artifactRef: z.string().trim().min(1).max(512),
  sha256: z.string().trim().min(1).max(128),
}).strict();

const ReviewOutputsSchema = z.partialRecord(
  z.enum(RequiredReviewKinds),
  ChapterReviewOutputSchema,
);

const ErrorClassificationSchema = z.object({
  category: z.enum(["transient", "schema", "conflict", "domain", "unknown"]),
  code: z.string().trim().min(1).max(80),
  message: z.string().trim().min(1).max(240),
}).strict();
const ReviewOutcomeSchema = z.object({
  candidateHash: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["approved-candidate", "revise", "rejected"]),
  blockingIssueFingerprints: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(128),
  score: z.number().finite().min(0).max(1),
}).strict();
const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const ReviewStageStateSchema = z.object({
  status: z.enum(["waiting", "reviewing", "revising", "passed", "continued_with_warnings"]),
  revisionRound: z.number().int().min(0).max(10),
  remainingRevisionRounds: z.number().int().min(0).max(10),
  candidateHash: ContentHashSchema.optional(),
  lastReviewArtifact: ArtifactReferenceSchema.optional(),
  unresolvedIssueFingerprints: z.array(ContentHashSchema).max(128),
}).strict();

const ReviewStageStatesSchema = z.partialRecord(z.enum(ReviewStageIds), ReviewStageStateSchema);

/**
 * Checkpoint-safe state. Large candidate, review, and memory bodies live in
 * artifacts; this graph carries only their references and content hashes.
 */
export const WorkflowGraphStateSchema = new StateSchema({
  runId: z.string().trim().min(1).max(128),
  parentSessionId: z.string().trim().min(1).max(128),
  target: ChapterWorkflowTarget,
  frozenDefinition: ArtifactReferenceSchema,
  frozenRequest: ArtifactReferenceSchema.optional(),
  /** Compact, artifact-backed target lock; never the chapter body itself. */
  targetLock: ArtifactReferenceSchema.optional(),
  chapterInitialized: z.boolean().optional(),
  planArtifact: ArtifactReferenceSchema.optional(),
  candidate: ArtifactReferenceSchema.optional(),
  memoryArtifact: ArtifactReferenceSchema.optional(),
  appliedArtifact: ArtifactReferenceSchema.optional(),
  /** Frozen execution policy. Old checkpoints remain proposal-only. */
  chapterWriteMode: z.enum(["candidate-only", "direct"]).default("candidate-only"),
  /** Receipt artifact for the current direct create/revision; prose never enters state. */
  chapterWriteArtifact: ArtifactReferenceSchema.optional(),
  /** Content revision proved by the receipt, compared with the reviewed candidate hash. */
  chapterWriteRevision: ContentHashSchema.optional(),
  reviewArtifacts: new ReducedValue(z.partialRecord(z.enum(RequiredReviewKinds), ArtifactReferenceSchema).default({}), {
    inputSchema: z.partialRecord(z.enum(RequiredReviewKinds), ArtifactReferenceSchema),
    reducer: (current, next) => ({ ...current, ...next }),
  }),
  reviewOutputs: new ReducedValue(ReviewOutputsSchema.default({}), {
    inputSchema: ReviewOutputsSchema,
    reducer: (current, next) => ({ ...current, ...next }),
  }),
  activeReviewStageId: z.enum(ReviewStageIds).optional(),
  reviewStageStates: new ReducedValue(ReviewStageStatesSchema.default({}), {
    inputSchema: ReviewStageStatesSchema,
    reducer: (current, next) => ({ ...current, ...next }),
  }),
  remainingRevisionRounds: z.number().int().min(0).max(10),
  revisionRound: z.number().int().min(0).max(10),
  noProgressRounds: z.number().int().min(0).max(2).default(0),
  reviewOutcome: ReviewOutcomeSchema.optional(),
  revisionDecision: z.enum(["approved", "revise", "waiting_decision", "continue_with_warnings", "blocked"]).optional(),
  proposalId: z.string().trim().min(1).max(128).optional(),
  appliedRevision: z.string().trim().min(1).max(128).optional(),
  approved: z.boolean().optional(),
  error: ErrorClassificationSchema.optional(),
  terminalStatus: WorkflowRunStatus.optional(),
});

export interface WorkflowArtifactReference {
  readonly artifactRef: string;
  readonly sha256: string;
}

export interface WorkflowGraphError {
  readonly category: "transient" | "schema" | "conflict" | "domain" | "unknown";
  readonly code: string;
  readonly message: string;
}

export type ReviewStageState = z.infer<typeof ReviewStageStateSchema>;

/** Public, compact state input and executor view. */
export interface WorkflowGraphState {
  readonly runId: string;
  readonly parentSessionId: string;
  readonly target: ChapterWorkflowTargetValue;
  readonly frozenDefinition: WorkflowArtifactReference;
  readonly frozenRequest?: WorkflowArtifactReference;
  readonly targetLock?: WorkflowArtifactReference;
  readonly chapterInitialized?: boolean;
  readonly planArtifact?: WorkflowArtifactReference;
  readonly candidate?: WorkflowArtifactReference;
  readonly memoryArtifact?: WorkflowArtifactReference;
  readonly appliedArtifact?: WorkflowArtifactReference;
  readonly chapterWriteMode?: "candidate-only" | "direct";
  readonly chapterWriteArtifact?: WorkflowArtifactReference;
  readonly chapterWriteRevision?: string;
  readonly reviewArtifacts?: Readonly<Partial<Record<(typeof RequiredReviewKinds)[number], WorkflowArtifactReference>>>;
  readonly reviewOutputs?: Readonly<Partial<Record<(typeof RequiredReviewKinds)[number], z.infer<typeof ChapterReviewOutputSchema>>>>;
  readonly activeReviewStageId?: ReviewStageId;
  readonly reviewStageStates?: Readonly<Partial<Record<ReviewStageId, ReviewStageState>>>;
  readonly remainingRevisionRounds: number;
  readonly revisionRound: number;
  readonly noProgressRounds?: number;
  readonly reviewOutcome?: z.infer<typeof ReviewOutcomeSchema>;
  readonly revisionDecision?: "approved" | "revise" | "waiting_decision" | "continue_with_warnings" | "blocked";
  readonly proposalId?: string;
  readonly appliedRevision?: string;
  readonly approved?: boolean;
  readonly error?: WorkflowGraphError;
  readonly terminalStatus?: WorkflowRunStatusValue;
}

export type WorkflowGraphStatePatch = Partial<Omit<WorkflowGraphState, "runId" | "parentSessionId" | "target" | "frozenDefinition" | "frozenRequest" | "chapterWriteMode">>;

/** Validates executor output before LangGraph persists it as a state update. */
export const WorkflowGraphStatePatchSchema = z.object({
  candidate: ArtifactReferenceSchema.optional(),
  targetLock: ArtifactReferenceSchema.optional(),
  chapterInitialized: z.boolean().optional(),
  planArtifact: ArtifactReferenceSchema.optional(),
  memoryArtifact: ArtifactReferenceSchema.optional(),
  appliedArtifact: ArtifactReferenceSchema.optional(),
  chapterWriteArtifact: ArtifactReferenceSchema.optional(),
  chapterWriteRevision: ContentHashSchema.optional(),
  reviewArtifacts: z.partialRecord(z.enum(RequiredReviewKinds), ArtifactReferenceSchema).optional(),
  reviewOutputs: ReviewOutputsSchema.optional(),
  activeReviewStageId: z.enum(ReviewStageIds).optional(),
  reviewStageStates: ReviewStageStatesSchema.optional(),
  remainingRevisionRounds: z.number().int().min(0).max(10).optional(),
  revisionRound: z.number().int().min(0).max(10).optional(),
  noProgressRounds: z.number().int().min(0).max(2).optional(),
  reviewOutcome: ReviewOutcomeSchema.optional(),
  revisionDecision: z.enum(["approved", "revise", "waiting_decision", "continue_with_warnings", "blocked"]).optional(),
  proposalId: z.string().trim().min(1).max(128).optional(),
  appliedRevision: z.string().trim().min(1).max(128).optional(),
  approved: z.boolean().optional(),
  error: ErrorClassificationSchema.optional(),
  terminalStatus: WorkflowRunStatus.optional(),
}).strict();
