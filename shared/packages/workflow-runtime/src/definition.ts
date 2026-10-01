import { z } from "zod";

const NodeId = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
const RegistryId = z.string().regex(/^[A-Za-z][A-Za-z0-9.-]{1,100}$/);

const Budgets = z.object({
  maxRevisionRounds: z.number().int().min(1).max(10),
  hardMaxRevisionRounds: z.literal(10),
  maxSchemaRepairs: z.number().int().min(0).max(2),
  maxTransientRetries: z.number().int().min(0).max(2),
  noProgressRounds: z.number().int().min(1).max(2),
}).strict().superRefine((budgets, context) => {
  if (budgets.maxRevisionRounds > budgets.hardMaxRevisionRounds) {
    context.addIssue({ code: "custom", path: ["maxRevisionRounds"], message: "Revision budget exceeds hard maximum" });
  }
});

const WorkflowNodeSchema = z.discriminatedUnion("kind", [
  z.object({
    id: NodeId,
    kind: z.literal("agent"),
    agent: RegistryId,
    inputSchema: RegistryId.optional(),
    outputSchema: RegistryId,
    candidateHashContract: z.literal("candidate-hash.v1").optional(),
    uiGroup: RegistryId,
  }).strict(),
  z.object({
    id: NodeId,
    kind: z.literal("tool"),
    handler: RegistryId,
    inputSchema: RegistryId.optional(),
    outputSchema: RegistryId.optional(),
    candidateHashContract: z.literal("candidate-hash.v1").optional(),
    uiGroup: RegistryId,
  }).strict(),
  z.object({
    id: NodeId,
    kind: z.literal("approval"),
    approval: z.literal("chapter-proposal"),
    uiGroup: RegistryId,
  }).strict(),
]);

const WorkflowEdgeSchema = z.object({
  from: NodeId,
  to: NodeId,
  when: RegistryId,
}).strict();

const WorkflowDefinitionV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: RegistryId,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  entry: NodeId,
  budgets: Budgets,
  nodes: z.array(WorkflowNodeSchema).min(1).max(64),
  edges: z.array(WorkflowEdgeSchema).max(128),
}).strict();

export const ReviewStageIds = ["continuity", "style", "ai-trace"] as const;

export const ReviewStageDefinitionSchema = z.object({
  id: z.enum(ReviewStageIds),
  reviewer: RegistryId,
  reviser: RegistryId,
  maxRevisionRounds: z.number().int().min(1).max(10),
  hardMaxRevisionRounds: z.literal(10),
  onLimit: z.literal("continue_with_warnings"),
}).strict();

const WorkflowDefinitionV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: RegistryId,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  entry: NodeId,
  budgets: Budgets,
  nodes: z.array(WorkflowNodeSchema).min(1).max(64),
  edges: z.array(WorkflowEdgeSchema).max(128),
  reviewStages: z.array(ReviewStageDefinitionSchema).min(1).max(ReviewStageIds.length),
}).strict();

export const WorkflowDefinitionSchema = z.discriminatedUnion("schemaVersion", [
  WorkflowDefinitionV1Schema,
  WorkflowDefinitionV2Schema,
]);

export type WorkflowDefinitionV1 = z.infer<typeof WorkflowDefinitionV1Schema>;
export type WorkflowDefinitionV2 = z.infer<typeof WorkflowDefinitionV2Schema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type ReviewStageDefinition = z.infer<typeof ReviewStageDefinitionSchema>;
export type ReviewStageId = ReviewStageDefinition["id"];
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

export const BUILT_IN_WORKFLOW_DEFINITION: WorkflowDefinitionV2 = {
  schemaVersion: 2,
  id: "chapter-production",
  version: "2.0.0",
  entry: "lock-target",
  budgets: {
    maxRevisionRounds: 5,
    hardMaxRevisionRounds: 10,
    maxSchemaRepairs: 2,
    maxTransientRetries: 2,
    noProgressRounds: 2,
  },
  nodes: [
    { id: "lock-target", kind: "tool", handler: "jizuo.lockChapterTarget", uiGroup: "target" },
    { id: "initialize-chapter", kind: "tool", handler: "jizuo.initializeWorkflowChapter", uiGroup: "target" },
    { id: "query-memory", kind: "tool", handler: "jizuo.queryMemory", uiGroup: "memory-query" },
    { id: "plan", kind: "agent", agent: "outline-planner", outputSchema: "chapter-plan.v1", uiGroup: "planning" },
    { id: "write", kind: "agent", agent: "novel-writer", outputSchema: "chapter-candidate.v1", uiGroup: "writing" },
    { id: "verify", kind: "tool", handler: "jizuo.verifyAppliedChapter", uiGroup: "verification" },
    { id: "extract-memory", kind: "agent", agent: "memory-extractor", outputSchema: "chapter-memory.v2", uiGroup: "memory-save" },
    { id: "save-memory", kind: "tool", handler: "jizuo.saveChapterMemory", uiGroup: "memory-save" },
  ],
  edges: [
    { from: "lock-target", to: "initialize-chapter", when: "always" },
    { from: "initialize-chapter", to: "query-memory", when: "always" },
    { from: "query-memory", to: "plan", when: "always" },
    { from: "plan", to: "write", when: "always" },
    { from: "write", to: "verify", when: "always" },
    { from: "verify", to: "extract-memory", when: "always" },
    { from: "extract-memory", to: "save-memory", when: "always" },
  ],
  reviewStages: [
    { id: "continuity", reviewer: "continuity-reviewer", reviser: "novel-writer", maxRevisionRounds: 5, hardMaxRevisionRounds: 10, onLimit: "continue_with_warnings" },
    { id: "style", reviewer: "style-reviewer", reviser: "novel-writer", maxRevisionRounds: 5, hardMaxRevisionRounds: 10, onLimit: "continue_with_warnings" },
    { id: "ai-trace", reviewer: "ai-trace-reviewer", reviser: "novel-writer", maxRevisionRounds: 5, hardMaxRevisionRounds: 10, onLimit: "continue_with_warnings" },
  ],
};

export const DEFAULT_WORKFLOW_DEFINITION: WorkflowDefinition = BUILT_IN_WORKFLOW_DEFINITION;
