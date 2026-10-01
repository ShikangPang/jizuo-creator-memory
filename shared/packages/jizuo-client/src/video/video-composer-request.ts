import type { GenerateVideoMediaInput } from "../../../contracts/src/media-operations.ts";
import type { MediaComposerTarget } from "./main-video-composer.ts";

export type VideoComposerInputs = {
  title: string;
  action: "optimize" | "generate" | "select";
  prompt?: string;
  /** References resolve saved prompts at submit time; text is an explicit editable snapshot. */
  promptMode?: "reference" | "text";
  kind: "image" | "video";
  generationSettings?: GenerateVideoMediaInput["generationSettings"];
  durationSeconds?: GenerateVideoMediaInput["durationSeconds"];
  aspectRatio?: GenerateVideoMediaInput["aspectRatio"];
  referenceAssetIds?: string[];
  videoImageRoles?: GenerateVideoMediaInput["videoImageRoles"];
  referenceVideoAssetIds?: string[];
};
export type VideoComposerRequest = MediaComposerTarget & VideoComposerInputs;

export function requestVideoComposer(request: VideoComposerRequest) {
  window.dispatchEvent(new CustomEvent<VideoComposerRequest>("jizuo:video-composer", { detail: request }));
}

export function clearVideoComposerSelection(context: { workId: string; episodeId?: string }) {
  window.dispatchEvent(new CustomEvent("jizuo:video-composer-clear", { detail: context }));
}
