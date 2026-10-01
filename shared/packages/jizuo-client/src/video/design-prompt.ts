import type { VideoAssetView, VideoDesign, VideoProject } from "@jizuo/contracts";
import { DESIGN_VIEW_PROMPTS } from "../../../contracts/src/media-prompt-rules.ts";
import { composeVisualPrompt, stripVisualStylePrompt } from "../../../contracts/src/visual-style-generation.ts";

/** Shared by the setting editor, reference preview and outgoing chat context. */
export function composeDesignPrompt(project: VideoProject, design: VideoDesign, view?: VideoAssetView): string {
  const selectedView = view ?? (design.kind === "character" ? "character-sheet" : undefined);
  return composeVisualPrompt(project, design.description, selectedView ? DESIGN_VIEW_PROMPTS[selectedView] : undefined, []);
}

export function composeDesignBasePrompt(project: VideoProject, design: VideoDesign): string {
  return composeVisualPrompt(project, design.description, undefined, []);
}

/** Keep generated view/style text out of the shared character or scene description. */
export function designPromptDescription(prompt: string, view: VideoAssetView): string {
  const content = stripVisualStylePrompt(prompt);
  const suffix = `\n${DESIGN_VIEW_PROMPTS[view]}`;
  return content.endsWith(suffix) ? content.slice(0, -suffix.length) : content;
}
