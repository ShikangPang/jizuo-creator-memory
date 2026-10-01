import { createHash, randomUUID } from "node:crypto";

import {
  ChapterWorkflowTarget,
  ChapterTarget,
  ControlChapterWorkflowInput,
  DecideWorkflowApprovalInput,
  ExtendWorkflowBudgetInput,
  GetWorkflowRunInput,
  ListWorkflowRunsInput,
  StartChapterWorkflowInput,
  type WorkflowRunDetailProjection,
  type WorkflowRunAvailableAction,
  type WorkflowRunProjection,
} from "@jizuo/contracts";

import { WorkflowRunError, publicWorkflowError, publicFailureSummary } from "./errors.ts";
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "./definition.ts";
import { sha256 } from "./hash.ts";
import { supportsDirectChapterWrite, validateWorkflowDefinition } from "./invariants.ts";
import { sanitizeWorkflowStepOutput, sanitizeWorkflowStepSummary, WorkflowProjectionService } from "./projection.ts";
import { defaultWorkflowRegistry } from "./registry.ts";
import { isTerminalWorkflowStatus, type WorkflowArtifactHandle, type WorkflowRepository, type WorkflowRunRecord } from "./repository.ts";
import { WORKFLOW_RUN_LEASE_TTL_MS, WorkflowRunLeaseHeartbeat, WorkflowSupervisor, type WorkflowExecutionPort, type WorkflowExecutionResult } from "./runSupervisor.ts";

export interface FrozenWorkflowStartConfig {
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly definitionHash: string;
  readonly definitionContents: string;
  readonly revisionBudget: number;
}

export interface WorkflowArtifactWriter {
  write(input: Readonly<{ runId: string; kind: "frozen-definition" | "other"; contents: string }>): Promise<WorkflowArtifactHandle>;
  read(artifactRef: string): Promise<Buffer>;
}

export interface WorkflowAuthorizationPort {
  authorizeProposal(proposalId: string): Promise<string>;
  rejectProposal?(proposalId: string): Promise<void>;
}

export interface WorkflowParentSessionPort {
  hasParentSession(sessionId: string): boolean;
}

export type WorkflowApplyReconciliationResult = Readonly<{ proposalId: string } & (
  | {
    status: "applied";
    candidateHash: string;
    appliedRevision: string;
    contentHash: string;
    workId: string;
    volumeId: string;
    chapterId: string;
    chapterNumber: number;
  }
  | { status: "conflict"; candidateHash?: string; conflictCode: string }
)>;

/** Narrow host-owned domain reread; it cannot execute a node or obtain approval. */
export interface WorkflowApplyReconciliationPort {
  reconcile(run: WorkflowRunRecord, signal: AbortSignal): Promise<WorkflowApplyReconciliationResult>;
}

export interface WorkflowRunServiceOptions {
  readonly repository: WorkflowRepository;
  readonly projections: WorkflowProjectionService;
  readonly artifacts: WorkflowArtifactWriter;
  readonly execution: WorkflowExecutionPort;
  readonly frozen: FrozenWorkflowStartConfig;
  readonly definitionProvider?: (input: Readonly<{ target: import("@jizuo/contracts").ChapterWorkflowTarget; userRequest: string }>) => Promise<FrozenWorkflowStartConfig>;
  readonly authorization: WorkflowAuthorizationPort;
  readonly parents?: WorkflowParentSessionPort;
  readonly applyReconciliation?: WorkflowApplyReconciliationPort;
  readonly createRunId?: () => string;
}

/**
 * Durable public lifecycle facade. The supervisor only receives a run after
 * its row and frozen-definition artifact have both committed.
 */
export class WorkflowRunService {
  readonly #repository: WorkflowRepository;
  readonly #projections: WorkflowProjectionService;
  readonly #artifacts: WorkflowArtifactWriter;
  readonly #approvalDecisions = new Set<string>();
  readonly #frozen: FrozenWorkflowStartConfig;
  readonly #definitionProvider: WorkflowRunServiceOptions["definitionProvider"];
  readonly #authorization: WorkflowAuthorizationPort;
  readonly #parents: WorkflowParentSessionPort | undefined;
  readonly #applyReconciliation: WorkflowApplyReconciliationPort | undefined;
  readonly #createRunId: () => string;
  readonly #supervisor: WorkflowSupervisor;
  readonly #execution: WorkflowExecutionPort;
  readonly #memoryResumes = new Map<string, Promise<WorkflowRunDetailProjection>>();

