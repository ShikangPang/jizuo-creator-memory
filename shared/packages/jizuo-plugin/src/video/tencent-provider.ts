import { createHash, createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { getMediaInputCapabilityError } from "../../../contracts/src/media-input-capabilities.ts";
import { MediaGenerationRequest, MediaOutput, type MediaPollResult, type MediaSubmission } from "../../../contracts/src/media.ts";
import { MediaProviderError } from "./provider-error.ts";

const configSchema = z.object({
  protocol: z.literal("tencent"), baseUrl: z.string().url(), model: z.string().trim().min(1), credentialRef: z.string().min(1),
  allowInsecureLoopback: z.boolean().optional(),
  executionMode: z.enum(["auto", "sync", "async"]).optional(),
  options: z.object({
    region: z.string().regex(/^[a-z]+-[a-z]+(?:-\d+)?$/).optional(), resolution: z.literal("720p").optional(),
    watermark: z.boolean().optional(), promptExtend: z.boolean().optional(), seed: z.number().int().min(1).max(4294967295).optional(),
  }).strict().optional(),
}).strict();
export type TencentMediaProviderConfig = z.infer<typeof configSchema>;
const credentialSchema = z.object({ secretId: z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/), secretKey: z.string().min(1).max(1024).regex(/^[^\s]+$/), token: z.string().min(1).max(16384).regex(/^[^\r\n]+$/).optional() }).strict();
export type TencentCredential = z.infer<typeof credentialSchema>;
export type TencentSignInput = { service: "aiart" | "vclm"; host: string; action: string; version: string; region: string; timestamp: number; body: string };
export type TencentSigner = (input: TencentSignInput, credential: TencentCredential) => Record<string, string> | Promise<Record<string, string>>;

const invalid = (message: string): never => { throw new MediaProviderError(message, "not-submitted"); };
const record = (input: unknown): Record<string, unknown> => input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
const text = (input: unknown): string | undefined => typeof input === "string" && input.length > 0 ? input : undefined;
const compact = (input: Record<string, unknown>) => Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

function serviceFor(config: TencentMediaProviderConfig) {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) return invalid("Invalid Tencent media configuration.");
  const url = new URL(parsed.data.baseUrl);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") invalid("Tencent requires its HTTPS API root endpoint.");
  const service = url.hostname === "aiart.tencentcloudapi.com" ? "aiart" : url.hostname === "vclm.tencentcloudapi.com" ? "vclm" : invalid("Unsupported Tencent media endpoint.");
  return { config: parsed.data, service, host: url.hostname, url: url.href, version: service === "aiart" ? "2022-12-29" : "2024-05-23" } as const;
}

/** Secret JSON lives only in the host credential store, never in provider settings. */
function parseCredential(key: string | TencentCredential): TencentCredential {
  try {
    const parsed = credentialSchema.safeParse(typeof key === "string" ? JSON.parse(key) : key);
    if (parsed.success) return parsed.data;
  } catch { /* Do not expose JSON fragments from secret input. */ }
  return invalid("Tencent credentials require secretId, secretKey and optional token.");
}

function httpsUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return invalid("Invalid Tencent media URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) invalid("Tencent media URLs must use HTTPS without embedded credentials or fragments.");
  return url.href;
}

export function validateTencentMediaInput(configInput: TencentMediaProviderConfig, requestInput: MediaGenerationRequest) {
  const { config, service } = serviceFor(configInput);
  const parsed = MediaGenerationRequest.safeParse(requestInput);
  if (!parsed.success) return invalid("Invalid Tencent media generation input.");
  const request = parsed.data;
  const image = request.kind === "image";
  if ((service === "aiart") !== image) invalid("Tencent endpoint does not match the requested media kind.");
  if (!request.prompt.trim() || Array.from(request.prompt.trim()).length > (image ? 8192 : 200)) invalid("Tencent media prompt exceeds the supported length.");
  const refs = request.references ?? [];
  const capabilityError = getMediaInputCapabilityError(config, request);
  if (capabilityError) invalid(capabilityError);
  if (refs.length > (image ? 3 : 1)) invalid("Too many reference images for this Tencent API.");
  for (const ref of refs) {
    if ("url" in ref) httpsUrl(ref.url);
    else if (ref.base64.length >= (image ? 6 : 8) * 1024 * 1024) invalid("Tencent reference image exceeds the API base64 size limit.");
  }
  if (request.aspectRatio) invalid("This Tencent API does not accept aspectRatio.");
  if (image) {
    if (config.options?.resolution !== undefined) invalid("Tencent image generation requires pixel dimensions instead of video resolution.");
    if (request.width !== undefined && (request.width < 512 || request.width > 2048 || request.height! < 512 || request.height! > 2048 || request.width * request.height! > 1024 ** 2)) invalid("Tencent image dimensions must be 512 to 2048 pixels with at most 1048576 total pixels.");
    if (config.options?.seed !== undefined && config.options.promptExtend !== false) invalid("Tencent fixed seeds require prompt extension to be disabled.");
  } else {
    if (request.width !== undefined || request.durationSeconds !== undefined) invalid("This Tencent video API does not accept custom dimensions or duration.");
    if (config.options?.seed !== undefined || config.options?.promptExtend !== undefined) invalid("Tencent video does not support image seed or prompt extension options.");
  }
  return { config, request };
}

