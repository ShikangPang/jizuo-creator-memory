import type { MediaGenerationRequest, MediaProviderConfig } from "./media.ts";

export type MediaInputCapabilities = {
  /** Semantic reference images, separate from video endpoint frames. */
  referenceImages: { min: number; max: number };
  firstFrame: boolean;
  lastFrame: boolean;
  referenceVideos: { max: number };
  frameRequired: boolean;
  /** False for opaque deployment IDs or model families the application cannot identify. */
  known: boolean;
};

const capabilities = (patch: Partial<MediaInputCapabilities> = {}): MediaInputCapabilities => ({
  referenceImages: { min: 0, max: 0 }, firstFrame: false, lastFrame: false,
  referenceVideos: { max: 0 }, frameRequired: false, known: true, ...patch,
});
const images = (max: number, min = 0) => capabilities({ referenceImages: { min, max } });
const frames = (lastFrame = false, frameRequired = false) => capabilities({ firstFrame: true, lastFrame, frameRequired });

/** Capabilities are limited by both the selected model and the implemented wire adapter. */
export function resolveMediaInputCapabilities(config: MediaProviderConfig, kind: "image" | "video"): MediaInputCapabilities {
  const model = config.model.toLowerCase();
  if (config.protocol === "nspox") {
    // The hosted gateway accepts input_images, but does not carry endpoint-frame roles or videos.
    if (kind === "image" && /^(?:gpt-image-|qwen-image-(?:[23][.-]0|edit)|(?:doubao-)?seedream-[456])/.test(model)) return images(8);
    if (kind === "video" && /seedance-2[.-][05]/.test(model)) return images(8);
    if (kind === "video" && /(?:wan.*-i2v|sora-2|hunyuan-video)/.test(model)) return frames();
    if (/^(?:qwen-image(?:$|-plus|-max)|wan.*-(?:t2i|t2v)|z-image)/.test(model)) return capabilities();
    return capabilities({ known: false });
  }
  if (kind === "image") {
    if (config.protocol === "openai") return /^gpt-image-/.test(model) ? images(14) : capabilities({ known: /^dall-e-/.test(model) });
    if (config.protocol === "ark") {
      if (/seedream-[456]/.test(model)) return images(14);
      return capabilities({ known: /seedream-3/.test(model) });
    }
    if (config.protocol === "dashscope") {
      if (config.options?.imageApi === "wan" || config.options?.imageApi === "z-image") return capabilities();
      if (/^qwen-image-edit/.test(model)) return images(3, 1);
      if (/^qwen-image-[23][.-]0/.test(model)) return images(3);
      return capabilities({ known: /^qwen-image(?:$|-plus|-max)|^wan.*-t2i|^z-image/.test(model) });
    }
    if (config.protocol === "tencent") return images(3);
    // This /images/generations adapter sends one `image`, not a multi-image list.
    if (config.protocol === "kuaishou") return config.options?.mode === "text-to-image" || /^kling-image/.test(model) ? images(1) : capabilities({ known: false });
  }
  if (config.protocol === "openai") return /^sora-2/.test(model) ? frames() : capabilities({ known: false });
  if (config.protocol === "ark") {
    // https://docs.byteplus.com/en/docs/Byteplus_LAS/video_gen_enhanced
    if (/seedance-2[.-][05]/.test(model)) return capabilities({
      firstFrame: true, lastFrame: true, referenceImages: { min: 0, max: /seedance-2[.-]5/.test(model) ? 14 : 9 }, referenceVideos: { max: 3 },
    });
    if (/seedance-1[.-]5/.test(model)) return frames(true);
    if (/seedance-1[.-]0/.test(model)) return model.includes("-t2v") ? capabilities() : frames(true);
    return capabilities({ known: false });
  }
  if (config.protocol === "dashscope") {
    const modern = config.options?.videoApi === "wan2.7" || (!config.options?.videoApi && model.startsWith("wan2.7"));
    if (modern || /-t2v/.test(model)) return capabilities();
    if (/^wan.*-i2v/.test(model)) return frames(false, true);
    return capabilities({ known: false });
  }
  if (config.protocol === "tencent") return frames();
  if (config.protocol === "kuaishou") {
    if (config.options?.mode === "text-to-video" || config.options?.mode === "text-to-image" || /-t2v$/.test(model)) return capabilities();
    if (config.options?.mode === "image-to-video" || /^kling-v[123](?:[.-]\d)?(?:-master|-turbo)?(?:-t2v|-i2v)?$/.test(model)) return frames(true, config.options?.mode === "image-to-video" || /-i2v$/.test(model));
    return capabilities({ known: false });
  }
  return capabilities({ known: false });
}

