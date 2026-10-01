import { isGptImage2, isGptImage25, validGptImageSize } from "../../../contracts/src/gpt-image.ts";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { getMediaInputCapabilityError } from "../../../contracts/src/media-input-capabilities.ts";
import { MediaGenerationRequest, MediaOutput, MediaProviderConfig, type MediaPollResult, type MediaReferenceImage, type MediaSubmission } from "../../../contracts/src/media.ts";
import { createTencentMediaProvider, validateTencentMediaInput } from "./tencent-provider.ts";
import { createKuaishouMediaProvider, resolveKuaishouTaskConfig, validateKuaishouMediaInput } from "./kuaishou-provider.ts";
import { MediaProviderError } from "./provider-error.ts";
import { resolveMediaExecution } from "./media-execution.ts";
import { openaiHttpError } from "./openai-http-error.ts";

export { MediaProviderError } from "./provider-error.ts";
const invalid = (message: string): never => { throw new MediaProviderError(message, "not-submitted"); };
const endpoint = (config: MediaProviderConfig, path: string) => `${config.baseUrl.replace(/\/+$/, "")}/${path}`;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
/** Accept only explicit progress fields; elapsed time and queue positions are not percentages. */
function reportedProgress(data: Record<string, unknown>): { progress?: number } {
  const percentage = data.progress_percent ?? data.progress_percentage ?? data.percentage;
  const raw = percentage ?? data.progress;
  const percentString = typeof raw === "string" && /^\s*\d+(?:\.\d+)?\s*%\s*$/.test(raw);
  const numeric = typeof raw === "number" ? raw : typeof raw === "string" && (percentString || /^\s*\d+(?:\.\d+)?\s*$/.test(raw)) ? Number(raw.replace("%", "").trim()) : undefined;
  if (numeric === undefined || !Number.isFinite(numeric) || numeric < 0 || numeric > 100) return {};
  const progress = percentage !== undefined || percentString || numeric > 1 ? numeric / 100 : numeric;
  // A running receipt at 100% can still be waiting for output; let the status convey that stage.
  return progress < 1 ? { progress } : {};
}
// Only known provider codes become UI text; raw responses may echo credentials or prompts.
// https://help.aliyun.com/zh/model-studio/error-code/
const dashScopePermissionErrors: Record<string, string> = {
  "Model.AccessDenied": "当前 API Key 无权调用此模型。请在阿里云百炼检查该 Key 所属业务空间的模型调用授权，或换用已授权的 Key。",
  "Workspace.AccessDenied": "当前 API Key 无权访问此业务空间。请核对 Key 所属业务空间及接口地址。",
  "App.AccessDenied": "当前 API Key 无权访问此应用或模型。请检查业务空间和子账号授权。",
  "AccessDenied.Unpurchased": "此账号尚未开通所需模型服务。请在阿里云百炼确认服务开通及模型使用资格。",
  "AllocationQuota.FreeTierOnly": "模型免费额度已耗尽且当前仅允许使用免费额度。请在百炼检查额度和调用设置；启用按量付费会产生费用。",
};
const compact = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}
/** Zod clones input; freezing recursively prevents callers changing a submitted snapshot. */
export function freezeMediaInput(config: MediaProviderConfig, request: MediaGenerationRequest) {
  const parsedConfig = MediaProviderConfig.safeParse(config);
  const parsedRequest = MediaGenerationRequest.safeParse(request);
  if (!parsedConfig.success || !parsedRequest.success) invalid("Invalid media configuration or generation input.");
  if (parsedConfig.data!.protocol === "nspox") parsedRequest.data!.idempotencyKey ??= randomUUID();
  // Kling queries use separate endpoints per operation and do not receive the original request.
  // Freeze the inferred mode so restarting a task keeps the same image2video/text2video route.
  const frozenConfig = resolveKuaishouTaskConfig(parsedConfig.data!, parsedRequest.data!);
  resolveMediaExecution(frozenConfig, parsedRequest.data!.kind);
  validate(frozenConfig, parsedRequest.data!);
  if (frozenConfig.protocol === "tencent") validateTencentMediaInput(frozenConfig, parsedRequest.data!);
  if (frozenConfig.protocol === "kuaishou") validateKuaishouMediaInput(frozenConfig, parsedRequest.data!);
  return deepFreeze({ config: frozenConfig, request: parsedRequest.data! });
}
function safeUrl(raw: string, config: MediaProviderConfig): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return invalid("Invalid media URL."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && config.allowInsecureLoopback))) invalid("Media URL must use HTTPS (HTTP requires explicit loopback development).");
  return url;
}
function validate(config: MediaProviderConfig, request: MediaGenerationRequest) {
  const refs = request.references ?? [];
  for (const ref of refs) if ("url" in ref) safeUrl(ref.url, config);
  for (const ref of request.videoReferences ?? []) safeUrl(ref.url, config);
  const capabilityError = getMediaInputCapabilityError(config, request);
  if (capabilityError) invalid(capabilityError);
  if (request.kind === "image" && (config.protocol === "openai" || config.protocol === "nspox")) {
    if (request.automaticSize && !isGptImage2(config.model)) invalid("当前模型不支持智能尺寸");
    if (request.width && isGptImage2(config.model) && !validGptImageSize(`${request.width}x${request.height}`)) invalid("GPT 图片尺寸须为 16 的倍数，比例在 1:3 到 3:1，且在模型像素上限内");
    if ((config.options?.quality === "xhigh" || config.options?.quality === "max") && !isGptImage25(config.model)) invalid("超高和最高质量仅适用于 GPT Image 2.5");
    if(config.options?.background === "transparent" && config.options?.outputFormat === "jpeg") invalid("透明背景需要 PNG 或 WebP");
  }
  const size = request.automaticSize ? "auto" : request.width === undefined ? undefined : `${request.width}x${request.height}`;
  if (config.protocol === "nspox") {
    if (refs.length > 8) invalid("NSPOX 单次最多支持 8 张参考图，请减少数量后重试。");
    if (refs.some(ref => !("url" in ref) || new URL(ref.url).protocol !== "https:")) invalid("NSPOX 参考图需要先上传为当前账号的 HTTPS 素材链接，请检查平台素材上传是否已启用。");
    if (request.kind === "image" && request.aspectRatio) invalid("NSPOX 图片请使用像素尺寸。");
    if (request.kind === "video" && request.width) invalid("NSPOX 视频请使用画幅比例。");
  }
  if (config.protocol === "openai") {
    if (request.kind === "video") {
      if (request.durationSeconds !== undefined && ![4, 8, 12].includes(request.durationSeconds)) invalid("OpenAI video duration must be 4, 8 or 12 seconds.");
      if (size && !["720x1280", "1280x720", "1024x1792", "1792x1024"].includes(size)) invalid("Unsupported OpenAI video dimensions.");
      if (request.aspectRatio && !["16:9", "9:16"].includes(request.aspectRatio)) invalid("OpenAI video aspect ratio must be 16:9 or 9:16.");
      if (refs.length > 1) invalid("OpenAI video supports one reference image.");
      if (config.options?.quality !== undefined) invalid("OpenAI video does not support image quality options.");
      if (config.model === "sora-2" && size && ["1024x1792", "1792x1024"].includes(size)) invalid("High resolution video requires sora-2-pro.");
    } else {
      if (config.options?.videoTransport !== undefined) invalid("OpenAI image generation does not support videoTransport options.");
      if (size && !(isGptImage2(config.model) ? validGptImageSize(size) : ["1024x1024", "1536x1024", "1024x1536"].includes(size))) invalid("GPT image dimensions must be 1024x1024, 1536x1024 or 1024x1536.");
      if (request.aspectRatio && request.aspectRatio !== "1:1") invalid("For GPT images specify supported pixel dimensions; only 1:1 is an exact aspect ratio.");
      if (/^dall-e-/.test(config.model)) invalid("This OpenAI image adapter supports GPT Image models, not the DALL-E protocol variants.");
    }
  } else if (config.protocol === "ark") {
    if (request.kind === "video") {
      if (request.width !== undefined) invalid("Ark video accepts aspectRatio and resolution, not exact dimensions.");
      const v25 = /seedance-2[.-]5/.test(config.model);
      const v2 = v25 || /seedance-2[.-]0/.test(config.model);
      const maxDuration = v25 ? 30 : v2 ? 15 : 12;
      if (request.durationSeconds !== undefined && (request.durationSeconds < (v2 ? 4 : 2) || request.durationSeconds > maxDuration)) invalid(`当前 Seedance 模型支持 ${v2 ? 4 : 2}–${maxDuration} 秒视频。`);
      if (v25 && config.options?.seed !== undefined) invalid("Seedance 2.5 不支持 seed 参数。");
      const roles = refs.map((ref, i) => ref.role ?? (i === 0 ? "first_frame" : "last_frame"));
      if (refs.some(ref=>ref.role) && refs.some(ref=>!ref.role)) invalid("请为每张视频图片指定用途。");
      if (roles.includes("reference_image")) {
        if (!v2) invalid("当前模型未接通参考图片模式，请使用 Seedance 2.x 模型 ID。");
        if (roles.some(role=>role!=="reference_image")) invalid("参考图片与首尾帧不能混用。");
        if (refs.length > (v25 ? 14 : 9)) invalid("参考图片数量超过当前模型或软件限制。");
      } else if (refs.length > 2 || roles.filter(role=>role==="first_frame").length > 1 || roles.filter(role=>role==="last_frame").length > 1 || roles.includes("last_frame") && !roles.includes("first_frame")) invalid("请选择一张首帧和至多一张尾帧，尾帧不能单独使用。");
      if (config.model.includes("seedance-1-5") && request.durationSeconds !== undefined && request.durationSeconds < 4) invalid("Seedance 1.5 video duration must be at least 4 seconds.");
      if (config.model.includes("seedance-1-0") && config.options?.generateAudio !== undefined) invalid("Seedance 1.0 does not support audio generation.");

    } else {
      if (request.aspectRatio) invalid("Ark images require pixel dimensions instead of aspectRatio.");
      if (size && (request.width! * request.height! < 1280 * 720 || request.width! / request.height! > 3 || request.height! / request.width! > 3)) invalid("Seedream dimensions require at least 921600 pixels and an aspect ratio between 1:3 and 3:1.");
      if (config.options?.resolution !== undefined || config.options?.generateAudio !== undefined) invalid("Ark image generation does not support video resolution/audio options.");
    }
  } else if (config.protocol === "dashscope") {
    const options = config.options;
    if (request.kind === "image") {
      if (options?.videoApi !== undefined || options?.resolution !== undefined) invalid("DashScope images do not support video options.");
      if (request.aspectRatio) invalid("DashScope images require pixel dimensions instead of aspectRatio.");
      if (options?.imageApi === "wan") {
        if (refs.length) invalid("Wan text-to-image does not accept references; choose the Qwen image adapter.");
        if (size && /^wanx?2\.[56]-t2i/.test(config.model)) {
          if (request.width! * request.height! < 1280 ** 2 || request.width! * request.height! > 1440 ** 2 || request.width! / request.height! > 4 || request.height! / request.width! > 4) invalid("Wan 2.5/2.6 images require 1280 squared to 1440 squared pixels and an aspect ratio between 1:4 and 4:1.");
        } else if (size && /^wanx?2\.[012]-t2i/.test(config.model) && (request.width! < 512 || request.height! < 512 || request.width! > 1440 || request.height! > 1440)) invalid("Wan 2.2 and earlier dimensions must be between 512 and 1440.");
      } else if (options?.imageApi === "z-image") {
        if (refs.length) invalid("Z-Image is text-to-image only and does not accept reference images.");
        if (options.watermark !== undefined) invalid("Z-Image does not support the watermark parameter.");
        if (Array.from(request.prompt).length > 800) invalid("Z-Image prompts must not exceed 800 characters.");
        if (size && (request.width! * request.height! < 512 ** 2 || request.width! * request.height! > 2048 ** 2)) invalid("Z-Image output must contain 512 squared to 2048 squared pixels.");
      }
      else {
        if (refs.length > 3) invalid("Qwen image editing supports up to three reference images.");
        if (refs.length && /^qwen-image(?:$|-plus|-max)/.test(config.model)) invalid("This Qwen model is text-to-image only; choose qwen-image-2.0 or qwen-image-edit.");
        if (!refs.length && config.model.startsWith("qwen-image-edit")) invalid("Qwen image edit requires at least one reference image.");
        if (config.model === "qwen-image-edit" && (size || options?.promptExtend !== undefined)) invalid("qwen-image-edit does not support custom size or prompt extension.");
        if (size && refs.length && !config.model.startsWith("qwen-image-3.0") && (request.width! < 512 || request.height! < 512 || request.width! > 2048 || request.height! > 2048)) invalid("Qwen editing dimensions must be between 512 and 2048.");
        if (size && config.model.startsWith("qwen-image-3.0") && (request.width! * request.height! < 512 ** 2 || request.width! * request.height! > 2048 ** 2 || request.width! / request.height! > 8 || request.height! / request.width! > 8)) invalid("Qwen Image 3.0 requires 512 squared to 2048 squared pixels and an aspect ratio between 1:8 and 8:1.");
        if (size && !refs.length && config.model.startsWith("qwen-image-2.0") && (request.width! * request.height! < 512 ** 2 || request.width! * request.height! > 2048 ** 2)) invalid("Qwen image output must contain 512 squared to 2048 squared pixels.");
        if (size && /^qwen-image(?:$|-plus|-max)/.test(config.model) && !["1664x928", "1472x1104", "1328x1328", "1104x1472", "928x1664"].includes(size)) invalid("Unsupported Qwen image dimensions for this model.");
      }
    } else {
      if (options?.imageApi !== undefined) invalid("DashScope video does not support imageApi options.");
      if (refs.length > 1) invalid("This Wan adapter supports one first-frame image.");
      if (refs.length && /-t2v/.test(config.model)) invalid("Select a Wan i2v model for reference images.");
      if (!refs.length && /-i2v/.test(config.model)) invalid("Wan i2v models require one reference image.");
      const modern = options?.videoApi === "wan2.7" || (!options?.videoApi && config.model.startsWith("wan2.7"));
      if (modern && refs.length) invalid("Wan2.7 image-to-video uses a different input protocol; use wan2.6-i2v in this adapter.");
      if (modern && request.width !== undefined) invalid("Wan2.7 uses aspectRatio and resolution instead of exact dimensions.");
      if (!modern && refs.length && (request.width !== undefined || request.aspectRatio)) invalid("Wan image-to-video derives dimensions from its reference; set resolution only.");
      if (!modern && !refs.length && request.aspectRatio) invalid("Wan text-to-video requires pixel dimensions for the legacy API.");
      if (modern && request.durationSeconds !== undefined && (request.durationSeconds < 2 || request.durationSeconds > 15)) invalid("Wan2.7 duration must be 2 to 15 seconds.");
      if (!modern && request.durationSeconds !== undefined && ![5, 10, ...(config.model.startsWith("wan2.6") ? [15] : [])].includes(request.durationSeconds)) invalid("Wan duration must be 5 or 10 seconds (also 15 for Wan2.6).");
      if ((modern || config.model.startsWith("wan2.6")) && options?.resolution === "480P") invalid("This Wan model supports 720P or 1080P.");
      if (!modern && !refs.length && options?.resolution) invalid("Legacy Wan text-to-video uses pixel dimensions instead of resolution.");
      if (size && !["1280x720", "720x1280", "960x960", "1920x1080", "1080x1920", "1440x1440", "832x480", "480x832", "624x624"].includes(size)) invalid("Unsupported Wan video dimensions.");
    }
  } else {
    // Vendor-specific providers validate their own request shape.
  }
}
const refData = (ref: MediaReferenceImage) => "url" in ref ? ref.url : `data:${ref.mimeType};base64,${ref.base64}`;

