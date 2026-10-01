import { z } from "zod";
import { StableId } from "./work.ts";
export const SelectVideoAssetInput=z.object({
  workId:StableId,episodeId:StableId,shotId:StableId,assetId:StableId,kind:z.enum(["image","video"]),expectedRevision:z.number().int().nonnegative(),
}).strict();
export type SelectVideoAssetInput=z.infer<typeof SelectVideoAssetInput>;

export const RenameVideoAssetInput=z.object({
  workId:StableId,assetId:StableId,expectedRevision:z.number().int().nonnegative(),label:z.string().trim().min(1).max(120),
}).strict();
export type RenameVideoAssetInput=z.infer<typeof RenameVideoAssetInput>;