export type MediaCapabilityRequest = Pick<MediaGenerationRequest, "kind" | "references"> & { videoReferences?: readonly unknown[] | undefined };

/** Pure preflight shared by the composer and host; no uploads or paid submissions occur here. */
export function getMediaInputCapabilityError(config: MediaProviderConfig, request: MediaCapabilityRequest): string | undefined {
  const supported = resolveMediaInputCapabilities(config, request.kind);
  const refs = request.references ?? [];
  const videos = request.videoReferences?.length ?? 0;
  if (request.kind === "image") {
    if (videos) return "图片生成不支持参考视频。";
    if (refs.some(ref => ref.role)) return "图片生成不支持视频帧角色。";
    if (supported.known && refs.length > supported.referenceImages.max) return supported.referenceImages.max ? `当前图片模型最多支持 ${supported.referenceImages.max} 张参考图。` : "当前图片模型不支持参考图，请更换支持图像编辑的模型。";
    if (supported.known && refs.length < supported.referenceImages.min) return `当前图片模型需要至少 ${supported.referenceImages.min} 张参考图。`;
    return;
  }
  if (videos > supported.referenceVideos.max) return supported.referenceVideos.max ? `当前视频模型最多支持 ${supported.referenceVideos.max} 段参考视频。` : "当前模型或接口尚不支持参考视频，请选择支持视频输入的 Seedance 模型。";
  if (refs.some(ref => ref.role) && refs.some(ref => !ref.role)) return "请为每张视频图片指定用途。";
  // Preserve old unlabelled requests, whose meaning is defined by the existing provider adapter.
  const roles = refs.map((ref, index) => ref.role ?? (config.protocol === "nspox" && !supported.firstFrame ? "reference_image" : index === 0 ? "first_frame" : "last_frame"));
  const semantic = roles.filter(role => role === "reference_image").length;
  const first = roles.filter(role => role === "first_frame").length;
  const last = roles.filter(role => role === "last_frame").length;
  if (semantic && (first || last)) return "参考图片与首尾帧不能混用。";
  if (videos && (first || last)) return "参考视频与首尾帧不能混用，请将图片设为参考图片。";
  if (first > 1 || last > 1 || (last && !first)) return "请选择一张首帧和至多一张尾帧，尾帧不能单独使用。";
  if (supported.known) {
    if (first && !supported.firstFrame) return "当前视频模型不支持首帧图片。";
    if (last && !supported.lastFrame) return "当前视频模型不支持尾帧图片。";
    if (semantic > supported.referenceImages.max) return supported.referenceImages.max ? `当前视频模型最多支持 ${supported.referenceImages.max} 张参考图。` : "当前视频模型不支持参考图片模式。";
    if (supported.frameRequired && !first) return "当前图生视频模型需要一张首帧图片。";
  } else {
    // Unknown deployment IDs retain legacy inputs, but never gain a new wire format by name alone.
    if (last && config.protocol !== "ark" && config.protocol !== "kuaishou") return "当前接口不支持尾帧图片。";
    if (semantic && config.protocol !== "nspox") return "当前模型尚未确认支持参考图片模式，请使用可识别的模型 ID。";
  }
}
