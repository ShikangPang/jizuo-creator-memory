import { createHash } from "node:crypto";

import {
  WorkflowHarnessManifest,
  defaultWorkflowRegistry,
  type FrozenAgentBinding,
  type WorkflowHarnessWorkerId,
  type WorkflowRegistry,
} from "@jizuo/workflow-runtime";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { BUILTIN_RESOURCE_MANIFEST } from "../skills.ts";

export interface WorkflowResourceReader {
  read(resourcePath: string): Promise<string>;
}

export interface RegisteredWorkflowWorker {
  readonly agentId: WorkflowHarnessWorkerId;
  readonly publicLabel: string;
  readonly persona: Readonly<{ id: WorkflowHarnessWorkerId; text: string; hash: string }>;
  readonly skills: readonly string[];
  readonly tools: readonly string[];
  readonly canWrite: boolean;
  readonly outputSchema: Readonly<{
    id: string;
    version: 1;
    hash: string;
    parse(value: unknown): unknown;
  }>;
  readonly artifactKind: "plan" | "candidate" | "review" | "memory";
  readonly reviewKind?: "continuity" | "style" | "ai-trace";
}

const ReadOnlyWorkflowToolSchema = z.enum([
  "jizuo_list_works",
  "jizuo_list_volumes",
  "jizuo_list_chapters",
  "jizuo_read_chapter",
  "jizuo_query_memory",
]);

const WorkflowAgentToolSchema = z.union([
  ReadOnlyWorkflowToolSchema,
  z.literal("jizuo_workflow_write_chapter"),
]);

const AgentResourceMetadataSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  role: z.literal("subagent"),
  canWrite: z.boolean(),
  skills: z.array(z.string().trim().min(1)).default([]),
  tools: z.array(WorkflowAgentToolSchema).min(1),
}).strict().superRefine((metadata, context) => {
  const declaresWorkflowWrite = metadata.tools.includes("jizuo_workflow_write_chapter");
  const writerIds = ["novel-writer"];
  if (metadata.canWrite && !writerIds.includes(metadata.id)) {
    context.addIssue({ code: "custom", path: ["canWrite"], message: "Only a registered novel writer may declare workflow write authority" });
  }
  if (declaresWorkflowWrite && (!writerIds.includes(metadata.id) || metadata.canWrite !== true)) {
    context.addIssue({ code: "custom", path: ["tools"], message: "Only a writable novel writer may declare the workflow chapter write tool" });
  }
});

interface ParsedWorkflowAgentResource {
  readonly id: string;
  readonly name: string;
  readonly persona: string;
  readonly skills: readonly string[];
  readonly tools: readonly string[];
  readonly canWrite: boolean;
}

function unique(values: readonly string[], field: string): readonly string[] {
  if (new Set(values).size !== values.length) throw new Error(`Workflow agent ${field} contains duplicate entries`);
  return Object.freeze([...values]);
}

/** Parse one hash-verified agent file into the native Harness child-agent inputs. */
export function parseWorkflowAgentResource(contents: string): ParsedWorkflowAgentResource {
  const matched = contents.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!matched) throw new Error("Workflow agent resource is missing YAML frontmatter");
  const metadata = AgentResourceMetadataSchema.parse(parseYaml(matched[1]!));
  const skills = unique(metadata.skills, "skills");
  const declaredTools = unique(metadata.tools, "tools");
  const tools = Object.freeze([
    ...(skills.length > 0 ? ["skill"] : []),
    ...declaredTools,
  ]);
  const persona = matched[2]!.trim();
  if (persona === "") throw new Error("Workflow agent persona is empty");
  return Object.freeze({ id: metadata.id, name: metadata.name, persona, skills, tools, canWrite: metadata.canWrite });
}

