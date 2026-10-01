import type { ChapterWriteNodeId, WorkflowRunRecord } from "./repository.ts";
import { Command, type BaseCheckpointSaver } from "@langchain/langgraph";
import { createHash, randomUUID } from "node:crypto";

import { compileWorkflow, createWorkflowRuntimeRegistries, type NodeExecutor, type WorkflowRuntimeRegistries } from "./compiler.ts";
import { evaluateReviewStageGateResolved, evaluateRevisionDecision, evaluateStrictReviewGateResolved } from "./conditions.ts";
import { WorkflowDefinitionSchema } from "./definition.ts";
import { sha256 } from "./hash.ts";
import { WorkflowGraphStatePatchSchema, type WorkflowGraphState, type WorkflowGraphStatePatch } from "./state.ts";
import type { WorkflowArtifactStore } from "./artifacts.ts";
import type { WorkflowRepository } from "./repository.ts";
import { WorkflowMemoryPending, WorkflowPauseRequested, WorkflowRunError, publicFailureSummary } from "./errors.ts";

export const WORKFLOW_RUN_LEASE_TTL_MS = 15_000;
export const WORKFLOW_RUN_LEASE_HEARTBEAT_MS = 5_000;

function graphRecursionLimit(definition: ReturnType<typeof WorkflowDefinitionSchema.parse>): number {
  const expandedNodes = definition.schemaVersion === 2 ? definition.reviewStages.length * 3 : 0;
  return (definition.nodes.length + expandedNodes) * (definition.budgets.hardMaxRevisionRounds + 1);
}

function directWriteRevisionRound(nodeId: ChapterWriteNodeId, state: WorkflowGraphState): number {
  if (nodeId === "write") return 0;
  if (nodeId === "revise") return state.revisionRound;
  const stage = nodeId.replace(/-revise$/, "") as "continuity" | "style" | "ai-trace";
  const round = state.reviewStageStates?.[stage]?.revisionRound;
  if (!Number.isInteger(round) || round! < 1 || round! > 10) throw new Error(`Direct chapter write ${nodeId} has no active stage round`);
  return round!;
}

function pendingDirectWriteRevisionRound(nodeId: ChapterWriteNodeId, state: WorkflowGraphState): number {
  if (nodeId === "write") return 0;
  if (nodeId === "revise") return state.revisionRound + 1;
  const stage = nodeId.replace(/-revise$/, "") as "continuity" | "style" | "ai-trace";
  const round = (state.reviewStageStates?.[stage]?.revisionRound ?? 0) + 1;
  if (round < 1 || round > 10) throw new Error(`Direct chapter write ${nodeId} has no pending stage round`);
  return round;
}

function chapterWriteNodeId(nodeId: string): ChapterWriteNodeId | undefined {
  return (["write", "revise", "continuity-revise", "style-revise", "ai-trace-revise"] as const).find((candidate) => candidate === nodeId);
}

type WorkflowLeaseRepository = Pick<WorkflowRepository, "acquireRunLease" | "assertAndRenewRunLease" | "releaseRunLease">;

function isRunLeaseLost(error: unknown): boolean {
  return error instanceof Error && error.message === "Workflow run lease was lost";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[a-z][a-z0-9_-]{2,79}$/.test(code) ? code : undefined;
}

function isParentAgentUnavailable(error: unknown): boolean {
  return errorCode(error) === "parent_agent_unavailable"
    || (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "ParentAgentUnavailable");
}

function runningNodeSummary(nodeId: string, directWrite = false): string {
  if (directWrite) return nodeId === "revise"
    ? "正在根据审查意见修订并保存同一章节。"
    : "小说写作 Agent 正在创作，并将通过工具创建章节、写入正文。";
  const labels: Readonly<Record<string, string>> = {
    "lock-target": "正在锁定章节目标并核对作品上下文。",
    "initialize-chapter": "正在创建可见章节并准备空草稿。",
    "query-memory": "正在查询与当前章节相关的记忆。",
    plan: "章节策划 Agent 正在生成方案，内容会实时显示在对话中。",
    write: "正在调用小说写作模型生成正文候选。",
    revise: "正在根据审查意见调用写作模型修订正文。",
    continuity: "正在进行连续性审查。",
    style: "正在进行文风审查。",
    "ai-trace": "正在进行 AI 痕迹审查。",
    "review-gate": "正在汇总审查结果并判断是否需要修订。",
    proposal: "正在生成待确认提案。",
    approval: "正在等待人工确认。",
    apply: "正在安全写入正文。",
    verify: "正在回读并校验已写入正文。",
    "extract-memory": "正在从已确认正文提取记忆。",
    "save-memory": "正在保存本章记忆。",
  };
  return labels[nodeId] ?? "正在执行工作流节点。";
}

