import { renderSkillPrompt } from "../../../contracts/src/skill-prompt.ts";
import { serializeEpisodeReference } from "./episode-chat-reference.ts";
import type { VideoProject, VideoSourceChapter } from "@jizuo/contracts";

export interface StoryboardChatRequest {
  workId: string;
  episodeId: string;
  title: string;
  instructions: string;
  shotIds?: string[];
  sourceChapters?: VideoSourceChapter[];
}

export function storyboardChatPrompt(request: StoryboardChatRequest): string {
  return renderSkillPrompt("storyboard-chat-task", {
    action: request.shotIds?.length ? "调整指定镜头的制作稿" : "生成制作稿",
    instructions: request.instructions.trim(),
  });
}

export function storyboardChatMessage(project: VideoProject, request: StoryboardChatRequest): string {
  const reference = serializeEpisodeReference(project, request, {instructions:request.instructions,...(request.shotIds?.length ? {shotIds:request.shotIds} : {})});
  return `${reference}\n${storyboardChatPrompt(request)}`;
}
