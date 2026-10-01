import { z } from "zod";
import { StableId } from "./work.ts";

export const AdaptVideoEpisodeInput = z.object({
  workId: StableId,
  episodeId: StableId,
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  instructions: z.string().trim().max(10_000).optional(),
  shotIds: z.array(StableId).min(1).max(200).refine((ids) => new Set(ids).size === ids.length, "返工镜头不能重复").optional(),
}).strict();
export type AdaptVideoEpisodeInput = z.infer<typeof AdaptVideoEpisodeInput>;

export const DiscussVideoPromptInput = z.object({
  workId: StableId, episodeId: StableId, shotId: StableId,
  expectedRevision: z.number().int().nonnegative(),
  message: z.string().trim().min(1).max(10000),
  draftPrompt: z.string().max(32000).optional(),
  referenceAssetIds: z.array(StableId).max(14).optional(),
}).strict();
export type DiscussVideoPromptInput = z.infer<typeof DiscussVideoPromptInput>;

const shotPromptTarget = {
  workId: StableId, episodeId: StableId, shotId: StableId,
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
/** Replace one saved prompt, without accepting unrelated shot fields or triggering generation. */
export const ReplaceVideoPromptInput = z.discriminatedUnion("kind", [
  z.object({ ...shotPromptTarget, kind: z.literal("image"), prompt: z.string().trim().min(1).max(50_000) }).strict(),
  z.object({ ...shotPromptTarget, kind: z.literal("video"), prompt: z.string().trim().min(1).max(32_000) }).strict(),
]);
export type ReplaceVideoPromptInput = z.infer<typeof ReplaceVideoPromptInput>;