async function completedNodeSummary(
  nodeId: string,
  patch: WorkflowGraphStatePatch,
  artifacts: Pick<WorkflowArtifactStore, "read">,
): Promise<string> {
  const readCount = async (reference: unknown, field: string): Promise<number | undefined> => {
    if (typeof reference !== "object" || reference === null) return undefined;
    const artifactRef = (reference as { artifactRef?: unknown }).artifactRef;
    if (typeof artifactRef !== "string") return undefined;
    try {
      const parsed = JSON.parse((await artifacts.read(artifactRef)).toString("utf8")) as Record<string, unknown>;
      return Array.isArray(parsed[field]) ? parsed[field].length : undefined;
    } catch {
      return undefined;
    }
  };
  if (nodeId === "initialize-chapter") return patch.chapterInitialized
    ? "章节已创建，正在准备正文草稿。"
    : "当前目标无需创建新章节。";
  if (nodeId === "plan") {
    const count = await readCount(patch.planArtifact, "beats");
    return count === undefined ? "章节策划 Agent 已完成。" : `章节策划 Agent 已完成，整理出 ${count} 段可执行方案。`;
  }
  if (nodeId === "write" || nodeId === "revise") {
    if (patch.chapterWriteArtifact !== undefined) return nodeId === "revise"
      ? "修订正文已写入章节文件，接下来继续审查。"
      : "正文已写入章节文件，接下来进行质量审查。";
    const reference = patch.candidate;
    if (reference !== undefined) {
      try {
        const parsed = JSON.parse((await artifacts.read(reference.artifactRef)).toString("utf8")) as Record<string, unknown>;
        if (typeof parsed.content === "string") return `${nodeId === "revise" ? "正文修订模型" : "小说写作模型"}已完成，候选正文约 ${parsed.content.length} 字。`;
      } catch { /* fall through to the bounded generic summary */ }
    }
    return `${nodeId === "revise" ? "正文修订模型" : "小说写作模型"}已完成正文候选输出。`;
  }
  if (nodeId === "continuity" || nodeId === "style" || nodeId === "ai-trace") {
    const outputs = patch.reviewOutputs;
    const review = outputs?.[nodeId];
    const label = nodeId === "continuity" ? "连续性" : nodeId === "style" ? "文风" : "AI 痕迹";
    if (review) return `${label}审查已完成，评分 ${Math.round(review.score * 100)} 分，发现 ${review.issues.length} 个问题。`;
    return "审查 Agent 已完成。";
  }
  if (nodeId === "extract-memory") {
    const count = await readCount(patch.memoryArtifact, "facts");
    return count === undefined ? "记忆提取 Agent 已完成。" : `记忆提取 Agent 已完成，提取 ${count} 条事实。`;
  }
  const labels: Readonly<Record<string, string>> = {
    "lock-target": "章节目标已锁定。",
    "query-memory": "记忆查询已完成。",
    "review-gate": "审查结果已汇总。",
    proposal: "待确认提案已生成。",
    apply: "正文已写入，等待回读校验。",
    verify: "正文回读校验已完成。",
    "save-memory": "本章记忆已保存。",
    approval: "人工确认已完成。",
  };
  return labels[nodeId] ?? "节点已完成。";
}

async function reviewGateSummary(state: WorkflowGraphState, registries: WorkflowRuntimeRegistries): Promise<string> {
  // Evaluate the same immutable candidate/reviews as the compiler before the
  // durable step commits, so its public result includes the actual stop cause.
  const review = await evaluateStrictReviewGateResolved(state, registries.resolveCandidateContent);
  if (review.kind === "rejected") return "审查结论与正文证据不匹配，已停止自动修订；请查看审查意见。";
  if (review.kind === "approved-candidate") return "连续性、文风和 AI 痕迹审查均已通过。";
  const decision = evaluateRevisionDecision(state, review)!;
  if (decision.kind === "continue_with_warnings") return `已完成 ${state.revisionRound} 轮修订，达到本次上限；仍有未解决的审查意见，已使用最后一版继续。`;
  if (decision.kind === "waiting_decision") return `已完成 ${state.revisionRound} 轮修订，连续两轮未见改善；已暂停，等待你决定是否继续。`;
  return `本轮审查仍需修改，将进行第 ${state.revisionRound + 1} 轮修订；具体意见见对话。`;
}

async function serialReviewGateSummary(
  nodeId: string,
  state: WorkflowGraphState,
  registries: WorkflowRuntimeRegistries,
): Promise<string | undefined> {
  const matched = /^(continuity|style|ai-trace)-gate$/.exec(nodeId);
  if (!matched) return undefined;
  const stage = matched[1] as "continuity" | "style" | "ai-trace";
  const label = stage === "continuity" ? "连续性审查" : stage === "style" ? "文风审查" : "AI 痕迹审查";
  const current = state.reviewStageStates?.[stage];
  const decision = await evaluateReviewStageGateResolved(state, stage, registries.resolveCandidateContent);
  if (decision.kind === "rejected") return `${label}结论与正文证据不匹配，已停止本节点。`;
  if (decision.kind === "passed") return `${label}已通过。`;
  if (current?.remainingRevisionRounds === 0) {
    return `${label}已完成 ${current.revisionRound} 轮修订，达到本类上限；仍有未解决的审查意见，已使用最后一版继续。`;
  }
  return `${label}仍需修改，将进行第 ${(current?.revisionRound ?? 0) + 1} 轮修订；具体意见见对话。`;
}

/**
 * Converts the worker's durable artifact into a bounded transcript payload.
 * Only model result fields are selected; prompts, target identities, hashes,
 * and artifact references are left in the private artifact store.
 */
