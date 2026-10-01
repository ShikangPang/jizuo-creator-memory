import { z } from "zod";

import { StableId } from "./work.ts";

const workflowTitle = z.string().trim().min(1).max(120);
const workflowTimestamp = z.string().datetime();

export const ChapterWorkflowTarget = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("modify"),
    workId: StableId,
    volumeId: StableId,
    chapterId: StableId,
  }).strict(),
  z.object({
    mode: z.literal("create_explicit"),
    workId: StableId,
    volumeId: StableId,
    title: workflowTitle,
  }).strict(),
  z.object({
    mode: z.literal("create_next"),
    workId: StableId,
    volumeId: StableId,
    afterChapterId: StableId,
    title: workflowTitle,
  }).strict(),
]);

export const WorkflowChapterWriteArgs = z.object({
  content: z.string().min(1),
  plan: z.string().default(""),
  detailedOutline: z.string().default(""),
}).strict();

export const WorkflowChapterWriteReceipt = z.object({
  operation: z.enum(["created", "replaced"]),
  workId: StableId,
  volumeId: StableId,
  chapterId: StableId,
  chapterNumber: z.number().int().positive(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const WorkflowRunStatus = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "waiting_decision",
  "paused",
  "retrying",
  "memory_pending",
  "completed",
  "blocked",
  "failed",
  "rejected",
  "cancelled",
]);

export const WorkflowStepStatus = z.enum([
  "waiting",
  "running",
  "completed",
  "retrying",
  "blocked",
  "failed",
  "skipped",
  "cancelled",
]);

/** Bounded, display-ready output from one workflow node. Prompts and runtime
 * identifiers are never part of this value; long prose is explicitly marked
 * when it has been clipped for the live conversation projection. */
export const WorkflowStepOutputProjection = z.object({
  content: z.string().min(1).max(20_000),
  truncated: z.boolean(),
}).strict();

export const WorkflowStepProjection = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  label: z.string().trim().min(1).max(40),
  status: WorkflowStepStatus,
  /** Completed successfully, but the user should review a non-fatal result. */
  warning: z.boolean().optional(),
  summary: z.string().trim().max(240).optional(),
  output: WorkflowStepOutputProjection.optional(),
  attempt: z.number().int().positive(),
  durationMs: z.number().int().nonnegative().optional(),
}).strict();

export const WorkflowRevisionProjection = z.object({
  completed: z.number().int().nonnegative().max(10),
  budget: z.number().int().min(1).max(10),
  hardMaximum: z.literal(10),
}).strict().superRefine((revision, context) => {
  if (revision.completed > revision.budget) {
    context.addIssue({
      code: "custom",
      path: ["completed"],
      message: "已完成修订轮数不能超过当前预算",
    });
  }
});

export const WorkflowRunAvailableAction = z.enum([
  "approve_proposal",
  "reject_proposal",
  "extend_review",
  "resume",
  "reconcile_apply",
  "cancel",
]);

export const ChapterWorkflowControlAction = z.enum([
  "inspect",
  "extend_review",
  "resume",
  "reconcile_apply",
  "cancel",
]);

export const ControlChapterWorkflowInput = z.object({
  action: ChapterWorkflowControlAction,
  confirmCancel: z.literal(true).optional(),
}).strict().superRefine((input, context) => {
  if (input.action === "cancel" && input.confirmCancel !== true) {
    context.addIssue({
      code: "custom",
      path: ["confirmCancel"],
      message: "只有用户明确要求取消时才能确认取消",
    });
  }
  if (input.action !== "cancel" && input.confirmCancel !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["confirmCancel"],
      message: "非取消操作不得携带取消确认",
    });
  }
});

const WorkflowRunAvailableActions = z.array(WorkflowRunAvailableAction).max(6)
  .refine((actions) => new Set(actions).size === actions.length, {
    message: "工作流可用操作不能重复",
  });