const labels: Readonly<Record<WorkflowHarnessWorkerId, string>> = Object.freeze({
  "outline-planner": "章节策划",
  "novel-writer": "小说写作",
  "continuity-reviewer": "连贯性审校",
  "style-reviewer": "文风审校",
  "ai-trace-reviewer": "AI 痕迹审查",
  "memory-extractor": "章节记忆提取",
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resourceHash(path: string): string | undefined {
  return BUILTIN_RESOURCE_MANIFEST.find((resource) => resource.path === path)?.sha256;
}

function sameHashes(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => key === rightEntries[index]![0] && value === rightEntries[index]![1]);
}

/** Closed mapper from frozen bindings to shipped, hash-verified Harness resources. */
export class HarnessAgentWorkerRegistry {
  readonly #cache = new Map<string, Promise<string>>();

  constructor(
    private readonly resources: WorkflowResourceReader,
    private readonly workflow: WorkflowRegistry = defaultWorkflowRegistry,
  ) {
    const expected = [WorkflowHarnessManifest.workflow, WorkflowHarnessManifest.team, WorkflowHarnessManifest.skill, ...Object.values(WorkflowHarnessManifest.skills), ...Object.values(WorkflowHarnessManifest.workers).map((worker) => worker.persona)];
    for (const resource of expected) {
      if (resourceHash(resource.path) !== resource.sha256) {
        throw new Error(`Workflow resource manifest drifted: ${resource.path}`);
      }
    }
  }

  async resolve(binding: FrozenAgentBinding): Promise<RegisteredWorkflowWorker | undefined> {
    const worker = WorkflowHarnessManifest.workers[binding.agentId as WorkflowHarnessWorkerId];
    const agent = this.workflow.agents[binding.agentId];
    const outputSchema = this.workflow.outputSchemas[binding.outputSchemaId];
    if (!worker || !agent || !outputSchema) return undefined;
    if (
      worker.outputSchemaId !== binding.outputSchemaId
      || worker.outputSchemaVersion !== binding.outputSchemaVersion
      || worker.outputSchemaHash !== binding.harnessSchemaHash
      || binding.agentHash !== agent.hash
      || binding.personaHash !== agent.personaHash
      || !sameHashes(binding.skillHashes, agent.skillHashes)
      || binding.outputSchemaHash !== outputSchema.hash
      || outputSchema.version !== binding.outputSchemaVersion
      || outputSchema.harnessSchemaHash !== worker.outputSchemaHash
      || agent.personaHash !== worker.persona.sha256
    ) return undefined;
    const workflowResource = WorkflowHarnessManifest.workflow;
    const [personaResource] = await Promise.all([
      this.readVerified(worker.persona.path, worker.persona.sha256),
      this.readVerified(workflowResource.path, workflowResource.sha256),
      this.readVerified(WorkflowHarnessManifest.team.path, WorkflowHarnessManifest.team.sha256),
      this.readVerified(WorkflowHarnessManifest.skill.path, WorkflowHarnessManifest.skill.sha256),
      ...worker.skills.map((skill) => {
        const resource = WorkflowHarnessManifest.skills[skill];
        if (!resource) throw new Error(`Workflow worker declares an unregistered skill: ${skill}`);
        return this.readVerified(resource.path, resource.sha256);
      }),
    ]);
    const definition = parseWorkflowAgentResource(personaResource);
    if (definition.id !== binding.agentId) {
      throw new Error(`Workflow agent resource identity mismatch: ${worker.persona.path}`);
    }
    if (definition.skills.length !== worker.skills.length || definition.skills.some((skill, index) => skill !== worker.skills[index])) {
      throw new Error(`Workflow agent skill binding mismatch: ${worker.persona.path}`);
    }
    return Object.freeze({
      agentId: binding.agentId as WorkflowHarnessWorkerId,
      publicLabel: labels[binding.agentId as WorkflowHarnessWorkerId],
      persona: Object.freeze({ id: binding.agentId as WorkflowHarnessWorkerId, text: definition.persona, hash: worker.persona.sha256 }),
      skills: definition.skills,
      tools: definition.tools,
      canWrite: definition.canWrite,
      outputSchema: Object.freeze({
        id: binding.outputSchemaId,
        version: outputSchema.version,
        hash: outputSchema.hash,
        parse: outputSchema.implementation.parse,
      }),
      artifactKind: worker.artifactKind,
      ...("reviewKind" in worker ? { reviewKind: worker.reviewKind } : {}),
    });
  }

  private readVerified(path: string, expectedHash: string): Promise<string> {
    let value = this.#cache.get(path);
    if (!value) {
      value = this.resources.read(path).then((contents) => {
        if (hash(contents) !== expectedHash) throw new Error(`Workflow resource integrity check failed: ${path}`);
        return contents;
      });
      this.#cache.set(path, value);
    }
    return value;
  }
}

export function createHarnessAgentWorkerRegistry(resources: WorkflowResourceReader, workflow?: WorkflowRegistry): HarnessAgentWorkerRegistry {
  return new HarnessAgentWorkerRegistry(resources, workflow);
}
