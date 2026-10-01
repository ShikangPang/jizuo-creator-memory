import { createHash } from "node:crypto";

import {
  ChapterCandidateOutputSchema,
  ChapterMemoryOutputSchema,
  ChapterMemoryOutputSchemaV2,
  ChapterPlanOutputSchema,
  ChapterReviewOutputSchemaV1,
  evaluateReviewStageGateResolved,
  freezeAgentBinding,
  WorkflowMemoryPending,
  type AgentRunnerPort,
  type NodeExecutor,
  type WorkflowArtifactHandle,
  type WorkflowGraphState,
  type WorkflowRegistry,
  type ChapterWriteNodeId,
  type WorkflowRepository,
} from "@jizuo/workflow-runtime";
import { mapChapterMemoryFacts, mapTypedChapterMemoryFacts } from "./memoryFacts.ts";
export { mapChapterMemoryFacts, mapTypedChapterMemoryFacts } from "./memoryFacts.ts";
import { WorkflowChapterWriteReceipt, type WorkflowChapterWriteReceipt as WorkflowChapterWriteReceiptValue } from "@jizuo/contracts";

import type { DomainNodePort } from "./domainRegistry.ts";
import { ChapterListLockSchema, TransientDomainError, type AppliedChapter, type LockedChapterTarget } from "./domainAdapter.ts";
import { groundMemoryEvidence, groundTypedMemoryEvidence, MemoryExtractionEvidenceInvalid } from "./memoryEvidence.ts";
import type { WorkflowChapterWriteGrant } from "./writeCapability.ts";

type ReviewStageId = "continuity" | "style" | "ai-trace";
const reviewStageIds = ["continuity", "style", "ai-trace"] as const;
const stageLabels: Readonly<Record<ReviewStageId, string>> = Object.freeze({
  continuity: "连续性审查",
  style: "文风审查",
  "ai-trace": "AI 痕迹审查",
});

type ArtifactReference = Readonly<{ artifactRef: string; sha256: string }>;
type DirectChapterTargetLock = LockedChapterTarget;
type WorkflowArtifacts = Readonly<{
  write(input: Readonly<{ runId: string; kind: "frozen-definition" | "plan" | "candidate" | "review" | "memory" | "other"; contents: string | Uint8Array }>): Promise<WorkflowArtifactHandle>;
  read(artifactRef: string): Promise<Buffer>;
}>;

export interface ChapterWorkflowNodeExecutorOptions {
  readonly domain: DomainNodePort;
  readonly agents: AgentRunnerPort;
  readonly artifacts: WorkflowArtifacts;
  readonly workflow: WorkflowRegistry;
  readonly candidateContents?: Map<string, string>;
  /** Durable model-result cache: a failed chapter projection must not call the model again. */
  readonly modelResults?: Pick<WorkflowRepository,
    "claimIdempotency" | "completeIdempotency" | "getIdempotency" | "getArtifact">;
}

/** Restores transient review input from the durable, integrity-checked candidate artifact. */
export async function resolveCandidateContentFromArtifact(
  artifacts: Pick<WorkflowArtifacts, "read">,
  candidateRef: ArtifactReference,
): Promise<string> {
  const candidate = ChapterCandidateOutputSchema.parse(await readJson(artifacts, candidateRef));
  if (candidate.candidateHash !== candidateRef.sha256 || hash(candidate.content) !== candidateRef.sha256) {
    throw new Error("Workflow candidate artifact does not match its checkpoint hash");
  }
  return candidate.content;
}