export const WorkflowRunProjection = z.object({
  runId: StableId,
  sessionId: StableId,
  target: ChapterWorkflowTarget,
  status: WorkflowRunStatus,
  currentGroup: z.number().int().min(1).max(10),
  totalGroups: z.number().int().min(1).max(10),
  /** Only the server's durable chapter-write receipt can establish this fact. */
  draftRetained: z.boolean().optional(),
  /** Server-authoritative operations currently valid for this exact run. */
  availableActions: WorkflowRunAvailableActions.optional(),
  revision: WorkflowRevisionProjection,
  steps: z.array(WorkflowStepProjection).min(1).max(10),
  createdAt: workflowTimestamp,
  updatedAt: workflowTimestamp,
}).strict().refine((run) => run.steps.length === run.totalGroups, {
  path: ["steps"], message: "进度分组数量必须与总步数一致",
}).refine((run) => run.currentGroup <= run.totalGroups, {
  path: ["currentGroup"], message: "当前进度不能超过总步数",
});

export const WorkflowApprovalProjection = z.object({
  proposalId: StableId,
}).strict();

export const WorkflowRunDetailProjection = WorkflowRunProjection.safeExtend({
  approval: WorkflowApprovalProjection.optional(),
}).strict();

export const StartChapterWorkflowInput = z.object({
  target: ChapterWorkflowTarget,
  userRequest: z.string().trim().min(1).max(4_000),
}).strict();

export const ListWorkflowRunsInput = z.object({
  sessionId: StableId.optional(),
  statuses: z.array(WorkflowRunStatus).min(1).optional(),
}).strict();

export const GetWorkflowRunInput = z.object({
  runId: StableId,
}).strict();

export const DecideWorkflowApprovalInput = z.object({
  runId: StableId,
  proposalId: StableId,
  decision: z.enum(["approved", "rejected"]),
}).strict();

export const ExtendWorkflowBudgetInput = z.object({
  runId: StableId,
  additionalRounds: z.literal(2),
}).strict();

export const WorkflowRunActionInput = z.object({
  runId: StableId,
}).strict();

export const PauseWorkflowRunInput = WorkflowRunActionInput;
export const ResumeWorkflowRunInput = WorkflowRunActionInput;
export const CancelWorkflowRunInput = WorkflowRunActionInput;

export const WatchWorkflowRunsInput = z.object({
  sessionId: StableId,
  afterSequence: z.number().int().nonnegative(),
  timeoutMs: z.number().int().min(0).max(25_000),
}).strict();

export type ChapterWorkflowTarget = z.infer<typeof ChapterWorkflowTarget>;
export type WorkflowChapterWriteArgs = z.infer<typeof WorkflowChapterWriteArgs>;
export type WorkflowChapterWriteReceipt = z.infer<typeof WorkflowChapterWriteReceipt>;
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatus>;
export type WorkflowStepStatus = z.infer<typeof WorkflowStepStatus>;
export type WorkflowStepOutputProjection = z.infer<typeof WorkflowStepOutputProjection>;
export type WorkflowStepProjection = z.infer<typeof WorkflowStepProjection>;
export type WorkflowRevisionProjection = z.infer<typeof WorkflowRevisionProjection>;
export type WorkflowRunAvailableAction = z.infer<typeof WorkflowRunAvailableAction>;
export type ChapterWorkflowControlAction = z.infer<typeof ChapterWorkflowControlAction>;
export type ControlChapterWorkflowInput = z.infer<typeof ControlChapterWorkflowInput>;
export type WorkflowRunProjection = z.infer<typeof WorkflowRunProjection>;
export type WorkflowApprovalProjection = z.infer<typeof WorkflowApprovalProjection>;
export type WorkflowRunDetailProjection = z.infer<typeof WorkflowRunDetailProjection>;
export type StartChapterWorkflowInput = z.infer<typeof StartChapterWorkflowInput>;
export type ListWorkflowRunsInput = z.infer<typeof ListWorkflowRunsInput>;
export type GetWorkflowRunInput = z.infer<typeof GetWorkflowRunInput>;
export type DecideWorkflowApprovalInput = z.infer<typeof DecideWorkflowApprovalInput>;
export type ExtendWorkflowBudgetInput = z.infer<typeof ExtendWorkflowBudgetInput>;
export type WorkflowRunActionInput = z.infer<typeof WorkflowRunActionInput>;
export type PauseWorkflowRunInput = z.infer<typeof PauseWorkflowRunInput>;
export type ResumeWorkflowRunInput = z.infer<typeof ResumeWorkflowRunInput>;
export type CancelWorkflowRunInput = z.infer<typeof CancelWorkflowRunInput>;
export type WatchWorkflowRunsInput = z.infer<typeof WatchWorkflowRunsInput>;
