import { END, START, StateGraph, interrupt, type BaseCheckpointSaver, type CompiledStateGraph } from "@langchain/langgraph";
import { z } from "zod";

import { createConditionResolvers, evaluateReviewStageGateResolved, evaluateRevisionDecision, evaluateStrictReviewGateResolved, type CandidateContentResolver, type ConditionResolver } from "./conditions.ts";
import type { ReviewStageDefinition, WorkflowDefinition, WorkflowDefinitionV2, WorkflowNode } from "./definition.ts";
import { validateWorkflowDefinition } from "./invariants.ts";
import {
  resolveAgent,
  resolveTool,
  type ResolvedAgentInvocation,
  type ResolvedDomainToolInvocation,
  type WorkflowRegistry,
} from "./registry.ts";
import {
  WorkflowGraphStatePatchSchema,
  WorkflowGraphStateSchema,
  type ReviewStageState,
  type WorkflowGraphState,
  type WorkflowGraphStatePatch,
} from "./state.ts";

const ApprovalDecisionSchema = z.enum(["approved", "rejected"]);
const ProposalIdSchema = z.string().trim().min(1).max(128);

export interface NodeExecutionContext {
  readonly node: Exclude<WorkflowNode, { kind: "approval" }>;
  readonly invocation: ResolvedAgentInvocation | ResolvedDomainToolInvocation;
  readonly state: WorkflowGraphState;
  /** Host-owned cancellation boundary; lease loss aborts it. */
  readonly signal?: AbortSignal;
  /** Process-local one-time approval capability. Never serialized into graph state. */
  readonly privateApproval?: Readonly<{ proposalId: string; token: string }>;
  /** Durable host metadata. It is process-local and never enters graph data. */
  readonly privateExecution?: Readonly<{
    chapterWriteMode: "candidate-only" | "direct";
    assertActive: () => void;
    lease: Readonly<{ ownerToken: string; ownerPid: number }>;
  }>;
}

export type NodeExecutor = (context: NodeExecutionContext) => WorkflowGraphStatePatch | Promise<WorkflowGraphStatePatch>;

export interface WorkflowRuntimeRegistries {
  readonly workflow: WorkflowRegistry;
  readonly nodeExecutors: Readonly<Record<string, NodeExecutor>>;
  readonly conditionResolvers: Readonly<Record<string, ConditionResolver>>;
  readonly resolveCandidateContent: CandidateContentResolver;
  /**
   * Process-local capability lookup for the apply node.  The capability is
   * intentionally absent from graph state, checkpoints, and projections.
   */
  readonly resolvePrivateApproval?: (state: WorkflowGraphState) => Readonly<{ proposalId: string; token: string }> | undefined;
}

export function createWorkflowRuntimeRegistries(
  workflow: WorkflowRegistry,
  nodeExecutors: Readonly<Record<string, NodeExecutor>>,
  conditionResolvers: Readonly<Record<string, ConditionResolver>>,
  resolveCandidateContent: CandidateContentResolver,
  resolvePrivateApproval?: WorkflowRuntimeRegistries["resolvePrivateApproval"],
): WorkflowRuntimeRegistries {
  return Object.freeze({
    workflow,
    nodeExecutors: Object.freeze({ ...nodeExecutors }),
    conditionResolvers: Object.freeze({ ...conditionResolvers }),
    resolveCandidateContent,
    ...(resolvePrivateApproval === undefined ? {} : { resolvePrivateApproval }),
  });
}

function assertRunThread(state: WorkflowGraphState, config: { configurable?: Record<string, unknown> } | undefined): void {
  const threadId = config?.configurable?.thread_id;
  if (typeof threadId !== "string" || threadId !== state.runId) {
    throw new Error("Workflow graph requires configurable.thread_id to equal state.runId");
  }
}

function invocationFor(node: Exclude<WorkflowNode, { kind: "approval" }>, registry: WorkflowRegistry, state: WorkflowGraphState) {
  if (node.kind === "agent") {
    const agent = resolveAgent(registry, node.agent);
    if (!agent) throw new Error(`Missing registered agent: ${node.agent}`);
    return agent.implementation.resolveInvocation({ agentId: node.agent, input: { runId: state.runId } });
  }
  const tool = resolveTool(registry, node.handler);
  if (!tool) throw new Error(`Missing registered tool: ${node.handler}`);
  return tool.implementation.resolveInvocation({ handlerId: node.handler, input: { runId: state.runId } });
}

