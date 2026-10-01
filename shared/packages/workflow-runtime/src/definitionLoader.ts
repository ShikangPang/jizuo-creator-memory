import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ChapterWorkflowTarget } from "@jizuo/contracts";

import { BUILT_IN_WORKFLOW_DEFINITION, type WorkflowDefinition } from "./definition.ts";
import { deepFreeze, sha256 } from "./hash.ts";
import { validateWorkflowDefinition } from "./invariants.ts";
import { defaultWorkflowRegistry, registryHashes, type WorkflowRegistry, type WorkflowRegistryHashes } from "./registry.ts";

export type WorkflowDefinitionSource = "built-in" | "global" | "work";

export interface WorkflowMemoryBoundary {
  workId: string;
  throughChapterId: string;
}

export interface WorkflowDefinitionLoadInput {
  workRoot: string;
  workflowId: string;
  target?: ChapterWorkflowTarget;
  userRequest?: string;
  memoryBoundary?: WorkflowMemoryBoundary;
}

export interface WorkflowDefinitionLoaderOptions {
  settingsRoot?: string;
  registry?: WorkflowRegistry;
  builtInDefinitions?: readonly WorkflowDefinition[];
}

export interface WorkflowDefinitionDiagnostic {
  source: "global" | "work";
  workflowId: string;
  reason: "invalid-definition" | "legacy-default-upgraded";
}

// Canonical 1.0.0 shipped template, excluding user-adjustable budgets. Never
// upgrade arbitrary custom graphs or reinterpret an already frozen run.
const LEGACY_DEFAULT_TOPOLOGY_HASH = "fdcde0f3368b2ecf60ba6008f95d6f6022e75ab4bd1b5a38ec0bec1b3219e285";
const DIRECT_DEFAULT_TOPOLOGY_HASH = "d67ffab4c30a521d13065c3bb717e0b7efb3089003b7ba662da917e8a1064b30";

export interface FrozenWorkflowDefinition {
  readonly source: WorkflowDefinitionSource;
  readonly definition: Readonly<WorkflowDefinition>;
  readonly definitionHash: string;
  readonly workflowId: string;
  readonly version: string;
  readonly registryHashes: WorkflowRegistryHashes;
  readonly target: ChapterWorkflowTarget | null;
  readonly userRequest: string | null;
  readonly memoryBoundary: Readonly<WorkflowMemoryBoundary> | null;
  readonly initialBudget: Readonly<WorkflowDefinition["budgets"]>;
  readonly diagnostics: readonly WorkflowDefinitionDiagnostic[];
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return null;
  }
}

export class WorkflowDefinitionLoader {
  private readonly settingsRoot: string | undefined;
  private readonly registry: WorkflowRegistry;
  private readonly builtIns: readonly WorkflowDefinition[];

  constructor(options: WorkflowDefinitionLoaderOptions = {}) {
    this.settingsRoot = options.settingsRoot;
    this.registry = options.registry ?? defaultWorkflowRegistry;
    this.builtIns = options.builtInDefinitions ?? [BUILT_IN_WORKFLOW_DEFINITION];
    for (const definition of this.builtIns) {
      if (!validateWorkflowDefinition(structuredClone(definition), this.registry).ok) {
        throw new Error(`Invalid built-in workflow: ${definition.id}`);
      }
    }
  }

  async load(input: WorkflowDefinitionLoadInput): Promise<FrozenWorkflowDefinition> {
    const builtIn = this.builtIns.find((definition) => definition.id === input.workflowId);
    if (!builtIn) throw new Error(`Unknown built-in workflow: ${input.workflowId}`);
    const validatedBuiltIn = validateWorkflowDefinition(structuredClone(builtIn), this.registry);
    if (!validatedBuiltIn.ok) throw new Error(`Invalid built-in workflow: ${input.workflowId}`);
    const diagnostics: WorkflowDefinitionDiagnostic[] = [];
    const layers: { source: "work" | "global"; path: string | undefined }[] = [
      { source: "work", path: join(input.workRoot, ".jizuo", "workflows", `${input.workflowId}.json`) },
      { source: "global", path: this.settingsRoot ? join(this.settingsRoot, "workflows", `${input.workflowId}.json`) : undefined },
    ];
    for (const layer of layers) {
      if (!layer.path) continue;
      const candidate = await readJson(layer.path);
      if (candidate === undefined) continue;
      const validated = validateWorkflowDefinition(candidate, this.registry);
      if (!validated.ok || validated.definition.id !== input.workflowId) {
        diagnostics.push({ source: layer.source, workflowId: input.workflowId, reason: "invalid-definition" });
        return this.freeze(validatedBuiltIn.definition, "built-in", input, diagnostics);
      }
      const { budgets, ...topology } = validated.definition;
      if (layer.source === "global" && [LEGACY_DEFAULT_TOPOLOGY_HASH, DIRECT_DEFAULT_TOPOLOGY_HASH].includes(sha256(topology))
        && validatedBuiltIn.definition.version !== validated.definition.version) {
        diagnostics.push({ source: layer.source, workflowId: input.workflowId, reason: "legacy-default-upgraded" });
        return this.freeze({ ...validatedBuiltIn.definition, budgets }, "built-in", input, diagnostics);
      }
      return this.freeze(validated.definition, layer.source, input, diagnostics);
    }
    return this.freeze(validatedBuiltIn.definition, "built-in", input, diagnostics);
  }

  private freeze(definition: WorkflowDefinition, source: WorkflowDefinitionSource, input: WorkflowDefinitionLoadInput, diagnostics: readonly WorkflowDefinitionDiagnostic[]): FrozenWorkflowDefinition {
    const clone = structuredClone(definition);
    return deepFreeze({
      source,
      definition: clone,
      definitionHash: sha256(clone),
      workflowId: clone.id,
      version: clone.version,
      registryHashes: registryHashes(this.registry),
      target: input.target ? structuredClone(input.target) : null,
      userRequest: input.userRequest ?? null,
      memoryBoundary: input.memoryBoundary ? structuredClone(input.memoryBoundary) : null,
      initialBudget: structuredClone(clone.budgets),
      diagnostics: [...diagnostics],
    });
  }
}
