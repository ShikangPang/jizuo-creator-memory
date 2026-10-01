import { GptImageOptions } from "./gpt-image.ts";
import { z } from "zod";

const Identity = z.string().trim().min(1).max(512);
export const MediaExecutionMode = z.enum(["auto", "sync", "async"]);
const common = {
  executionMode: MediaExecutionMode.optional(),
  baseUrl: z.string().url().max(2048),
  model: Identity,
  credentialRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
  allowInsecureLoopback: z.boolean().optional(),
};
const seed = z.number().int().min(0).max(2147483647).optional();

/** Contains only non-secret host configuration. Never put an API key here. */
export const MediaProviderConfig = z.discriminatedUnion("protocol", [
  z.object({ ...common, protocol: z.literal("nspox"), baseUrl: z.string().refine((value): boolean => value === "https://www.nspox.com/v1", "NSPOX requires the official endpoint"), options: z.object({ ...GptImageOptions }).strict().optional() }).strict(),
  z.object({ ...common, protocol: z.literal("openai"), options: z.object({
    ...GptImageOptions,
    videoTransport: z.enum(["json", "multipart"]).optional(),
  }).strict().optional() }).strict(),
  z.object({ ...common, protocol: z.literal("ark"), options: z.object({
    resolution: z.enum(["480p", "720p", "1080p"]).optional(),
    watermark: z.boolean().optional(), seed,
    generateAudio: z.boolean().optional(),
  }).strict().optional() }).strict(),
  z.object({ ...common, protocol: z.literal("dashscope"), options: z.object({
    imageApi: z.enum(["qwen", "wan", "z-image"]).optional(),
    videoApi: z.enum(["wan2.6", "wan2.7"]).optional(),
    resolution: z.enum(["480P", "720P", "1080P"]).optional(),
    watermark: z.boolean().optional(), seed,
    promptExtend: z.boolean().optional(),
  }).strict().optional() }).strict(),
  z.object({ ...common, protocol: z.literal("tencent"), options: z.object({
    region: z.string().trim().min(1).max(64).optional(),
    resolution: z.literal("720p").optional(),
    watermark: z.boolean().optional(),
    promptExtend: z.boolean().optional(),
    seed,
  }).strict().optional() }).strict(),
  z.object({ ...common, protocol: z.literal("kuaishou"), options: z.object({
    modelName: z.string().trim().min(1).max(128).optional(),
    resolution: z.enum(["720p", "1080p"]).optional(),
    mode: z.enum(["text-to-video", "image-to-video", "text-to-image"]).optional(),
  }).strict().optional() }).strict(),
]).superRefine((value, context) => {
  let url: URL;
  try { url = new URL(value.baseUrl); } catch { return; } // z.string().url() reports malformed URLs.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && value.allowInsecureLoopback))) {
    context.addIssue({ code: "custom", path: ["baseUrl"], message: "Use HTTPS without embedded credentials/query/fragment, or explicitly enable HTTP loopback development." });
  }
});
export type MediaProviderConfig = z.infer<typeof MediaProviderConfig>;

/** Match host duration alignment before estimating or constructing a generation request. */
export function resolveVideoGenerationDuration(config: MediaProviderConfig, shotDurationSec: number, requestedDuration?: number): number | undefined {
  if (config.protocol === "tencent") return undefined;
  if (requestedDuration !== undefined) return requestedDuration;
  const desired = Math.ceil(shotDurationSec);
  const modernDash = config.protocol === "dashscope" && (config.options?.videoApi === "wan2.7" || (!config.options?.videoApi && config.model.startsWith("wan2.7")));
  const supported = config.protocol === "openai" ? [4, 8, 12] : config.protocol === "dashscope" && !modernDash ? (config.model.startsWith("wan2.6") ? [5, 10, 15] : [5, 10]) : undefined;
  return supported?.find((value) => value >= desired) ?? desired;
}

export const VideoImageRole = z.enum(["first_frame", "last_frame", "reference_image"]);
export const MediaReferenceImage = z.union([
  z.object({ url: z.string().url().max(8192), role: VideoImageRole.optional() }).strict(),
  z.object({ base64: z.string().min(4).max(14_000_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/), mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), role: VideoImageRole.optional() }).strict(),
]);
export type MediaReferenceImage = z.infer<typeof MediaReferenceImage>;
/** Reference videos use provider-reachable URLs; Ark does not accept video data URIs. */
export const MediaReferenceVideo = z.object({ url: z.string().url().max(8192) }).strict();
export type MediaReferenceVideo = z.infer<typeof MediaReferenceVideo>;
export const MediaGenerationRequest = z.object({
  idempotencyKey: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/).optional(),
  kind: z.enum(["image", "video"]),
  prompt: z.string().min(1).max(32000),
  width: z.number().int().min(256).max(4096).optional(),
  height: z.number().int().min(256).max(4096).optional(),
  aspectRatio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]).optional(),
  automaticSize: z.boolean().optional(),
  durationSeconds: z.number().int().positive().max(30).optional(),
  references: z.array(MediaReferenceImage).max(14).optional(),
  videoReferences: z.array(MediaReferenceVideo).max(3).optional(),
}).strict().superRefine((value, context) => {
  if ((value.width === undefined) !== (value.height === undefined)) context.addIssue({ code: "custom", message: "Specify both width and height." });
  if (value.automaticSize && (value.kind !== "image" || value.width !== undefined || value.aspectRatio !== undefined)) context.addIssue({ code: "custom", message: "Automatic size is only for images without explicit dimensions." });
  if (value.width !== undefined && value.aspectRatio !== undefined) context.addIssue({ code: "custom", message: "Specify dimensions or aspectRatio, not both." });
  if (value.kind === "image" && value.durationSeconds !== undefined) context.addIssue({ code: "custom", message: "Image requests do not support durationSeconds." });
  if (value.kind === "image" && value.videoReferences?.length) context.addIssue({ code: "custom", message: "Image requests do not support reference videos." });
});
export type MediaGenerationRequest = z.infer<typeof MediaGenerationRequest>;

export const MediaOutput = z.union([
  z.object({ url: z.string().url().max(16384), mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "video/mp4"]), requiresAuth: z.boolean().optional() }).strict(),
  z.object({ base64: z.string().min(4).max(100_000_000), mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "video/mp4"]) }).strict(),
]);
export type MediaOutput = z.infer<typeof MediaOutput>;
/** Optional progress is reported by the provider, normalized to the 0–1 range. */
export type MediaSubmission = { status: "running"; remoteId: string; progress?: number } | { status: "succeeded"; output: MediaOutput };
export type MediaPollResult = MediaSubmission | { status: "failed"; message: string };