function reference(artifact: WorkflowArtifactHandle): ArtifactReference {
  return Object.freeze({ artifactRef: artifact.artifactRef, sha256: artifact.sha256 });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundAgentId(node: Parameters<NodeExecutor>[0]["node"], fallback: string): string {
  return node.kind === "agent" ? node.agent : fallback;
}

async function readJson<T>(artifacts: Pick<WorkflowArtifacts, "read">, ref: ArtifactReference): Promise<T> {
  return JSON.parse((await artifacts.read(ref.artifactRef)).toString("utf8")) as T;
}

async function writeJson(
  artifacts: WorkflowArtifacts,
  runId: string,
  kind: "plan" | "candidate" | "review" | "memory" | "other",
  value: unknown,
): Promise<ArtifactReference> {
  return reference(await artifacts.write({ runId, kind, contents: JSON.stringify(value) }));
}

function requireRef(ref: ArtifactReference | undefined, label: string): ArtifactReference {
  if (!ref) throw new Error(`Workflow ${label} artifact is missing`);
  return ref;
}

async function frozenUserRequest(artifacts: WorkflowArtifacts, state: WorkflowGraphState): Promise<string> {
  const ref = requireRef(state.frozenRequest, "user request");
  const value = JSON.parse((await artifacts.read(ref.artifactRef)).toString("utf8")) as { userRequest?: unknown };
  if (typeof value.userRequest !== "string" || value.userRequest.trim() === "") throw new Error("Workflow frozen user request is invalid");
  return value.userRequest;
}

function reviewFeedback(state: WorkflowGraphState) {
  return Object.values(state.reviewOutputs ?? {}).map((review) => review.issues);
}

function stageForEffect(nodeId: ChapterWriteNodeId): ReviewStageId | undefined {
  const value = nodeId.replace(/-revise$/, "");
  return reviewStageIds.find((stage) => stage === value);
}

function writeRound(state: WorkflowGraphState, nodeId: ChapterWriteNodeId): number {
  if (nodeId === "write") return 0;
  if (nodeId === "revise") return state.revisionRound;
  const stage = stageForEffect(nodeId)!;
  const round = state.reviewStageStates?.[stage]?.revisionRound;
  if (!Number.isInteger(round) || round! < 1 || round! > 10) throw workflowWriteRuntimeUnavailable(`Serial revision ${nodeId} has no active round`);
  return round!;
}

function previousWriteEffect(state: WorkflowGraphState, nodeId: ChapterWriteNodeId): WorkflowChapterWriteGrant["previousEffect"] {
  const round = writeRound(state, nodeId);
  if (nodeId === "write") return undefined;
  if (nodeId === "revise") return { nodeId: round === 1 ? "write" : "revise", revisionRound: round - 1 };
  if (round > 1) return { nodeId, revisionRound: round - 1 };
  const stage = stageForEffect(nodeId)!;
  const priorStages = reviewStageIds.slice(0, reviewStageIds.indexOf(stage)).reverse();
  for (const prior of priorStages) {
    const priorRound = state.reviewStageStates?.[prior]?.revisionRound ?? 0;
    if (priorRound > 0) return { nodeId: `${prior}-revise`, revisionRound: priorRound };
  }
  return { nodeId: "write", revisionRound: 0 };
}

function stageReviewFeedback(state: WorkflowGraphState, stage: ReviewStageId): unknown[] {
  const current = state.reviewOutputs?.[stage];
  const priorWarnings = reviewStageIds.slice(0, reviewStageIds.indexOf(stage)).flatMap((prior) =>
    state.reviewStageStates?.[prior]?.status === "continued_with_warnings" && state.reviewOutputs?.[prior]
      ? [state.reviewOutputs[prior]] : [],
  );
  return [...(current ? [current] : []), ...priorWarnings];
}

function renderReview(stage: ReviewStageId, review: ReturnType<typeof ChapterReviewOutputSchemaV1.parse>): string {
  const lines = [
    `# ${stageLabels[stage]}`,
    "",
    `结论：${review.decision === "pass" ? "通过" : "需要修订"}`,
    `评分：${Math.round(review.score * 100)} 分`,
  ];
  if (review.issues.length === 0) return `${lines.join("\n")}\n`;
  lines.push("", "## 审查意见", "");
  review.issues.forEach((issue, index) => {
    lines.push(`${index + 1}. ${issue.requirement}`, `   - 原文：${issue.evidence}`, `   - 严重度：${issue.severity}${issue.blocking ? "（需修订）" : ""}`);
  });
  return `${lines.join("\n")}\n`;
}

function renderPlan(plan: ReturnType<typeof ChapterPlanOutputSchema.parse>): string {
  return `# ${plan.title}\n\n${plan.intent}\n\n## 情节点\n\n${plan.beats.map((beat) => `${beat.order}. ${beat.summary}`).join("\n")}\n${plan.constraints.length > 0 ? `\n## 约束\n\n${plan.constraints.map((item) => `- ${item}`).join("\n")}\n` : ""}`;
}

function renderMemoryExtraction(extracted: unknown): string {
  const legacy = ChapterMemoryOutputSchema.safeParse(extracted);
  if (legacy.success) return `# 记忆提取\n\n已从本章提取 ${legacy.data.facts.length} 条可验证事实。\n`;
  const typed = ChapterMemoryOutputSchemaV2.parse(extracted);
  const kinds = new Map<string, number>();
  for (const fact of typed.facts) {
    const kind = fact.factKind === "state" ? fact.subject.kind : `${fact.subject.kind}→${fact.object.kind}`;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const distribution = [...kinds.entries()].map(([kind, count]) => `${kind} ${count} 条`).join("、") || "无新增记忆";
  return `# 记忆提取\n\n已从本章提取 ${typed.facts.length} 条记忆：${distribution}。\n`;
}

function projectionPending(cause: unknown): Error & { code: "chapter_projection_pending" } {
  return Object.assign(new Error("章节流程记录尚未保存，等待恢复重试", { cause }), { code: "chapter_projection_pending" as const });
}

async function runWorkerResult(
  options: ChapterWorkflowNodeExecutorOptions,
  state: WorkflowGraphState,
  nodeId: string,
  agentId: string,
  outputSchemaId: string,
  frozenContext: unknown,
  signal?: AbortSignal,
  chapterWriteGrant?: WorkflowChapterWriteGrant,
) {
  const invocation = options.workflow.agents[agentId]?.implementation.resolveInvocation({ agentId, input: { runId: state.runId } });
  if (!invocation) throw new Error(`Workflow worker is not registered: ${agentId}`);
  const result = await options.agents.run({
    runId: state.runId,
    nodeId,
    parentSessionId: state.parentSessionId,
    invocation,
    binding: freezeAgentBinding(options.workflow, invocation, outputSchemaId),
    frozenContext,
    artifacts: {
      store: (input) => options.artifacts.write(input),
      read: (artifactRef) => options.artifacts.read(artifactRef),
    },
    ...(chapterWriteGrant === undefined ? {} : { chapterWriteGrant }),
  }, signal ?? new AbortController().signal);
  if (result.outputSchemaId !== outputSchemaId) throw new Error("Workflow worker returned a mismatched output schema");
  return result;
}

async function runWorker(
  options: ChapterWorkflowNodeExecutorOptions,
  state: WorkflowGraphState,
  nodeId: string,
  agentId: string,
  outputSchemaId: string,
  frozenContext: unknown,
  signal?: AbortSignal,
): Promise<ArtifactReference> {
  const key = `${nodeId}/${hash(JSON.stringify(frozenContext))}`;
  const cached = options.modelResults?.getIdempotency("workflow-model-result", key);
  if (cached?.completed && cached.resultRef) {
    const artifact = options.modelResults?.getArtifact(cached.resultRef);
    if (!artifact || artifact.runId !== state.runId || artifact.status !== "ready") {
      throw new Error("Workflow cached model artifact is unavailable");
    }
    return Object.freeze({ artifactRef: artifact.artifactRef, sha256: artifact.sha256 });
  }
  options.modelResults?.claimIdempotency({ scope: "workflow-model-result", key, runId: state.runId });
  const result = await runWorkerResult(options, state, nodeId, agentId, outputSchemaId, frozenContext, signal);
  options.modelResults?.completeIdempotency({
    scope: "workflow-model-result", key, runId: state.runId, resultRef: result.artifact.artifactRef,
  });
  return reference(result.artifact);
}

/**
 * Closed production node map.  It translates only registered graph nodes into
 * artifact-backed domain/worker calls; no model-visible generic tool exists.
 */
export function createChapterWorkflowNodeExecutors(options: ChapterWorkflowNodeExecutorOptions): Readonly<Record<string, NodeExecutor>> {
  const lock = async (state: WorkflowGraphState) => writeJson(options.artifacts, state.runId, "other", await options.domain.lockChapterTarget(state.target));
  const projectionTarget = async (state: WorkflowGraphState) => {
    if (state.appliedArtifact) {
      const applied = await readJson<AppliedChapter>(options.artifacts, state.appliedArtifact);
      return { workId: applied.workId, volumeId: applied.volumeId, chapterId: applied.chapterId };
    }
    if (state.target.mode === "modify") return { workId: state.target.workId, volumeId: state.target.volumeId, chapterId: state.target.chapterId };
    // Legacy candidate-only create runs do not own a chapter directory until
    // approval applies the proposal. Their frozen v1 execution must continue.
    if (state.chapterInitialized !== true) return undefined;
    const locked = ChapterListLockSchema.parse(await readJson(options.artifacts, requireRef(state.targetLock, "target lock")));
    return { workId: locked.target.workId, volumeId: locked.target.volumeId, chapterId: locked.reservedChapterId };
  };
  const saveProjection = async (state: WorkflowGraphState, record: {
    kind: "memory-context" | "plan" | "summary" | "memory-extraction";
    label: string;
    content: string;
  } | {
    kind: "review";
    stage: ReviewStageId;
    round: number;
    label: string;
    content: string;
  }) => {
    try {
      const target = await projectionTarget(state);
      if (!target) return;
      await options.domain.saveWorkflowChapterProjection({ target, runId: state.runId, record });
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "revision_conflict") throw error;
      throw projectionPending(error);
    }
  };
  const runReview = async (
    state: WorkflowGraphState,
    worker: string,
    kind: ReviewStageId,
    nodeId: string,
    signal?: AbortSignal,
  ) => {
    const artifact = await runWorker(options, state, nodeId, worker, "chapter-review.v1", {
      target: state.target,
      userRequest: await frozenUserRequest(options.artifacts, state),
      candidate: ChapterCandidateOutputSchema.parse(await readJson(options.artifacts, requireRef(state.candidate, "candidate"))),
    }, signal);
    const review = ChapterReviewOutputSchemaV1.parse(await readJson(options.artifacts, artifact));
    const patch = {
      reviewArtifacts: { [kind]: artifact },
      reviewOutputs: { [kind]: review },
    };
    const decision = await evaluateReviewStageGateResolved(
      { ...state, ...patch, reviewOutputs: { ...(state.reviewOutputs ?? {}), ...patch.reviewOutputs } },
      kind,
      (candidate) => resolveCandidateContentFromArtifact(options.artifacts, candidate),
    );
    if (decision.kind !== "rejected" && nodeId.endsWith("-review")) {
      const stageRound = state.reviewStageStates?.[kind]?.revisionRound ?? 0;
      await saveProjection(state, {
        kind: "review", stage: kind, round: stageRound + 1,
        label: `${stageLabels[kind]}第 ${stageRound + 1} 轮`, content: renderReview(kind, review),
      });
    }
    return patch;
  };
  const writeCandidate = async (
    state: WorkflowGraphState,
    nodeId: ChapterWriteNodeId,
    writerAgentId: string,
    context: Readonly<Record<string, unknown>>,
    privateExecution: Parameters<NodeExecutor>[0]["privateExecution"],
    signal?: AbortSignal,
  ) => {
    const direct = state.chapterWriteMode === "direct";
    if (privateExecution !== undefined && privateExecution.chapterWriteMode !== state.chapterWriteMode) {
      throw workflowWriteRuntimeUnavailable("Workflow chapter write mode disagrees with the durable run");
    }
    if (direct && privateExecution === undefined) {
      throw workflowWriteRuntimeUnavailable("Direct chapter writing requires the active durable workflow lease");
    }
    const targetLock = direct
      ? requireDirectTargetLock(await readJson<LockedChapterTarget>(options.artifacts, requireRef(state.targetLock, "target lock")))
      : undefined;
    const revisionRound = writeRound(state, nodeId);
    const previousReceipt = direct && nodeId !== "write"
      ? WorkflowChapterWriteReceipt.parse(await readJson(options.artifacts, requireRef(state.chapterWriteArtifact, "chapter write receipt")))
      : undefined;
    if (direct) assertDirectWriteTarget(state, nodeId, targetLock!, previousReceipt);
    const writeMode = direct ? "direct" as const : "candidate-only" as const;
    const stage = stageForEffect(nodeId);
    const previousEffect = previousWriteEffect(state, nodeId);
    const grant = direct ? {
      runId: state.runId,
      nodeId,
      revisionRound,
      operation: {
        effectId: nodeId,
        operation: nodeId === "write" ? "write" : "revise",
        ...(stage === undefined ? {} : { stage }),
        revisionRound,
      },
      ...(previousEffect === undefined ? {} : { previousEffect }),
      lock: targetLock!,
      ...(state.chapterInitialized === undefined ? {} : { chapterInitialized: state.chapterInitialized }),
      ...(previousReceipt === undefined ? {} : { previous: previousReceipt }),
      artifacts: options.artifacts,
      lease: privateExecution!.lease,
    } satisfies WorkflowChapterWriteGrant : undefined;
    const result = await runWorkerResult(options, state, nodeId, writerAgentId, "chapter-candidate.v1", {
      ...context,
      writeMode,
      ...(direct ? { targetLock, revisionRound, ...(previousReceipt === undefined ? {} : { previousReceipt }) } : {}),
    }, signal, grant);
    const artifact = reference(result.artifact);
    const candidate = ChapterCandidateOutputSchema.parse(await readJson(options.artifacts, artifact));
    options.candidateContents?.set(candidate.candidateHash, candidate.content);
    const candidateRef = { artifactRef: artifact.artifactRef, sha256: candidate.candidateHash };
    if (!direct) return { candidate: candidateRef };
    if (!result.chapterWrite) throw workflowWriteRuntimeUnavailable("Direct chapter writing completed without a durable receipt");
    const receipt = WorkflowChapterWriteReceipt.parse(result.chapterWrite.receipt);
    assertDirectWriteResult(nodeId, targetLock!, previousReceipt, candidate.candidateHash, receipt);
    return {
      candidate: candidateRef,
      chapterWriteArtifact: reference(result.chapterWrite.receiptArtifact),
      chapterWriteRevision: receipt.contentHash,
    };
  };
  return Object.freeze({
    "lock-target": async ({ state }) => ({ targetLock: await lock(state) }),
    "initialize-chapter": async ({ state, privateExecution }) => {
      if (state.target.mode === "modify" || state.chapterWriteMode !== "direct") return {};
      if (!privateExecution || privateExecution.chapterWriteMode !== "direct") {
        throw workflowWriteRuntimeUnavailable("Chapter initialization requires the active durable lease");
      }
      privateExecution.assertActive();
      const lockRef = requireRef(state.targetLock, "target lock");
      const lockBytes = await options.artifacts.read(lockRef.artifactRef);
      if (hash(lockBytes.toString("utf8")) !== lockRef.sha256) throw new Error("Chapter initialization lock does not match its checkpoint");
      const targetLock = requireDirectTargetLock(JSON.parse(lockBytes.toString("utf8")) as LockedChapterTarget);
      privateExecution.assertActive();
      assertDirectWriteTarget(state, "write", targetLock, undefined);
      return options.domain.initializeWorkflowChapter({ lock: targetLock, runId: state.runId }, privateExecution.assertActive);
    },
    "query-memory": async ({ state }) => {
      const targetLock = await readJson<any>(options.artifacts, requireRef(state.targetLock, "target lock"));
      const memory = await options.domain.queryMemory({
        lock: targetLock,
        query: { workId: state.target.workId, mode: "current", identities: [] },
      });
      const memoryArtifact = await writeJson(options.artifacts, state.runId, "memory", memory);
      const counts = {
        identities: Array.isArray((memory as any).identities) ? (memory as any).identities.length : Array.isArray((memory as any).nodes) ? (memory as any).nodes.length : 0,
        states: Array.isArray((memory as any).states) ? (memory as any).states.length : 0,
        relations: Array.isArray((memory as any).edges) ? (memory as any).edges.length : 0,
      };
      await saveProjection(state, {
        kind: "memory-context", label: "查询记忆",
        content: `# 查询记忆\n\n已读取 ${counts.identities} 个记忆实体、${counts.states} 条状态和 ${counts.relations} 条关系，供本章策划与写作使用。\n`,
      });
      return { memoryArtifact };
    },
    plan: async ({ state, signal, node }) => {
      const planArtifact = await runWorker(options, state, "plan", boundAgentId(node, "outline-planner"), "chapter-plan.v1", {
        target: state.target, userRequest: await frozenUserRequest(options.artifacts, state), memory: await readJson(options.artifacts, requireRef(state.memoryArtifact, "memory")),
      }, signal);
      const plan = ChapterPlanOutputSchema.parse(await readJson(options.artifacts, planArtifact));
      await saveProjection(state, { kind: "plan", label: "章节策划", content: renderPlan(plan) });
      return { planArtifact };
    },
    write: async ({ state, signal, privateExecution, node }) => writeCandidate(state, "write", boundAgentId(node, "novel-writer"), {
        target: state.target, userRequest: await frozenUserRequest(options.artifacts, state),
        plan: ChapterPlanOutputSchema.parse(await readJson(options.artifacts, requireRef(state.planArtifact, "plan"))),
        memory: await readJson(options.artifacts, requireRef(state.memoryArtifact, "memory")),
      }, privateExecution, signal),
    revise: async ({ state, signal, privateExecution, node }) => writeCandidate(state, "revise", boundAgentId(node, "novel-writer"), {
        target: state.target, userRequest: await frozenUserRequest(options.artifacts, state),
        plan: state.planArtifact ? await readJson(options.artifacts, state.planArtifact) : undefined,
        memory: state.memoryArtifact ? await readJson(options.artifacts, state.memoryArtifact) : undefined,
        candidate: ChapterCandidateOutputSchema.parse(await readJson(options.artifacts, requireRef(state.candidate, "candidate"))),
        reviewFeedback: reviewFeedback(state),
      }, privateExecution, signal),
    continuity: async ({ state, signal }) => runReview(state, "continuity-reviewer", "continuity", "continuity", signal),
    style: async ({ state, signal }) => runReview(state, "style-reviewer", "style", "style", signal),
    "ai-trace": async ({ state, signal }) => runReview(state, "ai-trace-reviewer", "ai-trace", "ai-trace", signal),
    "review-gate": async () => ({}),
    "continuity-review": async ({ state, signal, node }) => runReview(state, boundAgentId(node, "continuity-reviewer"), "continuity", "continuity-review", signal),
    "continuity-gate": async () => ({}),
    "continuity-revise": async ({ state, signal, privateExecution, node }) => writeCandidate(state, "continuity-revise", boundAgentId(node, "novel-writer"), {
      target: state.target, userRequest: await frozenUserRequest(options.artifacts, state),
      plan: state.planArtifact ? await readJson(options.artifacts, state.planArtifact) : undefined,
      memory: state.memoryArtifact ? await readJson(options.artifacts, state.memoryArtifact) : undefined,
      candidate: ChapterCandidateOutputSchema.parse(await readJson(options.artifacts, requireRef(state.candidate, "candidate"))),
      reviewStage: { id: "continuity", revisionRound: state.reviewStageStates?.continuity?.revisionRound ?? 0 },
      reviewFeedback: stageReviewFeedback(state, "continuity"),
    }, privateExecution, signal),
    "style-review": async ({ state, signal, node }) => runReview(state, boundAgentId(node, "style-reviewer"), "style", "style-review", signal),
    "style-gate": async () => ({}),
    "style-revise": async ({ state, signal, privateExecution, node }) => writeCandidate(state, "style-revise", boundAgentId(node, "novel-writer"), {
      target: state.target, userRequest: await frozenUserRequest(options.artifacts, state),
      plan: state.planArtifact ? await readJson(options.artifacts, state.planArtifact) : undefined,
      memory: state.memoryArtifact ? await readJson(options.artifacts, state.memoryArtifact) : undefined,
      candidate: ChapterCandidateOutputSchema.parse(await readJson(options.artifacts, requireRef(state.candidate, "candidate"))),
      reviewStage: { id: "style", revisionRound: state.reviewStageStates?.style?.revisionRound ?? 0 },
      reviewFeedback: stageReviewFeedback(state, "style"),
    }, privateExecution, signal),
    "ai-trace-review": async ({ state, signal, node }) => runReview(state, boundAgentId(node, "ai-trace-reviewer"), "ai-trace", "ai-trace-review", signal),
    "ai-trace-gate": async () => ({}),
    "ai-trace-revise": async ({ state, signal, privateExecution, node }) => writeCandidate(state, "ai-trace-revise", boundAgentId(node, "novel-writer"), {
      target: state.target, userRequest: await frozenUserRequest(options.artifacts, state),
      plan: state.planArtifact ? await readJson(options.artifacts, state.planArtifact) : undefined,
      memory: state.memoryArtifact ? await readJson(options.artifacts, state.memoryArtifact) : undefined,
      candidate: ChapterCandidateOutputSchema.parse(await readJson(options.artifacts, requireRef(state.candidate, "candidate"))),
      reviewStage: { id: "ai-trace", revisionRound: state.reviewStageStates?.["ai-trace"]?.revisionRound ?? 0 },
      reviewFeedback: stageReviewFeedback(state, "ai-trace"),
    }, privateExecution, signal),
    proposal: async ({ state }) => {
      const targetLock = await readJson<any>(options.artifacts, requireRef(state.targetLock, "target lock"));
      const candidate = ChapterCandidateOutputSchema.parse(await readJson(options.artifacts, requireRef(state.candidate, "candidate")));
      const proposal = await options.domain.createChapterProposal({ runId: state.runId, lock: targetLock, candidate, review: { kind: "approved-candidate", candidateHash: candidate.candidateHash } });
      return { proposalId: proposal.proposalId };
    },
    apply: async ({ state, privateApproval }) => {
      if (!privateApproval) throw new Error("Workflow apply requires a private approval capability");
      const targetLock = await readJson<any>(options.artifacts, requireRef(state.targetLock, "target lock"));
      const candidate = ChapterCandidateOutputSchema.parse(await readJson(options.artifacts, requireRef(state.candidate, "candidate")));
      const proposal = { proposalId: privateApproval.proposalId, kind: state.target.mode === "modify" ? "chapter_change" as const : "chapter_create" as const, target: state.target, candidateHash: candidate.candidateHash };
      const applied = await options.domain.applyChapterProposal({ lock: targetLock, proposal, approval: privateApproval });
      return { appliedRevision: applied.appliedRevision, appliedArtifact: await writeJson(options.artifacts, state.runId, "other", applied) };
    },
    verify: async ({ state }) => {
      if (state.chapterWriteMode === "direct") {
        const receipt = WorkflowChapterWriteReceipt.parse(await readJson(options.artifacts, requireRef(state.chapterWriteArtifact, "chapter write receipt")));
        if (state.chapterWriteRevision !== receipt.contentHash || state.candidate?.sha256 !== receipt.contentHash) {
          throw new Error("Workflow direct chapter receipt does not match the reviewed candidate");
        }
        const applied = await options.domain.verifyAppliedChapter({
          proposalId: state.runId,
          workId: receipt.workId,
          volumeId: receipt.volumeId,
          chapterId: receipt.chapterId,
          chapterNumber: receipt.chapterNumber,
          appliedRevision: receipt.revision,
          contentHash: receipt.contentHash,
        });
        return { appliedRevision: applied.appliedRevision, appliedArtifact: await writeJson(options.artifacts, state.runId, "other", applied) };
      }
      const raw = await readJson<Record<string, unknown>>(options.artifacts, requireRef(state.appliedArtifact, "applied chapter"));
      const { status: _status, candidateHash: _candidateHash, ...appliedInput } = raw;
      const applied = await options.domain.verifyAppliedChapter(appliedInput);
      return { appliedRevision: applied.appliedRevision, appliedArtifact: await writeJson(options.artifacts, state.runId, "other", applied) };
    },
    "extract-memory": async ({ state, signal, node }) => {
      const applied = await readJson<AppliedChapter>(options.artifacts, requireRef(state.appliedArtifact, "applied chapter"));
      const candidate = ChapterCandidateOutputSchema.parse(await readJson(options.artifacts, requireRef(state.candidate, "candidate")));
      const outputSchema = node.kind === "agent" && (node.outputSchema === "chapter-memory.v1" || node.outputSchema === "chapter-memory.v2")
        ? node.outputSchema : "chapter-memory.v1";
      if (applied.contentHash !== candidate.candidateHash || applied.appliedRevision !== candidate.candidateHash
        || candidate.candidateHash !== state.candidate?.sha256 || hash(candidate.content) !== candidate.candidateHash) {
        throw new Error("Memory extraction candidate does not match the verified chapter");
      }
      // A lost save acknowledgement may hide a committed episode. Keep its
      // exact fact/evidence identities instead of asking the model for a new
      // version. A prior memory query or invalid legacy extraction is not a cache.
      if (state.memoryArtifact) {
        const bytes = await options.artifacts.read(state.memoryArtifact.artifactRef);
        if (hash(bytes.toString("utf8")) !== state.memoryArtifact.sha256) throw new Error("Memory artifact integrity mismatch");
        const cachedValue = JSON.parse(bytes.toString("utf8"));
        const cachedLegacy = ChapterMemoryOutputSchema.safeParse(cachedValue);
        const cachedTyped = ChapterMemoryOutputSchemaV2.safeParse(cachedValue);
        if (cachedLegacy.success || cachedTyped.success) {
          let grounded;
          try {
            grounded = cachedLegacy.success
              ? groundMemoryEvidence(candidate.content, cachedLegacy.data)
              : groundTypedMemoryEvidence(candidate.content, cachedTyped.data);
          }
          catch (error) { if (!(error instanceof MemoryExtractionEvidenceInvalid)) throw error; }
          if (grounded) {
            signal?.throwIfAborted();
            const memoryArtifact = JSON.stringify(grounded) === JSON.stringify(cachedValue)
              ? state.memoryArtifact : await writeJson(options.artifacts, state.runId, "memory", grounded);
            if (outputSchema === "chapter-memory.v2") {
              await saveProjection(state, {
                kind: "memory-extraction", label: "记忆提取", content: renderMemoryExtraction(grounded),
              });
            }
            return { memoryArtifact };
          }
        }
      }
      const memoryArtifact = await runWorker(options, state, "extract-memory", boundAgentId(node, "memory-extractor"), outputSchema, {
        target: { mode: "modify", workId: applied.workId, volumeId: applied.volumeId, chapterId: applied.chapterId },
        userRequest: await frozenUserRequest(options.artifacts, state), candidate,
      }, signal);
      if (outputSchema === "chapter-memory.v2") {
        await saveProjection(state, {
          kind: "memory-extraction", label: "记忆提取",
          content: renderMemoryExtraction(await readJson(options.artifacts, memoryArtifact)),
        });
      }
      return { memoryArtifact };
    },
    "save-memory": async ({ state }) => {
      const applied = await readJson<any>(options.artifacts, requireRef(state.appliedArtifact, "applied chapter"));
      const extractedValue = await readJson(options.artifacts, requireRef(state.memoryArtifact, "memory"));
      const legacy = ChapterMemoryOutputSchema.safeParse(extractedValue);
      const typed = !legacy.success;
      const extracted = legacy.success
        ? mapChapterMemoryFacts(applied, legacy.data)
        : mapTypedChapterMemoryFacts(applied, ChapterMemoryOutputSchemaV2.parse(extractedValue));
      try {
        await options.domain.saveChapterMemory({ verified: applied, candidate: extracted });
      } catch (error) {
        // A chapter write is already committed at this point.  Preserve that
        // fact and let the supervisor retry only the memory tail.
        // Domain adapters can cross plugin/runtime module boundaries.  Keep the
        // durable tail classification structural as well as nominal so a
        // committed memory write is never downgraded to a failed workflow.
        if (error instanceof TransientDomainError || (
          typeof error === "object"
          && error !== null
          && (error as { tailStatus?: unknown }).tailStatus === "memory_pending"
        )) throw new WorkflowMemoryPending();
        throw error;
      }
      if (typed) {
        const warnings = reviewStageIds.flatMap((stage) =>
          state.reviewStageStates?.[stage]?.status === "continued_with_warnings" ? [stageLabels[stage]] : []);
        await saveProjection(state, {
          kind: "summary", label: "工作流结果",
          content: `# 工作流结果\n\n正文已校验并完成记忆保存。${warnings.length > 0 ? `\n\n以下审查达到轮次上限后带警告继续：${warnings.join("、")}。` : ""}\n`,
        });
      }
      return {};
    },
  });
}

function workflowWriteRuntimeUnavailable(message: string): Error & { code: "workflow_write_runtime_unavailable" } {
  return Object.assign(new Error(message), { code: "workflow_write_runtime_unavailable" as const });
}

function assertDirectWriteTarget(
  state: WorkflowGraphState,
  nodeId: ChapterWriteNodeId,
  lock: DirectChapterTargetLock,
  previous: WorkflowChapterWriteReceiptValue | undefined,
): void {
  const round = writeRound(state, nodeId);
  const lockedChapterId = lock.kind === "chapter" ? lock.target.chapterId : lock.reservedChapterId;
  if (nodeId === "write" && (round !== 0 || previous !== undefined)) {
    throw workflowWriteRuntimeUnavailable("Initial direct chapter writing cannot reuse a prior receipt");
  }
  if (nodeId !== "write" && (
    round < 1
    || previous === undefined
    || previous.workId !== lock.target.workId
    || previous.volumeId !== lock.target.volumeId
    || previous.chapterId !== lockedChapterId
  )) {
    throw workflowWriteRuntimeUnavailable("Direct revision requires the immediately prior receipt for the same chapter");
  }
}

function assertDirectWriteResult(
  nodeId: ChapterWriteNodeId,
  lock: DirectChapterTargetLock,
  previous: WorkflowChapterWriteReceiptValue | undefined,
  candidateHash: string,
  receipt: WorkflowChapterWriteReceiptValue,
): void {
  const expectedOperation = nodeId === "write" && lock.kind === "chapter-list" ? "created" : "replaced";
  const lockedChapterId = lock.kind === "chapter" ? lock.target.chapterId : lock.reservedChapterId;
  if (
    receipt.operation !== expectedOperation
    || receipt.workId !== lock.target.workId
    || receipt.volumeId !== lock.target.volumeId
    || receipt.chapterId !== lockedChapterId
    || receipt.contentHash !== candidateHash
    || (previous !== undefined && receipt.chapterId !== previous.chapterId)
  ) {
    throw workflowWriteRuntimeUnavailable("Direct chapter write receipt does not match the frozen candidate and target");
  }
}

function requireDirectTargetLock(lock: LockedChapterTarget): DirectChapterTargetLock {
  return lock;
}
