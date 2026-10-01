import { sha256 } from "./hash.ts";
import type { WorkflowChapterWriteReceipt } from "@jizuo/contracts";
import { outputSchemaBinding } from "./outputSchemaManifest.ts";
import type { WorkflowArtifactHandle, WorkflowArtifactKind } from "./repository.ts";
import type { ResolvedAgentInvocation, WorkflowRegistry } from "./registry.ts";

export interface FrozenAgentBinding {
  readonly agentId: string;
  readonly agentHash: string;
  readonly personaHash: string;
  readonly skillHashes: Readonly<Record<string, string>>;
  readonly outputSchemaId: string;
  readonly outputSchemaVersion: 1;
  readonly outputSchemaHash: string;
  /** Canonical hash of the exact Harness JSON Schema, independently frozen from the registry entry hash. */
  readonly harnessSchemaHash: string;
}

export interface AgentRunnerArtifactStore {
  store(input: Readonly<{ runId: string; kind: WorkflowArtifactKind; contents: string }>): Promise<WorkflowArtifactHandle>;
  read(artifactRef: string): Promise<Buffer>;
}

export interface AgentRunnerRequest {
  readonly runId: string;
  /** Frozen graph node identity used only for user-visible stream labelling. */
  readonly nodeId: string;
  readonly parentSessionId: string;
  readonly invocation: ResolvedAgentInvocation;
  readonly binding: FrozenAgentBinding;
  readonly frozenContext: unknown;
  readonly artifacts: AgentRunnerArtifactStore;
  /**
   * Process-local, adapter-owned authority. Its target and lease fields are
   * deliberately opaque here and must never be merged into frozenContext.
   */
  readonly chapterWriteGrant?: unknown;
}

/** Artifact-only worker completion: no candidate, review, or memory body enters graph state. */
export interface AgentRunnerResult {
  readonly agentId: string;
  readonly outputSchemaId: string;
  readonly schemaVersion: 1;
  readonly artifact: Readonly<WorkflowArtifactHandle>;
  readonly repairAttempts: number;
  readonly chapterWrite?: Readonly<{
    readonly receipt: WorkflowChapterWriteReceipt;
    readonly receiptArtifact: Readonly<WorkflowArtifactHandle>;
  }>;
}

export interface AgentRunnerPort {
  run(request: AgentRunnerRequest, signal: AbortSignal): Promise<AgentRunnerResult>;
}

function sameHashes(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => key === rightEntries[index]![0] && value === rightEntries[index]![1]);
}

/** Rejects stale or forged frozen bindings before an adapter is allowed to call a model. */
export function validateAgentRunnerRequest(request: AgentRunnerRequest, registry: WorkflowRegistry): void {
  const agent = registry.agents[request.invocation.agentId];
  const outputSchema = registry.outputSchemas[request.binding.outputSchemaId];
  if (!agent || request.invocation.kind !== "harness-agent" || request.binding.agentId !== request.invocation.agentId) {
    throw new Error("Agent runner requires a registered Harness invocation");
  }
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(request.nodeId)) {
    throw new Error("Agent runner requires a valid workflow node id");
  }
  if (
    request.chapterWriteGrant !== undefined
    && (
      request.invocation.agentId !== "novel-writer"
      || !["write", "revise", "continuity-revise", "style-revise", "ai-trace-revise"].includes(request.nodeId)
    )
  ) {
    throw new Error("Agent runner direct chapter write grant is restricted to writer write or revise nodes");
  }
  if (!outputSchema || request.binding.outputSchemaVersion !== outputSchema.version) {
    throw new Error("Agent runner requires a registered output schema version");
  }
  const schemaBinding = outputSchemaBinding(request.binding.outputSchemaId);
  if (
    !schemaBinding
    || outputSchema.harnessSchema !== schemaBinding.harnessSchema
    || outputSchema.harnessSchemaHash !== schemaBinding.harnessSchemaHash
    || sha256(outputSchema.harnessSchema) !== schemaBinding.harnessSchemaHash
    || request.binding.harnessSchemaHash !== schemaBinding.harnessSchemaHash
  ) {
    throw new Error("Agent runner rejected a drifted Harness output schema");
  }
  if (
    request.binding.agentHash !== agent.hash
    || request.binding.personaHash !== agent.personaHash
    || !sameHashes(request.binding.skillHashes, agent.skillHashes)
    || request.binding.outputSchemaHash !== outputSchema.hash
  ) {
    throw new Error("Agent runner rejected a stale or forged frozen binding");
  }
}

export function freezeAgentBinding(
  registry: WorkflowRegistry,
  invocation: ResolvedAgentInvocation,
  outputSchemaId: string,
): FrozenAgentBinding {
  const agent = registry.agents[invocation.agentId];
  const outputSchema = registry.outputSchemas[outputSchemaId];
  if (!agent || !outputSchema || invocation.kind !== "harness-agent") throw new Error("Cannot freeze an unregistered Harness worker binding");
  return Object.freeze({
    agentId: invocation.agentId,
    agentHash: agent.hash,
    personaHash: agent.personaHash,
    skillHashes: Object.freeze({ ...agent.skillHashes }),
    outputSchemaId,
    outputSchemaVersion: outputSchema.version,
    outputSchemaHash: outputSchema.hash,
    harnessSchemaHash: outputSchema.harnessSchemaHash,
  });
}
