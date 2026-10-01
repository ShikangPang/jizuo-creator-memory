import { createHash } from "node:crypto";

import {
  ChapterWorkflowTarget,
  JizuoError,
  StableId,
  WorkflowChapterWriteArgs,
  WorkflowChapterWriteReceipt,
  type ChapterChangeProposal,
  type ChapterCreationProposal,
  type ChapterDocument,
  type WorkflowChapterWriteArgs as WorkflowChapterWriteArgsValue,
  type WorkflowChapterWriteReceipt as WorkflowChapterWriteReceiptValue,
  type WorkflowChapterProjectionInput,
} from "@jizuo/contracts";
import type { ChapterWriteNodeId } from "@jizuo/workflow-runtime";
import { MemoryEpisodeCandidate, type EpisodeCommitResult, type MemoryEpisodeCandidate as MemoryEpisodeCandidateInput, type MemoryGraph, type MemoryQueryInput } from "@jizuo/memory-domain";
import type {
  ProposalApplicationSnapshot,
  WorkflowChapterCreateInput,
  WorkflowChapterInspectionInput,
  WorkflowChapterInitializeInput,
  WorkflowChapterDraftInput,
  WorkflowChapterLiveDraftInput,
  WorkflowChapterReplaceInput,
} from "@jizuo/work-domain";
import { z } from "zod";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const ApprovalSchema = z.object({ proposalId: z.string().trim().min(1).max(128), token: z.string().trim().min(1).max(512) }).strict();
const CandidateSchema = z.object({ candidateHash: Hash, content: z.string() }).strict();
const ReviewSchema = z.object({ kind: z.literal("approved-candidate"), candidateHash: Hash }).strict();
const ModifyTargetSchema = z.object({ mode: z.literal("modify"), workId: StableId, volumeId: StableId, chapterId: StableId }).strict();
const CreateExplicitTargetSchema = z.object({ mode: z.literal("create_explicit"), workId: StableId, volumeId: StableId, title: z.string().trim().min(1).max(120) }).strict();
const CreateNextTargetSchema = z.object({ mode: z.literal("create_next"), workId: StableId, volumeId: StableId, afterChapterId: StableId, title: z.string().trim().min(1).max(120) }).strict();

const ChapterLockSchema = z.object({
  kind: z.literal("chapter"),
  target: ModifyTargetSchema,
  revision: Hash,
  chapterNumber: z.number().int().positive(),
  plan: z.string(),
  detailedOutline: z.string(),
}).strict();
export const ChapterListLockSchema = z.object({
  kind: z.literal("chapter-list"),
  target: z.union([
    CreateExplicitTargetSchema,
    CreateNextTargetSchema,
  ]),
  chapterListHash: Hash,
  insertAfterChapterId: z.string().trim().min(1).nullable(),
  reservedChapterId: StableId,
}).strict();
// 1.0.0 persisted create locks predate reserved identities. Parsing them must
// not allocate authority; only direct write/reconciliation requires the new ID.
export const LockedChapterTargetSchema = z.union([ChapterLockSchema, ChapterListLockSchema.partial({ reservedChapterId: true })]);

const ProposalReferenceSchema = z.object({
  proposalId: z.string().trim().min(1).max(128),
  kind: z.enum(["chapter_change", "chapter_create"]),
  target: ChapterWorkflowTarget,
  candidateHash: Hash,
}).strict();

const AppliedChapterSchema = z.object({
  proposalId: z.string().trim().min(1).max(128),
  workId: z.string().trim().min(1),
  volumeId: z.string().trim().min(1),
  chapterId: z.string().trim().min(1),
  chapterNumber: z.number().int().positive(),
  appliedRevision: Hash,
  contentHash: Hash,
}).strict();

export type LockedChapterTarget = z.infer<typeof LockedChapterTargetSchema>;
export type ChapterProposalReference = z.infer<typeof ProposalReferenceSchema>;
export type AppliedChapter = z.infer<typeof AppliedChapterSchema>;

export interface WorkflowChapterWriteInput {
  readonly chapterInitialized?: boolean;
  readonly lock: LockedChapterTarget;
  readonly runId: string;
  readonly nodeId: ChapterWriteNodeId;
  readonly revisionRound: number;
  readonly previousEffect?: Readonly<{ nodeId: ChapterWriteNodeId; revisionRound: number }>;
  readonly previous?: WorkflowChapterWriteReceiptValue;
  /** Host-validated previous candidate artifact, never a model argument. */
  readonly previousArgs?: WorkflowChapterWriteArgsValue;
  readonly args: z.input<typeof WorkflowChapterWriteArgs>;
}