  public constructor(options: WorkflowRunServiceOptions) {
    this.#repository = options.repository;
    this.#execution = options.execution;
    this.#projections = options.projections;
    this.#artifacts = options.artifacts;
    this.#frozen = validateFrozen(options.frozen);
    this.#definitionProvider = options.definitionProvider;
    this.#authorization = options.authorization;
    this.#parents = options.parents;
    this.#applyReconciliation = options.applyReconciliation;
    this.#createRunId = options.createRunId ?? (() => `run_${randomUUID().replaceAll("-", "")}`);
    this.#supervisor = new WorkflowSupervisor(options.execution, {
      onStarted: (run) => {
        const current = this.#repository.getRun(run.runId);
        if (current && !isTerminalWorkflowStatus(current.status) && current.status !== "paused") {
          this.#repository.updateRunStatus(run.runId, "running", current.currentNode);
        }
      },
      onSettled: (runId, result) => this.settle(runId, result),
      onFailed: (runId, error) => {
        // If apply crossed its durable claim boundary, the domain write may
        // already exist. Never terminally fail it: park it for host-owned
        // reread reconciliation instead of permitting a blind replay.
        const current = this.#repository.getRun(runId);
        const indeterminateApply = current !== undefined
          && this.#repository.getIdempotency("workflow-applied", runId)?.completed !== true
          && this.#repository.getNodeEffectState(runId, "apply") !== "none";
        // The executor classified this exact round before recording its attempt.
        // Historical completed revisions cannot prove an unresolved current write.
        const currentFailure = this.#repository.listSteps(runId)
          .filter((step) => step.nodeKey === current?.currentNode)
          .sort((left, right) => right.attempt - left.attempt)[0];
        const directWrite = current?.chapterWriteMode === "direct"
          && currentFailure?.errorCode === "workflow_chapter_write_unconfirmed";
        // Compilation, checkpoint reads and pre-node guards can fail before a
        // durable executor records anything. Preserve those failures too, but
        // never replace a node's more precise write/conflict diagnosis.
        if (current && !["failed", "blocked"].includes(currentFailure?.status ?? "")) {
          const failure = publicFailureSummary(error);
          const nodeKey = current.currentNode ?? "runtime-start";
          const attempts = this.#repository.listSteps(runId).filter((step) => step.nodeKey === nodeKey);
          this.#repository.recordStepAttempt({
            runId, nodeKey, attempt: Math.max(0, ...attempts.map((step) => step.attempt)) + 1,
            status: "failed", errorCategory: failure.category, errorCode: failure.code,
            summary: failure.summary,
          });
        }
        this.settle(runId, indeterminateApply ? { status: "blocked", currentNode: "apply" } : directWrite ? { status: "blocked" } : { status: "failed" });
      },
    }, this.#repository);
  }

  async start(raw: unknown, sessionId: string, signal?: AbortSignal): Promise<WorkflowRunDetailProjection> {
    signal?.throwIfAborted();
    const request = StartChapterWorkflowInput.parse(raw);
    const parsedSessionId = validId(sessionId, "sessionId");
    const target = ChapterWorkflowTarget.parse(request.target);
    const previous = await this.findPreviousChapterRun(target, parsedSessionId);
    signal?.throwIfAborted();
    if (previous?.status === "blocked") throw new WorkflowRunError("invalid_state", "本章仍有待核对的工作流结果，请先处理原任务中的阻塞原因");
    if (previous && this.#repository.getControlIntent(previous.runId).pauseRequested && this.#supervisor.isActive(previous.runId)) {
      throw new WorkflowRunError("invalid_state", "工作流正在停止，请稍后再次启动");
    }
    if (previous && (previous.status === "paused" || previous.status === "failed" && (previous.chapterWriteMode === "direct" || this.#repository.hasVerifiedMemoryTail(previous.runId)))) {
      if (previous.frozenDefinitionRef) return this.restart(previous, request.userRequest, signal);
      // An input-storage failure before dispatch has no chapter to continue.
      // Do not pin subsequent starts to an unexecutable, unfrozen run; but never
      // recreate a chapter when missing metadata might hide an earlier effect.
      if (this.#repository.listSteps(previous.runId).some((step) => step.nodeKey !== "freeze-inputs")
        || this.#repository.getNodeEffectState(previous.runId, "initialize-chapter") !== "none"
        || this.#repository.getChapterWrite(previous.runId, "write", 0)) {
        throw new WorkflowRunError("invalid_state", "工作流冻结定义缺失，请先核对已有章节，不能重复创建");
      }
      if (previous.status === "paused") this.#repository.updateRunStatus(previous.runId, "failed");
    }
    const selected = await this.#definitionProvider?.({ target, userRequest: request.userRequest }) ?? this.#frozen;
    signal?.throwIfAborted();
    const { frozen, definition } = validateFrozenDefinition(selected);
    const chapterWriteMode = supportsDirectChapterWrite(definition) ? "direct" as const : "candidate-only" as const;
    const created = this.#repository.createOrGetRun({
      runId: validId(this.#createRunId(), "runId"),
      sessionId: parsedSessionId,
      target,
      workflowId: frozen.workflowId,
      workflowVersion: frozen.workflowVersion,
      frozenDefinitionHash: frozen.definitionHash,
      revisionBudget: frozen.revisionBudget,
      chapterWriteMode,
    });
    if (created.created) {
      try {
        const artifact = await this.#artifacts.write({ runId: created.run.runId, kind: "frozen-definition", contents: frozen.definitionContents });
        this.#repository.setFrozenDefinitionRef(created.run.runId, artifact);
        const frozenRequest = await this.#artifacts.write({ runId: created.run.runId, kind: "other", contents: JSON.stringify({ userRequest: request.userRequest }) });
        this.#repository.setFrozenRequestRef(created.run.runId, frozenRequest);
      } catch (error) {
        const failure = publicFailureSummary(error);
        const summary = `工作流启动资料保存失败，尚未开始章节生成。${failure.summary}`;
        this.#repository.recordStepAttempt({
          runId: created.run.runId, nodeKey: "freeze-inputs", attempt: 1, status: "failed",
          errorCategory: "storage", errorCode: "workflow_input_storage", summary,
        });
        this.#repository.updateRunStatus(created.run.runId, "failed");
        throw new WorkflowRunError("execution_failed", summary);
      }
      if (signal?.aborted) {
        this.#repository.setControlIntent(created.run.runId, { pause: true });
        this.#repository.updateRunStatus(created.run.runId, "paused");
      } else this.dispatchOrPark(created.run.runId);
    } else if (
      created.run.sessionId !== parsedSessionId
      && !this.#supervisor.isActive(created.run.runId)
      && ["waiting_approval", "waiting_decision", "paused"].includes(created.run.status)
    ) {
      const adopted = this.#repository.adoptParkedRun(created.run.runId, created.run.sessionId, parsedSessionId);
      return this.get({ runId: adopted.runId });
    } else if (created.run.sessionId === parsedSessionId && created.run.status === "paused") {
      // Starting again is an explicit request to continue this chapter, not a
      // new creation. The executor resumes its checkpoint and reconciles writes.
      return this.restart(created.run, request.userRequest, signal);
    }
    return this.get({ runId: created.run.runId });
  }

  /** Explicit conversation recovery; never creates a run or re-enters writing. */
  async resumeMemory(sessionId: string, userRequest: string, target?: import("@jizuo/contracts").ChapterTarget, signal?: AbortSignal): Promise<WorkflowRunDetailProjection | undefined> {
    signal?.throwIfAborted();
    const owner = validId(sessionId, "sessionId");
    const chapter = target === undefined ? undefined : ChapterTarget.parse(target);
    const seen = new Set<string>();
    const eligible: WorkflowRunRecord[] = [];
    for (const run of this.#repository.listRuns({ sessionId: owner })) {
      if (chapter && (chapter.workId !== run.target.workId || chapter.volumeId !== run.target.volumeId)) continue;
      const effect = this.#repository.getChapterWrite(run.runId, "write", 0);
      const chapterId = run.target.mode === "modify" ? run.target.chapterId
        : await this.#execution.readChapterIdentity?.(run) ?? effect?.chapterId ?? effect?.reservedChapterId;
      if (!chapterId || chapter && chapter.chapterId !== chapterId) continue;
      const key = `${run.target.workId}/${run.target.volumeId}/${chapterId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (["failed", "paused", "memory_pending", "queued", "running", "retrying"].includes(run.status)
        && this.#repository.hasVerifiedMemoryTail(run.runId)) eligible.push(run);
    }
    signal?.throwIfAborted();
    if (eligible.length > 1) throw new WorkflowRunError("invalid_state", "当前对话有多个章节等待保存记忆，请说明要继续哪一章");
    const run = eligible[0];
    if (!run) return undefined;
    const pending = this.#memoryResumes.get(run.runId);
    if (pending) return pending;
    if (this.#repository.getControlIntent(run.runId).pauseRequested && this.#supervisor.isActive(run.runId)) {
      throw new WorkflowRunError("invalid_state", "工作流正在停止，请稍后再次启动");
    }
    if (this.#supervisor.isActive(run.runId)) {
      // The supervisor persists a failed memory tail immediately before its
      // finally block releases the active slot. Yield once so an immediate
      // user retry cannot be acknowledged and then silently ignored in that
      // narrow cleanup window. A genuinely running recovery is still reused.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal?.throwIfAborted();
      if (this.#supervisor.isActive(run.runId)) return this.get({ runId: run.runId });
    }
    const operation = this.restart(run, userRequest, signal);
    this.#memoryResumes.set(run.runId, operation);
    try { return await operation; }
    finally { if (this.#memoryResumes.get(run.runId) === operation) this.#memoryResumes.delete(run.runId); }
  }

  private async findPreviousChapterRun(target: import("@jizuo/contracts").ChapterWorkflowTarget, sessionId: string): Promise<WorkflowRunRecord | undefined> {
    // Inspect the latest matching run, including completed ones, so an older
    // failed attempt cannot resurrect a chapter that a later run completed.
    for (const run of this.#repository.listRuns({ sessionId })) {
      if (run.target.workId !== target.workId || run.target.volumeId !== target.volumeId) continue;
      if (sameChapterTarget(run.target, target)) return run;
      if (target.mode === "modify" && (run.chapterWriteMode === "direct" || this.#repository.hasVerifiedMemoryTail(run.runId))) {
        const effect = this.#repository.getChapterWrite(run.runId, "write", 0);
        const chapterId = await this.#execution.readChapterIdentity?.(run) ?? effect?.chapterId ?? effect?.reservedChapterId;
        if (chapterId === target.chapterId) return run;
      }
    }
    return undefined;
  }

  private async restart(run: WorkflowRunRecord, userRequest: string, signal?: AbortSignal): Promise<WorkflowRunDetailProjection> {
    if (this.#supervisor.isActive(run.runId)) throw new WorkflowRunError("invalid_state", "工作流正在停止，请稍后再次启动");
    const previous = run.frozenRequestRef
      ? JSON.parse((await this.#artifacts.read(run.frozenRequestRef)).toString("utf8")) as { userRequest?: unknown }
      : {};
    if (run.frozenRequestRef && typeof previous.userRequest !== "string") throw new WorkflowRunError("invalid_state", "原始工作流要求无法核对");
    const original = typeof previous.userRequest === "string" ? previous.userRequest : "";
    const combined = !original || original === userRequest ? userRequest : `${original}\n\n停止后补充要求：\n${userRequest}`;
    if (combined.length > 32_000) throw new WorkflowRunError("invalid_state", "累计创作要求过长，请整理要求后重试");
    const artifact = await this.#artifacts.write({ runId: run.runId, kind: "other", contents: JSON.stringify({ userRequest: combined }) });
    signal?.throwIfAborted();
    this.#repository.restartRun(run.runId, run.frozenRequestRef, artifact);
    this.dispatchOrPark(run.runId);
    return this.get({ runId: run.runId });
  }

  list(raw: unknown = {}): readonly WorkflowRunProjection[] {
    const input = ListWorkflowRunsInput.parse(raw);
    return this.#repository.listRuns(input.sessionId === undefined ? {} : { sessionId: input.sessionId }).filter((run) => !input.statuses || input.statuses.includes(run.status))
      .map((run) => this.project(run));
  }

  /** Historical lifecycle states do not prove that an executor is still running. */
  hasActiveWork(workId: string): boolean {
    return this.#repository.listRuns().some((run) => run.target.workId === workId && this.#supervisor.isActive(run.runId))
      || this.#repository.hasActiveWorkLease(workId);
  }

  getActiveChapterIds(workId: string): ReadonlySet<string> {
    const leasedRuns = new Set(this.#repository.listActiveWorkRunIds(workId));
    const chapters = new Set<string>();
    for (const run of this.#repository.listRuns()) {
      if (run.target.workId !== workId || (!this.#supervisor.isActive(run.runId) && !leasedRuns.has(run.runId))) continue;
      if (run.target.mode === "modify") chapters.add(run.target.chapterId);
      // A create task reserves its new chapter before installing any prose.
      // The predecessor in create_next is only a position, not an occupied chapter.
      const write = this.#repository.getChapterWrite(run.runId, "write", 0);
      const chapterId = write?.chapterId ?? write?.reservedChapterId;
      if (chapterId) chapters.add(chapterId);
    }
    return chapters;
  }

  get(raw: unknown): WorkflowRunDetailProjection {
    const input = GetWorkflowRunInput.parse(raw);
    const run = this.#repository.getRun(input.runId);
    if (!run) throw new WorkflowRunError("not_found", "章节工作流不存在");
    const approval = this.#repository.getApproval(run.runId);
    return {
      ...this.project(run),
      ...(approval ? { approval: { proposalId: approval.proposalId } } : {}),
    };
  }

  /** Session-bound model control. It never accepts a run id or proposal decision. */
  async control(raw: unknown, sessionId: string, signal?: AbortSignal): Promise<WorkflowRunDetailProjection> {
    signal?.throwIfAborted();
    const input = ControlChapterWorkflowInput.parse(raw);
    const owner = validId(sessionId, "sessionId");
    const runs = this.#repository.listRuns({ sessionId: owner });
    if (input.action === "inspect") {
      const latest = runs[0];
      if (!latest) throw new WorkflowRunError("not_found", "当前对话没有章节工作流");
      return this.get({ runId: latest.runId });
    }

    const action: WorkflowRunAvailableAction = input.action;
    const run = runs.find((candidate) => this.availableActions(candidate).includes(action));
    if (!run) throw new WorkflowRunError("invalid_state", "当前对话没有可执行该操作的章节工作流");
    signal?.throwIfAborted();
    if (input.action === "extend_review") {
      return this.extendBudget({ runId: run.runId, additionalRounds: 2 });
    }
    if (input.action === "resume") return this.resume(run.runId);
    if (input.action === "reconcile_apply") return this.reconcileIndeterminateApply(run.runId);
    return this.cancel(run.runId);
  }

  ownsProposal(proposalId: string): boolean {
    return this.#repository.hasApprovalProposal(validId(proposalId, "proposalId"));
  }

  async decideApproval(raw: unknown, decidedBy = "user"): Promise<WorkflowRunDetailProjection> {
    const input = DecideWorkflowApprovalInput.parse(raw);
    if (this.#approvalDecisions.has(input.runId)) throw new WorkflowRunError("invalid_state", "提案正在处理中，请稍后核对结果");
    this.#approvalDecisions.add(input.runId);
    try {
      const run = this.requireRun(input.runId);
      if (run.status !== "waiting_approval" && run.status !== "paused") throw new WorkflowRunError("invalid_state", "当前工作流不在等待审批状态");
      const pending = this.#repository.getApproval(run.runId);
      if (!pending || pending.proposalId !== input.proposalId) throw new WorkflowRunError("invalid_state", "审批提案与当前工作流不一致");
      if (input.decision === "rejected") {
        if (!this.#authorization.rejectProposal) throw new WorkflowRunError("authorization_failed", "提案拒绝能力不可用，请重试");
        try {
          await this.#authorization.rejectProposal(input.proposalId);
        } catch {
          // Keep the workflow waiting until the durable proposal file confirms
          // the rejection. Never publish a rejected run with a pending proposal.
          throw new WorkflowRunError("authorization_failed", "提案拒绝未能保存，请重试");
        }
        this.#repository.recordApproval({ runId: run.runId, proposalId: input.proposalId, decision: "rejected", decidedBy });
        this.#repository.updateRunStatus(run.runId, "rejected", "approval");
        return this.get({ runId: run.runId });
      }
      let authorization: string;
      try {
        authorization = await this.#authorization.authorizeProposal(input.proposalId);
      } catch (error) {
        if (authorizationFailureCode(error) === "revision_conflict") this.cancel(run.runId);
        throw new WorkflowRunError("authorization_failed", authorizationFailureMessage(error));
      }
      this.#repository.recordApproval({
        runId: run.runId,
        proposalId: input.proposalId,
        decision: "approved",
        decidedBy,
        resumeTokenHash: createHash("sha256").update(authorization).digest("hex"),
      });
      this.#repository.updateRunStatus(run.runId, "running", "apply");
      this.#supervisor.dispatch(this.requireRun(run.runId), { decision: "approved", authorization });
      return this.get({ runId: run.runId });
    } finally {
      this.#approvalDecisions.delete(input.runId);
    }
  }

  extendBudget(raw: unknown): WorkflowRunDetailProjection {
    const input = ExtendWorkflowBudgetInput.parse(raw);
    const run = this.requireRun(input.runId);
    if (run.status !== "waiting_decision" && run.status !== "paused") throw new WorkflowRunError("invalid_state", "当前工作流不能扩展修订预算");
    this.#repository.extendRevisionBudget(run.runId, input.additionalRounds);
    this.#repository.updateRunStatus(run.runId, "queued", "revise");
    this.dispatchOrPark(run.runId);
    return this.get({ runId: run.runId });
  }

  pause(runId: string): WorkflowRunDetailProjection {
    const run = this.requireRun(runId);
    if (isTerminalWorkflowStatus(run.status)) throw new WorkflowRunError("invalid_state", "已结束的工作流不能暂停");
    this.#repository.setControlIntent(run.runId, { pause: true });
    if (!this.#supervisor.requestPause(run.runId)) this.#repository.updateRunStatus(run.runId, "paused", run.currentNode);
    return this.get({ runId: run.runId });
  }

  resume(runId: string): WorkflowRunDetailProjection {
    const run = this.requireRun(runId);
    if (isTerminalWorkflowStatus(run.status)) throw new WorkflowRunError("invalid_state", "已结束的工作流不能恢复");
    if (this.#supervisor.isActive(runId)) throw new WorkflowRunError("invalid_state", "工作流正在停止，请稍后再次启动");
    this.#repository.clearControlIntent(run.runId);
    this.#repository.updateRunStatus(run.runId, "queued", run.currentNode);
    this.dispatchOrPark(run.runId);
    return this.get({ runId: run.runId });
  }

  cancel(runId: string): WorkflowRunDetailProjection {
    const run = this.requireRun(runId);
    if (isTerminalWorkflowStatus(run.status)) return this.get({ runId });
    this.#repository.setControlIntent(run.runId, { cancel: true });
    const afterApply = this.#repository.getIdempotency("workflow-applied", run.runId)?.completed === true;
    const possiblyApplied = !afterApply && this.#repository.getNodeEffectState(run.runId, "apply") !== "none";
    if (possiblyApplied) {
      // The external chapter write may have succeeded after the apply claim but
      // before its durable marker. Never label it cancelled or retry blindly.
      this.#repository.updateRunStatus(run.runId, "blocked", "apply");
      return this.get({ runId: run.runId });
    }
    if (afterApply) {
      // A confirmed apply is immutable. The active graph is allowed to reach
      // verify at its next boundary; a stopped process is parked at verify,
      // never labelled cancelled or allowed to re-enter application.
      if (!this.#supervisor.requestCancel(run.runId)) this.#repository.updateRunStatus(run.runId, "paused", "verify");
    } else if (!this.#supervisor.requestCancel(run.runId)) {
      this.#repository.updateRunStatus(run.runId, "cancelled", run.currentNode);
    }
    return this.get({ runId: run.runId });
  }

  recoverNonterminal(): readonly WorkflowRunProjection[] {
    this.#repository.cancelLegacyProposalRuns();
    const recovered: WorkflowRunProjection[] = [];
    for (const run of this.#repository.listRuns({ nonterminalOnly: true })) {
      const intent = this.#repository.getControlIntent(run.runId);
      const approval = this.#repository.getApproval(run.runId);
      const applied = this.#repository.getIdempotency("workflow-applied", run.runId)?.completed === true;
      const possiblyApplied = !applied && this.#repository.getNodeEffectState(run.runId, "apply") !== "none";
      if (possiblyApplied) {
        this.#repository.updateRunStatus(run.runId, "blocked", "apply");
      } else if (intent.cancelRequested && !applied && run.status !== "memory_pending") {
        this.#repository.updateRunStatus(run.runId, "cancelled", run.currentNode);
      } else if (intent.pauseRequested) {
        this.#repository.updateRunStatus(run.runId, "paused", run.currentNode);
      } else if (approval?.decision === "approved" && run.currentNode === "apply") {
        // The raw one-time authorization is intentionally process-local. A
        // process restart cannot replay approval into apply without a fresh UI
        // confirmation, so park instead of fabricating/reusing a capability.
        this.#repository.updateRunStatus(run.runId, "paused", run.currentNode);
      } else if (!this.parentMissing(run)) {
        if (intent.cancelRequested && applied) this.#repository.updateRunStatus(run.runId, "running", "verify");
        this.dispatchOrPark(run.runId);
      } else {
        this.#repository.recordIdempotency({ scope: "parent-wait", key: run.runId, runId: run.runId, completed: false });
        this.#repository.updateRunStatus(run.runId, "paused", run.currentNode);
      }
      recovered.push(this.project(this.requireRun(run.runId)));
    }
    return recovered;
  }

  /**
   * Repairs only an indeterminate, already-approved apply by domain reread.
   * It never receives an authorization token and cannot invoke apply again.
   */
  async reconcileIndeterminateApply(runId: string): Promise<WorkflowRunDetailProjection> {
    const run = this.requireRun(runId);
    const existing = this.#repository.getApplyReconciliation(run.runId);
    if (existing) {
      if (existing.status === "applied" && this.requireRun(run.runId).status === "queued") this.dispatchOrPark(run.runId);
      return this.get({ runId: run.runId });
    }
    if (!this.#applyReconciliation) throw new WorkflowRunError("invalid_state", "当前宿主未配置应用对账能力");
    const approval = this.#repository.getApproval(run.runId);
    if (!this.canReconcileApply(run) || approval === undefined) {
      throw new WorkflowRunError("invalid_state", "当前工作流不属于可对账的应用中断");
    }

    const leaseToken = randomUUID();
    if (!this.#repository.acquireRunLease({ runId: run.runId, ownerToken: leaseToken, ownerPid: process.pid, ttlMs: WORKFLOW_RUN_LEASE_TTL_MS })) {
      throw new WorkflowRunError("invalid_state", "工作流正在由另一宿主修复");
    }
    const controller = new AbortController();
    const heartbeat = new WorkflowRunLeaseHeartbeat(this.#repository, run.runId, leaseToken, controller);
    heartbeat.start();
    let shouldDispatch = false;
    try {
      const claim = this.#repository.claimIdempotency({ scope: "workflow-apply-reconcile", key: run.runId, runId: run.runId });
      if (!claim.claimed && claim.completed) return this.get({ runId: run.runId });
      let result: WorkflowApplyReconciliationResult;
      try {
        result = await this.#applyReconciliation.reconcile(run, controller.signal);
      } catch {
        result = {
          proposalId: approval.proposalId,
          status: "conflict",
          conflictCode: "domain_evidence_unavailable",
        };
      }
      if (result.proposalId !== approval.proposalId || (result.candidateHash !== undefined && !/^[a-f0-9]{64}$/.test(result.candidateHash))) {
        throw new WorkflowRunError("invalid_state", "应用对账结果与已审批提案不一致");
      }
      const outcome = result.status === "applied"
        ? { status: "applied" as const, appliedRevision: requiredHash(result.appliedRevision, "appliedRevision") }
        : { status: "conflict" as const, conflictCode: validConflictCode(result.conflictCode) };
      if (result.status === "applied") {
        requiredHash(result.contentHash, "contentHash");
        if (result.contentHash !== result.candidateHash || result.appliedRevision !== result.candidateHash) {
          throw new WorkflowRunError("invalid_state", "领域重读未匹配已审批正文哈希");
        }
      }
      const artifact = await this.#artifacts.write({
        runId: run.runId,
        kind: "other",
        contents: JSON.stringify(result.status === "applied" ? {
          status: result.status,
          proposalId: result.proposalId,
          ...(result.candidateHash === undefined ? {} : { candidateHash: result.candidateHash }),
          appliedRevision: result.appliedRevision,
          contentHash: result.contentHash,
          workId: result.workId,
          volumeId: result.volumeId,
          chapterId: result.chapterId,
          chapterNumber: result.chapterNumber,
        } : {
          status: result.status,
          proposalId: result.proposalId,
          candidateHash: result.candidateHash,
          conflictCode: result.conflictCode,
        }),
      });
      heartbeat.assertOwned();
      this.#repository.completeApplyReconciliation({
        runId: run.runId,
        proposalId: result.proposalId,
        ...(result.candidateHash === undefined ? {} : { candidateHash: result.candidateHash }),
        artifact,
        outcome,
      });
      shouldDispatch = result.status === "applied";
    } finally {
      heartbeat.stop();
      this.#repository.releaseRunLease(run.runId, leaseToken);
    }
    if (shouldDispatch) this.dispatchOrPark(run.runId);
    return this.get({ runId: run.runId });
  }

  async waitForChange(input: { readonly sessionId: string; readonly afterSequence: number; readonly timeoutMs: number }, signal?: AbortSignal): Promise<{
    readonly sequence: number;
    readonly changed: boolean;
    readonly runs: readonly WorkflowRunProjection[];
  }> {
    const sessionId = validId(input.sessionId, "sessionId");
    const afterSequence = Math.max(0, Math.floor(input.afterSequence));
    const timeoutMs = Math.min(25_000, Math.max(0, Math.floor(input.timeoutMs)));
    const current = () => this.#repository.getChangeSequence();
    if (current() <= afterSequence && timeoutMs > 0) await waitForCursor(current, afterSequence, timeoutMs, signal);
    const currentSequence = current();
    const changed = currentSequence > afterSequence;
    // A reconnecting client may carry a cursor from a newer database/process.
    // Never move it backward on an unchanged long-poll response.
    const sequence = changed ? currentSequence : Math.max(afterSequence, currentSequence);
    return { sequence, changed, runs: this.list({ sessionId }) };
  }

  dispose(): void { this.#supervisor.dispose(); }

  /** Called only when the exact Harness parent session is recreated. */
  resumeParentSession(sessionId: string): readonly WorkflowRunProjection[] {
    const resumed: WorkflowRunProjection[] = [];
    for (const run of this.#repository.listRuns({ sessionId })) {
      if (run.status !== "paused" || !this.#repository.getIdempotency("parent-wait", run.runId)) continue;
      const intent = this.#repository.getControlIntent(run.runId);
      if (intent.pauseRequested || intent.cancelRequested) continue;
      if (this.parentMissing(run)) continue;
      this.#repository.clearIdempotency("parent-wait", run.runId);
      this.#repository.updateRunStatus(run.runId, "queued", run.currentNode);
      this.dispatchOrPark(run.runId);
      resumed.push(this.project(this.requireRun(run.runId)));
    }
    return resumed;
  }

  private dispatchOrPark(runId: string): void {
    const run = this.requireRun(runId);
    if (isTerminalWorkflowStatus(run.status) || run.status === "paused" || run.status === "waiting_approval" || run.status === "waiting_decision") return;
    if (this.parentMissing(run)) {
      this.#repository.recordIdempotency({ scope: "parent-wait", key: run.runId, runId: run.runId, completed: false });
      this.#repository.updateRunStatus(run.runId, "paused", run.currentNode);
      return;
    }
    this.#supervisor.dispatch(run);
  }

  private parentMissing(run: WorkflowRunRecord): boolean {
    return this.#parents !== undefined && !this.#parents.hasParentSession(run.sessionId);
  }

  private settle(runId: string, result: WorkflowExecutionResult): void {
    const current = this.#repository.getRun(runId);
    if (!current || isTerminalWorkflowStatus(current.status)) return;
    const control = this.#repository.getControlIntent(runId);
    // An execution result may contain only a terminal status. Never erase the
    // last node written by the durable executor: it is the authoritative safe
    // boundary for terminal progress and cancellation projection.
    const currentNode = result.currentNode ?? current.currentNode;
    if (result.status === "completed" && current.chapterWriteMode === "direct"
      && this.#repository.getNodeEffectState(runId, "save-memory") !== "completed") {
      this.#repository.updateRunStatus(runId, "blocked", currentNode);
      return;
    }
    if (control.pauseRequested && result.status === "running") {
      this.#repository.updateRunStatus(runId, "paused", currentNode);
      return;
    }
    if (control.cancelRequested && result.status !== "completed" && result.status !== "memory_pending") {
      this.#repository.updateRunStatus(runId, "cancelled", currentNode);
      return;
    }
    this.#repository.updateRunStatus(runId, result.status, currentNode);
    if (isTerminalWorkflowStatus(result.status) || result.status === "completed") this.#repository.clearControlIntent(runId);
  }

  private requireRun(runId: string): WorkflowRunRecord {
    const run = this.#repository.getRun(validId(runId, "runId"));
    if (!run) throw new WorkflowRunError("not_found", "章节工作流不存在");
    return run;
  }

  private project(run: WorkflowRunRecord): WorkflowRunProjection {
    const stored = this.#projections.getRun(run.runId);
    if (!stored) throw new WorkflowRunError("not_found", "章节工作流不存在");
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      target: run.target,
      status: stored.status,
      availableActions: this.availableActions(run),
      currentGroup: stored.currentGroup,
      totalGroups: stored.totalGroups,
      ...(stored.draftRetained ? { draftRetained: true } : {}),
      revision: stored.revision,
      steps: stored.steps.map((step) => ({
        key: step.group,
        label: step.label.slice(0, 40),
        status: step.status,
        attempt: step.attempt,
        ...(step.warning === true ? { warning: true } : {}),
        ...(() => {
          const summary = sanitizeWorkflowStepSummary(step.summary);
          return summary === undefined ? {} : { summary };
        })(),
        ...(() => {
          const output = sanitizeWorkflowStepOutput(step.output);
          return output === undefined ? {} : { output };
        })(),
        ...(run.chapterWriteMode === "direct" && run.status === "blocked"
          && (run.currentNode === "write" || run.currentNode === "revise")
          && stored.currentGroup - 1 === stored.steps.indexOf(step)
          && (step.summary === undefined || step.summary === "章节草稿已保留，但无法确认本轮写入结果")
          ? { summary: stored.draftRetained
            ? "章节草稿已保留，但无法确认本轮写入结果"
            : "尚未确认章节写入；需恢复核对本轮写入结果。" } : {}),
        ...(run.status === "paused" && this.parentMissing(run) && stored.currentGroup - 1 === stored.steps.indexOf(step) ? { summary: "等待原会话恢复" } : {}),
        ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
      })),
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }

  private availableActions(run: WorkflowRunRecord): WorkflowRunAvailableAction[] {
    if (run.status === "blocked") {
      return this.canReconcileApply(run) ? ["reconcile_apply"] : [];
    }
    if (isTerminalWorkflowStatus(run.status)) return [];

    const actions: WorkflowRunAvailableAction[] = [];
    if (run.status === "waiting_approval") {
      const approval = this.#repository.getApproval(run.runId);
      if (approval !== undefined && approval.decision === undefined) {
        actions.push("approve_proposal", "reject_proposal");
      }
    } else if (run.status === "waiting_decision" && run.revisionBudget + 2 <= run.revisionHardMaximum) {
      actions.push("extend_review");
    } else if (run.status === "paused" && !this.parentMissing(run) && !this.#supervisor.isActive(run.runId)) {
      actions.push("resume");
    }
    if (!this.#repository.getControlIntent(run.runId).cancelRequested) actions.push("cancel");
    return actions;
  }

  private canReconcileApply(run: WorkflowRunRecord): boolean {
    return this.#applyReconciliation !== undefined
      && run.status === "blocked"
      && run.currentNode === "apply"
      && this.#repository.getApproval(run.runId)?.decision === "approved"
      && this.#repository.getApplyReconciliation(run.runId) === undefined
      && this.#repository.getIdempotency("workflow-applied", run.runId) === undefined
      && this.#repository.getNodeEffectState(run.runId, "apply") !== "none";
  }
}

function sameChapterTarget(left: import("@jizuo/contracts").ChapterWorkflowTarget, right: import("@jizuo/contracts").ChapterWorkflowTarget): boolean {
  if (left.workId !== right.workId || left.volumeId !== right.volumeId || left.mode !== right.mode) return false;
  if (left.mode === "modify" && right.mode === "modify") return left.chapterId === right.chapterId;
  if (left.mode === "create_next" && right.mode === "create_next") return left.afterChapterId === right.afterChapterId;
  return left.mode === "create_explicit" && right.mode === "create_explicit" && left.title === right.title;
}

function validId(value: string, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{3,127}$/.test(value)) throw new WorkflowRunError("invalid_state", `无效的${field}`);
  return value;
}

function requiredHash(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new WorkflowRunError("invalid_state", `无效的${field}`);
  return value;
}

function validConflictCode(value: string): string {
  if (!/^[a-z][a-z0-9_-]{2,79}$/.test(value)) throw new WorkflowRunError("invalid_state", "无效的应用对账冲突分类");
  return value;
}

function authorizationFailureCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function authorizationFailureMessage(error: unknown): string {
  const code = authorizationFailureCode(error);
  if (code === "revision_conflict") {
    return "提案已经应用，但正文随后发生变化。本次旧工作流已结束，请从当前正文重新启动章节工作流。";
  }
  if (code === "denied") return "提案已被处理，不能再次确认。请返回工作流进度核对提案状态。";
  return "提案授权失败，请重新确认";
}

function validateFrozen(frozen: FrozenWorkflowStartConfig): FrozenWorkflowStartConfig {
  if (!/^[a-f0-9]{64}$/.test(frozen.definitionHash) || !Number.isInteger(frozen.revisionBudget) || frozen.revisionBudget < 1 || frozen.revisionBudget > 10) {
    throw new Error("Invalid frozen workflow start configuration");
  }
  return Object.freeze({ ...frozen });
}

function validateFrozenDefinition(input: FrozenWorkflowStartConfig): Readonly<{ frozen: FrozenWorkflowStartConfig; definition: WorkflowDefinition }> {
  const frozen = validateFrozen(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(frozen.definitionContents);
  } catch {
    throw new Error("Invalid frozen workflow definition JSON");
  }
  const definitionResult = WorkflowDefinitionSchema.safeParse(parsed);
  if (!definitionResult.success) throw new Error("Invalid frozen workflow definition schema");
  const definition = definitionResult.data;
  const validated = validateWorkflowDefinition(definition, defaultWorkflowRegistry);
  if (!validated.ok) throw new Error(`Invalid frozen workflow definition: ${validated.issues.map((issue) => issue.code).join(", ")}`);
  if (
    definition.id !== frozen.workflowId
    || definition.version !== frozen.workflowVersion
    || sha256(definition) !== frozen.definitionHash
    || definition.budgets.maxRevisionRounds !== frozen.revisionBudget
  ) {
    throw new Error("Invalid frozen workflow definition integrity metadata");
  }
  return Object.freeze({ frozen, definition: validated.definition });
}

function waitForCursor(read: () => number, afterSequence: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { cleanup(); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    const tick = () => {
      if (read() > afterSequence || Date.now() >= deadline) { cleanup(); resolve(); return; }
      timer = setTimeout(tick, Math.min(100, Math.max(1, deadline - Date.now())));
    };
    const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    tick();
  });
}
