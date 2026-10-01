import { z } from "zod";
import { GenerateVideoMediaInput } from "./media-operations.ts";
export const ChatMediaInput = GenerateVideoMediaInput.pick({kind:true,prompt:true,connectionId:true,aspectRatio:true,durationSeconds:true,referenceAssetIds:true}).extend({
 prompt:z.string().trim().min(1).max(32000),
 referenceAttachmentIds:z.array(z.string().min(1).max(256)).max(14).optional(),
}).strict();
export type ChatMediaInput=z.infer<typeof ChatMediaInput>;
export const ChatMediaSessionInput=z.object({sessionId:z.string().min(1).max(128)}).strict();
