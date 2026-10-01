import type { VideoAssetView } from "./video.ts";
import { MEDIA_PROMPT_RULES } from "./media-prompt-rules.generated.ts";

export const DESIGN_VIEW_PROMPTS: Record<VideoAssetView, string> = {
  "character-sheet": MEDIA_PROMPT_RULES["view-character-sheet"],
  turnaround: MEDIA_PROMPT_RULES["view-turnaround"], front: MEDIA_PROMPT_RULES["view-front"],
  side: MEDIA_PROMPT_RULES["view-side"], back: MEDIA_PROMPT_RULES["view-back"],
  expression: MEDIA_PROMPT_RULES["view-expression"], outfit: MEDIA_PROMPT_RULES["view-outfit"],
  panorama: MEDIA_PROMPT_RULES["view-panorama"], detail: MEDIA_PROMPT_RULES["view-detail"],
};