async function completedNodeOutput(
  nodeId: string,
  patch: WorkflowGraphStatePatch,
  artifacts: Pick<WorkflowArtifactStore, "read">,
): Promise<string | undefined> {
  const readJson = async (reference: unknown): Promise<Record<string, unknown> | undefined> => {
    if (typeof reference !== "object" || reference === null) return undefined;
    const artifactRef = (reference as { artifactRef?: unknown }).artifactRef;
    if (typeof artifactRef !== "string") return undefined;
    try {
      const value = JSON.parse((await artifacts.read(artifactRef)).toString("utf8"));
      return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  };
  const bound = (value: string): string => {
    const text = value.trim();
    if (text.length <= 100_000) return text;
    return `${text.slice(0, 99_980)}\n\n（输出已截断）`;
  };
  if (nodeId === "plan") {
    const plan = await readJson(patch.planArtifact);
    if (!plan) return undefined;
    const lines: string[] = [];
    if (typeof plan.title === "string") lines.push(`标题：${plan.title}`);
    if (typeof plan.intent === "string") lines.push(`创作意图：${plan.intent}`);
    if (Array.isArray(plan.beats)) {
      lines.push("情节点：");
      for (const beat of plan.beats) {
        if (typeof beat !== "object" || beat === null) continue;
        const order = (beat as { order?: unknown }).order;
        const summary = (beat as { summary?: unknown }).summary;
        if (typeof summary === "string") lines.push(`${typeof order === "number" ? `${order}. ` : "- "}${summary}`);
      }
    }
    if (Array.isArray(plan.constraints) && plan.constraints.length > 0) {
      lines.push("约束：");
      for (const constraint of plan.constraints) if (typeof constraint === "string") lines.push(`- ${constraint}`);
    }
    return lines.length === 0 ? undefined : bound(lines.join("\n"));
  }
  if (nodeId === "write" || nodeId === "revise") {
    const candidate = await readJson(patch.candidate);
    return typeof candidate?.content === "string" ? bound(candidate.content) : undefined;
  }
  if (nodeId === "continuity" || nodeId === "style" || nodeId === "ai-trace") {
    const review = patch.reviewOutputs?.[nodeId];
    if (!review) return undefined;
    const label = nodeId === "continuity" ? "连续性审查" : nodeId === "style" ? "文风审查" : "AI 痕迹审查";
    const lines = [`${label}：${review.decision === "pass" ? "通过" : "需要修订"}`, `评分：${Math.round(review.score * 100)} 分`];
    if (review.issues.length > 0) {
      lines.push("问题：");
      for (const issue of review.issues) {
        lines.push(`- [${issue.severity}] ${issue.requirement}`);
        lines.push(`  证据：${issue.evidence}`);
      }
    } else lines.push("问题：无");
    return bound(lines.join("\n"));
  }
  if (nodeId === "extract-memory") {
    const memory = await readJson(patch.memoryArtifact);
    if (!Array.isArray(memory?.facts)) return undefined;
    const lines = ["记忆提取结果："];
    for (const fact of memory.facts) {
      if (typeof fact !== "object" || fact === null) continue;
      const subject = (fact as { subject?: unknown }).subject;
      const predicate = (fact as { predicate?: unknown }).predicate;
      const object = (fact as { object?: unknown }).object;
      const evidence = (fact as { evidence?: unknown }).evidence;
      if (typeof subject === "string" && typeof predicate === "string" && typeof object === "string") {
        lines.push(`- ${subject}：${predicate}：${object}`);
        if (typeof evidence === "string") lines.push(`  依据：${evidence}`);
      }
    }
    return lines.length === 1 ? undefined : bound(lines.join("\n"));
  }
  return undefined;
}

/** Keeps one fenced owner alive for the entire async execution interval. */
export class WorkflowRunLeaseHeartbeat {
  #timer: ReturnType<typeof setInterval> | undefined;
  #lost: unknown;

  public constructor(
    private readonly repository: WorkflowLeaseRepository,
    private readonly runId: string,
    private readonly ownerToken: string,
    private readonly controller: AbortController,
    private readonly ownerPid = process.pid,
    private readonly ttlMs = WORKFLOW_RUN_LEASE_TTL_MS,
    private readonly intervalMs = WORKFLOW_RUN_LEASE_HEARTBEAT_MS,
  ) {}

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      try {
        this.assertOwned();
      } catch (error) {
        this.#lost = error;
        this.stop();
        this.controller.abort(error);
      }
    }, this.intervalMs);
  }

  assertOwned(): void {
    if (this.#lost !== undefined) throw this.#lost;
    try {
      this.repository.assertAndRenewRunLease({
        runId: this.runId,
        ownerToken: this.ownerToken,
        ownerPid: this.ownerPid,
        ttlMs: this.ttlMs,
      });
    } catch (error) {
      this.#lost = error;
      this.controller.abort(error);
      throw error;
    }
  }

  get lostReason(): unknown { return this.#lost; }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

export interface WorkflowExecutionResult {
  readonly status: "queued" | "running" | "waiting_approval" | "waiting_decision" | "paused" | "retrying" | "memory_pending" | "completed" | "blocked" | "failed" | "rejected" | "cancelled";
  readonly currentNode?: string;
}

export interface WorkflowExecutionPort {
  /** Prefer the verified applied chapter; a frozen lock identifies a pre-write draft. */
  readChapterIdentity?(run: WorkflowRunRecord): Promise<string | undefined>;
  execute(input: Readonly<{
    run: WorkflowRunRecord;
    signal: AbortSignal;
    leaseToken?: string;
    resume?: Readonly<{ decision: "approved" | "rejected"; authorization?: string }>;
  }>): Promise<WorkflowExecutionResult>;
}

export interface WorkflowApplyReconciliationContext {
  readonly target: WorkflowGraphState["target"];
  readonly proposalId: string;
  readonly candidateHash: string;
}

export interface WorkflowTranscriptEntry {
  readonly runId: string;
  readonly sessionId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly status: "completed" | "failed";
  /** Display-ready model result or a bounded public failure reason. */
  readonly content: string;
}

export interface WorkflowToolTranscriptEntry {
  readonly runId: string;
  readonly sessionId: string;
  readonly nodeId: string;
  readonly attempt: number;
  /** Public tool label; arguments and private target identifiers stay hidden. */
  readonly name: string;
  readonly content: string;
}

export interface WorkflowTranscriptPort {
  /** The Agent adapter already publishes completed model output token-by-token. */
  readonly publishesLiveModelOutput?: boolean;
  publish(entry: WorkflowTranscriptEntry): Promise<void> | void;
  /** Completed graph-owned domain calls use the normal Harness tool-card path. */
  publishTool?(entry: WorkflowToolTranscriptEntry): Promise<void> | void;
}

export interface CompiledWorkflowExecutionOptions {
  readonly registries: WorkflowRuntimeRegistries;
  readonly checkpointer: BaseCheckpointSaver;
  /** Artifact storage is mandatory: production execution compiles only the frozen run definition. */
  readonly artifacts: WorkflowArtifactStore;
  readonly repository: WorkflowRepository;
  /** Read-only check before resuming a checkpoint that already owns a chapter. */
  readonly validateRestartedChapter?: (state: WorkflowGraphState) => Promise<void>;
  /** Host-owned durable direct-write repair. Lease authority remains process-local. */
  readonly recoverChapterWrite?: (input: Readonly<{
    state: WorkflowGraphState;
    nodeId: ChapterWriteNodeId;
    revisionRound: number;
    lease: Readonly<{ ownerToken: string; ownerPid: number }>;
    /** Process-local cancellation and current lease check, including after awaits. */
    assertActive: () => void;
  }>) => Promise<WorkflowGraphStatePatch>;
  /** Optional user-facing bridge into the parent conversation transcript. */
  readonly transcript?: WorkflowTranscriptPort;
}

/**
 * The only stock execution adapter: it recompiles the frozen closed graph and
 * resumes the same LangGraph thread. Product code can substitute a stricter
 * host port, but cannot introduce a second scheduler.
 */
export class CompiledWorkflowExecutionPort implements WorkflowExecutionPort {
  readonly #authorizations = new Map<string, Readonly<{ proposalId: string; token: string }>>();

  public constructor(private readonly options: CompiledWorkflowExecutionOptions) {}

  /** Private process-local capability; never enters a checkpoint or projection. */
  setApprovalAuthorization(runId: string, proposalId: string, token: string): void {
    this.#authorizations.set(runId, Object.freeze({ proposalId, token }));
  }

  takeApprovalAuthorization(runId: string, proposalId: string): string | undefined {
    const authorization = this.#authorizations.get(runId);
    if (!authorization || authorization.proposalId !== proposalId) return undefined;
    this.#authorizations.delete(runId);
    return authorization.token;
  }

  privateApproval(runId: string, proposalId: string): Readonly<{ proposalId: string; token: string }> | undefined {
    const authorization = this.#authorizations.get(runId);
    if (!authorization || authorization.proposalId !== proposalId) return undefined;
    return authorization;
  }

  async readChapterIdentity(run: WorkflowRunRecord): Promise<string | undefined> {
    if (!run.frozenDefinitionRef) return undefined;
    const { graph, config } = await this.openFrozenGraph(run);
    const state = (await graph.getState(config as never)).values as unknown as WorkflowGraphState | undefined;
    if (state?.runId !== run.runId || JSON.stringify(state.target) !== JSON.stringify(run.target)) return undefined;
    if (state.appliedArtifact) {
      const bytes = await this.options.artifacts.read(state.appliedArtifact.artifactRef);
      const applied = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (createHash("sha256").update(bytes).digest("hex") !== state.appliedArtifact.sha256
        || applied.workId !== run.target.workId || applied.volumeId !== run.target.volumeId
        || typeof applied.chapterId !== "string" || !applied.chapterId
        || applied.contentHash !== state.appliedRevision || applied.contentHash !== state.candidate?.sha256
        || (run.target.mode === "modify" && applied.chapterId !== run.target.chapterId)) {
        throw new WorkflowRunError("invalid_state", "已保存章节的工作流记录无法核对，请先检查原任务");
      }
      return applied.chapterId;
    }
    if (!state.targetLock) return undefined;
    const bytes = await this.options.artifacts.read(state.targetLock.artifactRef);
    if (createHash("sha256").update(bytes).digest("hex") !== state.targetLock.sha256) throw new Error("Workflow target lock integrity mismatch");
    const lock = JSON.parse(bytes.toString("utf8")) as { reservedChapterId?: unknown; target?: unknown };
    if (JSON.stringify(lock.target) !== JSON.stringify(run.target)) throw new Error("Workflow target lock identity mismatch");
    return typeof lock.reservedChapterId === "string" ? lock.reservedChapterId : undefined;
  }

  /** Closed checkpoint read used only by the host-owned apply repair path. */
  async readApplyReconciliationContext(run: WorkflowRunRecord): Promise<WorkflowApplyReconciliationContext> {
    const { graph, config } = await this.openFrozenGraph(run);
    const snapshot = await graph.getState(config as never);
    const state = snapshot.values as unknown as WorkflowGraphState | undefined;
    const approval = this.options.repository.getApproval(run.runId);
    const candidateHash = state?.candidate?.sha256;
    if (
      !state
      || state.runId !== run.runId
      || JSON.stringify(state.target) !== JSON.stringify(run.target)
      || state.approved !== true
      || !state.proposalId
      || approval?.decision !== "approved"
      || approval.proposalId !== state.proposalId
      || !candidateHash
      || state.reviewOutcome?.kind !== "approved-candidate"
      || state.reviewOutcome.candidateHash !== candidateHash
    ) {
      throw new WorkflowRunError("invalid_state", "冻结检查点不能证明待修复的已审批提案");
    }
    return Object.freeze({ target: state.target, proposalId: state.proposalId, candidateHash });
  }

  async execute(input: Readonly<{
    run: WorkflowRunRecord;
    signal: AbortSignal;
    leaseToken?: string;
    resume?: Readonly<{ decision: "approved" | "rejected"; authorization?: string }>;
  }>): Promise<WorkflowExecutionResult> {
    if (input.signal.aborted) return { status: "cancelled" };
    if (!input.leaseToken) throw new Error("Workflow execution requires a durable run lease");
    const { graph, config, definition } = await this.openFrozenGraph(input.run, input.leaseToken, input.signal);
    const initial: WorkflowGraphState = {
      runId: input.run.runId,
      parentSessionId: input.run.sessionId,
      target: input.run.target,
      frozenDefinition: { artifactRef: input.run.frozenDefinitionRef!, sha256: input.run.frozenDefinitionHash },
      ...(input.run.frozenRequestRef === undefined ? {} : { frozenRequest: { artifactRef: input.run.frozenRequestRef, sha256: "request" } }),
      chapterWriteMode: input.run.chapterWriteMode,
      remainingRevisionRounds: input.run.revisionBudget,
      revisionRound: input.run.revisionCompleted,
    };
    if (input.resume?.decision === "approved") {
      if (!input.resume.authorization) throw new WorkflowRunError("authorization_failed", "审批恢复缺少一次性授权");
      const approval = this.options.repository.getApproval(input.run.runId);
      if (!approval?.proposalId) throw new WorkflowRunError("invalid_state", "审批记录缺失");
      this.setApprovalAuthorization(input.run.runId, approval.proposalId, input.resume.authorization);
    }
    let snapshot = await graph.getState(config as never);
    const checkpointed = snapshot.values && typeof snapshot.values === "object" && (snapshot.values as { runId?: unknown }).runId === input.run.runId;
    let values = checkpointed ? snapshot.values as unknown as WorkflowGraphState : undefined;
    const recoveringWrite = values && snapshot.next.some((rawNodeId) => {
      const nodeId = chapterWriteNodeId(rawNodeId);
      return nodeId !== undefined
        && this.options.repository.getChapterWrite(input.run.runId, nodeId, pendingDirectWriteRevisionRound(nodeId, values!)) !== undefined;
    });
    if (values?.chapterWriteArtifact && !recoveringWrite && this.options.validateRestartedChapter) {
      try {
        await this.options.validateRestartedChapter(values);
      } catch {
        if (input.signal.aborted) throw input.signal.reason;
        const nodeKey = input.run.currentNode ?? "verify";
        const previous = this.options.repository.listSteps(input.run.runId).filter((step) => step.nodeKey === nodeKey);
        const attempt = Math.max(0, ...previous.map((step) => step.attempt)) + 1;
        const summary = "章节正文已变化或无法核对，已保留现有文件。请确认当前版本后再启动工作流。";
        this.options.repository.recordStepAttempt({ runId: input.run.runId, nodeKey, attempt, status: "blocked", inputHash: stableHash(values), summary, errorCategory: "conflict", errorCode: "workflow_restart_chapter_conflict" });
        try { await this.options.transcript?.publish({ runId: input.run.runId, sessionId: input.run.sessionId, nodeId: nodeKey, attempt, status: "failed", content: summary }); } catch { /* Status remains durable when the conversation is unavailable. */ }
        return { status: "blocked", currentNode: nodeKey };
      }
    }
    if (checkpointed && initial.frozenRequest && values?.frozenRequest?.artifactRef !== initial.frozenRequest.artifactRef) {
      // The user explicitly restarted with supplementary requirements. Keep the
      // graph position and committed chapter artifacts, update only its input.
      await graph.updateState(config as never, { frozenRequest: initial.frozenRequest });
      snapshot = await graph.getState(config as never);
      values = snapshot.values as unknown as WorkflowGraphState;
    }
    if (input.run.chapterWriteMode === "direct" && !checkpointed
      && (this.options.repository.getChapterWrite(input.run.runId, "write", 0)
        || this.options.repository.getNodeEffectState(input.run.runId, "initialize-chapter") !== "none")) {
      // Never generate a new reserved identity after a durable direct write.
      return { status: "blocked", currentNode: input.run.currentNode ?? "write" };
    }
    const isMemoryTail = input.run.status === "memory_pending" || this.options.repository.hasVerifiedMemoryTail(input.run.runId);
    const applied = this.options.repository.getIdempotency("workflow-applied", input.run.runId)?.completed === true;
    const possiblyApplied = !applied && this.options.repository.getNodeEffectState(input.run.runId, "apply") !== "none";
    const reconciliation = this.options.repository.getApplyReconciliation(input.run.runId);
    if (possiblyApplied && reconciliation?.status !== "applied") {
      // A durable claim proves the external apply call may have crossed its
      // boundary. Reconciliation needs a domain reread; graph replay is unsafe.
      return { status: "blocked", currentNode: "apply" };
    }
    if (reconciliation?.status === "conflict") return { status: "blocked", currentNode: "apply" };
    if (reconciliation?.status === "applied" && checkpointed && !values?.appliedRevision) {
      const evidence = JSON.parse((await this.options.artifacts.read(reconciliation.resultRef)).toString("utf8")) as Record<string, unknown>;
      if (
        evidence.status !== "applied"
        || evidence.proposalId !== reconciliation.proposalId
        || evidence.candidateHash !== reconciliation.candidateHash
        || evidence.appliedRevision !== reconciliation.appliedRevision
      ) {
        throw new WorkflowRunError("invalid_state", "应用对账证据与持久标记不一致");
      }
      await graph.updateState(config as never, {
        appliedRevision: reconciliation.appliedRevision,
        appliedArtifact: { artifactRef: reconciliation.resultRef, sha256: reconciliation.candidateHash },
      }, "apply");
      snapshot = await graph.getState(config as never);
      values = snapshot.values as unknown as WorkflowGraphState;
    }
    if ((applied || isMemoryTail) && !checkpointed) {
      // The domain effect is durable but graph state is not. Re-entering START
      // could generate/propose/apply again, so wait for explicit repair.
      return { status: "paused", currentNode: "verify" };
    }
    if (isMemoryTail && checkpointed && !values?.appliedRevision && values?.appliedArtifact) {
      // A crash between apply's graph write and the memory-tail status may
      // leave a compact applied artifact without its redundant hash field.
      // Reconstruct only that hash from the artifact already bound to this
      // run, never from model output or an unverified domain reread.
      const appliedArtifact = JSON.parse((await this.options.artifacts.read(values.appliedArtifact.artifactRef)).toString("utf8")) as { appliedRevision?: unknown };
      if (typeof appliedArtifact.appliedRevision === "string" && /^[a-f0-9]{64}$/.test(appliedArtifact.appliedRevision)) {
        await graph.updateState(config as never, { appliedRevision: appliedArtifact.appliedRevision }, "apply");
        snapshot = await graph.getState(config as never);
        values = snapshot.values as unknown as WorkflowGraphState;
      }
    }
    if (isMemoryTail) {
      if (!values?.appliedArtifact) return { status: "blocked", currentNode: "verify" };
      // Reset pending graph tasks to the already-applied boundary. A goto
      // command would ADD verify alongside the old failed extraction/save,
      // allowing stale evidence to race the reread. No apply executor runs.
      const verifiedBoundary = definition.schemaVersion === 2
        ? `${definition.reviewStages.at(-1)!.id}-gate`
        : "apply";
      await graph.updateState(config as never, { appliedArtifact: values.appliedArtifact }, verifiedBoundary);
    }
    const graphInput = input.resume && !isMemoryTail
      ? new Command({ resume: input.resume.decision })
      : checkpointed ? null : initial;
    const state = await graph.invoke(graphInput, config as never) as unknown as WorkflowGraphState;
    if (input.signal.aborted) {
      const currentNode = this.options.repository.getRun(input.run.runId)?.currentNode;
      return { status: "cancelled", ...(currentNode === undefined ? {} : { currentNode }) };
    }
    if (state.terminalStatus) {
      // Durable executors publish the physical node before invoking model or
      // effect work. Preserve that last safe boundary when a terminal graph
      // state contains only the public status (for example strict review
      // rejection or exhausted revision budget).
      const currentNode = this.options.repository.getRun(input.run.runId)?.currentNode;
      return { status: state.terminalStatus, ...(currentNode === undefined ? {} : { currentNode }) };
    }
    if (state.proposalId && state.approved === undefined) {
      // The interrupt payload is ephemeral; persist the proposal identity
      // before publishing the approval state so the UI can make an exact,
      // restart-safe decision without ever receiving an authorization token.
      this.options.repository.recordApproval({ runId: input.run.runId, proposalId: state.proposalId });
      return { status: "waiting_approval", currentNode: "approval" };
    }
    return { status: "running" };
  }

  private async openFrozenGraph(run: WorkflowRunRecord, leaseToken?: string, signal?: AbortSignal) {
    if (!run.frozenDefinitionRef) throw new Error("Workflow run has no frozen definition artifact");
    const frozenBytes = await this.options.artifacts.read(run.frozenDefinitionRef);
    const definition = WorkflowDefinitionSchema.parse(JSON.parse(frozenBytes.toString("utf8")));
    if (sha256(definition) !== run.frozenDefinitionHash || definition.id !== run.workflowId || definition.version !== run.workflowVersion) {
      throw new Error("Frozen workflow definition integrity verification failed");
    }
    const registries = leaseToken === undefined ? this.options.registries : this.durableRegistries(run, leaseToken, signal);
    return {
      graph: compileWorkflow(definition, registries, this.options.checkpointer),
      definition,
      config: {
        configurable: { thread_id: run.runId },
        recursionLimit: graphRecursionLimit(definition),
      },
    };
  }

  private durableRegistries(run: WorkflowRunRecord, leaseToken: string, signal?: AbortSignal): WorkflowRuntimeRegistries {
    const executors = Object.fromEntries(Object.entries(this.options.registries.nodeExecutors).map(([nodeId, executor]) => [
      nodeId,
      this.durableExecutor(run, leaseToken, nodeId, executor, signal),
    ]));
    return createWorkflowRuntimeRegistries(
      this.options.registries.workflow,
      executors,
      this.options.registries.conditionResolvers,
      this.options.registries.resolveCandidateContent,
      (state) => state.proposalId ? this.privateApproval(run.runId, state.proposalId) : undefined,
    );
  }

  private durableExecutor(run: WorkflowRunRecord, leaseToken: string, nodeId: string, executor: NodeExecutor, signal?: AbortSignal): NodeExecutor {
    const repository = this.options.repository;
    const artifacts = this.options.artifacts;
    return async (context) => {
      const assertActive = () => {
        if (signal?.aborted) throw signal.reason ?? new Error("Workflow execution aborted");
        if (repository.getControlIntent(run.runId).cancelRequested) throw new WorkflowRunError("cancelled", "工作流已取消");
        repository.assertAndRenewRunLease({ runId: run.runId, ownerToken: leaseToken, ownerPid: process.pid, ttlMs: WORKFLOW_RUN_LEASE_TTL_MS });
      };
      if (signal?.aborted) throw signal.reason ?? new Error("Workflow execution aborted");
      repository.assertAndRenewRunLease({ runId: run.runId, ownerToken: leaseToken, ownerPid: process.pid, ttlMs: WORKFLOW_RUN_LEASE_TTL_MS });
      const control = repository.getControlIntent(run.runId);
      const applied = repository.getIdempotency("workflow-applied", run.runId)?.completed === true;
      if (control.pauseRequested) throw new WorkflowPauseRequested();
      if (control.cancelRequested) {
        if (!applied) throw new WorkflowRunError("cancelled", "工作流已在应用前取消");
        if (nodeId !== "verify") throw new WorkflowMemoryPending();
      }
      const prior = repository.listSteps(run.runId).filter((step) => step.nodeKey === nodeId);
      const active = prior.find((step) => step.status === "running" || step.status === "retrying");
      const attempt = active?.attempt ?? Math.max(0, ...prior.map((step) => step.attempt)) + 1;
      const inputHash = stableHash({ nodeId, state: context.state });
      const idempotencyKey = `${run.runId}/${nodeId}/${inputHash}`;
      const writeNodeId = chapterWriteNodeId(nodeId);
      const directWriteNode = run.chapterWriteMode === "direct" && writeNodeId !== undefined;
      const writeRound = directWriteNode ? directWriteRevisionRound(writeNodeId!, context.state) : undefined;
      const chapterEffect = directWriteNode
        ? repository.getChapterWrite(run.runId, writeNodeId!, writeRound!) : undefined;
      // Initialization is idempotent only under the already checkpointed lock.
      // This covers both commit-before-completion and completion-before-checkpoint.
      const replayableInitializer = nodeId === "initialize-chapter"
        && context.node.kind === "tool" && context.node.handler === "jizuo.initializeWorkflowChapter"
        && run.chapterWriteMode === "direct" && context.state.chapterWriteMode === "direct"
        && context.state.targetLock !== undefined;
      const replayableComputation = context.node.kind === "agent" && !directWriteNode
        || ["lock-target", "query-memory", "review-gate", "verify"].includes(nodeId)
        || /^(?:continuity|style|ai-trace)-gate$/.test(nodeId);
      const claim = repository.claimIdempotency({ scope: "workflow-node", key: idempotencyKey, runId: run.runId });
      if (!claim.claimed && !chapterEffect && !(directWriteNode && !claim.completed) && !replayableInitializer && !replayableComputation) {
        throw new WorkflowRunError("invalid_state", claim.completed
          ? `节点 ${nodeId} 已完成但缺少可恢复检查点`
          : `节点 ${nodeId} 的效果已开始但未形成可验证结果`);
      }
      const startedAt = Date.now();
      repository.updateRunStatus(run.runId, "running", nodeId);
      repository.recordStepAttempt({
        runId: run.runId,
        nodeKey: nodeId,
        attempt,
        status: "running",
        inputHash,
        summary: runningNodeSummary(nodeId, directWriteNode),
      });
      try {
        if (nodeId === "apply") {
          const approval = context.privateApproval;
          if (!approval || approval.proposalId !== context.state.proposalId) {
            throw new WorkflowRunError("authorization_failed", "应用提案缺少一次性授权");
          }
          // Consume the one-time capability only at the durable effect
          // boundary, after the compiler has matched it to the checkpoint.
          if (this.takeApprovalAuthorization(run.runId, approval.proposalId) !== approval.token) {
            throw new WorkflowRunError("authorization_failed", "应用提案授权已失效");
          }
        }
        // A durable write effect is stronger evidence than the unfinished
        // generic node claim. Restore it before a model can run again, and let
        // the original graph node checkpoint the compact result normally.
        const patch = chapterEffect
          ? await (async () => {
            if (!this.options.recoverChapterWrite) throw new Error("Direct chapter write recovery is unavailable");
            return WorkflowGraphStatePatchSchema.parse(await this.options.recoverChapterWrite({
              state: context.state,
              nodeId: writeNodeId!,
              revisionRound: writeRound!,
              lease: { ownerToken: leaseToken, ownerPid: process.pid },
              assertActive,
            })) as WorkflowGraphStatePatch;
          })()
          : await executor({
          ...context,
          ...(signal === undefined ? {} : { signal }),
          privateExecution: {
            chapterWriteMode: run.chapterWriteMode,
            lease: { ownerToken: leaseToken, ownerPid: process.pid },
            assertActive,
          },
        });
        if (replayableInitializer) assertActive();
        if (signal?.aborted) throw signal.reason ?? new Error("Workflow execution aborted");
        // The completion marker contains only hashes, references, statuses, and
        // fixed node metadata; it cannot accidentally persist candidate prose.
        const outputHash = stableHash(patch);
        const artifact = await artifacts.write({
          runId: run.runId,
          kind: "other",
          contents: JSON.stringify({ nodeId, inputHash, outputHash, fields: Object.keys(patch).sort() }),
        });
        const summary = nodeId === "review-gate"
          ? await reviewGateSummary(context.state, this.options.registries)
          : await serialReviewGateSummary(nodeId, context.state, this.options.registries)
            ?? await completedNodeSummary(nodeId, patch, artifacts);
        const output = await completedNodeOutput(nodeId, patch, artifacts);
        if (replayableInitializer) assertActive();
        repository.completeNodeAttempt({
          runId: run.runId,
          ownerToken: leaseToken,
          ownerPid: process.pid,
          ttlMs: WORKFLOW_RUN_LEASE_TTL_MS,
          nodeKey: nodeId,
          attempt,
          inputHash,
          outputHash,
          artifact,
          idempotencyKey,
          durationMs: Math.max(0, Date.now() - startedAt),
          summary,
          ...(nodeId === "apply" ? { markApplied: true } : {}),
        });
        const tool = completedWorkflowTool(nodeId, run.target, summary);
        if (tool !== undefined) {
          try {
            await this.options.transcript?.publishTool?.({
              runId: run.runId,
              sessionId: run.sessionId,
              nodeId,
              attempt,
              name: tool.name,
              content: tool.content,
            });
          } catch {
            // Conversation publication is observational. The durable node
            // result remains authoritative if its parent session has closed.
          }
        }
        if (output !== undefined && this.options.transcript?.publishesLiveModelOutput !== true) {
          try {
            await this.options.transcript?.publish({
              runId: run.runId,
              sessionId: run.sessionId,
              nodeId,
              attempt,
              status: "completed",
              content: output,
            });
          } catch {
            // Conversation publication is observational. The durable model
            // result remains authoritative even if its live session closed.
          }
        }
        return patch;
      } catch (error) {
        const persisted = repository.listSteps(run.runId).find((step) => step.nodeKey === nodeId && step.attempt === attempt);
        const leaseLost = signal?.aborted === true || isRunLeaseLost(error);
        if (!leaseLost && (!persisted || !["completed", "blocked", "failed", "skipped", "cancelled"].includes(persisted.status))) {
          const writeEffect = run.chapterWriteMode === "direct" && writeNodeId !== undefined && writeRound !== undefined
            ? repository.getChapterWrite(run.runId, writeNodeId, writeRound) : undefined;
          const directWriteUncertain = writeEffect !== undefined;
          const writeSummary = repository.getChapterWrite(run.runId, "write", 0)?.status === "completed"
            ? "章节草稿已保留，但无法确认本轮写入结果"
            : writeEffect?.conflictCode === "workflow_chapter_identity_conflict"
              ? "候选稿已保存，但尚未确认章节写入。目标身份校验冲突，请检查作品、分卷和章节目录。"
              : "候选稿已保存，但尚未确认章节写入；需恢复核对本轮写入结果。";
          const failure = publicFailureSummary(error);
          const parentUnavailable = isParentAgentUnavailable(error);
          if (parentUnavailable) repository.recordIdempotency({ scope: "parent-wait", key: run.runId, runId: run.runId, completed: false });
          repository.recordStepAttempt({
            runId: run.runId,
            nodeKey: nodeId,
            attempt,
            status: parentUnavailable || directWriteUncertain ? "blocked" : "failed",
            inputHash,
            durationMs: Math.max(0, Date.now() - startedAt),
            summary: failure.summary,
            errorCategory: failure.category,
            errorCode: failure.code,
            ...(directWriteUncertain ? {
              summary: writeSummary,
              errorCategory: "conflict",
              errorCode: "workflow_chapter_write_unconfirmed",
            } : {}),
          });
          if (["plan", "write", "revise", "continuity", "style", "ai-trace", "extract-memory"].includes(nodeId)
            || /^(?:continuity|style|ai-trace)-(?:review|revise)$/.test(nodeId)) {
            try {
              await this.options.transcript?.publish({
                runId: run.runId,
                sessionId: run.sessionId,
                nodeId,
                attempt,
                status: "failed",
                content: directWriteUncertain ? writeSummary : failure.summary,
              });
            } catch {
              // Preserve the original worker failure and its durable status.
            }
          }
        }
        // Memory persistence has its own evidence-bound idempotency key in the
        // domain.  Release this *node* claim so a restarted host can replay
        // only the memory tail; all other incomplete effects remain blocked.
        if (nodeId === "save-memory" && (isWorkflowMemoryPending(error) || errorCode(error) === "memory_evidence_invalid")) {
          repository.clearIdempotency("workflow-node", idempotencyKey);
        }
        throw error;
      }
    };
  }
}

function completedWorkflowTool(
  nodeId: string,
  target: WorkflowRunRecord["target"],
  summary: string,
): Readonly<{ name: string; content: string }> | undefined {
  const name = nodeId === "lock-target" ? "jizuo_lock_chapter_target"
    : nodeId === "initialize-chapter" ? "jizuo_initialize_workflow_chapter"
    : nodeId === "query-memory" ? "jizuo_query_memory"
      : nodeId === "review-gate" ? "jizuo_review_gate"
        : nodeId === "proposal" ? "jizuo_create_chapter_proposal"
          : nodeId === "apply" ? target.mode === "modify" ? "jizuo_replace_chapter" : "jizuo_create_chapter"
            : nodeId === "verify" ? "jizuo_read_chapter"
              : nodeId === "save-memory" ? "jizuo_save_memory"
                : undefined;
  if (name === undefined) return undefined;
  const content = nodeId === "apply" && target.mode !== "modify"
    ? "新章节已写入，等待回读校验。"
    : summary;
  return Object.freeze({ name, content });
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export interface WorkflowSupervisorHooks {
  onStarted(run: WorkflowRunRecord): void;
  onSettled(runId: string, result: WorkflowExecutionResult): void;
  onFailed(runId: string, error: unknown): void;
}

interface ActiveExecution {
  readonly controller: AbortController;
  readonly leaseToken: string;
  readonly heartbeat: WorkflowRunLeaseHeartbeat;
  pauseRequested: boolean;
  cancelRequested: boolean;
}

/**
 * A plugin may be bundled with a separately resolved copy of the runtime.
 * The durable error contract therefore includes its stable name, not only JS
 * class identity, so an already-applied chapter always resumes at memory tail.
 */
function isWorkflowMemoryPending(error: unknown): error is WorkflowMemoryPending {
  return error instanceof WorkflowMemoryPending || (
    typeof error === "object"
    && error !== null
    && (error as { name?: unknown }).name === "WorkflowMemoryPending"
  );
}

/**
 * Plugin-lifetime owner for background execution. It never owns product state:
 * callers persist every boundary before dispatching and settle from durable data.
 */
export class WorkflowSupervisor {
  readonly #active = new Map<string, ActiveExecution>();

  public constructor(
    private readonly execution: WorkflowExecutionPort,
    private readonly hooks: WorkflowSupervisorHooks,
    private readonly leases: WorkflowLeaseRepository,
  ) {}

  isActive(runId: string): boolean {
    return this.#active.has(runId);
  }

  dispatch(run: WorkflowRunRecord, resume?: Readonly<{ decision: "approved" | "rejected"; authorization?: string }>): boolean {
    if (this.#active.has(run.runId)) return false;
    const leaseToken = randomUUID();
    if (!this.leases.acquireRunLease({ runId: run.runId, ownerToken: leaseToken, ownerPid: process.pid, ttlMs: WORKFLOW_RUN_LEASE_TTL_MS })) return false;
    const controller = new AbortController();
    const heartbeat = new WorkflowRunLeaseHeartbeat(this.leases, run.runId, leaseToken, controller);
    const active: ActiveExecution = { controller, heartbeat, leaseToken, pauseRequested: false, cancelRequested: false };
    this.#active.set(run.runId, active);
    heartbeat.start();
    this.hooks.onStarted(run);
    void this.execute(run, active, resume);
    return true;
  }

  requestPause(runId: string): boolean {
    const active = this.#active.get(runId);
    if (!active) return false;
    active.pauseRequested = true;
    active.controller.abort(new WorkflowPauseRequested());
    return true;
  }

  requestCancel(runId: string): boolean {
    const active = this.#active.get(runId);
    if (!active) return false;
    active.cancelRequested = true;
    // Do not abort a running domain write. The durable executor observes this
    // intent before the next graph node, which is the only safe boundary.
    return true;
  }

  dispose(): void {
    for (const [runId, active] of this.#active) {
      active.controller.abort();
      active.heartbeat.stop();
      this.leases.releaseRunLease(runId, active.leaseToken);
    }
    this.#active.clear();
  }

  private async execute(
    run: WorkflowRunRecord,
    active: ActiveExecution,
    resume?: Readonly<{ decision: "approved" | "rejected"; authorization?: string }>,
  ): Promise<void> {
    try {
      const result = await this.execution.execute({ run, signal: active.controller.signal, leaseToken: active.leaseToken, ...(resume ? { resume } : {}) });
      // Disposal releases ownership synchronously and may close the database
      // before the executor acknowledges its abort. Ignore that late result.
      if (this.#active.get(run.runId) !== active) return;
      if (active.heartbeat.lostReason !== undefined) {
        // Some executors acknowledge the ownership-loss abort by resolving a
        // cancelled result instead of rejecting. The fenced-out owner still
        // must publish no lifecycle transition; only durable recovery may
        // settle this run under a newly acquired lease.
        return;
      }
      // A node runner may complete just as a lifecycle intent arrives. The intent
      // wins only at this durable boundary, never in the middle of a domain write.
      if (active.pauseRequested && result.status !== "completed") {
        this.hooks.onSettled(run.runId, { status: "paused", ...(result.currentNode === undefined ? {} : { currentNode: result.currentNode }) });
      } else if (active.cancelRequested && result.status !== "completed" && result.status !== "memory_pending") {
        this.hooks.onSettled(run.runId, { status: "cancelled", ...(result.currentNode === undefined ? {} : { currentNode: result.currentNode }) });
      } else {
        this.hooks.onSettled(run.runId, result);
      }
    } catch (error) {
      if (this.#active.get(run.runId) !== active) return;
      if (active.heartbeat.lostReason !== undefined || isRunLeaseLost(error)) {
        // This owner is fenced out and must not publish any further lifecycle
        // transition. Releasing its token leaves the durable run recoverable.
        if (!active.controller.signal.aborted) active.controller.abort(error);
      } else if (active.pauseRequested || error instanceof WorkflowPauseRequested) {
        this.hooks.onSettled(run.runId, { status: "paused" });
      } else if (isParentAgentUnavailable(error)) {
        // The Harness parent can disappear after dispatch (for example when
        // the initiating conversation turn finishes). This is recoverable and
        // must wait for that exact session instead of becoming a terminal run.
        this.hooks.onSettled(run.runId, { status: "paused", ...(run.currentNode === undefined ? {} : { currentNode: run.currentNode }) });
      } else if (isWorkflowMemoryPending(error)) {
        this.hooks.onSettled(run.runId, { status: "memory_pending", currentNode: "save-memory" });
      } else if (error instanceof WorkflowRunError && error.code === "cancelled") {
        this.hooks.onSettled(run.runId, { status: "cancelled" });
      } else
      if (active.cancelRequested || active.controller.signal.aborted) {
        if (isWorkflowMemoryPending(error)) {
          this.hooks.onSettled(run.runId, { status: "memory_pending", currentNode: "save-memory" });
        } else {
        this.hooks.onSettled(run.runId, { status: "cancelled" });
        }
      } else if (isWorkflowMemoryPending(error)) {
        this.hooks.onSettled(run.runId, { status: "memory_pending", currentNode: "save-memory" });
      } else {
        this.hooks.onFailed(run.runId, error);
      }
    } finally {
      active.heartbeat.stop();
      if (this.#active.get(run.runId) === active) {
        this.#active.delete(run.runId);
        this.leases.releaseRunLease(run.runId, active.leaseToken);
      }
    }
  }
}
