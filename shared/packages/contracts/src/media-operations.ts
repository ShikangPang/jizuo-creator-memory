import { z } from "zod";
import { VideoAssetView, PanoramaMetadata, PanoramaSource } from "./video.ts";
import { VideoImageRole } from "./media.ts";
import { MediaGenerationSettings } from "./media-generation-controls.ts";
import { StableId } from "./work.ts";
export const GenerateVideoMediaInput=z.object({
  workId:StableId,episodeId:StableId.optional(),shotId:StableId.optional(),expectedRevision:z.number().int().nonnegative(),
  kind:z.enum(["image","video"]),prompt:z.string().min(1).max(32000).optional(),label:z.string().min(1).max(120).optional(),
  selectResult:z.boolean().optional(),
  connectionId:z.string().min(1).max(128).optional(),
  sourceSessionId:z.string().min(1).max(128).optional(),
  referenceAssetIds:z.array(StableId).max(14).optional(),
  referenceVideoAssetIds:z.array(StableId).max(3).refine(ids=>new Set(ids).size===ids.length,"参考视频不能重复").optional(),
  videoImageRoles:z.array(VideoImageRole).max(14).optional(),
  designId:StableId.optional(),view:VideoAssetView.optional(),
  aspectRatio:z.enum(["16:9","9:16","1:1","4:3","3:4","21:9"]).optional(),
  durationSeconds:z.number().int().positive().max(30).optional(),
  generationSettings:MediaGenerationSettings.optional(),
}).strict();
export type GenerateVideoMediaInput=z.infer<typeof GenerateVideoMediaInput>;
export const ControlVideoJobInput=z.object({
  workId:StableId,jobId:StableId,action:z.enum(["cancel","resume","retry","reconcile","abandon"]),
  remoteId:z.string().regex(/^[a-zA-Z0-9_-]{1,512}$/).optional(),
}).strict().superRefine((input,context)=>{
  if(input.action==="reconcile"&&!input.remoteId)context.addIssue({code:"custom",message:"核对任务时必须提供服务方任务 ID"});
  if(input.action!=="reconcile"&&input.remoteId)context.addIssue({code:"custom",message:"仅核对操作可以提供服务方任务 ID"});
});
export type ControlVideoJobInput=z.infer<typeof ControlVideoJobInput>;
export const SubmitVideoBatchInput=z.object({
  workId:StableId,episodeId:StableId,expectedRevision:z.number().int().nonnegative(),
  batchId:StableId,shotIds:z.array(StableId).min(1).max(100).refine(ids=>new Set(ids).size===ids.length,"镜头列表不能重复"),
  kind:z.enum(["image","video"]),maxRequests:z.number().int().min(1).max(100),
  aspectRatio:z.enum(["16:9","9:16","1:1","4:3","3:4","21:9"]).optional(),
}).strict();
export type SubmitVideoBatchInput=z.infer<typeof SubmitVideoBatchInput>;
export const VideoAssetTarget=z.object({workId:StableId,assetId:StableId}).strict();
export const ImportVideoAssetInput=z.object({
  workId:StableId,expectedRevision:z.number().int().nonnegative(),kind:z.enum(["image","video","audio"]),
  designId:StableId.optional(),view:VideoAssetView.optional(),panorama:PanoramaMetadata.optional(),panoramaSource:PanoramaSource.optional(),
  label:z.string().min(1).max(120),mimeType:z.enum(["image/png","image/jpeg","image/webp","video/mp4","video/webm","audio/mpeg","audio/wav","audio/mp4","audio/ogg"]),
  base64:z.string().min(4).max(28_000_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
export type ImportVideoAssetInput=z.infer<typeof ImportVideoAssetInput>;
