import { WorkflowHarnessManifest } from "./harnessManifest.ts";
import { sha256 } from "./hash.ts";
import { outputSchemaBinding, type HarnessJsonSchema } from "./outputSchemaManifest.ts";
import { ChapterReviewSchema, ReviewKinds, type ChapterReview, type ReviewKind } from "./outputSchemas.ts";
import { aggregateReviews, type ReviewGateDecision } from "./reviewGate.ts";
import { evaluateRevisionProgress } from "./revisionBudget.ts";

export type AgentCapability = "memory-read" | "work-read" | "proposal-read";
export type AgentRole = "planner" | "writer" | "reviewer" | "memory-extractor";
export type CandidateHashContractId = "candidate-hash.v1";
export const RequiredReviewKinds = ReviewKinds;
export type RequiredReviewKind = typeof RequiredReviewKinds[number];

export const ChapterReviewOutputSchema = ChapterReviewSchema;

export type ChapterReviewOutput = ChapterReview;
export type ReviewOutputMap = Readonly<Partial<Record<RequiredReviewKind, unknown>>>;
export type ReviewGateResult = ReviewGateDecision;

export interface RegisteredReviewGate {
  readonly requiredReviewKinds: readonly RequiredReviewKind[];
  evaluateCandidate(candidate: Readonly<{ candidateHash: string; content: string }>, reviews: ReviewOutputMap): ReviewGateResult;
}

