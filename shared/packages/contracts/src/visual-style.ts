import { MEDIA_PROMPT_RULES } from "./media-prompt-rules.generated.ts";
import { renderSkillPrompt } from "./skill-prompt.ts";
import { z } from "zod";
import { StableId } from "./work.ts";

export const VisualStyleDraft = z.object({
  preset: z.enum(["cn-animation", "anime", "webtoon", "3d-animation", "realistic", "custom"]),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(6000),
  avoid: z.string().max(2000).default(""),
  referenceAssetIds: z.array(StableId).max(8).refine(ids => new Set(ids).size === ids.length, "画风参考图不能重复").default([]),
}).strict();
export type VisualStyleDraft = z.infer<typeof VisualStyleDraft>;
export const WorkVisualStyle = VisualStyleDraft.extend({ revision: z.number().int().nonnegative() }).strict();
export type WorkVisualStyle = z.infer<typeof WorkVisualStyle>;
export const SaveWorkVisualStyleInput = z.object({ workId: StableId, expectedRevision: z.number().int().nonnegative(), style: VisualStyleDraft.nullable() }).strict();
export type SaveWorkVisualStyleInput = z.infer<typeof SaveWorkVisualStyleInput>;

export const visualStylePresets: readonly VisualStyleDraft[] = VisualStyleDraft.extend({description:z.string().max(6000)}).array().parse(JSON.parse(MEDIA_PROMPT_RULES["visual-style-presets"]));
export function visualStyleText(style: WorkVisualStyle | VisualStyleDraft | undefined): string {
  return style ? renderSkillPrompt("visual-style-text", {name:style.name, description:style.description, avoid:style.avoid}) : "";
}

export const StyledPromptEdit = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("design"),id:StableId,prompt:z.string().trim().min(1).max(10000)}).strict(),
  z.object({kind:z.literal("image"),id:StableId,episodeId:StableId,prompt:z.string().trim().min(1).max(50000)}).strict(),
  z.object({kind:z.literal("video"),id:StableId,episodeId:StableId,prompt:z.string().trim().min(1).max(32000)}).strict(),
]);
export type StyledPromptEdit = z.infer<typeof StyledPromptEdit>;
export const SaveStyledPromptsInput = z.object({workId:StableId,expectedRevision:z.number().int().nonnegative(),styleRevision:z.number().int().nonnegative(),edits:z.array(StyledPromptEdit).min(1).max(100)}).strict();
export type SaveStyledPromptsInput = z.infer<typeof SaveStyledPromptsInput>;
export const StyledPromptHistory = z.object({
  id:StableId,createdAt:z.string().datetime(),styleRevision:z.number().int().nonnegative(),
  changes:z.array(z.object({edit:StyledPromptEdit,before:z.string().max(50000).optional()}).strict()).max(100),
  skippedIds:z.array(StableId).max(100),undone:z.boolean().optional(),
}).strict();
export type StyledPromptHistory = z.infer<typeof StyledPromptHistory>;
export const UndoStyledPromptsInput = z.object({workId:StableId,expectedRevision:z.number().int().nonnegative(),historyId:StableId}).strict();
export type UndoStyledPromptsInput = z.infer<typeof UndoStyledPromptsInput>;
