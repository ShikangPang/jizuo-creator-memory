import { createHash } from "node:crypto";

import {
  StableId,
  WorkflowChapterWriteArgs,
  WorkflowChapterWriteReceipt,
  type WorkflowChapterWriteArgs as WorkflowChapterWriteArgsValue,
  type WorkflowChapterWriteReceipt as WorkflowChapterWriteReceiptValue,
} from "@jizuo/contracts";
import {
  WORKFLOW_RUN_LEASE_TTL_MS,
  WorkflowRunError,
  type ChapterWriteEffect,
  type WorkflowArtifactHandle,
  type WorkflowArtifactKind,
  type ChapterWriteNodeId,
  type WorkflowRepository,
} from "@jizuo/workflow-runtime";
import { z } from "zod";

import {
  TargetConflict,
  type ChapterWriteReconciliationInput,
  type JizuoDomainNodeAdapter,
  type LockedChapterTarget,
} from "./domainAdapter.ts";

const CandidateArtifact = WorkflowChapterWriteArgs.extend({
  candidateHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export interface AgentRunnerArtifactStore {
  write(input: Readonly<{
    runId: string;
    kind: WorkflowArtifactKind;
    contents: string | Uint8Array;
  }>): Promise<WorkflowArtifactHandle>;
  read(artifactRef: string): Promise<Buffer>;
}

export type WorkflowReviewStageId = "continuity" | "style" | "ai-trace";
export type WorkflowWriteOperation = Readonly<{
  effectId: ChapterWriteNodeId;
  operation: "write" | "revise";
  stage?: WorkflowReviewStageId;
  revisionRound: number;
}>;

export interface WorkflowChapterWriteGrant {
  readonly chapterInitialized?: boolean;
  readonly runId: string;
  readonly nodeId: ChapterWriteNodeId;
  readonly revisionRound: number;
  /** New v2 grants carry the complete code-owned operation; v1 grants remain readable. */
  readonly operation?: WorkflowWriteOperation;
  readonly previousEffect?: Readonly<{ nodeId: ChapterWriteNodeId; revisionRound: number }>;
  readonly lock: LockedChapterTarget;
  readonly previous?: WorkflowChapterWriteReceiptValue;
  readonly artifacts: AgentRunnerArtifactStore;
  /** Runtime-only lease fence. It is never serialized into model arguments or artifacts. */
  readonly lease: Readonly<{ ownerToken: string; ownerPid: number }>;
}

export interface RecoveredChapterWrite {
  readonly args: WorkflowChapterWriteArgsValue;
  readonly receipt: WorkflowChapterWriteReceiptValue;
  readonly candidateRef: string;
  readonly candidateHash: string;
  readonly candidateArtifact: WorkflowArtifactHandle;
  readonly receiptArtifact: WorkflowArtifactHandle;
}

/** Deliberately identifier-free result returned across the model tool boundary. */
export interface WorkflowChapterWriteToolResult {
  readonly status: "written";
}

type CapabilityCode =
  | "workflow_write_capability_missing"
  | "workflow_write_capability_consumed"
  | "workflow_write_capability_conflict"
  | "workflow_write_capability_invalid";

export class WorkflowChapterWriteCapabilityError extends Error {
  readonly name = "WorkflowChapterWriteCapabilityError";

  constructor(readonly code: CapabilityCode, message: string, readonly cause?: unknown) {
    super(message);
  }
}

type CapabilityRecord = {
  readonly grant: WorkflowChapterWriteGrant;
  status: "active" | "executing" | "consumed" | "failed" | "revoked";
  failure?: unknown;
  result?: RecoveredChapterWrite;
  resultTaken?: boolean;
  signal?: AbortSignal;
  detachAbort?: () => void;
  liveDraftTail: Promise<void>;
};

type PreparedGrant = Readonly<{
  input: ChapterWriteReconciliationInput;
  operation: "create" | "replace";
  chapterId: string;
  expectedRevision?: string;
}>;

const stageEffectIds = ["continuity-revise", "style-revise", "ai-trace-revise"] as const;

function operationFor(grant: WorkflowChapterWriteGrant): WorkflowWriteOperation {
  const inferredStage = stageEffectIds.find((effectId) => effectId === grant.nodeId)?.replace(/-revise$/, "") as WorkflowReviewStageId | undefined;
  const inferred: WorkflowWriteOperation = {
    effectId: grant.nodeId,
    operation: grant.nodeId === "write" ? "write" : "revise",
    ...(inferredStage ? { stage: inferredStage } : {}),
    revisionRound: grant.revisionRound,
  };
  if (!grant.operation) return inferred;
  if (grant.operation.effectId !== inferred.effectId || grant.operation.operation !== inferred.operation
    || grant.operation.revisionRound !== inferred.revisionRound || grant.operation.stage !== inferred.stage) {
    throw capabilityError("workflow_write_capability_invalid", "Workflow write operation disagrees with its durable effect identity");
  }
  return grant.operation;
}

type ChapterWriteRepository = Pick<WorkflowRepository,
  "claimChapterWrite" | "getChapterWrite" | "completeChapterWrite" | "markChapterWriteConflict" | "assertAndRenewRunLease" | "getControlIntent">;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function capabilityError(code: CapabilityCode, message: string, cause?: unknown): WorkflowChapterWriteCapabilityError {
  return new WorkflowChapterWriteCapabilityError(code, message, cause);
}

/** One-shot, child-session-scoped authority for one frozen workflow chapter effect. */
export class WorkflowChapterWriteCapabilityBroker {
  readonly #records = new Map<string, CapabilityRecord>();
  readonly #domain: Pick<JizuoDomainNodeAdapter, "writeWorkflowChapter" | "reconcileWorkflowChapterWrite" | "saveWorkflowChapterDraft">
    & Partial<Pick<JizuoDomainNodeAdapter, "saveWorkflowChapterLiveDraft">>;
  readonly #repository: ChapterWriteRepository;

  constructor(input: Readonly<{
    domain: Pick<JizuoDomainNodeAdapter, "writeWorkflowChapter" | "reconcileWorkflowChapterWrite" | "saveWorkflowChapterDraft">
      & Partial<Pick<JizuoDomainNodeAdapter, "saveWorkflowChapterLiveDraft">>;
    repository: ChapterWriteRepository;
  }>) {
    this.#domain = input.domain;
    this.#repository = input.repository;
  }

  grant(sessionId: string, grant: WorkflowChapterWriteGrant, signal?: AbortSignal): void {
    StableId.parse(sessionId);
    this.validateGrant(grant);
    if (this.#records.has(sessionId)) {
      throw capabilityError("workflow_write_capability_consumed", "A child session cannot receive a second workflow chapter target");
    }
    const record: CapabilityRecord = {
      grant: Object.freeze({
        ...grant,
        lock: structuredClone(grant.lock),
        ...(grant.operation === undefined ? {} : { operation: Object.freeze({ ...grant.operation }) }),
        ...(grant.previousEffect === undefined ? {} : { previousEffect: Object.freeze({ ...grant.previousEffect }) }),
        ...(grant.previous === undefined ? {} : { previous: structuredClone(grant.previous) }),
        lease: Object.freeze({ ...grant.lease }),
      }),
      status: "active",
      liveDraftTail: Promise.resolve(),
      ...(signal === undefined ? {} : { signal }),
    };
    this.#records.set(sessionId, record);
    if (signal) {
      const abort = () => this.revoke(sessionId);
      signal.addEventListener("abort", abort, { once: true });
      record.detachAbort = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) abort();
    }
  }

  revoke(sessionId: string): void {
    const record = this.#records.get(sessionId);
    if (record) {
      record.status = "revoked";
      record.detachAbort?.();
    }
  }

  async execute(sessionId: string, rawArgs: unknown): Promise<WorkflowChapterWriteToolResult> {
    const record = this.#records.get(sessionId);
    if (!record || record.status === "revoked") {
      throw capabilityError("workflow_write_capability_missing", "No workflow chapter write is authorized for this child session");
    }
    if (record.status === "failed") throw record.failure;
    if (record.status !== "active") {
      throw capabilityError("workflow_write_capability_consumed", "This workflow chapter write capability has already been used");
    }
    record.status = "executing";
    try {
      await record.liveDraftTail;
      this.assertExecuting(record);
      const args = this.parseArgs(rawArgs);
      const prepared = await this.prepare(record.grant, args);
      const candidateHash = sha256(args.content);
      const candidateContents = JSON.stringify({ ...args, candidateHash });
      const candidate = await record.grant.artifacts.write({
        runId: record.grant.runId,
        kind: "candidate",
        contents: candidateContents,
      });
      this.assertExecuting(record);
      const effect = this.claim(record.grant, prepared, candidateHash, candidate.artifactRef);
      const recovered = await this.finish(record.grant, prepared, args, effect, candidate, () => this.assertExecuting(record));
      record.result = recovered;
      record.status = "consumed";
      return { status: "written" };
    } catch (error) {
      if (record.status === "executing") {
        record.status = "failed";
        record.failure = error;
        // Before a durable claim, no chapter write can have started. Permit
        // corrected arguments/storage retries without granting a second effect.
        // After a claim, only host recovery may reconcile the frozen candidate.
        try {
          if (!this.#repository.getChapterWrite(record.grant.runId, record.grant.nodeId, record.grant.revisionRound)) {
            record.status = "active";
          }
        } catch {
          // If claim state cannot be read, keep the grant closed and the cause.
        }
      }
      throw error;
    }
  }

  /** Best-effort projection of public writer prose into an initialized empty chapter. */
  async saveLiveDraft(sessionId: string, content: string): Promise<void> {
    const record = this.#records.get(sessionId);
    if (!record || record.status !== "active" || record.signal?.aborted) return;
    if (record.grant.lock.kind !== "chapter-list") return;
    if (!record.grant.chapterInitialized || record.grant.nodeId !== "write" || record.grant.revisionRound !== 0) return;
    const task = async () => {
      if (record.status !== "active" || record.signal?.aborted) return;
      const guard = () => {
        if (record.status !== "active" || record.signal?.aborted) {
          throw new WorkflowRunError("cancelled", "Workflow live draft cancelled");
        }
        this.assertGrantActive(record.grant);
      };
      try {
        guard();
        if (this.#domain.saveWorkflowChapterLiveDraft === undefined) return;
        await this.#domain.saveWorkflowChapterLiveDraft({
          chapterInitialized: true,
          runId: record.grant.runId,
          nodeId: record.grant.nodeId,
          revisionRound: record.grant.revisionRound,
          lock: record.grant.lock,
          args: { content, plan: "", detailedOutline: "" },
        }, guard);
      } catch {
        // This is a visibility projection only. Formal chapter authority stays
        // with execute(), so a preview IO failure must not consume the write.
      }
    };
    record.liveDraftTail = record.liveDraftTail.then(task, task);
    await record.liveDraftTail;
  }

  /**
   * Transfers the completed internal result to the workflow coordinator once.
   * Reading it neither restores nor creates authority for another write.
   */
  takeResult(sessionId: string): RecoveredChapterWrite | undefined {
    const record = this.#records.get(sessionId);
    if (!record || record.status !== "consumed" || !record.result || record.resultTaken) return undefined;
    record.resultTaken = true;
    return record.result;
  }

  /** A continuation may ask the same child to finish only before a durable claim. */
  canRetry(sessionId: string): boolean {
    const record = this.#records.get(sessionId);
    if (!record || record.status !== "active" || record.signal?.aborted) return false;
    this.assertGrantActive(record.grant);
    return this.#repository.getChapterWrite(record.grant.runId, record.grant.nodeId, record.grant.revisionRound) === undefined;
  }

  async recover(grant: WorkflowChapterWriteGrant, assertActive: () => void): Promise<RecoveredChapterWrite | undefined> {
    this.validateGrant(grant);
    const guard = () => { assertActive(); this.assertGrantActive(grant); };
    guard();
    const effect = this.#repository.getChapterWrite(grant.runId, grant.nodeId, grant.revisionRound);
    if (!effect) return undefined;
    const candidate = await this.readCandidate(grant, effect);
    const prepared = await this.prepare(grant, candidate.args);
    this.assertMatchingEffect(effect, prepared, sha256(candidate.args.content), effect.candidateRef);
    guard();
    const recovered = await this.finish(grant, prepared, candidate.args, effect, candidate.artifact, guard);
    guard();
    return recovered;
  }

  private parseArgs(rawArgs: unknown): WorkflowChapterWriteArgsValue {
    const parsed = WorkflowChapterWriteArgs.safeParse(rawArgs);
    if (!parsed.success) {
      throw capabilityError("workflow_write_capability_invalid", "Workflow chapter write arguments are invalid", parsed.error);
    }
    return parsed.data;
  }

  private validateGrant(grant: WorkflowChapterWriteGrant): void {
    StableId.parse(grant.runId);
    if (!["write", "revise", ...stageEffectIds].includes(grant.nodeId as never) || !Number.isInteger(grant.revisionRound) || grant.revisionRound < 0 || grant.revisionRound > 10) {
      throw capabilityError("workflow_write_capability_invalid", "Workflow chapter write grant has an invalid node identity");
    }
    const operation = operationFor(grant);
    if (operation.operation === "write" && operation.revisionRound !== 0 || operation.operation === "revise" && operation.revisionRound < 1) {
      throw capabilityError("workflow_write_capability_invalid", "Workflow chapter write grant has an invalid operation round");
    }
    if (grant.previousEffect) {
      if (!["write", "revise", ...stageEffectIds].includes(grant.previousEffect.nodeId as never)
        || !Number.isInteger(grant.previousEffect.revisionRound) || grant.previousEffect.revisionRound < 0 || grant.previousEffect.revisionRound > 10) {
        throw capabilityError("workflow_write_capability_invalid", "Workflow chapter write grant has an invalid previous effect identity");
      }
    }
    if (typeof grant.lease.ownerToken !== "string" || grant.lease.ownerToken.length === 0 || !Number.isInteger(grant.lease.ownerPid) || grant.lease.ownerPid < 1) {
      throw capabilityError("workflow_write_capability_invalid", "Workflow chapter write grant requires the active hidden lease");
    }
    if (typeof grant.artifacts?.write !== "function" || typeof grant.artifacts?.read !== "function") {
      throw capabilityError("workflow_write_capability_invalid", "Workflow chapter write grant requires the shared artifact store");
    }
  }

  private async prepare(grant: WorkflowChapterWriteGrant, args: WorkflowChapterWriteArgsValue): Promise<PreparedGrant> {
    const input: ChapterWriteReconciliationInput = {
      lock: grant.lock,
      runId: grant.runId,
      nodeId: grant.nodeId,
      revisionRound: grant.revisionRound,
      ...(grant.chapterInitialized === undefined ? {} : { chapterInitialized: grant.chapterInitialized }),
      ...(grant.previousEffect === undefined ? {} : { previousEffect: grant.previousEffect }),
      ...(grant.previous === undefined ? {} : { previous: grant.previous }),
      args,
    };
    const operation = operationFor(grant);
    if (operation.operation === "write") {
      if (grant.revisionRound !== 0 || grant.previous !== undefined) {
        throw capabilityError("workflow_write_capability_invalid", "Initial workflow writes cannot replace a prior receipt");
      }
      if (grant.lock.kind === "chapter") {
        return {
          input,
          operation: "replace",
          chapterId: grant.lock.target.chapterId,
          expectedRevision: grant.lock.revision,
        };
      }
      const reservedChapterId = StableId.parse(grant.lock.reservedChapterId);
      return { input, operation: "create", chapterId: reservedChapterId };
    }
    if (grant.revisionRound < 1 || grant.previous === undefined) {
      throw capabilityError("workflow_write_capability_invalid", "Workflow revisions require the prior write receipt");
    }
    const previous = WorkflowChapterWriteReceipt.parse(grant.previous);
    const lockedChapterId = grant.lock.kind === "chapter"
      ? grant.lock.target.chapterId
      : StableId.parse(grant.lock.reservedChapterId);
    if (previous.workId !== grant.lock.target.workId
      || previous.volumeId !== grant.lock.target.volumeId
      || previous.chapterId !== lockedChapterId) {
      throw capabilityError("workflow_write_capability_conflict", "Workflow revision receipt changes the frozen chapter target");
    }
    const previousEffect = grant.previousEffect ?? {
      nodeId: grant.revisionRound === 1 ? "write" as const : "revise" as const,
      revisionRound: grant.revisionRound - 1,
    };
    if (operation.stage && !grant.previousEffect) {
      throw capabilityError("workflow_write_capability_invalid", "Serial workflow revisions require the explicit preceding durable effect");
    }
    const priorEffect = this.#repository.getChapterWrite(grant.runId, previousEffect.nodeId, previousEffect.revisionRound);
    if (!priorEffect || priorEffect.status !== "completed" || !priorEffect.receiptRef
      || priorEffect.chapterId !== previous.chapterId || priorEffect.appliedRevision !== previous.revision
      || priorEffect.candidateHash !== previous.contentHash) {
      throw capabilityError("workflow_write_capability_conflict", "Workflow revision requires the preceding durable write proof");
    }
    const priorCandidate = await this.readCandidate(grant, priorEffect);
    const priorReceipt = WorkflowChapterWriteReceipt.parse(JSON.parse((await grant.artifacts.read(priorEffect.receiptRef)).toString("utf8")));
    if (JSON.stringify(priorReceipt) !== JSON.stringify(previous)) {
      throw capabilityError("workflow_write_capability_conflict", "Workflow revision receipt does not match the preceding durable write");
    }
    return { input: { ...input, previousArgs: priorCandidate.args }, operation: "replace", chapterId: previous.chapterId, expectedRevision: previous.revision };
  }

  private claim(
    grant: WorkflowChapterWriteGrant,
    prepared: PreparedGrant,
    candidateHash: string,
    candidateRef: string,
  ): ChapterWriteEffect {
    const existing = this.#repository.getChapterWrite(grant.runId, grant.nodeId, grant.revisionRound);
    if (existing) {
      try {
        this.assertMatchingEffect(existing, prepared, candidateHash, candidateRef);
      } catch (error) {
        if (existing.status === "claimed") this.markConflict(grant, existing.candidateHash, "workflow_write_claim_mismatch");
        throw error;
      }
      return existing;
    }
    try {
      return this.#repository.claimChapterWrite({
        runId: grant.runId,
        nodeId: grant.nodeId,
        revisionRound: grant.revisionRound,
        candidateHash,
        candidateRef,
        ...grant.lease,
        ...(prepared.operation === "create"
          ? { operation: "create" as const, reservedChapterId: prepared.chapterId }
          : {
              operation: "replace" as const,
              chapterId: prepared.chapterId,
              expectedRevision: prepared.expectedRevision!,
            }),
      });
    } catch (error) {
      throw capabilityError("workflow_write_capability_conflict", "Unable to persist the fixed workflow chapter write claim", error);
    }
  }

  private async finish(
    grant: WorkflowChapterWriteGrant,
    prepared: PreparedGrant,
    args: WorkflowChapterWriteArgsValue,
    effect: ChapterWriteEffect,
    candidateArtifact: WorkflowArtifactHandle,
    assertActive: () => void,
  ): Promise<RecoveredChapterWrite> {
    assertActive();
    if (grant.chapterInitialized) {
      await this.#domain.saveWorkflowChapterDraft(prepared.input, assertActive);
      assertActive();
    }
    if (effect.status === "conflict") {
      throw capabilityError("workflow_write_capability_conflict", `Workflow chapter write is conflicted: ${effect.conflictCode ?? "unknown"}`);
    }
    if (effect.status === "completed") return this.readCompletedReceipt(grant, prepared, args, effect, candidateArtifact);

    let outcome = await this.#domain.reconcileWorkflowChapterWrite(prepared.input);
    assertActive();
    if (outcome.status === "not_written") {
      try {
        const receipt = await this.#domain.writeWorkflowChapter(prepared.input, assertActive);
        outcome = { status: "written", receipt };
      } catch (writeError) {
        const reconciled = await this.#domain.reconcileWorkflowChapterWrite(prepared.input);
        assertActive();
        if (reconciled.status === "not_written") throw writeError;
        outcome = reconciled;
      }
    }
    if (outcome.status === "conflict") {
      this.markConflict(grant, effect.candidateHash, outcome.conflictCode);
      throw capabilityError("workflow_write_capability_conflict", `Workflow chapter reconciliation failed: ${outcome.conflictCode}`);
    }
    this.assertReceipt(prepared, args, outcome.receipt);
    assertActive();
    const receiptContents = JSON.stringify(outcome.receipt);
    const receiptArtifact = await grant.artifacts.write({ runId: grant.runId, kind: "other", contents: receiptContents });
    assertActive();
    try {
      this.#repository.completeChapterWrite({
        runId: grant.runId,
        nodeId: grant.nodeId,
        revisionRound: grant.revisionRound,
        candidateHash: effect.candidateHash,
        receiptRef: receiptArtifact.artifactRef,
        chapterId: outcome.receipt.chapterId,
        appliedRevision: outcome.receipt.revision,
        ...grant.lease,
      });
    } catch (error) {
      throw capabilityError("workflow_write_capability_conflict", "Unable to complete the durable workflow chapter write", error);
    }
    return {
      args,
      receipt: outcome.receipt,
      candidateRef: effect.candidateRef,
      candidateHash: effect.candidateHash,
      candidateArtifact,
      receiptArtifact,
    };
  }

  private async readCandidate(grant: WorkflowChapterWriteGrant, effect: ChapterWriteEffect): Promise<Readonly<{ args: WorkflowChapterWriteArgsValue; artifact: WorkflowArtifactHandle }>> {
    try {
      const bytes = await grant.artifacts.read(effect.candidateRef);
      const candidate = CandidateArtifact.parse(JSON.parse(bytes.toString("utf8")));
      if (candidate.candidateHash !== effect.candidateHash || sha256(candidate.content) !== effect.candidateHash) {
        throw new Error("candidate-hash-mismatch");
      }
      return {
        args: WorkflowChapterWriteArgs.parse({
          content: candidate.content,
          plan: candidate.plan,
          detailedOutline: candidate.detailedOutline,
        }),
        artifact: {
          artifactRef: effect.candidateRef,
          sha256: sha256(bytes),
          byteSize: bytes.byteLength,
        },
      };
    } catch (error) {
      if (effect.status === "claimed") this.markConflict(grant, effect.candidateHash, "workflow_candidate_artifact_invalid");
      throw capabilityError("workflow_write_capability_conflict", "Workflow candidate artifact cannot prove the claimed write", error);
    }
  }

  private async readCompletedReceipt(
    grant: WorkflowChapterWriteGrant,
    prepared: PreparedGrant,
    args: WorkflowChapterWriteArgsValue,
    effect: ChapterWriteEffect,
    candidateArtifact: WorkflowArtifactHandle,
  ): Promise<RecoveredChapterWrite> {
    if (!effect.receiptRef) throw capabilityError("workflow_write_capability_conflict", "Completed workflow write has no receipt artifact");
    try {
      const receiptBytes = await grant.artifacts.read(effect.receiptRef);
      const receipt = WorkflowChapterWriteReceipt.parse(JSON.parse(receiptBytes.toString("utf8")));
      this.assertReceipt(prepared, args, receipt);
      if (receipt.chapterId !== effect.chapterId || receipt.revision !== effect.appliedRevision) throw new Error("receipt-effect-mismatch");
      return {
        args,
        receipt,
        candidateRef: effect.candidateRef,
        candidateHash: effect.candidateHash,
        candidateArtifact,
        receiptArtifact: {
          artifactRef: effect.receiptRef,
          sha256: sha256(receiptBytes),
          byteSize: receiptBytes.byteLength,
        },
      };
    } catch (error) {
      throw capabilityError("workflow_write_capability_conflict", "Workflow receipt artifact cannot prove the completed write", error);
    }
  }

  private assertMatchingEffect(effect: ChapterWriteEffect, prepared: PreparedGrant, candidateHash: string, candidateRef: string): void {
    const effectChapterId = effect.operation === "create" ? effect.reservedChapterId : effect.chapterId;
    if (
      effect.operation !== prepared.operation
      || effectChapterId !== prepared.chapterId
      || effect.candidateHash !== candidateHash
      || effect.candidateRef !== candidateRef
      || (prepared.operation === "replace" && effect.expectedRevision !== prepared.expectedRevision)
    ) {
      throw capabilityError("workflow_write_capability_conflict", "A different durable workflow chapter write claim already exists");
    }
  }

  private assertReceipt(prepared: PreparedGrant, args: WorkflowChapterWriteArgsValue, receipt: WorkflowChapterWriteReceiptValue): void {
    const expectedOperation = prepared.operation === "create" ? "created" : "replaced";
    if (
      receipt.operation !== expectedOperation
      || receipt.chapterId !== prepared.chapterId
      || receipt.contentHash !== sha256(args.content)
      || receipt.workId !== prepared.input.lock.target.workId
      || receipt.volumeId !== prepared.input.lock.target.volumeId
    ) {
      throw capabilityError("workflow_write_capability_conflict", "Workflow chapter receipt does not match the frozen target and candidate");
    }
  }

  private markConflict(grant: WorkflowChapterWriteGrant, candidateHash: string, conflictCode: string): void {
    try {
      this.#repository.markChapterWriteConflict({
        runId: grant.runId,
        nodeId: grant.nodeId,
        revisionRound: grant.revisionRound,
        candidateHash,
        conflictCode,
        ...grant.lease,
      });
    } catch (error) {
      throw capabilityError("workflow_write_capability_conflict", "Unable to durably mark the workflow chapter conflict", error);
    }
  }

  private assertExecuting(record: CapabilityRecord): void {
    if (record.status !== "executing") {
      throw capabilityError("workflow_write_capability_missing", "The workflow chapter write capability was revoked");
    }
    if (record.signal?.aborted) throw record.signal.reason ?? new WorkflowRunError("cancelled", "Workflow writer cancelled");
    this.assertGrantActive(record.grant);
  }

  private assertGrantActive(grant: WorkflowChapterWriteGrant): void {
    const control = this.#repository.getControlIntent(grant.runId);
    if (control.cancelRequested || control.pauseRequested) {
      throw new WorkflowRunError("cancelled", "Workflow chapter write cancelled");
    }
    this.#repository.assertAndRenewRunLease({ runId: grant.runId, ...grant.lease, ttlMs: WORKFLOW_RUN_LEASE_TTL_MS });
  }
}