export interface AgentExecutionRequest {
  readonly agentId: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ResolvedAgentInvocation extends AgentExecutionRequest {
  readonly kind: "harness-agent";
}

export interface DomainToolRequest {
  readonly handlerId: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ResolvedDomainToolInvocation extends DomainToolRequest {
  readonly kind: "domain-tool";
}

export interface RegisteredAgent {
  label: string;
  role: AgentRole;
  capabilities: readonly AgentCapability[];
  /**
   * Code-owned authority for a workflow reviser to request a host-mediated,
   * receipt-verified chapter commit. This is deliberately separate from the
   * model-visible read capabilities and is not part of legacy v1 hashes.
   */
  hostCapabilities: readonly ("chapter-body-commit")[];
  personaHash: string;
  skillHashes: Readonly<Record<string, string>>;
  implementation: Readonly<{
    kind: "harness-agent";
    resolveInvocation(request: AgentExecutionRequest): ResolvedAgentInvocation;
  }>;
  hash: string;
}

export interface RegisteredValue {
  label: string;
  hash: string;
}

export interface RegisteredOutputSchema extends RegisteredValue {
  version: 1;
  candidateHashField: "candidateHash" | null;
  candidateHashContract: CandidateHashContractId | null;
  /** Exact, immutable durable graph-data shape; it is not imposed on model prose. */
  harnessSchema: Readonly<HarnessJsonSchema>;
  /** Canonical SHA-256 of {@link harnessSchema}, carried through the frozen binding. */
  harnessSchemaHash: string;
  implementation: Readonly<{
    kind: "zod-schema";
    parse(value: unknown): unknown;
  }>;
}

export interface RevisionBudgetBinding {
  budgetKey: "maxRevisionRounds";
  counterKey: "remainingRevisionRounds";
  decrementBy: 1;
  hardMaximum: 10;
}

export interface ConditionExecutionState {
  readonly remainingRevisionRounds?: number;
  readonly revisionRound?: number;
  readonly noProgressRounds?: number;
  readonly candidate?: Readonly<{ candidateHash: string; content: string }>;
  readonly previousReviewQuality?: Readonly<{ candidateHash: string; blockingIssueFingerprints: readonly string[]; score: number }>;
  readonly reviewOutcome?: Readonly<{ candidateHash: string; kind: "approved-candidate" | "revise" | "rejected"; blockingIssueFingerprints: readonly string[]; score: number }>;
  readonly revisionDecision?: "approved" | "revise" | "waiting_decision" | "continue_with_warnings" | "blocked";
  readonly approved?: boolean;
  readonly reviewOutputs?: ReviewOutputMap;
  readonly target?: Readonly<{ mode: "modify" | "create_explicit" | "create_next" }>;
  readonly chapterWriteMode?: "candidate-only" | "direct";
  readonly chapterWriteArtifact?: Readonly<{ artifactRef: string; sha256: string }>;
  readonly chapterWriteRevision?: string;
}

export interface RegisteredCondition extends RegisteredValue {
  budget: RevisionBudgetBinding | null;
  reviewGateHandler: string | null;
  implementation: Readonly<{
    kind: "workflow-condition";
    evaluate(state: ConditionExecutionState): boolean;
    consume?(state: ConditionExecutionState): ConditionExecutionState;
  }>;
}

export interface RegisteredTool extends RegisteredValue {
  capabilities: readonly ("work-read" | "work-write" | "memory-read" | "proposal-read" | "proposal-write")[];
  semantic: "candidate-hash-review-gate" | null;
  candidateHashContract: CandidateHashContractId | null;
  reviewGate: RegisteredReviewGate | null;
  implementation: Readonly<{
    kind: "domain-tool";
    resolveInvocation(request: DomainToolRequest): ResolvedDomainToolInvocation;
  }>;
}

export interface RegisteredApproval extends RegisteredValue {
  implementation: Readonly<{
    kind: "checkpoint-approval";
    createInterrupt(proposalId: string): Readonly<{ kind: "checkpoint-approval"; proposalId: string }>;
  }>;
}

export interface WorkflowRegistry {
  readonly agents: Readonly<Record<string, RegisteredAgent>>;
  readonly tools: Readonly<Record<string, RegisteredTool>>;
  readonly outputSchemas: Readonly<Record<string, RegisteredOutputSchema>>;
  readonly conditions: Readonly<Record<string, RegisteredCondition>>;
  readonly uiGroups: Readonly<Record<string, RegisteredValue>>;
  readonly approvals: Readonly<Record<string, RegisteredApproval>>;
}

export interface WorkflowRegistryHashes {
  readonly agents: Readonly<Record<string, string>>;
  readonly tools: Readonly<Record<string, string>>;
  readonly outputSchemas: Readonly<Record<string, string>>;
  readonly conditions: Readonly<Record<string, string>>;
  readonly uiGroups: Readonly<Record<string, string>>;
  readonly approvals: Readonly<Record<string, string>>;
  readonly personas: Readonly<Record<string, string>>;
  readonly skills: Readonly<Record<string, string>>;
}

function value(label: string): RegisteredValue {
  return Object.freeze({ label, hash: sha256({ label }) });
}

function agentImplementation(agentId: string): RegisteredAgent["implementation"] {
  return Object.freeze({
    kind: "harness-agent",
    resolveInvocation(request) {
      if (request.agentId !== agentId) throw new Error(`Agent binding mismatch: ${request.agentId}`);
      return Object.freeze({ kind: "harness-agent", agentId, input: request.input });
    },
  });
}

function domainToolImplementation(handlerId: string): RegisteredTool["implementation"] {
  return Object.freeze({
    kind: "domain-tool",
    resolveInvocation(request) {
      if (request.handlerId !== handlerId) throw new Error(`Tool binding mismatch: ${request.handlerId}`);
      return Object.freeze({ kind: "domain-tool", handlerId, input: request.input });
    },
  });
}

function agent(label: string, role: AgentRole, capabilities: readonly AgentCapability[], agentId: string): RegisteredAgent {
  const binding = WorkflowHarnessManifest.workers[agentId as keyof typeof WorkflowHarnessManifest.workers];
  if (!binding) throw new Error(`Missing Harness resource binding: ${agentId}`);
  const personaHash = binding.persona.sha256;
  const skillHashes = Object.freeze({
    ...Object.fromEntries(binding.skills.map((skill) => {
      const resource = WorkflowHarnessManifest.skills[skill];
      if (!resource) throw new Error(`Missing Harness skill resource binding: ${skill}`);
      return [skill, resource.sha256];
    })),
    "novel-team": WorkflowHarnessManifest.team.sha256,
  });
  return Object.freeze({
    label,
    role,
    capabilities: Object.freeze([...capabilities]),
    hostCapabilities: Object.freeze(role === "writer" ? ["chapter-body-commit" as const] : []),
    personaHash,
    skillHashes,
    implementation: agentImplementation(agentId),
    hash: sha256({ label, role, capabilities: [...capabilities], personaHash, skillHashes, binding: { kind: "harness-agent", agentId } }),
  });
}

function outputSchema(id: string, label: string, candidateHashField: RegisteredOutputSchema["candidateHashField"] = null): RegisteredOutputSchema {
  const binding = outputSchemaBinding(id);
  if (!binding) throw new Error(`Missing workflow output schema binding: ${id}`);
  const candidateHashContract = candidateHashField ? "candidate-hash.v1" : null;
  return Object.freeze({
    version: binding.version,
    label,
    candidateHashField,
    candidateHashContract,
    harnessSchema: binding.harnessSchema,
    harnessSchemaHash: binding.harnessSchemaHash,
    implementation: Object.freeze({ kind: "zod-schema", parse: (input: unknown) => binding.parser.parse(input) }),
    hash: sha256({ id, label, version: binding.version, candidateHashField, candidateHashContract, harnessSchemaHash: binding.harnessSchemaHash, binding: "zod-schema" }),
  });
}

function tool(label: string, capabilities: RegisteredTool["capabilities"], handlerId: string, semantic: RegisteredTool["semantic"] = null, candidateHashContract: CandidateHashContractId | null = null, reviewGate: RegisteredReviewGate | null = null): RegisteredTool {
  return Object.freeze({
    label,
    capabilities: Object.freeze([...capabilities]),
    semantic,
    candidateHashContract,
    reviewGate,
    implementation: domainToolImplementation(handlerId),
    hash: sha256({ label, capabilities: [...capabilities], semantic, candidateHashContract, reviewGate: reviewGate ? { requiredReviewKinds: [...reviewGate.requiredReviewKinds] } : null, binding: { kind: "domain-tool", handlerId } }),
  });
}

function condition(label: string, evaluate: (state: ConditionExecutionState) => boolean, budget: RevisionBudgetBinding | null = null, consume?: (state: ConditionExecutionState) => ConditionExecutionState, reviewGateHandler: string | null = null): RegisteredCondition {
  return Object.freeze({
    label,
    budget,
    reviewGateHandler,
    implementation: Object.freeze({ kind: "workflow-condition", evaluate, ...(consume ? { consume } : {}) }),
    hash: sha256({ label, budget, reviewGateHandler, binding: "workflow-condition" }),
  });
}

function approval(label: string): RegisteredApproval {
  return Object.freeze({
    label,
    implementation: Object.freeze({
      kind: "checkpoint-approval",
      createInterrupt(proposalId: string) {
        return Object.freeze({ kind: "checkpoint-approval" as const, proposalId });
      },
    }),
    hash: sha256({ label, binding: "checkpoint-approval" }),
  });
}

function createReviewGate(): RegisteredReviewGate {
  return Object.freeze({
    requiredReviewKinds: Object.freeze([...RequiredReviewKinds]),
    evaluateCandidate(candidate: Readonly<{ candidateHash: string; content: string }>, reviews: ReviewOutputMap) { return aggregateReviews({ candidate, reviews }); },
  });
}

const aggregateReviewsGate = createReviewGate();
const aggregateReviewsTool = tool(
  "Aggregate same-candidate reviews",
  ["proposal-read"],
  "jizuo.aggregateReviews",
  "candidate-hash-review-gate",
  "candidate-hash.v1",
  aggregateReviewsGate,
);
const allRequiredReviewsPassCondition = condition(
  "All required reviews pass for candidateHash",
  (state) => reviewedCandidateMayProceed(state)
    || (state.candidate !== undefined && aggregateReviewsGate.evaluateCandidate(state.candidate, state.reviewOutputs ?? {}).kind === "approved-candidate"),
  null,
  undefined,
  "jizuo.aggregateReviews",
);

function reviewedCandidateMayProceed(state: ConditionExecutionState): boolean {
  return state.candidate !== undefined
    && (state.reviewOutcome?.kind === "approved-candidate"
      || state.reviewOutcome?.kind === "revise" && state.revisionDecision === "continue_with_warnings")
    && state.reviewOutcome.candidateHash === state.candidate.candidateHash;
}

const approvedCreateTargetCondition = condition(
  "Approved direct create target with matching write receipt",
  (state) => state.target?.mode !== "modify"
    && state.chapterWriteMode === "direct"
    && state.chapterWriteArtifact !== undefined
    && reviewedCandidateMayProceed(state)
    && state.chapterWriteRevision === state.candidate?.candidateHash,
  null,
  undefined,
  "jizuo.aggregateReviews",
);

const approvedModifyTargetCondition = condition(
  "Approved modify target for proposal flow",
  (state) => state.target?.mode === "modify" && reviewedCandidateMayProceed(state),
  null,
  undefined,
  "jizuo.aggregateReviews",
);

export const defaultWorkflowRegistry: WorkflowRegistry = Object.freeze({
  agents: Object.freeze({
    "outline-planner": agent("Outline planner", "planner", ["memory-read", "work-read"], "outline-planner"),
    "novel-writer": agent("Novel writer", "writer", ["memory-read", "work-read", "proposal-read"], "novel-writer"),
    "continuity-reviewer": agent("Continuity reviewer", "reviewer", ["memory-read", "work-read", "proposal-read"], "continuity-reviewer"),
    "style-reviewer": agent("Style reviewer", "reviewer", ["work-read", "proposal-read"], "style-reviewer"),
    "ai-trace-reviewer": agent("AI trace reviewer", "reviewer", ["work-read", "proposal-read"], "ai-trace-reviewer"),
    "memory-extractor": agent("Memory extractor", "memory-extractor", ["memory-read", "work-read"], "memory-extractor"),
  }),
  tools: Object.freeze({
    "jizuo.lockChapterTarget": tool("Lock chapter target", ["work-read"], "jizuo.lockChapterTarget"),
    "jizuo.initializeWorkflowChapter": tool("Initialize workflow chapter", ["work-write"], "jizuo.initializeWorkflowChapter"),
    "jizuo.queryMemory": tool("Query work memory", ["memory-read", "work-read"], "jizuo.queryMemory"),
    "jizuo.aggregateReviews": aggregateReviewsTool,
    "jizuo.createChapterProposal": tool("Create chapter proposal", ["proposal-write"], "jizuo.createChapterProposal", null, "candidate-hash.v1"),
    "jizuo.applyChapterProposal": tool("Apply approved chapter proposal", ["work-write", "proposal-read"], "jizuo.applyChapterProposal"),
    "jizuo.verifyAppliedChapter": tool("Verify applied chapter", ["work-read"], "jizuo.verifyAppliedChapter"),
    "jizuo.saveChapterMemory": tool("Save verified chapter memory", ["memory-read"], "jizuo.saveChapterMemory"),
  }),
  outputSchemas: Object.freeze({
    "chapter-plan.v1": outputSchema("chapter-plan.v1", "Chapter plan v1"),
    "chapter-candidate.v1": outputSchema("chapter-candidate.v1", "Chapter candidate v1", "candidateHash"),
    "chapter-review.v1": outputSchema("chapter-review.v1", "Chapter review v1", "candidateHash"),
    "chapter-approved-candidate.v1": outputSchema("chapter-approved-candidate.v1", "Approved chapter candidate v1", "candidateHash"),
    "chapter-memory.v1": outputSchema("chapter-memory.v1", "Chapter memory v1"),
    "chapter-memory.v2": outputSchema("chapter-memory.v2", "Typed chapter memory v2"),
  }),
  conditions: Object.freeze({
    always: condition("Always", () => true),
    allRequiredReviewsPass: allRequiredReviewsPassCondition,
    approvedCreateTarget: approvedCreateTargetCondition,
    approvedModifyTarget: approvedModifyTargetCondition,
    revisionAllowed: condition(
      "Bounded revision allowed",
      (state) => {
        if (state.revisionDecision !== undefined) return state.revisionDecision === "revise";
        if (!Number.isInteger(state.remainingRevisionRounds) || !state.candidate) return false;
        const review = aggregateReviewsGate.evaluateCandidate(state.candidate, state.reviewOutputs ?? {});
        if (review.kind !== "revise") return false;
        const current = { decision: "revise" as const, blockingIssueFingerprints: review.issues.filter((issue) => issue.blocking).map((issue) => issue.fingerprint), score: averageScore(review.reviews) };
        const previous = state.previousReviewQuality && state.previousReviewQuality.candidateHash !== state.candidate.candidateHash
          ? { decision: "revise" as const, blockingIssueFingerprints: state.previousReviewQuality.blockingIssueFingerprints, score: state.previousReviewQuality.score }
          : undefined;
        return evaluateRevisionProgress({ revisionRound: state.revisionRound ?? 0, maxRevisionRounds: (state.revisionRound ?? 0) + state.remainingRevisionRounds!, noProgressRounds: state.noProgressRounds ?? 0, ...(previous ? { previous } : {}), current }).kind === "revise";
      },
      Object.freeze({ budgetKey: "maxRevisionRounds", counterKey: "remainingRevisionRounds", decrementBy: 1, hardMaximum: 10 }),
      (state) => ({ ...state, remainingRevisionRounds: Math.max(0, (state.remainingRevisionRounds ?? 0) - 1) }),
    ),
    approved: condition("Approved chapter proposal", (state) => state.approved === true),
  }),
  uiGroups: Object.freeze({
    target: value("Target"),
    "memory-query": value("Memory query"),
    planning: value("Planning"),
    writing: value("Writing"),
    review: value("Review"),
    proposal: value("Proposal"),
    approval: value("Approval"),
    application: value("Application"),
    verification: value("Verification"),
    "memory-save": value("Memory save"),
  }),
  approvals: Object.freeze({ "chapter-proposal": approval("Chapter proposal approval") }),
});

function averageScore(reviews: Readonly<Record<ReviewKind, ChapterReview>>): number {
  return Object.values(reviews).reduce((total, review) => total + review.score, 0) / RequiredReviewKinds.length;
}

export function resolveAgent(registry: WorkflowRegistry, id: string): RegisteredAgent | undefined {
  return registry.agents[id];
}

export function resolveTool(registry: WorkflowRegistry, id: string): RegisteredTool | undefined {
  return registry.tools[id];
}

export function resolveOutputSchema(registry: WorkflowRegistry, id: string): RegisteredOutputSchema | undefined {
  return registry.outputSchemas[id];
}

export function resolveCondition(registry: WorkflowRegistry, id: string): RegisteredCondition | undefined {
  return registry.conditions[id];
}

export function resolveApproval(registry: WorkflowRegistry, id: string): RegisteredApproval | undefined {
  return registry.approvals[id];
}

export function registryHashes(registry: WorkflowRegistry): WorkflowRegistryHashes {
  const hashes = (entries: Readonly<Record<string, { hash: string }>>) => Object.freeze(
    Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, entry.hash])),
  );
  return Object.freeze({
    agents: hashes(registry.agents),
    tools: hashes(registry.tools),
    outputSchemas: hashes(registry.outputSchemas),
    conditions: hashes(registry.conditions),
    uiGroups: hashes(registry.uiGroups),
    approvals: hashes(registry.approvals),
    personas: Object.freeze(Object.fromEntries(Object.entries(registry.agents).map(([id, entry]) => [id, entry.personaHash]))),
    skills: Object.freeze(Object.fromEntries(Object.entries(registry.agents).flatMap(([id, entry]) => Object.entries(entry.skillHashes).map(([skill, hash]) => [`${id}:${skill}`, hash])))),
  });
}
