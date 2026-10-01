import type { VideoProject } from "@jizuo/contracts";
import type { ComposerSnapshot } from "./main-video-composer.ts";
import { SHOT_CHAT_SOURCE, decodeShotChatReference } from "./shot-chat-reference.ts";

type PromptOccurrence = { source: string; ref: string; invalid?: boolean };

// Resolve only the saved defaults and explicit overrides. Native media chips are
// merged by the caller in their existing order, after validating their sources.
export function resolveComposerReferenceInputs(project: VideoProject, state: ComposerSnapshot, occurrences: readonly PromptOccurrence[]) {
  const target = state.target?.workId === project.workId ? state.target : undefined;
  const design = target?.designId ? project.designs?.find(item => item.id === target.designId) : undefined;
  const hasShotReference = target?.shotId && occurrences.some(item => {
    if (item.source !== SHOT_CHAT_SOURCE || item.invalid) return false;
    try {
      const ref = decodeShotChatReference(item.ref);
      return ref.workId === target.workId && ref.episodeId === target.episodeId && ref.shotId === target.shotId;
    } catch { return false; }
  });
  const shot = hasShotReference ? project.episodes.find(item => item.id === target?.episodeId)?.shots.find(item => item.id === target?.shotId && !item.archived) : undefined;
  const savedReferences = design?.referenceAssetIds ?? (state.kind === "image" ? shot?.referenceAssetIds : shot?.imageAssetId ? [shot.imageAssetId] : []);
  const attached = state.attachedMedia?.workId === project.workId ? state.attachedMedia : undefined;
  return {
    referenceAssetIds: [...new Set([...(state.inputs.referenceAssetIds ?? savedReferences ?? []), ...(attached?.imageIds ?? [])])],
    referenceVideoAssetIds: [...new Set([...(state.inputs.referenceVideoAssetIds ?? []), ...(attached?.videoIds ?? [])])],
  };
}
