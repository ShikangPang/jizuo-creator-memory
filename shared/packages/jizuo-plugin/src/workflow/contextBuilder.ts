import { renderSkillPrompt } from "../../../contracts/src/skill-prompt.ts";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { ChapterWorkflowTarget, WorkflowChapterWriteReceipt } from "@jizuo/contracts";
import { z } from "zod";

import { LockedChapterTargetSchema } from "./domainAdapter.ts";

const MAX_CONTEXT_BYTES = 2_000_000;

const FrozenContextSchema = z.object({
  target: ChapterWorkflowTarget,
  userRequest: z.string().trim().min(1).max(32_000),
  writeMode: z.enum(["direct", "candidate-only"]).optional(),
  targetLock: LockedChapterTargetSchema.optional(),
  revisionRound: z.number().int().min(0).max(10).optional(),
  previousReceipt: WorkflowChapterWriteReceipt.optional(),
  plan: z.unknown().optional(),
  candidate: z.unknown().optional(),
  memory: z.unknown().optional(),
  reviewStage: z.object({
    id: z.enum(["continuity", "style", "ai-trace"]),
    revisionRound: z.number().int().min(0).max(10),
  }).strict().optional(),
  reviewFeedback: z.array(z.unknown()).max(256).optional(),
}).strict();

export type FrozenWorkflowWorkerContext = z.infer<typeof FrozenContextSchema>;

function frozenJson(value: unknown): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Workflow worker context must be JSON serializable");
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_CONTEXT_BYTES) {
    throw new Error("Workflow worker context is invalid or exceeds its size boundary");
  }
  return deepFreeze(JSON.parse(serialized));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

/** Parses, clones, and freezes the only model-facing worker data boundary. */
export function freezeWorkflowWorkerContext(value: unknown): FrozenWorkflowWorkerContext {
  const parsed = FrozenContextSchema.parse(frozenJson(value));
  return deepFreeze(parsed);
}

function block(text: string): ContentBlock {
  return Object.freeze({ type: "text" as const, text });
}

/** One immutable data block; worker personas remain static and are never input fields. */
export function buildFrozenPromptBlocks(context: FrozenWorkflowWorkerContext): readonly ContentBlock[] {
  const payload = JSON.stringify(context);
  return Object.freeze([
    block(renderSkillPrompt("workflow-frozen-context",{payload})),
  ]);
}
