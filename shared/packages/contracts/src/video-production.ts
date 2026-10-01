import { z } from "zod";
import { StableId } from "./work.ts";

export const StartVideoProductionInput=z.object({
  workId:StableId,episodeId:StableId,expectedRevision:z.number().int().nonnegative(),requestId:z.string().uuid(),
  maxRequests:z.number().int().min(1).max(200),pauseAfterStoryboard:z.boolean().default(true),
  instructions:z.string().trim().max(10_000).optional(),
  shotIds:z.array(StableId).min(1).max(200).refine(ids=>new Set(ids).size===ids.length,"镜头列表不能重复").optional(),
  aspectRatio:z.enum(["16:9","9:16","1:1","4:3","3:4","21:9"]).optional(),
}).strict();
export type StartVideoProductionInput=z.input<typeof StartVideoProductionInput>;
export const ControlVideoProductionInput=z.object({
  workId:StableId,jobId:StableId,action:z.enum(["pause","resume","cancel"]),
  additionalRequests:z.number().int().min(0).max(100).optional(),requestId:z.string().uuid().optional(),
}).strict().superRefine((input,context)=>{
  if((input.additionalRequests??0)>0&&!input.requestId)context.addIssue({code:"custom",path:["requestId"],message:"增加预算需要唯一请求 ID，以便安全重试"});
  if(input.additionalRequests!==undefined&&input.action!=="resume")context.addIssue({code:"custom",message:"仅恢复操作可增加请求预算"});
});
export type ControlVideoProductionInput=z.infer<typeof ControlVideoProductionInput>;
