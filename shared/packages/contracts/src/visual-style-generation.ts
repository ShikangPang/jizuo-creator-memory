import { renderSkillPrompt } from "./skill-prompt.ts";
import { MEDIA_PROMPT_RULES } from "./media-prompt-rules.generated.ts";
import type { MediaProviderConfig, MediaReferenceImage } from "./media.ts";
import { resolveMediaInputCapabilities } from "./media-input-capabilities.ts";
import type { VideoProject } from "./video.ts";
import { visualStyleText } from "./visual-style.ts";

export const VISUAL_STYLE_AUTHORING_RULE = MEDIA_PROMPT_RULES["style-authoring"];
export function planVisualReferences(config: MediaProviderConfig, kind: "image" | "video", subjectIds: readonly string[], roles: readonly NonNullable<MediaReferenceImage["role"]>[] | undefined, styleIds: readonly string[]) {
  const caps = resolveMediaInputCapabilities(config, kind);
  // Untyped video inputs keep their existing endpoint-frame semantics.
  const frameMode = kind === "video" && (roles ? roles.some(role => role !== "reference_image") : subjectIds.length > 0 && !(config.protocol === "nspox" && !caps.firstFrame));
  const supported = caps.known && caps.referenceImages.max > 0 && !frameMode;
  const ids = [...subjectIds];
  if (supported) for (const id of styleIds) if (!ids.includes(id)) ids.push(id);
  const positions = supported ? styleIds.map(id => ids.indexOf(id) + 1) : [];
  return { ids, positions, textOnly: styleIds.length > 0 && !supported,
    roles: kind === "video" && supported && styleIds.length ? ids.map(() => "reference_image" as const) : roles };
}
export function stripVisualStylePrompt(base: string): string {
  // A copied full prompt may contain our previous style wrapper. Recompose it
  // with the current work style and actual reference positions, without nesting.
  const marker = `\n${MEDIA_PROMPT_RULES["style-generation"]}\n${MEDIA_PROMPT_RULES["content-heading"]}\n`;
  if (base.startsWith(`${MEDIA_PROMPT_RULES["style-heading"]}\n`) && base.includes(marker)) {
    base = base.slice(base.indexOf(marker) + marker.length);
    const [before, after] = MEDIA_PROMPT_RULES["style-references"].split("{{positions}}");
    const tail = base.lastIndexOf(`\n${before}`);
    if (tail >= 0 && base.endsWith(after!)) base = base.slice(0, tail);
  }
  return base;
}

export function composeVisualPrompt(project: VideoProject, base: string, view: string | undefined, stylePositions: readonly number[]): string {
  base = stripVisualStylePrompt(base);
  const content = renderSkillPrompt("visual-content", {base, view: view && !base.includes(view) ? view : undefined});
  if (!project.visualStyle) return content;
  return renderSkillPrompt("visual-generation", {style:visualStyleText(project.visualStyle), content, positions:stylePositions.join("、")});
}