function revisionPatch(node: WorkflowNode, state: WorkflowGraphState, registry: WorkflowRegistry): WorkflowGraphStatePatch {
  if (node.id !== "revise") return {};
  const revision = registry.conditions.revisionAllowed;
  const consumed = revision?.implementation.consume?.({ remainingRevisionRounds: state.remainingRevisionRounds });
  if (!consumed || consumed.remainingRevisionRounds === undefined) {
    throw new Error("Registered revisionAllowed condition must consume a revision budget");
  }
  return {
    revisionRound: state.revisionRound + 1,
    remainingRevisionRounds: consumed.remainingRevisionRounds,
  };
}

async function reviewGatePatch(node: WorkflowNode, state: WorkflowGraphState, resolveCandidateContent: CandidateContentResolver): Promise<WorkflowGraphStatePatch> {
  if (node.id !== "review-gate") return {};
  const review = await evaluateStrictReviewGateResolved(state, resolveCandidateContent);
  if (review.kind === "rejected") {
    return { reviewOutcome: { candidateHash: state.candidate?.sha256 ?? "", kind: "rejected", blockingIssueFingerprints: [], score: 0 }, terminalStatus: "blocked", error: { category: "schema", code: "review-gate-rejected", message: "Strict review evidence validation failed" } };
  }
  const score = Object.values(review.reviews).reduce((sum, value) => sum + value.score, 0) / 3;
  const reviewOutcome = { candidateHash: review.candidateHash, kind: review.kind, blockingIssueFingerprints: review.issues.filter((issue) => issue.blocking).map((issue) => issue.fingerprint), score } as const;
  if (review.kind === "approved-candidate") return { reviewOutcome, revisionDecision: "approved", noProgressRounds: 0 };
  const revision = evaluateRevisionDecision(state, review)!;
  if (revision.kind === "revise") return { reviewOutcome, revisionDecision: "revise", noProgressRounds: revision.noProgressRounds };
  if (revision.kind === "waiting_decision") return { reviewOutcome, revisionDecision: "waiting_decision", noProgressRounds: revision.noProgressRounds, terminalStatus: "waiting_decision" };
  return { reviewOutcome, revisionDecision: "continue_with_warnings" };
}

function executorNode(
  node: Exclude<WorkflowNode, { kind: "approval" }>,
  definition: WorkflowDefinition,
  registries: WorkflowRuntimeRegistries,
  terminalOverride?: boolean,
) {
  const executor = registries.nodeExecutors[node.id];
  if (!executor) throw new Error(`Missing NodeExecutor for workflow node: ${node.id}`);
  const terminal = terminalOverride ?? !definition.edges.some((edge) => edge.from === node.id);
  return async (state: WorkflowGraphState, config?: { configurable?: Record<string, unknown> }) => {
    assertRunThread(state, config);
    const consumedRevision = revisionPatch(node, state, registries.workflow);
    const executionState = Object.keys(consumedRevision).length === 0 ? state : { ...state, ...consumedRevision };
    const privateApproval = node.id === "apply" ? registries.resolvePrivateApproval?.(executionState) : undefined;
    const patch = WorkflowGraphStatePatchSchema.parse(await executor({
      node,
      invocation: invocationFor(node, registries.workflow, executionState),
      state: executionState,
      ...(privateApproval === undefined ? {} : { privateApproval }),
    }));
    if (node.id === "review-gate" && patch.candidate && (
      patch.candidate.sha256 !== state.candidate?.sha256 || patch.candidate.artifactRef !== state.candidate?.artifactRef
    )) {
      throw new Error("review-gate executor must not mutate candidate");
    }
    const gatePatch = await reviewGatePatch(node, state, registries.resolveCandidateContent);
    return WorkflowGraphStatePatchSchema.parse({
      ...patch,
      ...consumedRevision,
      ...gatePatch,
      ...(terminal && patch.terminalStatus === undefined ? { terminalStatus: "completed" } : {}),
    });
  };
}

function stageStateFor(state: WorkflowGraphState, stage: ReviewStageDefinition): ReviewStageState {
  return state.reviewStageStates?.[stage.id] ?? {
    status: "waiting",
    revisionRound: 0,
    remainingRevisionRounds: stage.maxRevisionRounds,
    unresolvedIssueFingerprints: [],
  };
}

