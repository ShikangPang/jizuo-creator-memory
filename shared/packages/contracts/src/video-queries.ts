import { z } from "zod";
import { StableId } from "./work.ts";
import { VideoEpisode, VideoShot, VideoProject } from "./video.ts";
const Revision = VideoProject.shape.revision;

export const VideoViewScope = z.enum(["overview", "episode", "library"]);
export type VideoViewScope = z.infer<typeof VideoViewScope>;
export const VideoEpisodeSummary = VideoEpisode.pick({id:true,title:true,status:true}).extend({
  shots: z.array(VideoShot.pick({id:true,title:true,locked:true,archived:true,imageAssetId:true,videoAssetId:true})),
});
export type VideoEpisodeSummary = z.infer<typeof VideoEpisodeSummary>;
export const GetVideoProjectViewInput = z.object({workId:StableId,scope:VideoViewScope,episodeId:StableId.optional()}).strict()
  .refine(value=>value.scope !== "episode" || Boolean(value.episodeId), "章节读取需要章节 ID");
export type GetVideoProjectViewInput = z.infer<typeof GetVideoProjectViewInput>;
export const VideoProjectView = z.object({project:VideoProject,episodes:z.array(VideoEpisodeSummary),contentToken:z.string().min(1)}).strict();
export type VideoProjectView = z.infer<typeof VideoProjectView>;
export const GetVideoJobUpdatesInput = z.object({workId:StableId,scope:VideoViewScope,episodeId:StableId.optional(),sessionId:z.string().min(1).max(128).optional(),knownRevision:Revision.optional(),knownContentToken:z.string().min(1).max(128).optional()}).strict()
  .refine(value=>value.scope !== "episode" || Boolean(value.episodeId), "章节读取需要章节 ID");
export type GetVideoJobUpdatesInput = z.infer<typeof GetVideoJobUpdatesInput>;
export const VideoJobUpdates = z.discriminatedUnion("unchanged", [
  z.object({workId:StableId,revision:Revision,unchanged:z.literal(true)}).strict(),
  z.object({workId:StableId,revision:Revision,unchanged:z.literal(false),contentToken:z.string(),project:VideoProject}).strict(),
]);
export type VideoJobUpdates = z.infer<typeof VideoJobUpdates>;
