import { composeVisualPrompt } from "../../../contracts/src/visual-style-generation.ts";
import { wrapPromptReference } from "./prompt-reference-envelope.ts";
import type { VideoProject } from "@jizuo/contracts";
import type { VideoComposerTarget } from "./main-video-composer.ts";

export const SHOT_CHAT_SOURCE = "镜头提示词";
export type ShotChatReference = VideoComposerTarget & { kind: "image" | "video" };

export function decodeShotChatReference(ref: string): ShotChatReference {
  const value = JSON.parse(decodeURIComponent(ref));
  if (!value || ![value.workId, value.episodeId, value.shotId].every(item => typeof item === "string" && item.length > 0)
    || !["image", "video"].includes(value.kind)) throw new Error("镜头引用无效，请在工作区重新选择");
  return value;
}

export function serializeShotChatReference(project: VideoProject, ref: ShotChatReference): string {
  const episode = project.episodes.find(item => item.id === ref.episodeId);
  const index = episode?.shots.findIndex(item => item.id === ref.shotId && !item.archived) ?? -1;
  const shot = episode?.shots[index];
  if (project.workId !== ref.workId || !episode || !shot) throw new Error("镜头已不可用，请重新选择");
  const visual = (item: typeof shot | undefined) => item ? { title: item.title, description: item.description, dialogue: item.dialogue, prompt: item.prompt, videoPrompt: item.videoPrompt, durationSec: item.durationSec } : null;
  const content = JSON.stringify({
    visualStyle: project.visualStyle,
    target: { workId: project.workId, episodeId: episode.id, shotId: shot.id, revision: project.revision },
    locks: { locked: shot.locked, promptLocked: shot.promptLocked },
    kind: ref.kind, script: episode.script, shot: visual(shot),
    previousShot: visual(episode.shots[index - 1]), nextShot: visual(episode.shots[index + 1]),
    designs: (project.designs ?? []).map(({ kind, name, description }) => ({ kind, name, description })),
    generationPrompt: composeVisualPrompt(project, (ref.kind === "image" ? shot.prompt : shot.videoPrompt ?? "") || "", undefined, []),
    referenceAssets: project.assets.filter(asset => shot.referenceAssetIds.includes(asset.id)).map(({ label, view }) => ({ label, view })),
  });
  if (content.length > 250_000) throw new Error("镜头上下文过长，请精简剧本或设定后重试");
  return wrapPromptReference(SHOT_CHAT_SOURCE, `${shot.title} · ${ref.kind === "image" ? "图片" : "视频"}`, content, "story-prompts");
}