function serialStageNode(stage: ReviewStageDefinition, kind: "review" | "gate" | "revise"): Exclude<WorkflowNode, { kind: "approval" }> {
  if (kind === "gate") {
    return {
      id: `${stage.id}-gate`,
      kind: "tool",
      handler: "jizuo.aggregateReviews",
      inputSchema: "chapter-review.v1",
      outputSchema: "chapter-approved-candidate.v1",
      candidateHashContract: "candidate-hash.v1",
      uiGroup: "review",
    };
  }
  return kind === "review"
    ? {
      id: `${stage.id}-review`, kind: "agent", agent: stage.reviewer,
      inputSchema: "chapter-candidate.v1", outputSchema: "chapter-review.v1",
      candidateHashContract: "candidate-hash.v1", uiGroup: "review",
    }
    : {
      id: `${stage.id}-revise`, kind: "agent", agent: stage.reviser,
      inputSchema: "chapter-candidate.v1", outputSchema: "chapter-candidate.v1",
      candidateHashContract: "candidate-hash.v1", uiGroup: "review",
    };
}

function serialStageExecutorNode(
  stage: ReviewStageDefinition,
  kind: "review" | "gate" | "revise",
  registries: WorkflowRuntimeRegistries,
) {
  const node = serialStageNode(stage, kind);
  const executor = registries.nodeExecutors[node.id];
  if (!executor) throw new Error(`Missing NodeExecutor for workflow node: ${node.id}`);
  return async (state: WorkflowGraphState, config?: { configurable?: Record<string, unknown> }) => {
    assertRunThread(state, config);
    const current = stageStateFor(state, stage);
    const consumed = kind === "revise"
      ? {
        ...current,
        status: "revising" as const,
        revisionRound: current.revisionRound + 1,
        remainingRevisionRounds: Math.max(0, current.remainingRevisionRounds - 1),
      }
      : current;
    if (kind === "revise" && current.remainingRevisionRounds <= 0) throw new Error(`Review stage ${stage.id} exhausted its revision budget`);
    const executionState: WorkflowGraphState = {
      ...state,
      activeReviewStageId: stage.id,
      reviewStageStates: { ...(state.reviewStageStates ?? {}), [stage.id]: consumed },
    };
    const patch = WorkflowGraphStatePatchSchema.parse(await executor({
      node,
      invocation: invocationFor(node, registries.workflow, executionState),
      state: executionState,
    }));
    if ((kind === "review" || kind === "gate") && patch.candidate && (
      patch.candidate.sha256 !== state.candidate?.sha256 || patch.candidate.artifactRef !== state.candidate?.artifactRef
    )) throw new Error(`${node.id} must not mutate candidate`);

    if (kind === "review") {
      const candidateHash = state.candidate?.sha256;
      if (!candidateHash) throw new Error(`Review stage ${stage.id} requires a candidate`);
      const lastReviewArtifact = patch.reviewArtifacts?.[stage.id];
      return WorkflowGraphStatePatchSchema.parse({
        ...patch,
        activeReviewStageId: stage.id,
        reviewStageStates: {
          [stage.id]: {
            ...current,
            status: "reviewing",
            candidateHash,
            ...(lastReviewArtifact ? { lastReviewArtifact } : {}),
          },
        },
      });
    }

    if (kind === "revise") {
      if (!patch.candidate) throw new Error(`Review stage ${stage.id} reviser must return a candidate`);
      return WorkflowGraphStatePatchSchema.parse({
        ...patch,
        activeReviewStageId: stage.id,
        reviewStageStates: {
          [stage.id]: {
            ...consumed,
            status: "reviewing",
            candidateHash: patch.candidate.sha256,
          },
        },
      });
    }

    const decision = await evaluateReviewStageGateResolved(state, stage.id, registries.resolveCandidateContent);
    const score = state.reviewOutputs?.[stage.id]?.score ?? 0;
    if (decision.kind === "rejected") {
      return WorkflowGraphStatePatchSchema.parse({
        ...patch,
        activeReviewStageId: stage.id,
        reviewStageStates: { [stage.id]: { ...current, status: "reviewing", candidateHash: state.candidate?.sha256 } },
        terminalStatus: "blocked",
        error: { category: "schema", code: "review-stage-gate-rejected", message: `Review stage evidence validation failed: ${decision.reason}` },
      });
    }
    const reviewOutcome = {
      candidateHash: decision.candidateHash,
      kind: decision.kind === "passed" ? "approved-candidate" as const : "revise" as const,
      blockingIssueFingerprints: decision.kind === "revise" ? [...decision.unresolvedIssueFingerprints] : [],
      score,
    };
    if (decision.kind === "passed") {
      return WorkflowGraphStatePatchSchema.parse({
        ...patch,
        activeReviewStageId: stage.id,
        reviewStageStates: { [stage.id]: { ...current, status: "passed", candidateHash: decision.candidateHash, unresolvedIssueFingerprints: [] } },
        reviewOutcome,
        revisionDecision: "approved",
      });
    }
    const reachedLimit = current.remainingRevisionRounds === 0;
    return WorkflowGraphStatePatchSchema.parse({
      ...patch,
      activeReviewStageId: stage.id,
      reviewStageStates: {
        [stage.id]: {
          ...current,
          status: reachedLimit ? "continued_with_warnings" : "revising",
          candidateHash: decision.candidateHash,
          unresolvedIssueFingerprints: [...decision.unresolvedIssueFingerprints],
        },
      },
      reviewOutcome,
      revisionDecision: reachedLimit ? "continue_with_warnings" : "revise",
    });
  };
}

