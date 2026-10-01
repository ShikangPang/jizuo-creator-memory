import { renderSkillPrompt } from "../../../contracts/src/skill-prompt.ts";
/** Keep the full send-time context separate from its compact transcript label. */
export function wrapPromptReference(source: "视频集" | "作品画风" | "人物与场景" | "镜头提示词" | "剪辑上下文", title: string, content: string,
  skill: "novel-video" | "creative-prompt" | "character-prompts" | "scene-prompts" | "story-prompts" = "creative-prompt"): string {
  return renderSkillPrompt("prompt-reference-envelope", {metadata:JSON.stringify({source,title,skill}),content});
}
