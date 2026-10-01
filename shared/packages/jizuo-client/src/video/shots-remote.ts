import type { VideoProject, UpdateVideoEpisodeInput } from "@jizuo/contracts";
import type { GenerateVideoMediaInput } from "../../../contracts/src/media-operations.ts";
import type { VideoAssetsRemote } from "./assets-remote.ts";

export type VideoBatchRequest = { workId: string; episodeId: string; expectedRevision: number; batchId: string; shotIds: string[]; kind: "video" | "image"; maxRequests: number; aspectRatio?: GenerateVideoMediaInput["aspectRatio"] };
export interface VideoShotsRemote extends VideoAssetsRemote {
  discussVideoPrompt?(input: import("@jizuo/contracts").DiscussVideoPromptInput): Promise<VideoProject>;
  submitVideoBatch?(input: VideoBatchRequest): Promise<VideoProject>;
  updateVideoEpisode?(input: UpdateVideoEpisodeInput): Promise<VideoProject>;
}