function proposalIdFor(state: WorkflowGraphState): string | undefined {
  return ProposalIdSchema.safeParse(state.proposalId).data;
}

function reviewedCandidateMayProceed(state: WorkflowGraphState): boolean {
  return state.candidate !== undefined
    && (state.reviewOutcome?.kind === "approved-candidate"
      || state.reviewOutcome?.kind === "revise" && state.revisionDecision === "continue_with_warnings")
    && state.reviewOutcome.candidateHash === state.candidate.sha256;
}

function strictReviewGateBranch(condition: string, state: WorkflowGraphState): boolean | undefined {
  if (condition === "allRequiredReviewsPass") return reviewedCandidateMayProceed(state);
  if (condition === "approvedCreateTarget") {
    return state.target.mode !== "modify"
      && state.chapterWriteMode === "direct"
      && state.chapterWriteArtifact !== undefined
      && reviewedCandidateMayProceed(state)
      && state.chapterWriteRevision === state.candidate?.sha256;
  }
  if (condition === "approvedModifyTarget") {
    return state.target.mode === "modify" && reviewedCandidateMayProceed(state);
  }
  if (condition === "revisionAllowed") {
    return state.revisionDecision === "revise" && state.reviewOutcome?.candidateHash === state.candidate?.sha256;
  }
  return undefined;
}

function approvalNode(state: WorkflowGraphState, config?: { configurable?: Record<string, unknown> }): WorkflowGraphStatePatch {
  assertRunThread(state, config);
  const proposalId = proposalIdFor(state);
  if (!proposalId) {
    return {
      approved: false,
      terminalStatus: "blocked",
      error: {
        category: "domain",
        code: "missing-proposal-id",
        message: "Approval requires a persisted proposal ID",
      },
    };
  }
  const decision = ApprovalDecisionSchema.parse(interrupt({
    runId: state.runId,
    proposalId,
    candidateHash: state.candidate?.sha256,
  }));
  return decision === "approved"
    ? { approved: true }
    : { approved: false, terminalStatus: "rejected" };
}

