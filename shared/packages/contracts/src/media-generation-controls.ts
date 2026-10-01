import { GptImageOptions, gptImageRatios, isGptImage2, isGptImage25, validGptImageSize } from "./gpt-image.ts";
import { z } from "zod";
import type { MediaProviderConfig } from "./media.ts";

/** Per-request overrides; never change a connection's saved defaults. */
export const MediaGenerationSettings = z.object({
  resolution: z.enum(["480p", "720p", "1080p"]).optional(),
  generateAudio: z.boolean().optional(),
  ...GptImageOptions,
  imageAspectRatio: z.enum(gptImageRatios).optional(),
  imageResolution: z.enum(["1k", "2k", "4k"]).optional(),
  imageSize: z.string().regex(/^(?:auto|\d{3,4}x\d{3,4})$/).optional(),
}).strict();
export type MediaGenerationSettings = z.infer<typeof MediaGenerationSettings>;
export const generationRatios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
export type GenerationRatio = typeof generationRatios[number];
const range = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, i) => i + min);

/** Expose only controls implemented by the current adapters. */
export function mediaGenerationControls(config: MediaProviderConfig, kind: "image" | "video", hasReferences = false) {
  const protocol = config.protocol;
  let ratios: readonly GenerationRatio[] = generationRatios;
  let resolutions: string[] = [], durations: number[] = [], imageSizes: string[] = [];
  let audio = false, quality = false;
  if (kind === "image") {
    if (protocol === "openai" || protocol === "nspox") {
      ratios = []; imageSizes = ["1024x1024", "1536x1024", "1024x1536"]; quality = true;
    } else if (protocol === "ark") {
      ratios = [];
      imageSizes = ["2048x2048", "2688x1536", "1536x2688", "2368x1728", "1728x2368", "3072x1312"];
      if (/seedream-[4-9]/.test(config.model)) imageSizes.push("4096x4096", "4096x2304", "2304x4096");
    } else if (protocol === "dashscope" && config.model === "qwen-image-edit") ratios = [];
    else if (protocol === "dashscope" && /^qwen-image(?:$|-plus|-max)/.test(config.model)) ratios = generationRatios.filter(ratio => ratio !== "21:9");
    else if (protocol === "tencent") ratios = ["1:1"];
  } else if (protocol === "ark") {
    const v25 = /seedance-2[.-]5/.test(config.model), v2 = v25 || /seedance-2[.-]0/.test(config.model);
    durations = range(v2 || config.model.includes("seedance-1-5") ? 4 : 2, v25 ? 30 : v2 ? 15 : 12);
    resolutions = ["480p", "720p", "1080p"];
    audio = !config.model.includes("seedance-1-0");
  } else if (protocol === "openai") {
    ratios = ["16:9", "9:16"]; durations = [4, 8, 12];
  } else if (protocol === "dashscope") {
    const modern = config.options?.videoApi === "wan2.7" || (!config.options?.videoApi && config.model.startsWith("wan2.7"));
    ratios = modern ? generationRatios : hasReferences ? [] : ["16:9", "9:16", "1:1"];
    durations = modern ? range(2, 15) : config.model.startsWith("wan2.6") ? [5, 10, 15] : [5, 10];
    if (modern || hasReferences) resolutions = modern || config.model.startsWith("wan2.6") ? ["720p", "1080p"] : ["480p", "720p", "1080p"];
  } else if (protocol === "tencent") ratios = [];
  else if (protocol === "kuaishou") { durations = [5, 10]; resolutions = ["720p", "1080p"]; }
  else if (protocol === "nspox") durations = range(1, 30);
  const customImage = kind === "image" && (protocol === "openai" || protocol === "nspox") && isGptImage2(config.model);
  const qualities = isGptImage25(config.model) ? ["auto", "low", "medium", "high", "xhigh", "max"] as const : ["auto", "low", "medium", "high"] as const;
  return { ratios, resolutions, durations, imageSizes, audio, quality, customImage, qualities };
}

export function applyMediaGenerationSettings(config: MediaProviderConfig, kind: "image" | "video", raw: MediaGenerationSettings | undefined, hasReferences: boolean) {
  const settings = MediaGenerationSettings.parse(raw ?? {});
  const controls = mediaGenerationControls(config, kind, hasReferences);
  if (settings.resolution && !controls.resolutions.includes(settings.resolution) || settings.generateAudio !== undefined && !controls.audio || settings.quality !== undefined && !controls.quality || settings.imageSize && !(controls.customImage ? validGptImageSize(settings.imageSize) : controls.imageSizes.includes(settings.imageSize))) throw new Error("当前模型不支持这些生成参数，请重新选择设置");
  if (settings.quality && !controls.qualities.includes(settings.quality as never)) throw new Error("当前模型不支持此质量档位");
  if (!controls.customImage && [settings.background,settings.outputFormat,settings.outputCompression,settings.moderation,settings.inputFidelity,settings.imageAspectRatio,settings.imageResolution].some(value=>value!==undefined)) throw new Error("当前模型未接通这些图片参数");
  if(settings.background==="transparent"&&settings.outputFormat==="jpeg")throw new Error("透明背景请使用 PNG 或 WebP");
  if(settings.outputCompression!==undefined&&(!settings.outputFormat||settings.outputFormat==="png"))throw new Error("压缩率只适用于 JPEG 或 WebP");
  if(settings.inputFidelity!==undefined&&(!hasReferences||!isGptImage25(config.model)))throw new Error("当前模型不支持调整参考保真度");
  const next = structuredClone(config);
  if (next.protocol === "ark" && (settings.resolution !== undefined || settings.generateAudio !== undefined)) next.options = { ...next.options, ...(settings.resolution ? { resolution: settings.resolution } : {}), ...(settings.generateAudio !== undefined ? { generateAudio: settings.generateAudio } : {}) };
  if (next.protocol === "dashscope" && settings.resolution) next.options = { ...next.options, resolution: settings.resolution.toUpperCase() as "480P" | "720P" | "1080P" };
  if (next.protocol === "kuaishou" && settings.resolution) next.options = { ...next.options, resolution: settings.resolution as "720p" | "1080p" };
  if (next.protocol === "openai" || next.protocol === "nspox") {
    const options = Object.fromEntries(Object.keys(GptImageOptions).flatMap(key => settings[key as keyof typeof GptImageOptions] === undefined ? [] : [[key, settings[key as keyof typeof GptImageOptions]]]));
    if(Object.keys(options).length) next.options = { ...next.options, ...options };
  }
  return next;
}
