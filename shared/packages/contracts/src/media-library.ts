import { z } from "zod";
import { MediaExecutionMode } from "./media.ts";

export const MediaProtocol = z.enum(["openai", "ark", "dashscope", "tencent", "kuaishou"]);
export const MediaPreset = z.enum(["openai", "ark", "dashscope", "tencent", "kuaishou", "custom"]);
const Identity = z.string().trim().min(1).max(512);
// A business workspace is a single DNS label in the official Model Studio catalog endpoint.
const WorkspaceId = z.string().trim().max(63).regex(/^$|^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/);
export const MediaLibraryModel = z.object({
  id: Identity, name: Identity, kind: z.enum(["image", "video"]),
  unavailableReason: z.string().trim().min(1).max(512).optional(),
  specialized: z.boolean().optional(),
  executionMode: MediaExecutionMode.optional(),
  options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
}).strict();
export type MediaLibraryModel = z.infer<typeof MediaLibraryModel>;
export const MediaModelSelection = z.object({ providerId: Identity, modelId: Identity }).strict();
export type MediaModelSelection = z.infer<typeof MediaModelSelection>;
export const MediaLibraryDefaults = z.object({ image: MediaModelSelection.nullable(), video: MediaModelSelection.nullable() }).strict();
export const MediaLibraryProvider = z.object({
  id: Identity, name: Identity, preset: MediaPreset, protocol: MediaProtocol,
  baseUrl: z.string().url().max(2048), keyConfigured: z.boolean(),
  workspaceId: WorkspaceId.optional(),
  models: z.array(MediaLibraryModel).max(500), source: z.enum(["media", "text"]),
}).strict();
export type MediaLibraryProvider = z.infer<typeof MediaLibraryProvider>;
export const MediaLibraryView = z.object({ revision: z.number().int().nonnegative(), providers: z.array(MediaLibraryProvider), defaults: MediaLibraryDefaults }).strict();
export type MediaLibraryView = z.infer<typeof MediaLibraryView>;
export const SaveMediaProviderInput = z.object({
  expectedRevision: z.number().int().nonnegative(), id: Identity.optional(), name: Identity,
  preset: MediaPreset, protocol: MediaProtocol.optional(), baseUrl: z.string().url().max(2048).optional(),
  apiKey: z.string().max(16384).optional(), models: z.array(MediaLibraryModel).max(500).optional(),
  workspaceId: WorkspaceId.optional(),
}).strict();
export type SaveMediaProviderInput = z.infer<typeof SaveMediaProviderInput>;
export const SetDefaultMediaModelsInput = z.object({ expectedRevision: z.number().int().nonnegative(), image: MediaModelSelection.nullable(), video: MediaModelSelection.nullable(), refreshKind: z.enum(["image", "video"]).optional() }).strict();
export type SetDefaultMediaModelsInput = z.infer<typeof SetDefaultMediaModelsInput>;
export const DiscoverMediaModelsInput = z.object({ providerId: Identity }).strict();
export type DiscoverMediaModelsInput = z.infer<typeof DiscoverMediaModelsInput>;
export const DiscoverMediaModelsResult = z.object({ models: z.array(MediaLibraryModel), source: z.enum(["remote", "builtin"]), notice: z.string().optional() }).strict();
export type DiscoverMediaModelsResult = z.infer<typeof DiscoverMediaModelsResult>;

/** Host-only persisted data; credentials are immutable vault references, never API keys. */
export const StoredMediaLibraryProvider = MediaLibraryProvider.omit({ keyConfigured: true }).extend({ credentialRef: Identity.optional(), allowInsecureLoopback: z.boolean().optional() });
export const StoredMediaLibrary = z.object({ providers: z.array(StoredMediaLibraryProvider).max(100), defaults: MediaLibraryDefaults }).strict();
export type StoredMediaLibrary = z.infer<typeof StoredMediaLibrary>;

export const MEDIA_PROVIDER_PRESETS = {
  openai: { name: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", models: [
    { id: "gpt-image-1", name: "GPT Image 1", kind: "image" },
    { id: "sora-2", name: "Sora 2", kind: "video", options: { videoTransport: "multipart" } },
  ] },
  ark: { name: "火山方舟", protocol: "ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", models: [
    { id: "doubao-seedream-4-0-250828", name: "Seedream 4.0", kind: "image" },
    { id: "doubao-seedance-1-5-pro-251215", name: "Seedance 1.5 Pro", kind: "video" },
  ] },
  dashscope: { name: "阿里云百炼", protocol: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/api/v1", models: [
    { id: "qwen-image-2.0-pro", name: "Qwen Image 2.0 Pro", kind: "image", options: { imageApi: "qwen" } },
    { id: "wan2.2-t2i-plus", name: "万相 2.2 图像", kind: "image", options: { imageApi: "wan" } },
    { id: "wan2.6-t2v", name: "万相 2.6 文生视频", kind: "video", options: { videoApi: "wan2.6" } },
    { id: "wan2.6-i2v", name: "万相 2.6 图生视频", kind: "video", options: { videoApi: "wan2.6" } },
  ] },
  tencent: { name: "腾讯混元", protocol: "tencent", baseUrl: "https://aiart.tencentcloudapi.com", models: [
    { id: "hunyuan-image-3.0", name: "混元生图 3.0", kind: "image" },
    { id: "hunyuan-video", name: "混元生视频", kind: "video" },
  ] },
  kuaishou: { name: "快手可灵", protocol: "kuaishou", baseUrl: "https://api-beijing.klingai.com", models: [
    { id: "kling-image-o1", name: "可灵图像 O1", kind: "image", options: { mode: "text-to-image" } },
    { id: "kling-v2-6-t2v", name: "可灵视频 2.6 文生视频", kind: "video", options: { modelName: "kling-v2-6", mode: "text-to-video" } },
    { id: "kling-v2-6-i2v", name: "可灵视频 2.6 图生视频", kind: "video", options: { modelName: "kling-v2-6", mode: "image-to-video" } },
  ] },
} satisfies Record<string, { name: string; protocol: z.infer<typeof MediaProtocol>; baseUrl: string; models: MediaLibraryModel[] }>;