/** Tencent Cloud API 3.0 TC3 signature; the exact serialized payload is signed once. */
export function signTencentRequest(input: TencentSignInput, credential: TencentCredential): Record<string, string> {
  const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value, "utf8").digest();
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/${input.service}/tc3_request`;
  const contentType = "application/json; charset=utf-8";
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalHeaders = `content-type:${contentType}\nhost:${input.host}\nx-tc-action:${input.action.toLowerCase()}\n`;
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(input.body)}`;
  const toSign = `TC3-HMAC-SHA256\n${input.timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
  const signature = hmac(hmac(hmac(hmac(`TC3${credential.secretKey}`, date), input.service), "tc3_request"), toSign).toString("hex");
  return {
    Authorization: `TC3-HMAC-SHA256 Credential=${credential.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "Content-Type": contentType, Host: input.host, "X-TC-Action": input.action, "X-TC-Version": input.version,
    "X-TC-Region": input.region, "X-TC-Timestamp": String(input.timestamp), ...(credential.token ? { "X-TC-Token": credential.token } : {}),
  };
}

export function createTencentMediaProvider(options: { fetch?: typeof fetch; signer?: TencentSigner; now?: () => number; timeoutMs?: number; maxDownloadBytes?: number } = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const signer = options.signer ?? signTencentRequest;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const maxBytes = options.maxDownloadBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) invalid("Invalid Tencent media transfer limits.");
  const signalFor = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  async function bytes(response: Response, limit: number) {
    if (Number(response.headers.get("Content-Length")) > limit) { await response.body?.cancel(); return invalid("Tencent media response exceeds its size limit."); }
    const reader = response.body?.getReader();
    if (!reader) return invalid("Empty Tencent media response.");
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const item = await reader.read(); if (item.done) break;
        length += item.value.length;
        if (length > limit) { await reader.cancel(); return invalid("Tencent media response exceeds its size limit."); }
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    return new Uint8Array(Buffer.concat(chunks, length));
  }
  async function call(config: TencentMediaProviderConfig, key: string | TencentCredential, action: string, bodyInput: Record<string, unknown>, submitted: boolean, signal?: AbortSignal) {
    const endpoint = serviceFor(config);
    const credential = parseCredential(key);
    if (signal?.aborted) return invalid("Tencent media request was cancelled before submission.");
    const body = JSON.stringify(bodyInput);
    let headers: Record<string, string>;
    try {
      headers = await signer({ service: endpoint.service, host: endpoint.host, version: endpoint.version, region: endpoint.config.options?.region ?? "ap-guangzhou", action, body, timestamp: Math.floor((options.now?.() ?? Date.now()) / 1000) }, credential);
    } catch { return invalid("Tencent request signing failed."); }
    if (signal?.aborted) return invalid("Tencent media request was cancelled before submission.");
    let response: Response;
    try { response = await fetcher(endpoint.url, { method: "POST", body, headers, redirect: "manual", signal: signalFor(signal) }); }
    catch { throw new MediaProviderError("Tencent request could not be completed; reconcile before retrying.", submitted ? "unknown" : "not-submitted"); }
    if (!response.ok) {
      await response.body?.cancel();
      const definite = response.status >= 400 && response.status < 500 && response.status !== 408;
      throw new MediaProviderError(`Tencent API request failed (HTTP ${response.status}).`, submitted ? definite ? "rejected" : "unknown" : "not-submitted", response.status);
    }
    let data: Record<string, unknown>;
    try { data = record(record(JSON.parse(new TextDecoder().decode(await bytes(response, 2 * 1024 * 1024)))).Response); }
    catch { throw new MediaProviderError("Tencent returned an unreadable response; reconcile before retrying.", submitted ? "unknown" : "not-submitted"); }
    if (data.Error !== undefined) {
      const code = text(record(data.Error).Code) ?? "";
      // Only documented pre-execution rejection families establish no task was created.
      const definite = /^(AuthFailure|InvalidParameter|InvalidParameterValue|MissingParameter|UnauthorizedOperation|OperationDenied|RequestLimitExceeded|ResourceUnavailable)(\.|$)/.test(code);
      throw new MediaProviderError("Tencent API rejected or could not complete the request.", submitted ? definite ? "rejected" : "unknown" : /JobNotExist|TaskNotExist/.test(code) ? "unknown" : "not-submitted");
    }
    return data;
  }
  return {
    async submit(configInput: TencentMediaProviderConfig, key: string | TencentCredential, requestInput: MediaGenerationRequest, signal?: AbortSignal): Promise<MediaSubmission> {
      const { config, request } = validateTencentMediaInput(configInput, requestInput);
      const settings = config.options;
      const refs = request.references ?? [];
      const image = request.kind === "image";
      const first = refs[0];
      const body = compact({ Prompt: request.prompt, LogoAdd: settings?.watermark === undefined ? undefined : Number(settings.watermark), ...(image ? {
        Resolution: request.width === undefined ? undefined : `${request.width}:${request.height}`, Images: refs.length ? refs.map(ref => "url" in ref ? ref.url : ref.base64) : undefined,
        Seed: settings?.seed, Revise: settings?.promptExtend === undefined ? undefined : Number(settings.promptExtend),
      } : { Image: first ? "url" in first ? { Url: first.url } : { Base64: first.base64 } : undefined, Resolution: settings?.resolution }) });
      const data = await call(config, key, image ? "SubmitTextToImageJob" : "SubmitHunyuanToVideoJob", body, true, signal);
      const id = text(data.JobId);
      if (!id || !/^[a-zA-Z0-9_-]{1,512}$/.test(id)) throw new MediaProviderError("Tencent submission has no valid task ID; reconcile before retrying.", "unknown");
      return { status: "running", remoteId: id };
    },
    async poll(config: TencentMediaProviderConfig, key: string | TencentCredential, remoteId: string, signal?: AbortSignal): Promise<MediaPollResult> {
      const image = serviceFor(config).service === "aiart";
      if (!/^[a-zA-Z0-9_-]{1,512}$/.test(remoteId)) invalid("Invalid Tencent remote task ID.");
      const data = await call(config, key, image ? "QueryTextToImageJob" : "DescribeHunyuanToVideoJob", { JobId: remoteId }, false, signal);
      if (data.JobId !== undefined && data.JobId !== remoteId) invalid("Tencent returned a different task ID.");
      const status = image ? data.JobStatusCode : data.Status;
      if ((image ? ["1", "2"] : ["WAIT", "RUN"]).includes(String(status))) return { status: "running", remoteId };
      if (status === (image ? "4" : "FAIL")) return { status: "failed", message: "Tencent media generation failed." };
      if (status !== (image ? "5" : "DONE")) throw new MediaProviderError("Tencent task state is unknown; do not automatically resubmit.", "unknown");
      const url = image ? text(Array.isArray(data.ResultImage) ? data.ResultImage[0] : undefined) : text(data.ResultVideoUrl);
      if (!url) invalid("Tencent completed the task without a usable output URL.");
      if (image && Array.isArray(data.ResultDetails) && data.ResultDetails[0] !== "Success") return { status: "failed", message: "Tencent media generation failed." };
      const safe = httpsUrl(url!);
      const path = new URL(safe).pathname.toLowerCase();
      const mimeType = image ? path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp" : "image/jpeg" : "video/mp4";
      return { status: "succeeded", output: { url: safe, mimeType } };
    },
    async download(config: TencentMediaProviderConfig, _key: string | TencentCredential, outputInput: MediaOutput, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }> {
      serviceFor(config);
      const parsed = MediaOutput.safeParse(outputInput);
      if (!parsed.success || !("url" in parsed.data) || parsed.data.requiresAuth) return invalid("Tencent outputs require an unauthenticated HTTPS download URL.");
      const output = parsed.data;
      let url = httpsUrl(output.url);
      try {
        const boundedSignal = signalFor(signal);
        for (let hop = 0; hop <= 5; hop++) {
          const response = await fetcher(url, { method: "GET", redirect: "manual", signal: boundedSignal });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("Location"); await response.body?.cancel();
            if (!location) return invalid("Tencent download redirect has no destination.");
            url = httpsUrl(new URL(location, url).href); continue;
          }
          if (!response.ok) { await response.body?.cancel(); throw new MediaProviderError(`Tencent media download failed (HTTP ${response.status}).`, "not-submitted", response.status); }
          const rawType = response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
          const mimeType = !rawType || rawType === "application/octet-stream" ? output.mimeType : rawType;
          const allowed = output.mimeType.startsWith("image/") ? ["image/png", "image/jpeg", "image/webp"] : ["video/mp4"];
          if (!allowed.includes(mimeType)) { await response.body?.cancel(); return invalid("Tencent download returned an unexpected media type."); }
          const value = await bytes(response, maxBytes);
          if (!value.length) return invalid("Tencent download returned an empty file.");
          return { bytes: value, mimeType };
        }
        return invalid("Too many Tencent media download redirects.");
      } catch (error) { if (error instanceof MediaProviderError) throw error; throw new MediaProviderError("Tencent media download could not be completed.", "not-submitted"); }
    },
  };
}
