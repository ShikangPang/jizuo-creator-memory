import { JizuoError, type MediaLibraryModel, type MediaLibraryProvider } from "@jizuo/contracts";

// Route API families, including their dated snapshots, rather than maintaining an ID allowlist.
// References: qwen-image-api, qwen-image-generation-and-editing-api-reference,
// text-to-image-v2-api-reference and z-image-api-reference on help.aliyun.com/zh/model-studio/.
const snapshot = "(?:-\\d{4}-\\d{2}-\\d{2})?";
const qwen = new RegExp(`^qwen-image(?:-(?:[23]\\.0(?:-pro)?|plus|max|edit(?:-plus|-max)?))?${snapshot}$`);
const wanImage = new RegExp(`^wanx?2\\.[01256]-t2i(?:-(?:plus|turbo|flash|preview))?${snapshot}$`);
const wanVideo = new RegExp(`^wanx?2\\.[1256]-(?:t2v|i2v)(?:-(?:plus|turbo|preview))?${snapshot}$`);

export function normalizeDashScopeModel(model: MediaLibraryModel): MediaLibraryModel {
  const { unavailableReason: _reason, specialized: _specialized, ...base } = model;
  if (model.kind === "image") {
    const specialized = model.id.startsWith("facechain-")
      ? model.id === "facechain-facedetect" ? "图像检测专用，不用于通用生图" : "人物写真专用，需要人物训练与写真流程"
      : /^aitryon(?:-|$)/.test(model.id) ? "试衣专用，需要服装和人物等专用输入" : undefined;
    if (specialized) return { ...base, specialized: true, unavailableReason: specialized };
    const imageApi = qwen.test(model.id) ? "qwen" : wanImage.test(model.id) ? "wan" : new RegExp(`^z-image-turbo${snapshot}$`).test(model.id) ? "z-image" : undefined;
    if (imageApi || ["qwen", "wan", "z-image"].includes(String(model.options?.imageApi))) {
      return { ...base, options: { ...(imageApi ? { imageApi } : {}), ...model.options } };
    }
  } else {
    const videoApi = wanVideo.test(model.id) ? "wan2.6" : new RegExp(`^wan2\\.7-t2v${snapshot}$`).test(model.id) ? "wan2.7" : undefined;
    if (videoApi || ["wan2.6", "wan2.7"].includes(String(model.options?.videoApi))) {
      return { ...base, options: { ...(videoApi ? { videoApi } : {}), ...model.options } };
    }
  }
  return { ...base, unavailableReason: "请选择与模型文档一致的生成接口类型" };
}

export function dashScopeGenerationBaseUrl(provider: MediaLibraryProvider, model: MediaLibraryModel): string {
  // Qwen 3.0 documents workspace endpoints. Existing configs/jobs keep their frozen address.
  if (!/^qwen-image-3\.0(?:-|$)/.test(model.id)) return provider.baseUrl;
  const regions: Record<string, string> = { "dashscope.aliyuncs.com": "cn-beijing", "dashscope-intl.aliyuncs.com": "ap-southeast-1", "cn-hongkong.dashscope.aliyuncs.com": "cn-hongkong" };
  const region = regions[new URL(provider.baseUrl).hostname];
  if (!region) return provider.baseUrl; // Already a workspace endpoint or an explicit compatible proxy.
  if (!provider.workspaceId) throw new JizuoError("validation_error", "Qwen Image 3.0 需要业务空间地址，请在管理服务商中填写百炼业务空间 ID。");
  return `https://${provider.workspaceId}.${region}.maas.aliyuncs.com/api/v1`;
}

export function dashScopeImageDimensions(model: string, ratio: string): number[] | undefined {
  const sizes: Record<string, number[] | undefined> = /^wanx?2\.[56]-t2i/.test(model) ? {
    "16:9": [1792, 1008], "9:16": [1008, 1792], "1:1": [1280, 1280], "4:3": [1536, 1152], "3:4": [1152, 1536], "21:9": [2016, 864],
  } : wanImage.test(model) ? {
    "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [1024, 1024], "4:3": [1360, 1024], "3:4": [1024, 1360], "21:9": [1344, 576],
  } : /^qwen-image(?:$|-plus|-max)/.test(model) ? {
    "16:9": [1664, 928], "9:16": [928, 1664], "1:1": [1328, 1328], "4:3": [1472, 1104], "3:4": [1104, 1472], "21:9": undefined,
  } : {
    "16:9": [1536, 864], "9:16": [864, 1536], "1:1": [1024, 1024], "4:3": [1360, 1024], "3:4": [1024, 1360], "21:9": [1792, 768],
  };
  return sizes[ratio];
}
