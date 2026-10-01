import { ChapterWorkflowTarget, WorkflowRunStatus, WorkflowStepStatus, type ChapterWorkflowTarget as ChapterWorkflowTargetValue, type WorkflowRunStatus as WorkflowRunStatusValue, type WorkflowStepStatus as WorkflowStepStatusValue } from "@jizuo/contracts";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const publicationCoordinates = {
  turn: z.number().int().positive(), step: z.number().int().min(1_000_000_000), messageId: z.string().min(1), model: z.string(),
  // Optional for pre-upgrade outbox rows. Delivery must not replace this clock
  // with the time the conversation is reopened or its parent tool settles.
  completedAt: z.number().int().nonnegative().optional(),
};
const publicationContent = z.union([
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("image"), attachment: z.object({
    attachmentId: z.string(), mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    bytes: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive(), name: z.string().optional(),
  }).strict() }).strict(),
]);

/** Closed public delivery contract. No worker context, write authority, typed
 * reasoning, callbacks or arbitrary tool metadata belongs in this outbox. */
export const WorkflowPublicationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), ...publicationCoordinates, text: z.string(), interrupted: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("tool"), ...publicationCoordinates, callId: z.string().min(1), name: z.string(), arguments: z.string(),
    content: z.array(publicationContent), isError: z.boolean(), error: z.object({ name: z.string(), code: z.string() }).strict().optional(),
  }).strict(),
]);
export type WorkflowPublication = z.infer<typeof WorkflowPublicationSchema>;

const terminalStatuses = new Set<WorkflowRunStatusValue>(["completed", "blocked", "failed", "rejected", "cancelled"]);

/** Public conversation delivery only; not graph state or write authority. */
export interface WorkflowConversationPublication {
  readonly publicationId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly payloadJson: string;
}

export type WorkflowArtifactKind = "frozen-definition" | "plan" | "candidate" | "review" | "memory" | "other";
export type WorkflowBudgetEventKind = "initial" | "manual_extension" | "no_progress_recovery";
export type ChapterWriteMode = "candidate-only" | "direct";
export type ChapterWriteNodeId = "write" | "revise" | "continuity-revise" | "style-revise" | "ai-trace-revise";
export type ChapterWriteOperation = "create" | "replace";
export type ChapterWriteStatus = "claimed" | "completed" | "conflict";

export interface WorkflowRunRecord {
  readonly runId: string;
  readonly sessionId: string;
  readonly target: ChapterWorkflowTargetValue;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly frozenDefinitionRef?: string;
  readonly frozenRequestRef?: string;
  readonly frozenDefinitionHash: string;
  readonly chapterWriteMode: ChapterWriteMode;
  readonly status: WorkflowRunStatusValue;
  readonly currentNode?: string;
  readonly revisionCompleted: number;
  readonly revisionBudget: number;
  readonly revisionHardMaximum: 10;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowStepRecord {
  readonly runId: string;
  readonly nodeKey: string;
  readonly attempt: number;
  readonly uiGroup: string;
  readonly uiLabel: string;
  readonly groupOrder: number;
  readonly status: WorkflowStepStatusValue;
  readonly inputHash?: string;
  readonly outputHash?: string;
  readonly artifactRef?: string;
  readonly summary?: string;
  /** Bounded, display-ready model output; prompts and internal references are excluded. */
  readonly output?: string;
  readonly durationMs?: number;
  readonly errorCategory?: string;
  readonly errorCode?: string;
}

export interface WorkflowArtifactRecord {
  readonly artifactRef: string;
  readonly runId: string;
  readonly kind: WorkflowArtifactKind;
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly status: "ready" | "quarantined" | "deleted";
}

export type WorkflowApplyReconciliationRecord = Readonly<{
  runId: string;
  proposalId: string;
  resultRef: string;
} & (
  | { status: "applied"; candidateHash: string; appliedRevision: string }
  | { status: "conflict"; candidateHash?: string; conflictCode: string }
)>;

export interface ChapterWriteEffect {
  readonly runId: string;
  readonly nodeId: ChapterWriteNodeId;
  readonly revisionRound: number;
  readonly operation: ChapterWriteOperation;
  readonly status: ChapterWriteStatus;
  readonly candidateHash: string;
  readonly candidateRef: string;
  readonly reservedChapterId?: string;
  readonly chapterId?: string;
  readonly expectedRevision?: string;
  readonly appliedRevision?: string;
  readonly receiptRef?: string;
  readonly conflictCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ChapterWriteClaimBase {
  readonly runId: string;
  readonly nodeId: ChapterWriteNodeId;
  readonly revisionRound: number;
  readonly candidateHash: string;
  readonly candidateRef: string;
}

export interface ChapterWriteLeaseIdentity {
  readonly ownerToken: string;
  readonly ownerPid: number;
}

export type ChapterWriteClaimInput = ChapterWriteClaimBase & ChapterWriteLeaseIdentity & (
  | {
      readonly operation: "create";
      readonly reservedChapterId: string;
      readonly chapterId?: never;
      readonly expectedRevision?: never;
    }
  | {
      readonly operation: "replace";
      readonly reservedChapterId?: never;
      readonly chapterId: string;
      readonly expectedRevision: string;
    }
);

export interface ChapterWriteCompletionInput extends ChapterWriteLeaseIdentity {
  readonly runId: string;
  readonly nodeId: ChapterWriteNodeId;
  readonly revisionRound: number;
  readonly candidateHash: string;
  readonly receiptRef: string;
  readonly chapterId: string;
  readonly appliedRevision: string;
}

export interface ChapterWriteConflictInput extends ChapterWriteLeaseIdentity {
  readonly runId: string;
  readonly nodeId: ChapterWriteNodeId;
  readonly revisionRound: number;
  readonly candidateHash: string;
  readonly conflictCode: string;
}

/** An integrity-bound artifact reference returned only after the artifact store commits it. */
export interface WorkflowArtifactHandle {
  readonly artifactRef: string;
  readonly sha256: string;
  readonly byteSize: number;
}

export interface CreateWorkflowRunInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly target: ChapterWorkflowTargetValue;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly frozenDefinitionHash: string;
  readonly frozenDefinitionRef?: string;
  readonly frozenRequestRef?: string;
  readonly revisionBudget: number;
  readonly chapterWriteMode?: ChapterWriteMode;
}

export type RecordWorkflowStepInput = Omit<WorkflowStepRecord, "uiGroup" | "uiLabel" | "groupOrder" | "artifactRef"> & {
  readonly artifact?: WorkflowArtifactHandle;
};

export interface CompleteWorkflowNodeAttemptInput {
  readonly runId: string;
  readonly ownerToken: string;
  readonly ownerPid: number;
  readonly ttlMs: number;
  readonly nodeKey: string;
  readonly attempt: number;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly artifact: WorkflowArtifactHandle;
  readonly idempotencyKey: string;
  readonly durationMs: number;
  readonly summary?: string;
  readonly output?: string;
  readonly markApplied?: boolean;
}

interface Row {
  [key: string]: unknown;
}

function now(): string {
  return new Date().toISOString();
}

function requiredString(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`Invalid ${field}`);
  return value;
}

function requiredHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${field}`);
  return value;
}

function chapterWriteMode(value: unknown): ChapterWriteMode {
  if (value !== "candidate-only" && value !== "direct") throw new Error("Invalid chapterWriteMode");
  return value;
}

function chapterWriteNode(input: { readonly nodeId: unknown; readonly revisionRound: unknown }): void {
  if (!["write", "revise", "continuity-revise", "style-revise", "ai-trace-revise"].includes(String(input.nodeId))) {
    throw new Error("Invalid chapter write nodeId");
  }
  if (!Number.isInteger(input.revisionRound) || Number(input.revisionRound) < 0 || Number(input.revisionRound) > 10) {
    throw new Error("Invalid chapter write revisionRound");
  }
}

function chapterWriteLeaseIdentity(input: { readonly ownerToken: unknown; readonly ownerPid: unknown }): void {
  requiredString(input.ownerToken, "ownerToken", 256);
  if (!Number.isInteger(input.ownerPid) || Number(input.ownerPid) < 1) throw new Error("Invalid ownerPid");
}

function targetKey(target: ChapterWorkflowTargetValue): string {
  if (target.mode === "modify") return `modify:${target.workId}:${target.volumeId}:${target.chapterId}`;
  if (target.mode === "create_next") return `create-next:${target.workId}:${target.volumeId}:${target.afterChapterId}`;
  return `create-explicit:${target.workId}:${target.volumeId}:${target.title}`;
}

function asRun(row: Row | undefined): WorkflowRunRecord | undefined {
  if (!row) return undefined;
  return {
    runId: String(row.run_id), sessionId: String(row.session_id), target: ChapterWorkflowTarget.parse(JSON.parse(String(row.target_json))),
    workflowId: String(row.workflow_id), workflowVersion: String(row.workflow_version),
    ...(row.frozen_definition_ref ? { frozenDefinitionRef: String(row.frozen_definition_ref) } : {}),
    ...(row.frozen_request_ref ? { frozenRequestRef: String(row.frozen_request_ref) } : {}),
    frozenDefinitionHash: String(row.frozen_definition_hash), chapterWriteMode: chapterWriteMode(row.chapter_write_mode), status: WorkflowRunStatus.parse(row.status),
    ...(row.current_node ? { currentNode: String(row.current_node) } : {}),
    revisionCompleted: Number(row.revision_completed), revisionBudget: Number(row.revision_budget), revisionHardMaximum: 10,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function asChapterWriteEffect(row: Row | undefined): ChapterWriteEffect | undefined {
  if (!row) return undefined;
  return {
    runId: String(row.run_id),
    nodeId: String(row.node_id) as ChapterWriteNodeId,
    revisionRound: Number(row.revision_round),
    operation: String(row.operation) as ChapterWriteOperation,
    status: String(row.status) as ChapterWriteStatus,
    candidateHash: String(row.candidate_hash),
    candidateRef: String(row.candidate_ref),
    ...(row.reserved_chapter_id ? { reservedChapterId: String(row.reserved_chapter_id) } : {}),
    ...(row.chapter_id ? { chapterId: String(row.chapter_id) } : {}),
    ...(row.expected_revision ? { expectedRevision: String(row.expected_revision) } : {}),
    ...(row.applied_revision ? { appliedRevision: String(row.applied_revision) } : {}),
    ...(row.receipt_ref ? { receiptRef: String(row.receipt_ref) } : {}),
    ...(row.conflict_code ? { conflictCode: String(row.conflict_code) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function asArtifact(row: Row | undefined): WorkflowArtifactRecord | undefined {
  if (!row) return undefined;
  return {
    artifactRef: String(row.artifact_ref), runId: String(row.run_id), kind: String(row.kind) as WorkflowArtifactKind,
    relativePath: String(row.relative_path), sha256: String(row.sha256), byteSize: Number(row.byte_size),
    status: String(row.status) as WorkflowArtifactRecord["status"],
  };
}

function asStep(row: Row): WorkflowStepRecord {
  return {
    runId: String(row.run_id), nodeKey: String(row.node_key), attempt: Number(row.attempt), uiGroup: String(row.ui_group),
    uiLabel: String(row.ui_label), groupOrder: Number(row.group_order), status: WorkflowStepStatus.parse(row.status),
    ...(row.input_hash ? { inputHash: String(row.input_hash) } : {}), ...(row.output_hash ? { outputHash: String(row.output_hash) } : {}),
    ...(row.artifact_ref ? { artifactRef: String(row.artifact_ref) } : {}), ...(row.summary ? { summary: String(row.summary) } : {}),
    ...(row.output ? { output: String(row.output) } : {}),
    ...(row.duration_ms !== null && row.duration_ms !== undefined ? { durationMs: Number(row.duration_ms) } : {}),
    ...(row.error_category ? { errorCategory: String(row.error_category) } : {}), ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
  };
}

const nodePresentation: Readonly<Record<string, { group: string; label: string; order: number }>> = Object.freeze({
  "freeze-inputs": { group: "target", label: "Target", order: 0 },
  "runtime-start": { group: "target", label: "Target", order: 0 },
  "lock-target": { group: "target", label: "Target", order: 0 },
  "initialize-chapter": { group: "target", label: "Target", order: 0 },
  "query-memory": { group: "memory", label: "Memory", order: 1 },
  plan: { group: "planning", label: "Planning", order: 2 },
  write: { group: "writing", label: "Writing", order: 3 },
  continuity: { group: "review", label: "Continuity review", order: 4 },
  style: { group: "review", label: "Style review", order: 4 },
  "ai-trace": { group: "review", label: "AI trace review", order: 4 },
  "review-gate": { group: "review", label: "Review", order: 4 },
  revise: { group: "writing", label: "Revision", order: 3 },
  "continuity-review": { group: "review", label: "Continuity review", order: 4 },
  "continuity-gate": { group: "review", label: "Continuity gate", order: 4 },
  "continuity-revise": { group: "review", label: "Continuity revision", order: 4 },
  "style-review": { group: "review", label: "Style review", order: 4 },
  "style-gate": { group: "review", label: "Style gate", order: 4 },
  "style-revise": { group: "review", label: "Style revision", order: 4 },
  "ai-trace-review": { group: "review", label: "AI trace review", order: 4 },
  "ai-trace-gate": { group: "review", label: "AI trace gate", order: 4 },
  "ai-trace-revise": { group: "review", label: "AI trace revision", order: 4 },
  proposal: { group: "proposal", label: "Proposal", order: 5 },
  approval: { group: "approval", label: "Approval", order: 6 },
  apply: { group: "application", label: "Application", order: 7 },
  verify: { group: "verification", label: "Verification", order: 8 },
  "extract-memory": { group: "memory-save", label: "Memory extraction", order: 9 },
  "save-memory": { group: "memory-save", label: "Memory save", order: 9 },
});

/** Product persistence. It deliberately stores artifact references, never candidate or memory bodies. */
export class WorkflowRepository {
  readonly #database: Database.Database;
  readonly #artifactRoot: string;

  public constructor(
    database: Database.Database,
    artifactRoot: string,
  ) {
    this.#database = database;
    this.#artifactRoot = artifactRoot;
  }

  createOrGetRun(input: CreateWorkflowRunInput): { readonly created: boolean; readonly run: WorkflowRunRecord } {
    requiredString(input.runId, "runId", 64); requiredString(input.sessionId, "sessionId", 64); requiredString(input.workflowId, "workflowId", 101);
    if (!/^[a-f0-9]{64}$/.test(input.frozenDefinitionHash)) throw new Error("Invalid frozenDefinitionHash");
    if (!Number.isInteger(input.revisionBudget) || input.revisionBudget < 1 || input.revisionBudget > 10) throw new Error("Invalid revisionBudget");
    const persistedChapterWriteMode = chapterWriteMode(input.chapterWriteMode ?? "candidate-only");
    const target = ChapterWorkflowTarget.parse(input.target);
    const activeTargetKey = targetKey(target);
    const create = this.#database.transaction(() => {
      const existing = asRun(this.#database.prepare("SELECT * FROM workflow_runs WHERE active_target_key = ? AND status NOT IN ('completed', 'blocked', 'failed', 'rejected', 'cancelled')").get(activeTargetKey) as Row | undefined);
      if (existing) return { created: false, run: existing } as const;
      const timestamp = now();
      try {
        this.#database.prepare(`INSERT INTO workflow_runs (run_id, session_id, target_json, active_target_key, workflow_id, workflow_version, frozen_definition_ref, frozen_request_ref, frozen_definition_hash, chapter_write_mode, status, revision_budget, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`)
          .run(input.runId, input.sessionId, JSON.stringify(target), activeTargetKey, input.workflowId, input.workflowVersion, input.frozenDefinitionRef ?? null, input.frozenRequestRef ?? null, input.frozenDefinitionHash, persistedChapterWriteMode, input.revisionBudget, timestamp, timestamp);
      } catch (error) {
        const duplicate = asRun(this.#database.prepare("SELECT * FROM workflow_runs WHERE active_target_key = ? AND status NOT IN ('completed', 'blocked', 'failed', 'rejected', 'cancelled')").get(activeTargetKey) as Row | undefined);
        if (duplicate) return { created: false, run: duplicate } as const;
        throw error;
      }
      this.change(input.runId, "run-created", timestamp);
      return { created: true, run: this.getRunRequired(input.runId) } as const;
    });
    return create();
  }

  getRun(runId: string): WorkflowRunRecord | undefined {
    return asRun(this.#database.prepare("SELECT * FROM workflow_runs WHERE run_id = ?").get(runId) as Row | undefined);
  }

  /**
   * Transfers only a parked run explicitly restarted from another root
   * conversation. This transaction fences active workers and retires
   * undelivered output owned by the old conversation before changing the
   * durable session owner.
   */
  adoptParkedRun(runId: string, expectedSessionId: string, nextSessionId: string): WorkflowRunRecord {
    requiredString(runId, "runId", 64);
    requiredString(expectedSessionId, "expectedSessionId", 64);
    requiredString(nextSessionId, "nextSessionId", 64);
    if (expectedSessionId === nextSessionId) return this.getRunRequired(runId);
    return this.#database.transaction(() => {
      const run = this.getRunRequired(runId);
      if (run.sessionId !== expectedSessionId
        || !["waiting_approval", "waiting_decision", "paused"].includes(run.status)) {
        throw new Error("工作流状态或会话所有权已变化，请刷新后重试");
      }
      const lease = this.#database.prepare("SELECT owner_pid, expires_at FROM workflow_run_leases WHERE run_id = ?").get(runId) as Row | undefined;
      if (lease && (Number(lease.expires_at) > Date.now() || isProcessAlive(Number(lease.owner_pid)))) {
        throw new Error("工作流仍在原会话执行，不能转移控制权");
      }
      const timestamp = now();
      this.#database.prepare(`UPDATE workflow_conversation_publications SET disposition = 'superseded'
        WHERE run_id = ? AND session_id = ? AND disposition = 'pending'`)
        .run(runId, expectedSessionId);
      const adopted = this.#database.prepare(`UPDATE workflow_runs SET session_id = ?, updated_at = ?
        WHERE run_id = ? AND session_id = ? AND status IN ('waiting_approval', 'waiting_decision', 'paused')`)
        .run(nextSessionId, timestamp, runId, expectedSessionId);
      if (adopted.changes !== 1) throw new Error("工作流状态或会话所有权已变化，请刷新后重试");
      this.change(runId, "run-session-adopted", timestamp);
      return this.getRunRequired(runId);
    })();
  }

  /** Read-only lifecycle enumeration. Callers receive no checkpoint, artifact payload, or authorization data. */
  listRuns(input: { readonly sessionId?: string; readonly nonterminalOnly?: boolean } = {}): readonly WorkflowRunRecord[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.sessionId !== undefined) {
      requiredString(input.sessionId, "sessionId", 64);
      clauses.push("session_id = ?");
      values.push(input.sessionId);
    }
    if (input.nonterminalOnly) clauses.push("status NOT IN ('completed', 'blocked', 'failed', 'rejected', 'cancelled')");
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.#database.prepare(`SELECT * FROM workflow_runs${where} ORDER BY created_at DESC`).all(...values) as Row[])
      .map((row) => asRun(row)!)
      .filter((run): run is WorkflowRunRecord => run !== undefined);
  }

  cancelLegacyProposalRuns(): readonly WorkflowRunRecord[] {
    return this.#database.transaction(() => {
      const legacy = (this.#database.prepare(`SELECT * FROM workflow_runs
        WHERE workflow_id IN ('chapter-production-v1', 'chapter-production-v2')
          AND status NOT IN ('completed', 'blocked', 'failed', 'rejected', 'cancelled')
        ORDER BY created_at ASC`).all() as Row[])
        .map((row) => asRun(row)!)
        .filter((run): run is WorkflowRunRecord => run !== undefined);
      const retired: WorkflowRunRecord[] = [];
      for (const run of legacy) {
        const timestamp = now();
        const result = this.#database.prepare(`UPDATE workflow_runs
          SET status = 'cancelled', updated_at = ?
          WHERE run_id = ? AND status NOT IN ('completed', 'blocked', 'failed', 'rejected', 'cancelled')`)
          .run(timestamp, run.runId);
        if (result.changes !== 1) continue;
        this.change(run.runId, "legacy-workflow-retired", timestamp);
        retired.push(this.getRunRequired(run.runId));
      }
      return retired;
    })();
  }

  setFrozenDefinitionRef(runId: string, artifact: WorkflowArtifactHandle): WorkflowRunRecord {
    this.requireVerifiedReadyArtifact(runId, artifact);
    const operation = this.#database.transaction(() => {
      const timestamp = now();
      const result = this.#database.prepare("UPDATE workflow_runs SET frozen_definition_ref = ?, updated_at = ? WHERE run_id = ? AND frozen_definition_ref IS NULL")
        .run(artifact.artifactRef, timestamp, runId);
      if (result.changes === 0) {
        const current = this.getRunRequired(runId);
        if (current.frozenDefinitionRef !== artifact.artifactRef) throw new Error("Frozen workflow definition cannot be replaced");
        return current;
      }
      this.change(runId, "frozen-definition-recorded", timestamp);
      return this.getRunRequired(runId);
    });
    return operation();
  }

  setFrozenRequestRef(runId: string, artifact: WorkflowArtifactHandle): WorkflowRunRecord {
    this.requireVerifiedReadyArtifact(runId, artifact);
    const operation = this.#database.transaction(() => {
      const timestamp = now();
      const result = this.#database.prepare("UPDATE workflow_runs SET frozen_request_ref = ?, updated_at = ? WHERE run_id = ? AND frozen_request_ref IS NULL")
        .run(artifact.artifactRef, timestamp, runId);
      if (result.changes === 0) {
        const current = this.getRunRequired(runId);
        if (current.frozenRequestRef !== artifact.artifactRef) throw new Error("Frozen workflow request cannot be replaced");
        return current;
      }
      this.change(runId, "frozen-request-recorded", timestamp);
      return this.getRunRequired(runId);
    });
    return operation();
  }

  /** Explicit user restart: keep old artifacts immutable and advance only a stopped run. */
  restartRun(runId: string, expectedRequestRef: string | undefined, request: WorkflowArtifactHandle): WorkflowRunRecord {
    this.requireVerifiedReadyArtifact(runId, request);
    return this.#database.transaction(() => {
      const run = this.getRunRequired(runId);
      if (run.status !== "paused" && !(run.status === "failed" && run.chapterWriteMode === "direct")
        && !(["failed", "memory_pending"].includes(run.status) && this.hasVerifiedMemoryTail(runId))) {
        throw new Error("工作流状态已变化，请刷新后重试");
      }
      const lease = this.#database.prepare("SELECT owner_pid, expires_at FROM workflow_run_leases WHERE run_id = ?").get(runId) as Row | undefined;
      if (lease && (Number(lease.expires_at) > Date.now() || isProcessAlive(Number(lease.owner_pid)))) {
        throw new Error("工作流正在停止，请稍后再次启动");
      }
      if (run.frozenRequestRef !== expectedRequestRef) throw new Error("工作流要求已变化，请刷新后重试");
      const timestamp = now();
      this.#database.prepare("UPDATE workflow_runs SET frozen_request_ref = ?, status = 'queued', updated_at = ? WHERE run_id = ?")
        .run(request.artifactRef, timestamp, runId);
      this.#database.prepare("DELETE FROM workflow_run_controls WHERE run_id = ?").run(runId);
      this.change(runId, "run-restarted", timestamp);
      return this.getRunRequired(runId);
    })();
  }

  /** A memory retry cannot grant permission to write or approve a chapter. */
  hasVerifiedMemoryTail(runId: string): boolean {
    const run = this.getRunRequired(runId);
    return (run.currentNode === "extract-memory" || run.currentNode === "save-memory"
      || run.currentNode === "verify" && ["queued", "running", "paused", "memory_pending"].includes(run.status))
      && this.listSteps(runId).some((step) => step.nodeKey === "verify" && step.status === "completed");
  }

  setControlIntent(runId: string, input: { readonly pause?: boolean; readonly cancel?: boolean }): void {
    const operation = this.#database.transaction(() => {
      this.getRunRequired(runId);
      const timestamp = now();
      this.#database.prepare(`INSERT INTO workflow_run_controls (run_id, pause_requested, cancel_requested, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          pause_requested = CASE WHEN excluded.pause_requested = 1 THEN 1 ELSE workflow_run_controls.pause_requested END,
          cancel_requested = CASE WHEN excluded.cancel_requested = 1 THEN 1 ELSE workflow_run_controls.cancel_requested END,
          updated_at = excluded.updated_at`)
        .run(runId, input.pause ? 1 : 0, input.cancel ? 1 : 0, timestamp);
      this.change(runId, "run-control-requested", timestamp);
    });
    operation();
  }

  getControlIntent(runId: string): { readonly pauseRequested: boolean; readonly cancelRequested: boolean } {
    const row = this.#database.prepare("SELECT pause_requested, cancel_requested FROM workflow_run_controls WHERE run_id = ?").get(runId) as Row | undefined;
    return { pauseRequested: Number(row?.pause_requested ?? 0) === 1, cancelRequested: Number(row?.cancel_requested ?? 0) === 1 };
  }

  clearControlIntent(runId: string): void {
    const result = this.#database.prepare("DELETE FROM workflow_run_controls WHERE run_id = ?").run(runId);
    if (result.changes === 1) this.change(runId, "run-control-cleared", now());
  }

  extendRevisionBudget(runId: string, additionalRounds: 2): WorkflowRunRecord {
    if (additionalRounds !== 2) throw new Error("Workflow budget extension must be exactly two rounds");
    const operation = this.#database.transaction(() => {
      const run = this.getRunRequired(runId);
      if (run.revisionBudget + additionalRounds > 10) throw new Error("Workflow revision hard maximum exceeded");
      const timestamp = now();
      this.#database.prepare("UPDATE workflow_runs SET revision_budget = ?, updated_at = ? WHERE run_id = ?")
        .run(run.revisionBudget + additionalRounds, timestamp, runId);
      this.#database.prepare("INSERT INTO workflow_budget_events (run_id, kind, delta, reason, created_at) VALUES (?, 'manual_extension', ?, 'user-approved-extension', ?)")
        .run(runId, additionalRounds, timestamp);
      this.change(runId, "revision-budget-extended", timestamp);
      return this.getRunRequired(runId);
    });
    return operation();
  }

  listSteps(runId: string): readonly WorkflowStepRecord[] {
    // Public groups summarize their latest activity, not the node whose name
    // happens to sort last ("style" previously hid every review-gate result).
    return (this.#database.prepare("SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY group_order, updated_at, rowid").all(runId) as Row[]).map(asStep);
  }

  claimChapterWrite(input: ChapterWriteClaimInput): ChapterWriteEffect {
    chapterWriteNode(input);
    chapterWriteLeaseIdentity(input);
    requiredHash(input.candidateHash, "candidateHash");
    requiredString(input.candidateRef, "candidateRef", 1_024);
    if (input.operation === "create") requiredString(input.reservedChapterId, "reservedChapterId", 128);
    else {
      requiredString(input.chapterId, "chapterId", 128);
      requiredHash(input.expectedRevision, "expectedRevision");
    }
    const operation = this.#database.transaction(() => {
      const run = this.requireActiveChapterWriteLease(input);
      const existing = this.getChapterWrite(input.runId, input.nodeId, input.revisionRound);
      if (existing) return this.requireMatchingChapterWriteClaim(existing, input);
      if (run.chapterWriteMode !== "direct") throw new Error("Chapter write claims require a direct-write run");
      const timestamp = now();
      const inserted = this.#database.prepare(`INSERT INTO workflow_chapter_write_effects
        (run_id, node_id, revision_round, operation, status, candidate_hash, candidate_ref, reserved_chapter_id, chapter_id, expected_revision, created_at, updated_at)
        SELECT ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM workflow_runs AS active_run
          JOIN workflow_run_leases AS active_lease ON active_lease.run_id = active_run.run_id
          WHERE active_run.run_id = ? AND active_run.chapter_write_mode = 'direct'
            AND active_run.status IN ('running', 'retrying') AND active_run.current_node = ?
            AND active_lease.owner_token = ? AND active_lease.owner_pid = ? AND active_lease.expires_at >= ?
        )
        ON CONFLICT(run_id, node_id, revision_round) DO NOTHING`)
        .run(input.runId, input.nodeId, input.revisionRound, input.operation, input.candidateHash, input.candidateRef,
          input.operation === "create" ? input.reservedChapterId : null,
          input.operation === "replace" ? input.chapterId : null,
          input.operation === "replace" ? input.expectedRevision : null,
          timestamp, timestamp,
          input.runId, input.nodeId, input.ownerToken, input.ownerPid, Date.now());
      const activeAfterInsert = this.requireActiveChapterWriteLease(input);
      if (activeAfterInsert.chapterWriteMode !== "direct") throw new Error("Chapter write claims require a direct-write run");
      const stored = this.getChapterWrite(input.runId, input.nodeId, input.revisionRound);
      if (!stored) throw new Error("Chapter write claim was not persisted");
      this.requireMatchingChapterWriteClaim(stored, input);
      if (inserted.changes === 1) this.change(input.runId, "chapter-write-claimed", timestamp);
      return stored;
    });
    return operation();
  }

  getChapterWrite(runId: string, nodeId: ChapterWriteNodeId, revisionRound: number): ChapterWriteEffect | undefined {
    requiredString(runId, "runId", 64);
    chapterWriteNode({ nodeId, revisionRound });
    return asChapterWriteEffect(this.#database.prepare(`SELECT * FROM workflow_chapter_write_effects
      WHERE run_id = ? AND node_id = ? AND revision_round = ?`).get(runId, nodeId, revisionRound) as Row | undefined);
  }

  completeChapterWrite(input: ChapterWriteCompletionInput): ChapterWriteEffect {
    chapterWriteNode(input);
    chapterWriteLeaseIdentity(input);
    requiredHash(input.candidateHash, "candidateHash");
    requiredString(input.receiptRef, "receiptRef", 1_024);
    requiredString(input.chapterId, "chapterId", 128);
    requiredHash(input.appliedRevision, "appliedRevision");
    const operation = this.#database.transaction(() => {
      this.requireActiveChapterWriteLease(input);
      const existing = this.getChapterWrite(input.runId, input.nodeId, input.revisionRound);
      if (!existing) throw new Error("Unknown chapter write claim");
      if (existing.candidateHash !== input.candidateHash) throw new Error("Chapter write completion candidate hash conflicts with the original claim");
      const claimedChapterId = existing.operation === "create" ? existing.reservedChapterId : existing.chapterId;
      if (claimedChapterId !== input.chapterId) throw new Error("Chapter write completion chapter target conflicts with the original claim");
      if (existing.status === "completed") {
        if (existing.receiptRef === input.receiptRef && existing.chapterId === input.chapterId && existing.appliedRevision === input.appliedRevision) return existing;
        throw new Error("Completed chapter write receipt is immutable");
      }
      if (existing.status === "conflict") throw new Error("Conflicted chapter write is terminal");
      const timestamp = now();
      const updated = this.#database.prepare(`UPDATE workflow_chapter_write_effects
        SET status = 'completed', chapter_id = ?, applied_revision = ?, receipt_ref = ?, updated_at = ?
        WHERE run_id = ? AND node_id = ? AND revision_round = ? AND candidate_hash = ? AND status = 'claimed'
          AND EXISTS (
            SELECT 1 FROM workflow_runs AS active_run
            JOIN workflow_run_leases AS active_lease ON active_lease.run_id = active_run.run_id
            WHERE active_run.run_id = ? AND active_run.chapter_write_mode = 'direct'
              AND active_run.status IN ('running', 'retrying') AND active_run.current_node = ?
              AND active_lease.owner_token = ? AND active_lease.owner_pid = ? AND active_lease.expires_at >= ?
          )`)
        .run(input.chapterId, input.appliedRevision, input.receiptRef, timestamp, input.runId, input.nodeId, input.revisionRound, input.candidateHash,
          input.runId, input.nodeId, input.ownerToken, input.ownerPid, Date.now());
      this.requireActiveChapterWriteLease(input);
      if (updated.changes !== 1) throw new Error("Chapter write completion conflicts with the durable claim");
      this.change(input.runId, "chapter-write-completed", timestamp);
      return this.getChapterWrite(input.runId, input.nodeId, input.revisionRound)!;
    });
    return operation();
  }

  markChapterWriteConflict(input: ChapterWriteConflictInput): ChapterWriteEffect {
    chapterWriteNode(input);
    chapterWriteLeaseIdentity(input);
    requiredHash(input.candidateHash, "candidateHash");
    requiredString(input.conflictCode, "conflictCode", 128);
    const operation = this.#database.transaction(() => {
      this.requireActiveChapterWriteLease(input);
      const existing = this.getChapterWrite(input.runId, input.nodeId, input.revisionRound);
      if (!existing) throw new Error("Unknown chapter write claim");
      if (existing.candidateHash !== input.candidateHash) throw new Error("Chapter write conflict candidate hash conflicts with the original claim");
      if (existing.status === "conflict") {
        if (existing.conflictCode === input.conflictCode) return existing;
        throw new Error("Conflicted chapter write is terminal and immutable");
      }
      if (existing.status === "completed") throw new Error("Completed chapter write is terminal");
      const timestamp = now();
      const updated = this.#database.prepare(`UPDATE workflow_chapter_write_effects
        SET status = 'conflict', conflict_code = ?, updated_at = ?
        WHERE run_id = ? AND node_id = ? AND revision_round = ? AND candidate_hash = ? AND status = 'claimed'
          AND EXISTS (
            SELECT 1 FROM workflow_runs AS active_run
            JOIN workflow_run_leases AS active_lease ON active_lease.run_id = active_run.run_id
            WHERE active_run.run_id = ? AND active_run.chapter_write_mode = 'direct'
              AND active_run.status IN ('running', 'retrying') AND active_run.current_node = ?
              AND active_lease.owner_token = ? AND active_lease.owner_pid = ? AND active_lease.expires_at >= ?
          )`)
        .run(input.conflictCode, timestamp, input.runId, input.nodeId, input.revisionRound, input.candidateHash,
          input.runId, input.nodeId, input.ownerToken, input.ownerPid, Date.now());
      this.requireActiveChapterWriteLease(input);
      if (updated.changes !== 1) throw new Error("Chapter write conflict does not match the durable claim");
      const blocked = this.#database.prepare(`UPDATE workflow_runs SET status = 'blocked', current_node = ?, updated_at = ?
        WHERE run_id = ? AND chapter_write_mode = 'direct' AND current_node = ? AND status IN ('running', 'retrying')
          AND EXISTS (
            SELECT 1 FROM workflow_run_leases AS active_lease
            WHERE active_lease.run_id = workflow_runs.run_id
              AND active_lease.owner_token = ? AND active_lease.owner_pid = ? AND active_lease.expires_at >= ?
          )`)
        .run(input.nodeId, timestamp, input.runId, input.nodeId, input.ownerToken, input.ownerPid, Date.now());
      this.requireBlockedChapterWriteLease(input);
      if (blocked.changes !== 1) throw new Error("Chapter write conflict lost its active workflow run");
      this.change(input.runId, "chapter-write-conflict", timestamp);
      return this.getChapterWrite(input.runId, input.nodeId, input.revisionRound)!;
    });
    return operation();
  }

  updateRunStatus(runId: string, status: WorkflowRunStatusValue, currentNode?: string): WorkflowRunRecord {
    WorkflowRunStatus.parse(status);
    const operation = this.#database.transaction(() => {
      const timestamp = now();
      const result = this.#database.prepare("UPDATE workflow_runs SET status = ?, current_node = ?, updated_at = ? WHERE run_id = ?").run(status, currentNode ?? null, timestamp, runId);
      if (result.changes !== 1) throw new Error(`Unknown workflow run: ${runId}`);
      this.change(runId, "run-status", timestamp);
      return this.getRunRequired(runId);
    });
    return operation();
  }

  recordStepAttempt(input: RecordWorkflowStepInput): WorkflowStepRecord {
    WorkflowStepStatus.parse(input.status);
    requiredString(input.nodeKey, "nodeKey", 64);
    if (!Number.isInteger(input.attempt) || input.attempt < 1) throw new Error("Invalid attempt");
    if (input.summary !== undefined && input.summary.length > 240) throw new Error("Step summary exceeds public projection limit");
    if (input.output !== undefined && (input.output.length < 1 || input.output.length > 20_000)) throw new Error("Step output exceeds public projection limit");
    if (input.durationMs !== undefined && (!Number.isInteger(input.durationMs) || input.durationMs < 0)) throw new Error("Invalid durationMs");
    if ("artifactRef" in input) throw new Error("Completed steps must use an artifact handle, not a raw artifactRef");
    if (input.status === "completed" && !input.artifact) throw new Error("Completed steps require an artifact handle");
    const presentation = nodePresentation[input.nodeKey];
    if (!presentation) throw new Error(`Workflow node has no frozen public presentation: ${input.nodeKey}`);
    // This physical/metadata verification happens before the product-table transaction makes completion visible.
    if (input.status === "completed" && input.artifact) this.requireVerifiedReadyArtifact(input.runId, input.artifact);
    const operation = this.#database.transaction(() => {
      const timestamp = now();
      const existingRow = this.#database.prepare("SELECT * FROM workflow_steps WHERE run_id = ? AND node_key = ? AND attempt = ?").get(input.runId, input.nodeKey, input.attempt) as Row | undefined;
      const intended: WorkflowStepRecord = {
        runId: input.runId, nodeKey: input.nodeKey, attempt: input.attempt,
        uiGroup: presentation.group, uiLabel: presentation.label, groupOrder: presentation.order, status: input.status,
        ...(input.inputHash ? { inputHash: input.inputHash } : {}), ...(input.outputHash ? { outputHash: input.outputHash } : {}),
        ...(input.artifact ? { artifactRef: input.artifact.artifactRef } : {}), ...(input.summary ? { summary: input.summary } : {}), ...(input.output ? { output: input.output } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}), ...(input.errorCategory ? { errorCategory: input.errorCategory } : {}), ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      };
      if (!existingRow) {
        this.#database.prepare(`INSERT INTO workflow_steps
          (run_id, node_key, attempt, ui_group, ui_label, group_order, status, input_hash, output_hash, artifact_ref, summary, output, duration_ms, error_category, error_code, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.runId, input.nodeKey, input.attempt, presentation.group, presentation.label, presentation.order, input.status,
            input.inputHash ?? null, input.outputHash ?? null, input.artifact?.artifactRef ?? null, input.summary ?? null, input.output ?? null, input.durationMs ?? null, input.errorCategory ?? null, input.errorCode ?? null, timestamp, timestamp);
        this.change(input.runId, "step-recorded", timestamp);
        return intended;
      }
      const existing = asStep(existingRow);
      if (isTerminalStepStatus(existing.status)) {
        if (sameStep(existing, intended)) return existing;
        throw new Error(`Cannot rewrite terminal workflow step: ${input.nodeKey}`);
      }
      if (!canTransitionStep(existing.status, intended.status)) throw new Error(`Invalid workflow step transition: ${existing.status} -> ${intended.status}`);
      if (sameStep(existing, intended)) return existing;
      this.#database.prepare(`UPDATE workflow_steps SET status = ?, input_hash = ?, output_hash = ?, artifact_ref = ?, summary = ?, output = ?, duration_ms = ?, error_category = ?, error_code = ?, updated_at = ?
        WHERE run_id = ? AND node_key = ? AND attempt = ?`)
        .run(input.status, input.inputHash ?? null, input.outputHash ?? null, input.artifact?.artifactRef ?? null, input.summary ?? null, input.output ?? null, input.durationMs ?? null, input.errorCategory ?? null, input.errorCode ?? null, timestamp, input.runId, input.nodeKey, input.attempt);
      this.change(input.runId, "step-updated", timestamp);
      return intended;
    });
    return operation();
  }

  recordApproval(input: { runId: string; proposalId: string; decision?: "approved" | "rejected"; decidedBy?: string; resumeTokenHash?: string }): void {
    const operation = this.#database.transaction(() => {
      const timestamp = now();
      this.#database.prepare(`INSERT INTO workflow_approvals (run_id, proposal_id, decision, decided_by, decided_at, resume_token_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET proposal_id = excluded.proposal_id, decision = excluded.decision, decided_by = excluded.decided_by, decided_at = excluded.decided_at, resume_token_hash = excluded.resume_token_hash, updated_at = excluded.updated_at`)
        .run(input.runId, input.proposalId, input.decision ?? null, input.decidedBy ?? null, input.decision ? timestamp : null, input.resumeTokenHash ?? null, timestamp, timestamp);
      this.change(input.runId, "approval-recorded", timestamp);
    });
    operation();
  }

  getArtifact(artifactRef: string): WorkflowArtifactRecord | undefined {
    return asArtifact(this.#database.prepare("SELECT * FROM workflow_artifacts WHERE artifact_ref = ?").get(artifactRef) as Row | undefined);
  }

  quarantineArtifact(artifactRef: string, reason: string): void {
    const operation = this.#database.transaction(() => {
      const record = this.getArtifact(artifactRef);
      if (!record) throw new Error(`Unknown workflow artifact: ${artifactRef}`);
      const timestamp = now();
      this.#database.prepare(`UPDATE workflow_steps
        SET status = 'blocked', error_category = COALESCE(error_category, 'artifact'), error_code = COALESCE(error_code, 'artifact-quarantined'), updated_at = ?
        WHERE run_id = ? AND artifact_ref = ? AND status = 'completed'`)
        .run(timestamp, record.runId, artifactRef);
      this.#database.prepare("UPDATE workflow_artifacts SET status = 'quarantined', updated_at = ? WHERE artifact_ref = ?").run(timestamp, artifactRef);
      this.#database.prepare("UPDATE workflow_runs SET status = 'blocked', updated_at = ? WHERE run_id = ?").run(timestamp, record.runId);
      this.change(record.runId, `artifact-quarantined:${reason.slice(0, 80)}`, timestamp);
    });
    operation();
  }

  recordIdempotency(input: { scope: string; key: string; runId: string; resultRef?: string; completed?: boolean }): void {
    const operation = this.#database.transaction(() => {
      const timestamp = now();
      const result = this.#database.prepare(`INSERT OR IGNORE INTO workflow_idempotency (scope, idempotency_key, run_id, result_ref, completed, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(input.scope, input.key, input.runId, input.resultRef ?? null, input.completed === false ? 0 : 1, timestamp, timestamp);
      if (result.changes === 1) this.change(input.runId, "idempotency-recorded", timestamp);
    });
    operation();
  }

  getIdempotency(scope: string, key: string): { readonly runId: string; readonly resultRef?: string; readonly completed: boolean } | undefined {
    const row = this.#database.prepare("SELECT run_id, result_ref, completed FROM workflow_idempotency WHERE scope = ? AND idempotency_key = ?")
      .get(scope, key) as Row | undefined;
    return row ? {
      runId: String(row.run_id),
      ...(row.result_ref ? { resultRef: String(row.result_ref) } : {}),
      completed: Number(row.completed) === 1,
    } : undefined;
  }

  clearIdempotency(scope: string, key: string): void {
    this.#database.prepare("DELETE FROM workflow_idempotency WHERE scope = ? AND idempotency_key = ?").run(scope, key);
  }

  /** Detects an apply effect that may have crossed the external domain boundary. */
  getNodeEffectState(runId: string, nodeId: string): "none" | "in_progress" | "completed" {
    const prefix = `${runId}/${nodeId}/`;
    const row = (this.#database.prepare(`SELECT idempotency_key, completed FROM workflow_idempotency
      WHERE scope = 'workflow-node' AND run_id = ? ORDER BY updated_at DESC`).all(runId) as Row[])
      .find((candidate) => String(candidate.idempotency_key).startsWith(prefix));
    if (!row) return "none";
    return Number(row.completed) === 1 ? "completed" : "in_progress";
  }

  claimIdempotency(input: { readonly scope: string; readonly key: string; readonly runId: string }): { readonly claimed: boolean; readonly completed: boolean; readonly resultRef?: string } {
    const operation = this.#database.transaction(() => {
      const timestamp = now();
      const existing = this.getIdempotency(input.scope, input.key);
      if (existing) {
        if (existing.runId !== input.runId) throw new Error("Workflow idempotency key belongs to another run");
        return { claimed: false, completed: existing.completed, ...(existing.resultRef ? { resultRef: existing.resultRef } : {}) };
      }
      this.#database.prepare(`INSERT INTO workflow_idempotency (scope, idempotency_key, run_id, completed, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?)`)
        .run(input.scope, input.key, input.runId, timestamp, timestamp);
      this.change(input.runId, "idempotency-claimed", timestamp);
      return { claimed: true, completed: false };
    });
    return operation();
  }

  completeIdempotency(input: { readonly scope: string; readonly key: string; readonly runId: string; readonly resultRef: string }): void {
    const operation = this.#database.transaction(() => {
      const timestamp = now();
      const result = this.#database.prepare(`UPDATE workflow_idempotency
        SET completed = 1, result_ref = ?, updated_at = ?
        WHERE scope = ? AND idempotency_key = ? AND run_id = ?`)
        .run(input.resultRef, timestamp, input.scope, input.key, input.runId);
      if (result.changes !== 1) throw new Error("Workflow effect completion requires its existing idempotency claim");
      this.change(input.runId, "idempotency-completed", timestamp);
    });
    operation();
  }

  /**
   * Fenced node commit. Lease assertion, effect completion markers, and the
   * terminal step transition share one SQLite transaction, so owner loss can
   * never expose a completed step with an incomplete effect claim.
   */
  completeNodeAttempt(input: CompleteWorkflowNodeAttemptInput): WorkflowStepRecord {
    this.requireVerifiedReadyArtifact(input.runId, input.artifact);
    const operation = this.#database.transaction(() => {
      this.assertAndRenewRunLease({
        runId: input.runId,
        ownerToken: input.ownerToken,
        ownerPid: input.ownerPid,
        ttlMs: input.ttlMs,
      });
      this.completeIdempotency({
        scope: "workflow-node",
        key: input.idempotencyKey,
        runId: input.runId,
        resultRef: input.artifact.artifactRef,
      });
      if (input.markApplied) {
        const applied = this.claimIdempotency({ scope: "workflow-applied", key: input.runId, runId: input.runId });
        if (!applied.claimed) throw new Error("Workflow applied marker already exists");
        this.completeIdempotency({
          scope: "workflow-applied",
          key: input.runId,
          runId: input.runId,
          resultRef: input.artifact.artifactRef,
        });
      }
      return this.recordStepAttempt({
        runId: input.runId,
        nodeKey: input.nodeKey,
        attempt: input.attempt,
        status: "completed",
        inputHash: input.inputHash,
        outputHash: input.outputHash,
        artifact: input.artifact,
        durationMs: input.durationMs,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.output === undefined ? {} : { output: input.output }),
      });
    });
    return operation();
  }

  getApplyReconciliation(runId: string): WorkflowApplyReconciliationRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM workflow_apply_reconciliations WHERE run_id = ?").get(runId) as Row | undefined;
    if (!row) return undefined;
    const common = {
      runId: String(row.run_id),
      proposalId: String(row.proposal_id),
      resultRef: String(row.result_ref),
    };
    return String(row.status) === "applied"
      ? { ...common, status: "applied", candidateHash: String(row.candidate_hash), appliedRevision: String(row.applied_revision) }
      : { ...common, status: "conflict", ...(row.candidate_hash ? { candidateHash: String(row.candidate_hash) } : {}), conflictCode: String(row.conflict_code) };
  }

  /**
   * Commits the reconciliation evidence, stable repair effect, applied marker,
   * and next product state in one SQLite transaction.
   */
  completeApplyReconciliation(input: Readonly<{
    runId: string;
    proposalId: string;
    candidateHash?: string;
    artifact: WorkflowArtifactHandle;
    outcome: Readonly<{ status: "applied"; appliedRevision: string } | { status: "conflict"; conflictCode: string }>;
  }>): WorkflowApplyReconciliationRecord {
    requiredString(input.proposalId, "proposalId", 128);
    if (input.candidateHash !== undefined && !/^[a-f0-9]{64}$/.test(input.candidateHash)) throw new Error("Invalid reconciled candidate hash");
    if (input.outcome.status === "applied" && input.candidateHash === undefined) throw new Error("Applied reconciliation requires an approved candidate hash");
    if (input.outcome.status === "applied" && !/^[a-f0-9]{64}$/.test(input.outcome.appliedRevision)) throw new Error("Invalid reconciled applied revision");
    if (input.outcome.status === "conflict" && !/^[a-z][a-z0-9_-]{2,79}$/.test(input.outcome.conflictCode)) throw new Error("Invalid reconciliation conflict code");
    this.requireVerifiedReadyArtifact(input.runId, input.artifact);
    const operation = this.#database.transaction(() => {
      const existing = this.getApplyReconciliation(input.runId);
      if (existing) {
        if (existing.proposalId !== input.proposalId || existing.candidateHash !== input.candidateHash || existing.status !== input.outcome.status) {
          throw new Error("Workflow apply reconciliation is immutable");
        }
        return existing;
      }
      const run = this.getRunRequired(input.runId);
      const approval = this.getApproval(input.runId);
      if (run.status !== "blocked" || run.currentNode !== "apply" || approval?.decision !== "approved" || approval.proposalId !== input.proposalId) {
        throw new Error("Workflow apply reconciliation requires the blocked approved proposal");
      }
      if (this.getNodeEffectState(input.runId, "apply") === "none" || this.getIdempotency("workflow-applied", input.runId)) {
        throw new Error("Workflow apply reconciliation requires an indeterminate unmarked apply");
      }
      const repair = this.getIdempotency("workflow-apply-reconcile", input.runId);
      if (!repair || repair.runId !== input.runId) throw new Error("Workflow apply reconciliation requires its stable claim");
      const timestamp = now();
      this.#database.prepare(`INSERT INTO workflow_apply_reconciliations
        (run_id, proposal_id, candidate_hash, status, applied_revision, result_ref, conflict_code, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          input.runId,
          input.proposalId,
          input.candidateHash,
          input.outcome.status,
          input.outcome.status === "applied" ? input.outcome.appliedRevision : null,
          input.artifact.artifactRef,
          input.outcome.status === "conflict" ? input.outcome.conflictCode : null,
          timestamp,
          timestamp,
        );
      const completedRepair = this.#database.prepare(`UPDATE workflow_idempotency SET completed = 1, result_ref = ?, updated_at = ?
        WHERE scope = 'workflow-apply-reconcile' AND idempotency_key = ? AND run_id = ?`)
        .run(input.artifact.artifactRef, timestamp, input.runId, input.runId);
      if (completedRepair.changes !== 1) throw new Error("Workflow apply reconciliation lost its stable claim");
      if (input.outcome.status === "applied") {
        this.#database.prepare(`INSERT INTO workflow_idempotency
          (scope, idempotency_key, run_id, result_ref, completed, created_at, updated_at)
          VALUES ('workflow-applied', ?, ?, ?, 1, ?, ?)`)
          .run(input.runId, input.runId, input.artifact.artifactRef, timestamp, timestamp);
        this.#database.prepare("UPDATE workflow_runs SET status = 'queued', current_node = 'verify', updated_at = ? WHERE run_id = ?")
          .run(timestamp, input.runId);
      } else {
        this.#database.prepare("UPDATE workflow_runs SET status = 'blocked', current_node = 'apply', updated_at = ? WHERE run_id = ?")
          .run(timestamp, input.runId);
      }
      this.change(input.runId, `apply-reconciliation-${input.outcome.status}`, timestamp);
      return this.getApplyReconciliation(input.runId)!;
    });
    return operation();
  }

  /** Also accounts for reconciliation or an executor owned by another host. */
  hasActiveWorkLease(workId: string): boolean {
    return this.listActiveWorkRunIds(workId).length > 0;
  }

  listActiveWorkRunIds(workId: string): readonly string[] {
    return (this.#database.prepare(`SELECT lease.run_id FROM workflow_run_leases AS lease
      JOIN workflow_runs AS run ON run.run_id = lease.run_id
      WHERE json_extract(run.target_json, '$.workId') = ? AND lease.expires_at > ?`)
      .all(workId, Date.now()) as Row[]).map((row) => String(row.run_id));
  }

  acquireRunLease(input: { readonly runId: string; readonly ownerToken: string; readonly ownerPid: number; readonly ttlMs: number }): boolean {
    if (!Number.isInteger(input.ownerPid) || input.ownerPid < 1 || !Number.isInteger(input.ttlMs) || input.ttlMs < 1_000) throw new Error("Invalid workflow lease owner");
    const operation = this.#database.transaction(() => {
      this.getRunRequired(input.runId);
      const current = Date.now();
      const existing = this.#database.prepare("SELECT owner_token, owner_pid, expires_at FROM workflow_run_leases WHERE run_id = ?").get(input.runId) as Row | undefined;
      if (existing) {
        const token = String(existing.owner_token);
        const pid = Number(existing.owner_pid);
        const expiresAt = Number(existing.expires_at);
        if (token !== input.ownerToken && (expiresAt > current || isProcessAlive(pid))) return false;
      }
      const timestamp = now();
      this.#database.prepare(`INSERT INTO workflow_run_leases (run_id, owner_token, owner_pid, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET owner_token = excluded.owner_token, owner_pid = excluded.owner_pid, expires_at = excluded.expires_at, updated_at = excluded.updated_at`)
        .run(input.runId, input.ownerToken, input.ownerPid, current + input.ttlMs, timestamp);
      this.change(input.runId, "lease-acquired", timestamp);
      return true;
    });
    return operation();
  }

  assertAndRenewRunLease(input: { readonly runId: string; readonly ownerToken: string; readonly ownerPid: number; readonly ttlMs: number }): void {
    const timestamp = now();
    const result = this.#database.prepare(`UPDATE workflow_run_leases SET expires_at = ?, updated_at = ?
      WHERE run_id = ? AND owner_token = ? AND owner_pid = ? AND expires_at >= ?`)
      .run(Date.now() + input.ttlMs, timestamp, input.runId, input.ownerToken, input.ownerPid, Date.now());
    if (result.changes !== 1) throw new Error("Workflow run lease was lost");
  }

  releaseRunLease(runId: string, ownerToken: string): void {
    this.#database.prepare("DELETE FROM workflow_run_leases WHERE run_id = ? AND owner_token = ?").run(runId, ownerToken);
  }

  recordBudgetEvent(input: { runId: string; kind: WorkflowBudgetEventKind; delta: number; reason: string }): void {
    const operation = this.#database.transaction(() => {
      const timestamp = now();
      this.#database.prepare("INSERT INTO workflow_budget_events (run_id, kind, delta, reason, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(input.runId, input.kind, input.delta, input.reason, timestamp);
      this.change(input.runId, "budget-event-recorded", timestamp);
    });
    operation();
  }

  getApproval(runId: string): { readonly proposalId: string; readonly decision?: "approved" | "rejected" } | undefined {
    const row = this.#database.prepare("SELECT proposal_id, decision FROM workflow_approvals WHERE run_id = ?").get(runId) as Row | undefined;
    return row ? { proposalId: String(row.proposal_id), ...(row.decision ? { decision: String(row.decision) as "approved" | "rejected" } : {}) } : undefined;
  }

  hasApprovalProposal(proposalId: string): boolean {
    requiredString(proposalId, "proposalId", 128);
    return this.#database.prepare("SELECT 1 FROM workflow_approvals WHERE proposal_id = ? LIMIT 1").get(proposalId) !== undefined;
  }

  getChangeSequence(): number {
    return Number((this.#database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM workflow_change_sequence").get() as Row).sequence);
  }

  enqueueConversationPublication(input: WorkflowConversationPublication): void {
    const operation = this.#database.transaction(() => {
      if (this.getRun(input.runId)?.sessionId !== input.sessionId) throw new Error("Workflow publication session owner mismatch");
      if (!input.publicationId || !input.payloadJson) throw new Error("Workflow publication requires an identity and public payload");
      const payload = WorkflowPublicationSchema.parse(JSON.parse(input.payloadJson));
      if (payload.messageId !== input.publicationId) throw new Error("Workflow publication identity does not match its public payload");
      const prior = this.#database.prepare("SELECT run_id, session_id, payload_json FROM workflow_conversation_publications WHERE publication_id = ?").get(input.publicationId) as Row | undefined;
      if (prior) {
        if (prior.run_id !== input.runId || prior.session_id !== input.sessionId || prior.payload_json !== input.payloadJson) throw new Error("Workflow publication is immutable and already has different content");
        return;
      }
      this.#database.prepare("INSERT INTO workflow_conversation_publications (publication_id, run_id, session_id, payload_json) VALUES (?, ?, ?, ?)")
        .run(input.publicationId, input.runId, input.sessionId, input.payloadJson);
    });
    operation();
  }

  listConversationPublications(sessionId: string): readonly WorkflowConversationPublication[] {
    return (this.#database.prepare("SELECT publication_id, run_id, session_id, payload_json FROM workflow_conversation_publications WHERE session_id = ? AND disposition = 'pending' ORDER BY sequence").all(sessionId) as Row[])
      .map((row) => ({ publicationId: String(row.publication_id), runId: String(row.run_id), sessionId: String(row.session_id), payloadJson: String(row.payload_json) }));
  }

  getConversationPublication(sessionId: string, publicationId: string): WorkflowConversationPublication | undefined {
    const row = this.#database.prepare("SELECT publication_id, run_id, session_id, payload_json FROM workflow_conversation_publications WHERE session_id = ? AND publication_id = ?")
      .get(sessionId, publicationId) as Row | undefined;
    return row ? { publicationId: String(row.publication_id), runId: String(row.run_id), sessionId: String(row.session_id), payloadJson: String(row.payload_json) } : undefined;
  }

  /** Caller must confirm actual Session persistence, never just in-memory append. */
  acknowledgeConversationPublication(sessionId: string, publicationId: string, disposition: "delivered" | "superseded" = "delivered"): void {
    const result = this.#database.prepare("UPDATE workflow_conversation_publications SET disposition = ? WHERE publication_id = ? AND session_id = ? AND disposition IN ('pending', ?)")
      .run(disposition, publicationId, sessionId, disposition);
    if (result.changes !== 1) throw new Error("Workflow publication session owner mismatch");
  }

  private requireMatchingChapterWriteClaim(existing: ChapterWriteEffect, input: ChapterWriteClaimInput): ChapterWriteEffect {
    const matches = existing.candidateHash === input.candidateHash
      && existing.candidateRef === input.candidateRef
      && existing.operation === input.operation
      && existing.reservedChapterId === (input.operation === "create" ? input.reservedChapterId : undefined)
      && existing.chapterId === (input.operation === "replace" ? input.chapterId : existing.status === "completed" ? existing.chapterId : undefined)
      && existing.expectedRevision === (input.operation === "replace" ? input.expectedRevision : undefined);
    if (!matches) throw new Error("Chapter write claim conflicts with the durable claim");
    return existing;
  }

  private requireActiveChapterWriteLease(input: { readonly runId: string; readonly nodeId: ChapterWriteNodeId } & ChapterWriteLeaseIdentity): WorkflowRunRecord {
    const run = this.getRunRequired(input.runId);
    if (isTerminalWorkflowStatus(run.status)) throw new Error("Cannot mutate a chapter write for a terminal workflow run");
    if ((run.status !== "running" && run.status !== "retrying") || run.currentNode !== input.nodeId) {
      throw new Error("Chapter write requires the active workflow run at the claimed node");
    }
    if (!this.hasExactActiveChapterWriteLease(input)) throw new Error("Workflow run lease was lost");
    return run;
  }

  private requireBlockedChapterWriteLease(input: { readonly runId: string; readonly nodeId: ChapterWriteNodeId } & ChapterWriteLeaseIdentity): WorkflowRunRecord {
    const run = this.getRunRequired(input.runId);
    if (run.status !== "blocked" || run.currentNode !== input.nodeId) throw new Error("Chapter write conflict lost its blocked workflow run");
    if (!this.hasExactActiveChapterWriteLease(input)) throw new Error("Workflow run lease was lost after chapter write conflict");
    return run;
  }

  private hasExactActiveChapterWriteLease(input: { readonly runId: string } & ChapterWriteLeaseIdentity): boolean {
    return Boolean(this.#database.prepare(`SELECT 1 FROM workflow_run_leases
      WHERE run_id = ? AND owner_token = ? AND owner_pid = ? AND expires_at >= ?`)
      .get(input.runId, input.ownerToken, input.ownerPid, Date.now()));
  }

  private getRunRequired(runId: string): WorkflowRunRecord {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Unknown workflow run: ${runId}`);
    return run;
  }

  private change(runId: string, changeKind: string, timestamp: string): void {
    this.#database.prepare("INSERT INTO workflow_change_sequence (run_id, change_kind, created_at) VALUES (?, ?, ?)").run(runId, changeKind, timestamp);
  }

  private requireVerifiedReadyArtifact(runId: string, artifact: WorkflowArtifactHandle): void {
    const record = this.getArtifact(artifact.artifactRef);
    if (!record || record.runId !== runId || record.status !== "ready") throw new Error("Completed artifact-backed steps require a ready stored artifact");
    if (record.sha256 !== artifact.sha256 || record.byteSize !== artifact.byteSize) throw new Error("Artifact handle does not match stored integrity metadata");
    try {
      const bytes = readFileSync(this.resolveArtifactPath(record.relativePath));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== record.byteSize || sha256 !== record.sha256) throw new Error("artifact-integrity-mismatch");
    } catch (error) {
      this.quarantineArtifact(artifact.artifactRef, error instanceof Error ? error.message : "artifact-read-failed");
      throw new Error("Artifact integrity verification failed before completed step commit");
    }
  }

  private resolveArtifactPath(relativePath: string): string {
    if (!relativePath || isAbsolute(relativePath)) throw new Error("Invalid relative artifact path");
    const root = resolve(this.#artifactRoot);
    const candidate = resolve(root, relativePath);
    const fromRoot = relative(root, candidate);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error("Invalid relative artifact path");
    return candidate;
  }
}

