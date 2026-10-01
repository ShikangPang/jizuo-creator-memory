import type { VideoProject } from "@jizuo/contracts";
import { wrapPromptReference } from "./prompt-reference-envelope.ts";
export const EPISODE_CHAT_SOURCE = "视频集";
export type EpisodeChatReference = { workId: string; episodeId: string };
export function decodeEpisodeReference(ref: string): EpisodeChatReference {
  const value = JSON.parse(decodeURIComponent(ref));
  if (!value || ![value.workId, value.episodeId].every(item => typeof item === "string" && item.length > 0)) throw new Error("视频集引用无效，请重新选择");
  return {workId:value.workId, episodeId:value.episodeId};
}
export function episodeReferenceContent(project: VideoProject, ref: EpisodeChatReference) {
  const episode = project.episodes.find(item => item.id === ref.episodeId);
  if (project.workId !== ref.workId || !episode) throw new Error("视频集已不可用，请重新选择");
  return {target:{workId:project.workId,episodeId:episode.id,revision:project.revision},title:episode.title,sourceChapters:episode.sourceChapters,script:episode.script,shotCount:episode.shots.filter(shot=>!shot.archived).length,visualStyle:project.visualStyle};
}
export function serializeEpisodeReference(project: VideoProject, ref: EpisodeChatReference, task?: { instructions: string; shotIds?: string[] }): string {
  const content = episodeReferenceContent(project,ref);
  return wrapPromptReference(EPISODE_CHAT_SOURCE, content.title, JSON.stringify({...content,...(task ? {task} : {})}), "novel-video");
}