export type ChapterWriteReconciliationInput = WorkflowChapterWriteInput;
export type WorkflowChapterWriteReconciliation =
  | { readonly status: "not_written" }
  | { readonly status: "written"; readonly receipt: WorkflowChapterWriteReceiptValue }
  | { readonly status: "conflict"; readonly conflictCode: string };

/** Public Jizuo-domain calls used by a workflow; no work paths or stores leak here. */
export interface JizuoWorkflowDomainService {
  readChapter(input: { workId: string; volumeId: string; chapterId: string }): Promise<ChapterDocument>;
  getChapterListSnapshot(input: { workId: string; volumeId: string }): Promise<{ expectedChapterListHash: string; insertAfterChapterId: string | null }>;
  queryMemoryBounded(input: { query: MemoryQueryInput; maximumChapter: number }): Promise<MemoryGraph>;
  createProposal(input: { workId: string; volumeId: string; chapterId: string; expectedRevision: string; nextContent: string; workflowRunId?: string }): Promise<ChapterChangeProposal>;
  createChapterProposal(input: { target: { workId: string; volumeId: string }; title: string; nextContent: string; expectedChapterListHash: string; insertAfterChapterId?: string | null; workflowRunId?: string }): Promise<ChapterCreationProposal>;
  applyProposal(input: { proposalId: string; token: string }): Promise<ChapterDocument>;
  inspectProposalApplication(proposalId: string): Promise<ProposalApplicationSnapshot>;
  saveChapterMemory(input: { volumeId: string; candidate: MemoryEpisodeCandidateInput }): Promise<EpisodeCommitResult>;
  reserveWorkflowChapterId(): string;
  initializeWorkflowChapter(input: WorkflowChapterInitializeInput, assertActive?: () => void): Promise<ChapterDocument>;
  saveWorkflowChapterDraft(input: WorkflowChapterDraftInput, assertActive?: () => void): Promise<{ relativePath: string; contentHash: string }>;
  saveWorkflowChapterLiveDraft(input: WorkflowChapterLiveDraftInput, assertActive?: () => void): Promise<{ relativePath: string; contentHash: string }>;
  writeWorkflowChapter(input: WorkflowChapterCreateInput | WorkflowChapterReplaceInput, assertActive?: () => void): Promise<ChapterDocument>;
  inspectWorkflowChapterWrite(input: WorkflowChapterInspectionInput): Promise<ChapterDocument | undefined>;
  saveWorkflowChapterProjection?(input: WorkflowChapterProjectionInput): Promise<unknown>;
}

export abstract class DomainNodeError extends Error {
  abstract readonly category: "conflict" | "domain" | "transient";
  abstract readonly code: string;
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.cause = cause;
  }
}

export class TargetConflict extends DomainNodeError {
  readonly category = "conflict" as const;
  readonly code = "target_conflict" as const;
}

export class ProposalConflict extends DomainNodeError {
  readonly category = "conflict" as const;
  readonly code = "proposal_conflict" as const;
}

export class VerificationFailed extends DomainNodeError {
  readonly category = "domain" as const;
  readonly code = "verification_failed" as const;
}

export class MemoryEvidenceInvalid extends DomainNodeError {
  readonly category = "domain" as const;
  readonly code = "memory_evidence_invalid" as const;
}

export class MemoryRevisionConflict extends DomainNodeError {
  readonly category = "conflict" as const;
  readonly code = "memory_revision_conflict" as const;
}

export class TransientDomainError extends DomainNodeError {
  readonly category = "transient" as const;
  readonly code: "transient_domain" | "memory_pending";
  readonly tailStatus?: "memory_pending";