export const isTerminalWorkflowStatus = (status: WorkflowRunStatusValue): boolean => terminalStatuses.has(status);

function isTerminalStepStatus(status: WorkflowStepStatusValue): boolean {
  return status === "completed" || status === "blocked" || status === "failed" || status === "skipped" || status === "cancelled";
}

function canTransitionStep(from: WorkflowStepStatusValue, to: WorkflowStepStatusValue): boolean {
  if (from === to) return true;
  if (from === "waiting") return to === "running" || to === "blocked" || to === "cancelled";
  if (from === "running") return to === "retrying" || isTerminalStepStatus(to);
  if (from === "retrying") return to === "running" || isTerminalStepStatus(to);
  return false;
}

function sameStep(left: WorkflowStepRecord, right: WorkflowStepRecord): boolean {
  return left.runId === right.runId && left.nodeKey === right.nodeKey && left.attempt === right.attempt && left.uiGroup === right.uiGroup && left.uiLabel === right.uiLabel && left.groupOrder === right.groupOrder && left.status === right.status && left.inputHash === right.inputHash && left.outputHash === right.outputHash && left.artifactRef === right.artifactRef && left.summary === right.summary && left.output === right.output && left.durationMs === right.durationMs && left.errorCategory === right.errorCategory && left.errorCode === right.errorCode;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another account; fail closed.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