export function createMediaProvider(options: { fetch?: typeof fetch; maxDownloadBytes?: number; timeoutMs?: number } = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const maxBytes = options.maxDownloadBytes ?? 256 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) invalid("Invalid media transfer limits.");
  const tencent = createTencentMediaProvider({ fetch: fetcher, timeoutMs, maxDownloadBytes: maxBytes });
  const kuaishou = createKuaishouMediaProvider({ fetch: fetcher, timeoutMs, maxDownloadBytes: maxBytes });
  const signalFor = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  async function readBytes(response: Response, limit: number): Promise<Uint8Array> {
    if (Number(response.headers.get("Content-Length")) > limit) { await response.body?.cancel(); invalid("Media response exceeds the configured size limit."); }
    const reader = response.body?.getReader();
    if (!reader) invalid("Empty media response.");
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      while (true) {
        const { done, value } = await reader!.read(); if (done) break;
        total += value.byteLength;
        if (total > limit) { await reader!.cancel(); invalid("Media response exceeds the configured size limit."); }
        chunks.push(value);
      }
    } finally { reader!.releaseLock(); }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
  async function transfer(config: MediaProviderConfig, key: string, raw: string, authenticated: boolean, signal?: AbortSignal, limit = maxBytes) {
    let url = safeUrl(raw, config);
    const origin = new URL(config.baseUrl).origin;
    if (authenticated && url.origin !== origin) invalid("Refusing authenticated media download from another origin.");
    const boundedSignal = signalFor(signal);
    for (let hop = 0; hop <= 5; hop++) {
      const response = await fetcher(url.href, { method: "GET", headers: authenticated && url.origin === origin ? { Authorization: `Bearer ${key}` } : {}, redirect: "manual", signal: boundedSignal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("Location"); await response.body?.cancel();
        if (!location) invalid("Media redirect has no destination.");
        const next = safeUrl(new URL(location!, url).href, config);
        if (next.origin !== url.origin) authenticated = false;
        url = next; continue;
      }
      if (!response.ok) throw new MediaProviderError(`Media download failed (HTTP ${response.status}).`, "not-submitted", response.status);
      const mimeType = response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
      return { bytes: await readBytes(response, limit), mimeType };
    }
    return invalid("Too many media download redirects.");
  }
  async function refBlob(config: MediaProviderConfig, ref: MediaReferenceImage, signal?: AbortSignal) {
    if ("base64" in ref) return new Blob([Buffer.from(ref.base64, "base64")], { type: ref.mimeType });
    const result = await transfer(config, "", ref.url, false, signal, 10 * 1024 * 1024);
    if (!["image/png", "image/jpeg", "image/webp"].includes(result.mimeType ?? "")) invalid("Reference URL did not return a PNG, JPEG or WebP image.");
    return new Blob([result.bytes as Uint8Array<ArrayBuffer>], { type: result.mimeType! });
  }
  async function json(config: MediaProviderConfig, key: string, path: string, body: BodyInit | undefined, asyncHeader: boolean, signal?: AbortSignal, idempotencyKey?: string, privateText?: readonly string[]) {
    if (!key.trim() || /[\r\n]/.test(key)) invalid("A valid host media credential is required.");
    if (signal?.aborted) invalid("Media request was cancelled before submission.");
    const post = body !== undefined;
    let response: Response;
    try {
      response = await fetcher(endpoint(config, path), { method: post ? "POST" : "GET", headers: { Authorization: `Bearer ${key}`, ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}), ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}), ...(asyncHeader ? { "X-DashScope-Async": "enable" } : {}) }, ...(body === undefined ? {} : { body }), redirect: "manual", signal: signalFor(signal) });
    } catch { throw new MediaProviderError(post ? "Submission result is unknown; reconcile before retrying." : "Media task query could not be completed.", post ? "unknown" : "not-submitted"); }
    if (!response.ok) {
      let message = `Media API request failed (HTTP ${response.status}).`;
      if (config.protocol === "openai") {
        let payload: unknown;
        try { payload = JSON.parse(new TextDecoder().decode(await readBytes(response, 16_384))); }
        catch { /* A safe header request ID remains useful for malformed or oversized bodies. */ }
        message = openaiHttpError(response.status, response.headers, payload, { credential: key, baseUrl: config.baseUrl, privateText });
      } else if (config.protocol === "dashscope" && response.status === 403) {
        try {
          const payload = record(JSON.parse(new TextDecoder().decode(await readBytes(response, 16_384))));
          const code = string(payload.code);
          if (code && Object.hasOwn(dashScopePermissionErrors, code)) message = `${dashScopePermissionErrors[code]}（HTTP 403 · ${code}）`;
        } catch { /* Keep the HTTP status when the body is malformed, oversized or interrupted. */ }
      } else if (config.protocol === "nspox" && response.status === 402) {
        try {
          const payload = record(JSON.parse(new TextDecoder().decode(await readBytes(response, 16_384))));
          if (record(payload.error).code === "media_credit_insufficient") {
            message = "NSPOX 媒体点数不足，请在 NSPOX 检查并补足媒体点数后重试。图片／视频使用独立媒体点数，文本额度不能抵扣。（HTTP 402 · media_credit_insufficient）";
          }
        } catch { /* Do not infer account balance from an unrecognized gateway response. */ }
      } else await response.body?.cancel();
      // A timeout, 5xx or redirect may follow a successful upstream submission.
      const definite = response.status >= 400 && response.status < 500 && response.status !== 408;
      throw new MediaProviderError(message, post ? (definite ? "rejected" : "unknown") : "not-submitted", response.status);
    }
    try { return record(JSON.parse(new TextDecoder().decode(await readBytes(response, 100_000_000)))); }
    catch { throw new MediaProviderError("Media API returned an unreadable response; reconcile before retrying.", post ? "unknown" : "not-submitted"); }
  }
  function result(config: MediaProviderConfig, data: Record<string, unknown>, submitted: boolean, remoteId?: string): MediaPollResult {
    if (config.protocol === "nspox") {
      const task = record(data.data);
      const uncertain = (message: string): never => { throw new MediaProviderError(message, submitted ? "unknown" : "not-submitted"); };
      const id = string(task.id);
      if (!id || !/^[a-zA-Z0-9_-]{1,512}$/.test(id) || remoteId && id !== remoteId || task.object !== "media_generation" || task.model !== config.model || !["image", "video"].includes(String(task.modality))) return uncertain("NSPOX 返回了不匹配的任务信息，请核对原任务。");
      if (["queued", "running"].includes(String(task.status))) return { status: "running", remoteId: id, ...reportedProgress(task) };
      if (record(task.error).code === "media_result_unknown") throw new MediaProviderError("上游结果尚未确认，请核对原任务，勿重复生成。", "unknown", undefined, true, id);
      if (["failed", "cancelled"].includes(String(task.status))) {
        if (submitted) throw new MediaProviderError("NSPOX 生成任务失败或已取消。", "rejected");
        return { status: "failed", message: "NSPOX 生成任务失败或已取消。" };
      }
      if (task.status !== "succeeded") return uncertain("NSPOX 返回了未知任务状态，请继续核对原任务。");
      const output = record(task.result), first = record(array(output.data)[0]);
      const url = task.modality === "video" ? string(output.video_url) : string(first.url);
      const format=output.output_format??config.options?.outputFormat;
      const mimeType=format==="jpeg"?"image/jpeg":format==="webp"?"image/webp":"image/png";
      const parsed = MediaOutput.safeParse(url ? { url, mimeType: task.modality === "video" ? "video/mp4" : mimeType } : { base64: first.b64_json, mimeType });
      if (!parsed.success || task.modality === "video" && !url) return uncertain("NSPOX 任务完成但未返回有效素材，请核对原任务。");
      return { status: "succeeded", output: parsed.data };
    }
    const output = record(data.output);
    const failure = (message: string): MediaPollResult => submitted ? (() => { throw new MediaProviderError(message, "rejected"); })() : { status: "failed", message };
    const id = string(data.id) ?? string(output.task_id) ?? remoteId;
    if (remoteId && id !== remoteId) throw new MediaProviderError("Media query returned a different task ID.", "not-submitted");
    const rawStatus = string(data.status) ?? string(output.task_status);
    const status = rawStatus?.toLowerCase();
    if (status && ["failed", "canceled", "cancelled", "expired"].includes(status)) return failure("Media generation failed or was cancelled at the provider.");
    if (status === "unknown") throw new MediaProviderError("The remote task is unknown or expired; do not automatically resubmit.", "unknown");
    // Never surface provider error messages; gateways can echo keys or request bodies.
    if (data.error || string(data.code)) {
      if (!submitted) throw new MediaProviderError("Media query failed. Check host credentials and retry polling the existing task.", "not-submitted");
      return failure("Media provider rejected the request. Check the model, inputs and host credentials.");
    }
    if ((status && ["queued", "pending", "running", "in_progress"].includes(status)) || (submitted && !status && id)) {
      if (id && /^[a-zA-Z0-9_-]{1,512}$/.test(id)) return { status: "running", remoteId: id, ...reportedProgress({ ...data, ...output }) };
    }
    if (config.protocol === "openai" && status === "completed" && id && /^[a-zA-Z0-9_-]{1,512}$/.test(id)) return { status: "succeeded", output: { url: endpoint(config, `videos/${encodeURIComponent(id)}/content`), mimeType: "video/mp4", requiresAuth: true } };
    const first = record(array(data.data)[0]);
    const content = record(record(array(output.choices)[0]).message).content;
    const image = string(record(array(content).find(item => string(record(item).image))).image);
    const videoUrl = string(record(data.content).video_url) ?? string(output.video_url);
    const url = videoUrl ?? string(first.url) ?? image ?? string(record(array(output.results)[0]).url);
    const base64 = string(first.b64_json);
    if (url || base64) {
      const format=data.output_format??(config.protocol==="openai"?config.options?.outputFormat:undefined);
      const mimeType=videoUrl?"video/mp4":format==="jpeg"?"image/jpeg":format==="webp"?"image/webp":"image/png";
      const parsed = MediaOutput.safeParse(url ? { url, mimeType } : { base64, mimeType });
      if (parsed.success) return { status: "succeeded", output: parsed.data };
    }
    throw new MediaProviderError("Media API response has no recognized task or output; reconcile before retrying.", submitted ? "unknown" : "not-submitted");
  }
  return {
    async submit(configInput: MediaProviderConfig, key: string, requestInput: MediaGenerationRequest, signal?: AbortSignal): Promise<MediaSubmission> {
      const { config, request } = freezeMediaInput(configInput, requestInput);
      if (config.protocol === "tencent") return tencent.submit(config, key, request, signal);
      if (config.protocol === "kuaishou") return kuaishou.submit(config, key, request, signal);
      const execution = resolveMediaExecution(config, request.kind);
      const refs = request.references ?? [];
      const size = request.automaticSize ? "auto" : request.width === undefined ? undefined : `${request.width}x${request.height}`;
      const imageOptions = (config.protocol === "openai" || config.protocol === "nspox") && request.kind === "image" ? compact({
        background:config.options?.background,output_format:config.options?.outputFormat,output_compression:config.options?.outputCompression,
        moderation:refs.length?undefined:config.options?.moderation,...(refs.length ? {input_fidelity:config.options?.inputFidelity} : {}),
      }) : {};
      let path: string; let body: BodyInit; let asyncHeader = false;
      if (config.protocol === "nspox") {
        path = "media/generations";
        body = JSON.stringify({ model: config.model, modality: request.kind, prompt: request.prompt,
          ...(refs.length ? { input_images: refs.map(ref => "url" in ref ? ref.url : invalid("NSPOX 需要远程参考图")) } : {}),
          options: compact(request.kind === "image" ? { n: 1, size, quality: config.options?.quality, ...imageOptions } : { duration: request.durationSeconds?.toString(), aspect_ratio: request.aspectRatio }) });
        if (new TextEncoder().encode(body).byteLength > 2 * 1024 * 1024) invalid("NSPOX 请求超过 2 MB 限制。");
      } else if (config.protocol === "openai") {
        path = request.kind === "video" ? "videos" : refs.length ? "images/edits" : "images/generations";
        const fields = compact({ model: config.model, prompt: request.prompt, ...(request.kind === "image" ? { n: 1, ...imageOptions, quality: config.options?.quality, size: size ?? (request.aspectRatio ? "1024x1024" : undefined) } : { seconds: request.durationSeconds?.toString(), size: size ?? (request.aspectRatio ? (request.aspectRatio === "16:9" ? "1280x720" : "720x1280") : undefined) }) });
        if (request.kind === "video" && config.options?.videoTransport !== "multipart") {
          body = JSON.stringify({ ...fields, ...(refs[0] ? { input_reference: { image_url: refData(refs[0]) } } : {}) });
        } else if (request.kind === "video" || refs.length) {
          const form = new FormData();
          for (const [name, value] of Object.entries(fields)) form.append(name, String(value));
          for (const [index, ref] of refs.entries()) {
            let blob: Blob;
            try { blob = await refBlob(config, ref, signal); }
            catch (error) { if (error instanceof MediaProviderError) throw error; throw new MediaProviderError("Reference image could not be read before submission.", "not-submitted"); }
            const extension = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
            form.append(request.kind === "video" ? "input_reference" : "image[]", blob, `reference-${index}.${extension}`);
          }
          body = form;
        } else body = JSON.stringify(fields);
      } else if (config.protocol === "ark") {
        path = request.kind === "image" ? "images/generations" : "contents/generations/tasks";
        const shared = { model: config.model, watermark: config.options?.watermark, seed: config.options?.seed };
        body = JSON.stringify(request.kind === "image" ? { ...shared, prompt: request.prompt, ...(refs.length ? { image: refs.map(refData) } : {}), size, response_format: "url", sequential_image_generation: "disabled" } : { ...shared, content: [{ type: "text", text: request.prompt }, ...refs.map((ref, index) => ({ type: "image_url", image_url: { url: refData(ref) }, role: ref.role ?? (index === 0 ? "first_frame" : "last_frame") })), ...(request.videoReferences ?? []).map(ref => ({ type: "video_url", video_url: { url: ref.url }, role: "reference_video" }))], duration: request.durationSeconds, ratio: /seedance-2[.-]5/.test(config.model) && refs.some(ref => ref.role !== "reference_image") ? "adaptive" : request.aspectRatio, resolution: config.options?.resolution, generate_audio: config.options?.generateAudio });
      } else if (config.protocol === "dashscope") {
        const settings = config.options;
        const parameters = compact({ watermark: settings?.watermark, seed: settings?.seed, prompt_extend: settings?.promptExtend });
        const dashSize = size?.replace("x", "*");
        if (request.kind === "image") {
          if (settings?.imageApi !== "z-image") parameters.n = 1;
          if (dashSize) parameters.size = dashSize;
          // Keep legacy Wan automatic routing for existing saved configurations.
          const legacyWan = settings?.imageApi === "wan" && execution === "async" && (!config.executionMode || config.executionMode === "auto" || !/^wan2\.6-t2i(?:-|$)/i.test(config.model));
          if (legacyWan) { path = "services/aigc/text2image/image-synthesis"; asyncHeader = true; body = JSON.stringify({ model: config.model, input: { prompt: request.prompt }, parameters }); }
          else { asyncHeader = execution === "async"; path = asyncHeader ? "services/aigc/image-generation/generation" : "services/aigc/multimodal-generation/generation"; body = JSON.stringify({ model: config.model, input: { messages: [{ role: "user", content: [...refs.map(ref => ({ image: refData(ref) })), { text: request.prompt }] }] }, parameters }); }
        } else {
          path = "services/aigc/video-generation/video-synthesis"; asyncHeader = true;
          const modern = settings?.videoApi === "wan2.7" || (!settings?.videoApi && config.model.startsWith("wan2.7"));
          Object.assign(parameters, compact({ ...(modern ? { ratio: request.aspectRatio, resolution: settings?.resolution } : refs.length ? { resolution: settings?.resolution } : { size: dashSize }), duration: request.durationSeconds }));
          body = JSON.stringify({ model: config.model, input: { prompt: request.prompt, ...(refs[0] ? { img_url: refData(refs[0]) } : {}) }, parameters });
        }
      } else {
        throw new MediaProviderError("Use the vendor-specific media adapter for this provider.", "not-submitted");
      }
      const privateText = [request.prompt, ...refs.map(ref => "url" in ref ? ref.url : ref.base64)];
      const submitted = result(config, await json(config, key, path, body, asyncHeader, signal, config.protocol === "nspox" ? request.idempotencyKey : undefined, privateText), true) as MediaSubmission;
      if (submitted.status === "succeeded" && !submitted.output.mimeType.startsWith(`${request.kind}/`)) throw new MediaProviderError("Media provider returned an unexpected output kind; reconcile before retrying.", "unknown");
      return submitted;
    },
    async poll(configInput: MediaProviderConfig, key: string, remoteId: string, signal?: AbortSignal): Promise<MediaPollResult> {
      if (configInput.protocol === "tencent") return tencent.poll(configInput, key, remoteId, signal);
      if (configInput.protocol === "kuaishou") return kuaishou.poll(configInput, key, remoteId, signal);
      const config = MediaProviderConfig.parse(configInput);
      if (!/^[a-zA-Z0-9_-]{1,512}$/.test(remoteId)) invalid("Invalid remote media task ID.");
      const path = config.protocol === "nspox" ? `media/generations/${remoteId}` : config.protocol === "openai" ? `videos/${remoteId}` : config.protocol === "ark" ? `contents/generations/tasks/${remoteId}` : `tasks/${remoteId}`;
      return result(config, await json(config, key, path, undefined, false, signal), false, remoteId);
    },
    async download(configInput: MediaProviderConfig, key: string, outputInput: MediaOutput, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }> {
      if (configInput.protocol === "tencent") return tencent.download(configInput, key, outputInput, signal);
      if (configInput.protocol === "kuaishou") return kuaishou.download(configInput, key, outputInput, signal);
      const config = MediaProviderConfig.parse(configInput); const output = MediaOutput.parse(outputInput);
      if ("base64" in output) {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(output.base64)) invalid("Invalid media base64 output.");
        const bytes = Buffer.from(output.base64, "base64"); if (!bytes.length || bytes.length > maxBytes) invalid("Media output exceeds the configured size limit or is empty.");
        return { bytes, mimeType: output.mimeType };
      }
      try {
        const value = await transfer(config, key, output.url, output.requiresAuth === true, signal);
        const mimeType = value.mimeType && value.mimeType !== "application/octet-stream" ? value.mimeType : output.mimeType;
        if (!["image/png", "image/jpeg", "image/webp", "video/mp4"].includes(mimeType) || !value.bytes.length) invalid("Download did not return a supported media file.");
        return { bytes: value.bytes, mimeType };
      } catch (error) { if (error instanceof MediaProviderError) throw error; throw new MediaProviderError("Media download could not be completed.", "not-submitted"); }
    },
  };
}
export type MediaProvider = ReturnType<typeof createMediaProvider>;