  constructor(message: string, options: { cause?: unknown; memoryPending?: boolean } = {}) {
    super(message, options.cause);
    this.code = options.memoryPending ? "memory_pending" : "transient_domain";
    if (options.memoryPending) this.tailStatus = "memory_pending";
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceHash(candidate: z.output<typeof MemoryEpisodeCandidate>): string {
  const evidence = [...candidate.evidence]
    .map(({ id, chapterId, chapterNumber, excerpt, contentHash }) => ({ id, chapterId, chapterNumber, excerpt, contentHash }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return hash(JSON.stringify(evidence));
}

function isConflict(error: unknown): boolean {
  return error instanceof JizuoError && (error.code === "revision_conflict" || error.code === "denied");
}

function invalidMemoryGraph(graph: MemoryGraph, workId: string, upperBound: number): boolean {
  if (graph.query.workId !== workId || graph.bounds.to > upperBound) return true;
  return [
    ...graph.nodes,
    ...graph.states,
    ...graph.edges,
    ...graph.evidence,
  ].some((entry) => (
    ("workId" in entry && entry.workId !== workId)
    || entry.chapterNumber > upperBound
    || ("evidenceChapter" in entry && entry.evidenceChapter > upperBound)
  ));
}

function clampMemoryQuery(query: MemoryQueryInput, workId: string, upperBound: number): MemoryQueryInput {
  const parsed = z.object({
    workId: z.string(),
    mode: z.enum(["chapter", "range_strict", "range_with_prior", "current", "entity_timeline", "multi_entity_relationships"]),
    chapter: z.number().int().positive().optional(),
    from: z.number().int().positive().optional(),
    to: z.number().int().positive().optional(),
    identities: z.array(z.string()).default([]),
  }).strict().parse(query);
  const chapter = parsed.chapter === undefined ? undefined : Math.min(parsed.chapter, upperBound);
  const to = parsed.to === undefined ? undefined : Math.min(parsed.to, upperBound);
  const from = parsed.from === undefined ? undefined : Math.min(parsed.from, to ?? upperBound);
  return {
    workId,
    mode: parsed.mode,
    ...(chapter === undefined ? {} : { chapter }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    identities: parsed.identities,
  } as MemoryQueryInput;
}

function compactChapter(proposalId: string, document: ChapterDocument): AppliedChapter {
  const contentHash = hash(document.content);
  return AppliedChapterSchema.parse({
    proposalId,
    workId: document.workId,
    volumeId: document.volumeId,
    chapterId: document.id,
    chapterNumber: document.order,
    appliedRevision: document.revisionToken,
    contentHash,
  });
}

/**
 * Concrete workflow-domain port. It accepts transient candidate prose only at
 * the proposal boundary and returns compact, checkpoint-safe references.
 */
export class JizuoDomainNodeAdapter {
  readonly #memorySaves = new Map<string, Promise<{ episodeKey: string; status: "committed" | "suggested" }>>();

  constructor(private readonly service: JizuoWorkflowDomainService) {}

  async lockChapterTarget(rawTarget: unknown): Promise<z.infer<typeof ChapterLockSchema> | z.infer<typeof ChapterListLockSchema>> {
    const target = ChapterWorkflowTarget.parse(rawTarget);
    try {
      if (target.mode === "modify") {
        const chapter = await this.service.readChapter(target);
        return ChapterLockSchema.parse({
          kind: "chapter",
          target,
          revision: chapter.revisionToken,
          chapterNumber: chapter.order,
          plan: chapter.plan,
          detailedOutline: chapter.detailedOutline,
        });
      }
      const snapshot = await this.service.getChapterListSnapshot(target);
      if (target.mode === "create_next" && snapshot.insertAfterChapterId !== target.afterChapterId) {
        throw new TargetConflict("The target chapter list changed before it could be locked");
      }
      return ChapterListLockSchema.parse({
        kind: "chapter-list",
        target,
        chapterListHash: snapshot.expectedChapterListHash,
        insertAfterChapterId: snapshot.insertAfterChapterId,
        reservedChapterId: this.service.reserveWorkflowChapterId(),
      });
    } catch (error) {
      if (error instanceof DomainNodeError) throw error;
      if (isConflict(error)) throw new TargetConflict("The target cannot be locked safely", error);
      throw new TransientDomainError("Unable to lock the chapter target", { cause: error });
    }
  }

  async initializeWorkflowChapter(input: { lock: LockedChapterTarget; runId: string }, assertActive: () => void): Promise<{ chapterInitialized: true }> {
    assertActive();
    const lock = ChapterListLockSchema.parse(input.lock);
    await this.service.initializeWorkflowChapter({
      runId: StableId.parse(input.runId), target: lock.target,
      reservedChapterId: lock.reservedChapterId, chapterListHash: lock.chapterListHash,
      insertAfterChapterId: lock.insertAfterChapterId,
    }, assertActive);
    assertActive();
    return { chapterInitialized: true };
  }

  async saveWorkflowChapterDraft(input: WorkflowChapterWriteInput, assertActive: () => void): Promise<void> {
    const prepared = this.prepareWorkflowChapterWrite(input);
    assertActive();
    await this.service.saveWorkflowChapterDraft({
      runId: prepared.runId, target: prepared.target, nodeId: input.nodeId,
      revisionRound: input.revisionRound,
      workflowTargetKind: input.lock.kind === "chapter" ? "existing" : "created",
      content: prepared.args.content,
    }, assertActive);
    assertActive();
  }

  async saveWorkflowChapterLiveDraft(input: WorkflowChapterWriteInput, assertActive: () => void): Promise<void> {
    const prepared = this.prepareWorkflowChapterWrite(input);
    assertActive();
    await this.service.saveWorkflowChapterLiveDraft({
      runId: prepared.runId, target: prepared.target, nodeId: input.nodeId,
      revisionRound: input.revisionRound, content: prepared.args.content,
    }, assertActive);
    assertActive();
  }

  async saveWorkflowChapterProjection(input: WorkflowChapterProjectionInput): Promise<unknown> {
    if (!this.service.saveWorkflowChapterProjection) throw new TransientDomainError("Workflow chapter projection is unavailable");
    return this.service.saveWorkflowChapterProjection(input);
  }

  async writeWorkflowChapter(input: WorkflowChapterWriteInput, assertActive?: () => void): Promise<WorkflowChapterWriteReceiptValue> {
    const prepared = this.prepareWorkflowChapterWrite(input);
    try {
      const document = await this.service.writeWorkflowChapter(prepared.writeInput, assertActive);
      return this.workflowChapterReceipt(prepared, document);
    } catch (error) {
      if (error instanceof DomainNodeError) throw error;
      if (isConflict(error)) throw new TargetConflict("The workflow chapter target changed while writing", error);
      throw new TransientDomainError("Unable to write the locked workflow chapter", { cause: error });
    }
  }

  async reconcileWorkflowChapterWrite(input: ChapterWriteReconciliationInput): Promise<WorkflowChapterWriteReconciliation> {
    const prepared = this.prepareWorkflowChapterWrite(input);
    let document: ChapterDocument | undefined;
    try {
      document = await this.service.inspectWorkflowChapterWrite({
        runId: prepared.runId,
        target: prepared.target,
        workflowTargetKind: input.lock.kind === "chapter" ? "existing" : "created",
      });
    } catch (error) {
      if (isConflict(error)) return { status: "conflict", conflictCode: "workflow_chapter_identity_conflict" };
      throw new TransientDomainError("Unable to reconcile the locked workflow chapter", { cause: error });
    }
    if (!document) {
      return prepared.operation === "created" && !input.chapterInitialized
        ? { status: "not_written" }
        : { status: "conflict", conflictCode: "workflow_chapter_missing" };
    }
    if (input.chapterInitialized && prepared.operation === "created"
      && document.workId === prepared.target.workId && document.volumeId === prepared.target.volumeId
      && document.id === prepared.target.chapterId
      && document.draftStatus === "pending" && document.content === ""
      && document.plan === "" && document.detailedOutline === "") {
      return { status: "not_written" };
    }
    if (input.lock.kind === "chapter" && input.nodeId === "write" && input.revisionRound === 0
      && document.workId === prepared.target.workId
      && document.volumeId === prepared.target.volumeId
      && document.id === prepared.target.chapterId
      && document.revisionToken === input.lock.revision
      && document.plan === input.lock.plan
      && document.detailedOutline === input.lock.detailedOutline) {
      return { status: "not_written" };
    }
    // A revision that has not crossed its domain commit still contains the
    // previous receipt's exact content revision. Only that proof permits retry;
    // any other content is an external edit, not an unfinished workflow write.
    if (prepared.operation === "replaced" && input.previous !== undefined && input.previousArgs !== undefined
      && document.workId === prepared.target.workId
      && document.volumeId === prepared.target.volumeId
      && document.id === prepared.target.chapterId
      && document.revisionToken === input.previous.revision
      && hash(document.content) === input.previous.contentHash
      && document.content === input.previousArgs.content
      && document.plan === input.previousArgs.plan
      && document.detailedOutline === input.previousArgs.detailedOutline
      && (document.content !== prepared.args.content || document.plan !== prepared.args.plan || document.detailedOutline !== prepared.args.detailedOutline)) {
      return { status: "not_written" };
    }
    try {
      return { status: "written", receipt: this.workflowChapterReceipt(prepared, document) };
    } catch (error) {
      if (error instanceof VerificationFailed) {
        return { status: "conflict", conflictCode: "workflow_chapter_content_mismatch" };
      }
      throw error;
    }
  }

  async queryMemory(input: { lock: LockedChapterTarget; query: MemoryQueryInput }): Promise<MemoryGraph> {
    const lock = LockedChapterTargetSchema.parse(input.lock);
    const upperBound = lock.kind === "chapter" ? lock.chapterNumber : await this.currentChapterUpperBound(lock);
    try {
      const graph = await this.service.queryMemoryBounded({
        query: clampMemoryQuery(input.query, lock.target.workId, upperBound),
        maximumChapter: upperBound,
      });
      if (invalidMemoryGraph(graph, lock.target.workId, upperBound)) {
        throw new MemoryEvidenceInvalid("Memory query returned evidence outside the locked work boundary");
      }
      return graph;
    } catch (error) {
      if (error instanceof DomainNodeError) throw error;
      if (error instanceof JizuoError && error.code === "validation_error") {
        throw new MemoryEvidenceInvalid("Memory query is invalid for the locked target", error);
      }
      throw new TransientDomainError("Unable to query chapter memory", { cause: error });
    }
  }

  private prepareWorkflowChapterWrite(input: WorkflowChapterWriteInput): Readonly<{
    runId: string;
    operation: "created" | "replaced";
    args: WorkflowChapterWriteArgsValue;
    target: { workId: string; volumeId: string; chapterId: string };
    writeInput: WorkflowChapterCreateInput | WorkflowChapterReplaceInput;
  }> {
    const runId = StableId.parse(input.runId);
    const args = WorkflowChapterWriteArgs.parse(input.args);
    if (!Number.isInteger(input.revisionRound) || input.revisionRound < 0 || input.revisionRound > 10) {
      throw new TargetConflict("The workflow chapter revision round is invalid");
    }
    if (input.lock.kind === "chapter") {
      const lock = ChapterLockSchema.parse(input.lock);
      if (input.nodeId === "write") {
        if (input.revisionRound !== 0 || input.previous !== undefined) {
          throw new TargetConflict("The initial workflow write cannot replace a prior receipt");
        }
        return {
          runId,
          operation: "replaced",
          args,
          target: lock.target,
          writeInput: {
            operation: "replace",
            runId,
            target: lock.target,
            expectedRevision: lock.revision,
            expectedPlan: lock.plan,
            expectedDetailedOutline: lock.detailedOutline,
            revisionRound: 0,
            workflowEffectId: input.nodeId,
            workflowTargetKind: "existing",
            ...args,
          },
        };
      }
      if (!["revise", "continuity-revise", "style-revise", "ai-trace-revise"].includes(input.nodeId)
        || input.revisionRound < 1 || input.previous === undefined || input.previousArgs === undefined) {
        throw new TargetConflict("A workflow revision requires its immediately prior receipt");
      }
      const previous = WorkflowChapterWriteReceipt.parse(input.previous);
      const previousArgs = WorkflowChapterWriteArgs.parse(input.previousArgs);
      if (
        previous.workId !== lock.target.workId
        || previous.volumeId !== lock.target.volumeId
        || previous.chapterId !== lock.target.chapterId
        || hash(previousArgs.content) !== previous.contentHash
        || previous.revision !== previous.contentHash
      ) {
        throw new TargetConflict("A workflow revision cannot change its locked existing chapter target");
      }
      return {
        runId,
        operation: "replaced",
        args,
        target: lock.target,
        writeInput: {
          operation: "replace",
          runId,
          target: lock.target,
          expectedRevision: previous.revision,
          revisionRound: input.revisionRound,
          workflowEffectId: input.nodeId,
          ...(input.previousEffect === undefined ? {} : {
            previousWorkflowEffectId: input.previousEffect.nodeId,
            previousWorkflowRevisionRound: input.previousEffect.revisionRound,
          }),
          workflowTargetKind: "existing",
          expectedPlan: previousArgs.plan,
          expectedDetailedOutline: previousArgs.detailedOutline,
          ...args,
        },
      };
    }
    const lock = ChapterListLockSchema.parse(input.lock);
    if (input.nodeId === "write") {
      if (input.revisionRound !== 0 || input.previous !== undefined) {
        throw new TargetConflict("The initial workflow write cannot replace a prior receipt");
      }
      return {
        runId,
        operation: "created",
        args,
        target: { workId: lock.target.workId, volumeId: lock.target.volumeId, chapterId: lock.reservedChapterId },
        writeInput: {
          operation: "create",
          ...(input.chapterInitialized ? { requireInitialized: true } : {}),
          runId,
          target: lock.target,
          reservedChapterId: lock.reservedChapterId,
          chapterListHash: lock.chapterListHash,
          insertAfterChapterId: lock.insertAfterChapterId,
          ...args,
        },
      };
    }
    if (!["revise", "continuity-revise", "style-revise", "ai-trace-revise"].includes(input.nodeId) || input.revisionRound < 1 || input.previous === undefined) {
      throw new TargetConflict("A workflow revision requires its immediately prior receipt");
    }
    const previous = WorkflowChapterWriteReceipt.parse(input.previous);
    if (!input.previousArgs) throw new TargetConflict("A workflow revision requires the prior candidate artifact proof");
    const previousArgs = WorkflowChapterWriteArgs.parse(input.previousArgs);
    if (
      previous.workId !== lock.target.workId
      || previous.volumeId !== lock.target.volumeId
      || previous.chapterId !== lock.reservedChapterId
      || hash(previousArgs.content) !== previous.contentHash
      || previous.revision !== previous.contentHash
    ) {
      throw new TargetConflict("A workflow revision cannot change its reserved chapter target");
    }
    return {
      runId,
      operation: "replaced",
      args,
      target: { workId: previous.workId, volumeId: previous.volumeId, chapterId: previous.chapterId },
      writeInput: {
        operation: "replace",
        runId,
        target: { workId: previous.workId, volumeId: previous.volumeId, chapterId: previous.chapterId },
        expectedRevision: previous.revision,
        revisionRound: input.revisionRound,
        workflowEffectId: input.nodeId,
        ...(input.previousEffect === undefined ? {} : {
          previousWorkflowEffectId: input.previousEffect.nodeId,
          previousWorkflowRevisionRound: input.previousEffect.revisionRound,
        }),
        workflowTargetKind: "created",
        expectedPlan: previousArgs.plan,
        expectedDetailedOutline: previousArgs.detailedOutline,
        ...args,
      },
    };
  }

  private workflowChapterReceipt(
    prepared: Readonly<{
      operation: "created" | "replaced";
      args: WorkflowChapterWriteArgsValue;
      target: { workId: string; volumeId: string; chapterId: string };
    }>,
    document: ChapterDocument,
  ): WorkflowChapterWriteReceiptValue {
    const contentHash = hash(document.content);
    if (
      document.workId !== prepared.target.workId
      || document.volumeId !== prepared.target.volumeId
      || document.id !== prepared.target.chapterId
      || document.content !== prepared.args.content
      || document.plan !== prepared.args.plan
      || document.detailedOutline !== prepared.args.detailedOutline
    ) {
      throw new VerificationFailed("The workflow chapter reread does not match the fixed target and candidate");
    }
    return WorkflowChapterWriteReceipt.parse({
      operation: prepared.operation,
      workId: document.workId,
      volumeId: document.volumeId,
      chapterId: document.id,
      chapterNumber: document.order,
      revision: document.revisionToken,
      contentHash,
    });
  }

  async createChapterProposal(input: {
    runId: string;
    lock: LockedChapterTarget;
    candidate: z.input<typeof CandidateSchema>;
    review: z.input<typeof ReviewSchema>;
  }): Promise<ChapterProposalReference> {
    const lock = LockedChapterTargetSchema.parse(input.lock);
    const candidate = CandidateSchema.parse(input.candidate);
    const review = ReviewSchema.parse(input.review);
    if (hash(candidate.content) !== candidate.candidateHash || review.candidateHash !== candidate.candidateHash) {
      throw new ProposalConflict("Proposal requires the final reviewed candidate hash");
    }
    try {
      if (lock.kind === "chapter") {
        const current = await this.service.readChapter(lock.target);
        if (current.revisionToken !== lock.revision) throw new TargetConflict("The locked chapter revision changed");
        const proposal = await this.service.createProposal({ ...lock.target, expectedRevision: lock.revision, nextContent: candidate.content, workflowRunId: input.runId });
        if (proposal.nextHash !== candidate.candidateHash || proposal.expectedRevision !== lock.revision || proposal.status !== "pending") {
          throw new ProposalConflict("Domain returned a proposal that does not match the locked candidate");
        }
        return ProposalReferenceSchema.parse({ proposalId: proposal.id, kind: "chapter_change", target: lock.target, candidateHash: candidate.candidateHash });
      }
      const snapshot = await this.service.getChapterListSnapshot(lock.target);
      if (snapshot.expectedChapterListHash !== lock.chapterListHash || snapshot.insertAfterChapterId !== lock.insertAfterChapterId) {
        throw new TargetConflict("The locked chapter list changed");
      }
      const proposal = await this.service.createChapterProposal({
        target: { workId: lock.target.workId, volumeId: lock.target.volumeId },
        title: lock.target.title,
        nextContent: candidate.content,
        expectedChapterListHash: lock.chapterListHash,
        insertAfterChapterId: lock.insertAfterChapterId,
        workflowRunId: input.runId,
      });
      if (proposal.nextHash !== candidate.candidateHash || proposal.expectedChapterListHash !== lock.chapterListHash || proposal.insertAfterChapterId !== lock.insertAfterChapterId || proposal.status !== "pending") {
        throw new ProposalConflict("Domain returned a proposal that does not match the locked chapter list");
      }
      return ProposalReferenceSchema.parse({ proposalId: proposal.id, kind: "chapter_create", target: lock.target, candidateHash: candidate.candidateHash });
    } catch (error) {
      if (error instanceof DomainNodeError) throw error;
      if (isConflict(error)) throw new TargetConflict("The target changed while creating its proposal", error);
      throw new TransientDomainError("Unable to create the chapter proposal", { cause: error });
    }
  }

  async applyChapterProposal(input: { lock: LockedChapterTarget; proposal: ChapterProposalReference; approval: z.input<typeof ApprovalSchema> }): Promise<AppliedChapter> {
    const lock = LockedChapterTargetSchema.parse(input.lock);
    const proposal = ProposalReferenceSchema.parse(input.proposal);
    const approval = ApprovalSchema.parse(input.approval);
    if (proposal.proposalId !== approval.proposalId || proposal.target.mode !== lock.target.mode || proposal.target.workId !== lock.target.workId || proposal.target.volumeId !== lock.target.volumeId) {
      throw new ProposalConflict("Approval does not authorize this proposal and target");
    }
    if (lock.kind === "chapter" && (proposal.target.mode !== "modify" || proposal.target.chapterId !== lock.target.chapterId)) {
      throw new ProposalConflict("Proposal does not match the locked chapter");
    }
    try {
      const applied = compactChapter(proposal.proposalId, await this.service.applyProposal({ proposalId: proposal.proposalId, token: approval.token }));
      if (applied.contentHash !== proposal.candidateHash) throw new VerificationFailed("Domain apply result does not match the approved candidate");
      return applied;
    } catch (error) {
      if (error instanceof DomainNodeError) throw error;
      if (isConflict(error)) throw new ProposalConflict("Proposal could not be applied safely", error);
      throw new TransientDomainError("Unable to apply the approved chapter proposal", { cause: error });
    }
  }

  async verifyAppliedChapter(rawApplied: unknown): Promise<AppliedChapter> {
    const applied = AppliedChapterSchema.parse(rawApplied);
    try {
      const current = await this.service.readChapter(applied);
      if (
        current.workId !== applied.workId
        || current.volumeId !== applied.volumeId
        || current.id !== applied.chapterId
        || current.order !== applied.chapterNumber
        || current.revisionToken !== applied.appliedRevision
        || hash(current.content) !== applied.contentHash
      ) {
        throw new VerificationFailed("Reread chapter does not match the applied revision");
      }
      return applied;
    } catch (error) {
      if (error instanceof DomainNodeError) throw error;
      throw new VerificationFailed("Unable to verify the applied chapter", error);
    }
  }

  /**
   * Read-only repair for the narrow crash window after domain apply returned
   * but before the workflow marker committed. It never calls applyProposal.
   */
  async reconcileAppliedProposal(input: {
    target: unknown;
    proposalId: string;
    candidateHash: string;
  }): Promise<AppliedChapter> {
    const target = ChapterWorkflowTarget.parse(input.target);
    const proposalId = z.string().trim().min(1).max(128).parse(input.proposalId);
    const candidateHash = Hash.parse(input.candidateHash);
    try {
      const proposal = await this.service.inspectProposalApplication(proposalId);
      if (proposal.id !== proposalId || proposal.status !== "applied" || proposal.nextHash !== candidateHash) {
        throw new ProposalConflict("Applied proposal evidence does not match the approved candidate");
      }
      if (proposal.target.workId !== target.workId || proposal.target.volumeId !== target.volumeId) {
        throw new ProposalConflict("Applied proposal belongs to another workflow target");
      }

      let chapterId: string;
      let expectedOrder: number;
      let expectedTitle: string | undefined;
      if (proposal.kind === "chapter_change") {
        if (target.mode !== "modify" || proposal.target.chapterId !== target.chapterId) {
          throw new ProposalConflict("Applied change proposal does not match the locked chapter");
        }
        chapterId = proposal.target.chapterId;
        expectedOrder = (await this.service.readChapter(target)).order;
      } else {
        if (target.mode === "modify") throw new ProposalConflict("Applied creation proposal does not match a modify target");
        if (proposal.title !== target.title) throw new ProposalConflict("Applied creation proposal title does not match the locked target");
        chapterId = proposal.reservedChapterId;
        expectedTitle = proposal.title;
        const anchor = proposal.insertAfterChapterId;
        if (target.mode === "create_next" && anchor !== target.afterChapterId) {
          throw new ProposalConflict("Applied creation proposal does not match the locked insert anchor");
        }
        expectedOrder = anchor === null
          ? 1
          : (await this.service.readChapter({ workId: target.workId, volumeId: target.volumeId, chapterId: anchor })).order + 1;
      }

      const current = await this.service.readChapter({ workId: target.workId, volumeId: target.volumeId, chapterId });
      const applied = compactChapter(proposalId, current);
      if (
        current.workId !== target.workId
        || current.volumeId !== target.volumeId
        || current.id !== chapterId
        || current.order !== expectedOrder
        || (expectedTitle !== undefined && current.title !== expectedTitle)
        || current.revisionToken !== candidateHash
        || applied.contentHash !== candidateHash
      ) {
        throw new VerificationFailed("Reread chapter cannot prove the approved proposal was applied");
      }
      return applied;
    } catch (error) {
      if (error instanceof DomainNodeError) throw error;
      throw new VerificationFailed("Unable to prove the approved proposal application", error);
    }
  }

  async saveChapterMemory(input: { verified: AppliedChapter; candidate: MemoryEpisodeCandidateInput }): Promise<{ episodeKey: string; status: "committed" | "suggested" }> {
    const verified = AppliedChapterSchema.parse(input.verified);
    let candidate: z.output<typeof MemoryEpisodeCandidate>;
    try {
      candidate = MemoryEpisodeCandidate.parse(input.candidate);
    } catch (error) {
      throw new MemoryEvidenceInvalid("Memory candidate is invalid", error);
    }
    if (
      candidate.source !== "chapter"
      || candidate.workId !== verified.workId
      || candidate.chapterId !== verified.chapterId
      || candidate.chapterNumber !== verified.chapterNumber
      || candidate.contentHash !== verified.appliedRevision
      || candidate.contentHash !== verified.contentHash
    ) {
      throw new MemoryEvidenceInvalid("Memory candidate is not bound to the verified chapter");
    }
    const key = `${verified.workId}/${verified.chapterId}/${verified.appliedRevision}/${evidenceHash(candidate)}`;
    const existing = this.#memorySaves.get(key);
    if (existing) return existing;
    const operation = this.persistMemory(verified, candidate, key);
    this.#memorySaves.set(key, operation);
    return operation;
  }

  private async currentChapterUpperBound(lock: Extract<LockedChapterTarget, { kind: "chapter-list" }>): Promise<number> {
    // A new chapter may only see memory through the chapter list locked before it.
    if (lock.insertAfterChapterId === null) return 1;
    try {
      const chapter = await this.service.readChapter({ workId: lock.target.workId, volumeId: lock.target.volumeId, chapterId: lock.insertAfterChapterId });
      return chapter.order;
    } catch (error) {
      if (isConflict(error) || error instanceof JizuoError) throw new TargetConflict("The chapter-list memory boundary is no longer readable", error);
      throw new TransientDomainError("Unable to resolve the chapter-list memory boundary", { cause: error });
    }
  }

  private async persistMemory(
    verified: AppliedChapter,
    candidate: z.output<typeof MemoryEpisodeCandidate>,
    key: string,
  ): Promise<{ episodeKey: string; status: "committed" | "suggested" }> {
    try {
      const result = await this.service.saveChapterMemory({ volumeId: verified.volumeId, candidate });
      return { episodeKey: result.episodeKey, status: result.status };
    } catch (error) {
      this.#memorySaves.delete(key);
      if (error instanceof JizuoError && error.code === "validation_error") {
        throw new MemoryEvidenceInvalid("记忆证据未通过校验，必须使用当前章节的连续原文。正文已保留，可在对话中输入“继续保存记忆”重新提取。", error);
      }
      if (error instanceof JizuoError && error.code === "revision_conflict") {
        throw new MemoryRevisionConflict("章节正文已变化，已停止保存旧版本记忆。请核对当前正文后再启动工作流；现有文件未修改。", error);
      }
      throw new TransientDomainError("Chapter was applied but memory save is pending", { cause: error, memoryPending: true });
    }
  }
}
