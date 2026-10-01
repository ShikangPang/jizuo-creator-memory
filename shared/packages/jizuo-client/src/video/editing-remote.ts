import type { VideoProject, UpdateVideoEpisodeInput } from "@jizuo/contracts";
import type { RoughCutVideoInput, EditVideoTimelineInput, ExportVideoInput } from "../../../contracts/src/video-editing.ts";
import type { GenerateSpeechInput } from "../../../contracts/src/video-speech.ts";
import type { VideoShotsRemote } from "./shots-remote.ts";

export interface VideoEditingRemote extends VideoShotsRemote {
  checkVideoRuntime?(): Promise<import("@jizuo/contracts").VideoRuntimeStatus>;
  getVideoTimelineHistory?(input: { workId: string; episodeId: string }): Promise<{ versions: Array<{ revision: number; clipCount: number; durationSec: number }> }>;
  restoreVideoTimeline?(input: { workId: string; episodeId: string; expectedRevision: number; revision: number }): Promise<VideoProject>;
  updateVideoEpisode?(input: UpdateVideoEpisodeInput): Promise<VideoProject>;
  roughCutVideo?(input: RoughCutVideoInput): Promise<VideoProject>;
  getVideoClipFrames?(input: import("@jizuo/contracts").GetVideoClipFramesInput): Promise<import("@jizuo/contracts").VideoClipFrames>;
  editVideoTimeline?(input: EditVideoTimelineInput): Promise<VideoProject>;
  exportVideo?(input: ExportVideoInput): Promise<VideoProject>;
  generateVideoSpeech?(input: GenerateSpeechInput): Promise<VideoProject>;
  saveVideoExport?(input: { workId: string; assetId: string; title: string }): Promise<{ path: string } | null>;
}