function compileSerialWorkflow(
  definition: WorkflowDefinitionV2,
  registries: WorkflowRuntimeRegistries,
  checkpointer: BaseCheckpointSaver,
): CompiledStateGraph<any, any, string, any> {
  const graph: any = new StateGraph(WorkflowGraphStateSchema);
  for (const node of definition.nodes) {
    if (node.kind === "approval") graph.addNode(node.id, approvalNode as any);
    else graph.addNode(node.id, executorNode(node, definition, registries, node.id === "write" ? false : undefined) as any);
  }
  for (const stage of definition.reviewStages) {
    graph.addNode(`${stage.id}-review`, serialStageExecutorNode(stage, "review", registries) as any);
    graph.addNode(`${stage.id}-gate`, serialStageExecutorNode(stage, "gate", registries) as any);
    graph.addNode(`${stage.id}-revise`, serialStageExecutorNode(stage, "revise", registries) as any);
  }
  graph.addEdge(START, definition.entry);

  for (const node of definition.nodes) {
    if (node.id === "write") continue;
    const outgoing = definition.edges.filter((edge) => edge.from === node.id);
    if (outgoing.length === 0) {
      graph.addEdge(node.id, END);
      continue;
    }
    if (node.kind !== "approval" && outgoing.length === 1 && outgoing[0]!.when === "always") {
      graph.addEdge(node.id, outgoing[0]!.to);
      continue;
    }
    const pathMap: Record<string, string> = Object.fromEntries(outgoing.map((edge) => [edge.to, edge.to]));
    pathMap[END] = END;
    graph.addConditionalEdges(node.id, (state: WorkflowGraphState) => {
      if (node.kind === "approval" && !proposalIdFor(state)) return END;
      for (const edge of outgoing) if (registries.conditionResolvers[edge.when]!(state)) return edge.to;
      return END;
    }, pathMap as any);
  }

  const firstStage = definition.reviewStages[0]!;
  graph.addEdge("write", `${firstStage.id}-review`);
  const macroExits = definition.edges.filter((edge) => edge.from === "write");
  for (const [index, stage] of definition.reviewStages.entries()) {
    const reviewNodeId = `${stage.id}-review`;
    const gateNodeId = `${stage.id}-gate`;
    const reviseNodeId = `${stage.id}-revise`;
    const nextStage = definition.reviewStages[index + 1];
    graph.addEdge(reviewNodeId, gateNodeId);
    graph.addEdge(reviseNodeId, reviewNodeId);
    const continuation = nextStage ? `${nextStage.id}-review` : undefined;
    const pathMap: Record<string, string> = {
      [reviseNodeId]: reviseNodeId,
      ...(continuation ? { [continuation]: continuation } : Object.fromEntries(macroExits.map((edge) => [edge.to, edge.to]))),
      [END]: END,
    };
    graph.addConditionalEdges(gateNodeId, (state: WorkflowGraphState) => {
      if (state.terminalStatus === "blocked") return END;
      const stageState = state.reviewStageStates?.[stage.id];
      if (stageState?.status === "revising") return reviseNodeId;
      if (stageState?.status !== "passed" && stageState?.status !== "continued_with_warnings") return END;
      if (continuation) return continuation;
      for (const edge of macroExits) {
        const strict = strictReviewGateBranch(edge.when, state);
        const matches = strict ?? registries.conditionResolvers[edge.when]!(state);
        if (matches) return edge.to;
      }
      return END;
    }, pathMap as any);
  }
  return graph.compile({ checkpointer }) as CompiledStateGraph<any, any, string, any>;
}

/** Compiles an already validated, closed JSON workflow into a durable LangGraph. */
export function compileWorkflow(
  input: WorkflowDefinition,
  registries: WorkflowRuntimeRegistries,
  checkpointer: BaseCheckpointSaver,
): CompiledStateGraph<any, any, string, any> {
  const validation = validateWorkflowDefinition(input, registries.workflow);
  if (!validation.ok) throw new Error(`Cannot compile invalid workflow: ${validation.issues.map((issue) => issue.code).join(", ")}`);
  if (typeof registries.resolveCandidateContent !== "function") throw new Error("Chapter workflow requires a CandidateContentResolver");
  const definition = validation.definition;

  for (const edge of definition.edges) {
    if (!registries.conditionResolvers[edge.when]) throw new Error(`Missing ConditionResolver: ${edge.when}`);
  }

  if (definition.schemaVersion === 2) return compileSerialWorkflow(definition, registries, checkpointer);

  const graph: any = new StateGraph(WorkflowGraphStateSchema);
  for (const node of definition.nodes) {
    if (node.kind === "approval") graph.addNode(node.id, approvalNode as any);
    else graph.addNode(node.id, executorNode(node, definition, registries) as any);
  }
  graph.addEdge(START, definition.entry);

  for (const node of definition.nodes) {
    const outgoing = definition.edges.filter((edge) => edge.from === node.id);
    if (outgoing.length === 0) {
      graph.addEdge(node.id, END);
      continue;
    }
    if (node.kind !== "approval" && outgoing.length === 1 && outgoing[0]!.when === "always") {
      graph.addEdge(node.id, outgoing[0]!.to);
      continue;
    }
    const pathMap: Record<string, string> = Object.fromEntries(outgoing.map((edge) => [edge.to, edge.to]));
    pathMap[END] = END;
    graph.addConditionalEdges(node.id, (state: WorkflowGraphState) => {
      if (node.kind === "approval" && !proposalIdFor(state)) return END;
      if (node.id === "review-gate" && (state.terminalStatus === "waiting_decision" || state.terminalStatus === "blocked")) return END;
      for (const edge of outgoing) {
        const strict = node.id === "review-gate" ? strictReviewGateBranch(edge.when, state) : undefined;
        const matches = strict ?? registries.conditionResolvers[edge.when]!(state);
        if (matches) return edge.to;
      }
      return END;
    }, pathMap as any);
  }
  return graph.compile({ checkpointer }) as CompiledStateGraph<any, any, string, any>;
}

export { type ConditionResolver } from "./conditions.ts";
