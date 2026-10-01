import type { ManageMediaConnectionInput, SaveVideoDesignInput, TagVideoAssetInput, ExtractVideoDesignsInput, VideoProject, MediaSettingsView } from "@jizuo/contracts";
import type { GenerateVideoMediaInput, ImportVideoAssetInput, ControlVideoJobInput } from "../../../contracts/src/media-operations.ts";
import type { SelectVideoAssetInput } from "../../../contracts/src/asset-operations.ts";

export interface VideoAssetPreviewRemote {
  getVideoAssetUrl?(input: { workId: string; assetId: string }): Promise<{ url: string }>;
}
export interface VideoAssetsRemote extends VideoAssetPreviewRemote {
  undoStyledPrompts?(input: import("@jizuo/contracts").UndoStyledPromptsInput): Promise<VideoProject>;
  saveWorkVisualStyle?(input: import("@jizuo/contracts").SaveWorkVisualStyleInput): Promise<VideoProject>;
  updateVideoEpisode?(input: import("@jizuo/contracts").UpdateVideoEpisodeInput): Promise<VideoProject>;
  deleteVideoItem?(input: import("@jizuo/contracts").DeleteVideoItemInput): Promise<VideoProject>;
  getMediaSettings?(): Promise<MediaSettingsView>;
  manageMediaConnection?(input: ManageMediaConnectionInput): Promise<MediaSettingsView>;
  saveVideoDesign?(input: SaveVideoDesignInput): Promise<VideoProject>;
  tagVideoAsset?(input: TagVideoAssetInput): Promise<VideoProject>;
  extractVideoDesigns?(input: ExtractVideoDesignsInput): Promise<VideoProject>;
  renameVideoAsset?(input: { workId: string; assetId: string; expectedRevision: number; label: string }): Promise<VideoProject>;
  generateVideoMedia?(input: GenerateVideoMediaInput): Promise<VideoProject>;
  importVideoAsset?(input: ImportVideoAssetInput): Promise<VideoProject>;
  controlVideoJob?(input: ControlVideoJobInput): Promise<VideoProject>;
  selectVideoAsset?(input: SelectVideoAssetInput): Promise<VideoProject>;
}
