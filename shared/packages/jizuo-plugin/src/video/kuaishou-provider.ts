import { Buffer } from "node:buffer";
import { getMediaInputCapabilityError } from "../../../contracts/src/media-input-capabilities.ts";
import { MediaGenerationRequest, MediaOutput, MediaProviderConfig, type MediaPollResult, type MediaReferenceImage, type MediaSubmission } from "../../../contracts/src/media.ts";
import { MediaProviderError } from "./provider-error.ts";

/** The mainland China endpoint documented by the Kling Open Platform. */
export const KLING_API_ORIGIN = "https://api-beijing.klingai.com";
const TASK_ID = /^[a-zA-Z0-9_-]{1,512}$/;
const TERMINAL_FAILURES = new Set(["failed", "canceled", "cancelled", "expired"]);
const PENDING_STATUSES = new Set(["submitted", "queued", "pending", "processing", "running", "in_progress"]);

export type KuaishouCredential = { accessKey: string; secretKey: string };
export type KlingCredential = KuaishouCredential;
type KuaishouConfig = Extract<MediaProviderConfig, { protocol: "kuaishou" }>;
type JsonRecord = Record<string, unknown>;
type KuaishouProviderOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxDownloadBytes?: number;
  /** Injectable clock for deterministic JWT tests. Returns milliseconds since epoch. */
  now?: () => number;
};

const record = (value: unknown): JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const invalid = (message: string): never => { throw new MediaProviderError(message, "not-submitted"); };

function parseCredential(raw: string | KuaishouCredential): KuaishouCredential {
  if (typeof raw !== "string") {
    const accessKey = text(record(raw).accessKey);
    const secretKey = text(record(raw).secretKey);
    if (accessKey && secretKey && !/[\r\n]/.test(accessKey) && !/[\r\n]/.test(secretKey)) return { accessKey, secretKey };
    return invalid("A valid Kling access key and secret key are required.");
  }
  if (!raw.trim() || /[\r\n]/.test(raw)) invalid("A valid Kling access key and secret key are required.");
  const value = raw.trim();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = undefined; }
  const object = record(parsed);
  const accessKey = text(object.accessKey) ?? text(object.access_key);
  const secretKey = text(object.secretKey) ?? text(object.secret_key);
  if (accessKey && secretKey) return { accessKey, secretKey };

  // Credential stores may use a compact value when JSON is inconvenient.
  const separator = value.indexOf(":");
  if (separator > 0 && separator < value.length - 1) {
    const compactAccessKey = value.slice(0, separator).trim();
    const compactSecretKey = value.slice(separator + 1).trim();
    if (compactAccessKey && compactSecretKey && !/[\r\n]/.test(compactSecretKey)) return { accessKey: compactAccessKey, secretKey: compactSecretKey };
  }
  return invalid("Kling credentials must be JSON {accessKey,secretKey} or accessKey:secretKey.");
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function utf8(value: string): Uint8Array { return new TextEncoder().encode(value); }

/** Build the short-lived HS256 token required by the official Kling API. */
export async function createKlingJwt(credential: KuaishouCredential, now = Date.now()): Promise<string> {
  const header = base64Url(utf8(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const seconds = Math.floor(now / 1000);
  const payload = base64Url(utf8(JSON.stringify({ iss: credential.accessKey, exp: seconds + 1800, nbf: seconds - 5 })));
  const signingInput = `${header}.${payload}`;
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new MediaProviderError("Web Crypto is required to sign Kling requests.", "not-submitted");
  try {
    const key = await cryptoApi.subtle.importKey("raw", Buffer.from(credential.secretKey, "utf8"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await cryptoApi.subtle.sign("HMAC", key, Buffer.from(signingInput, "utf8"));
    return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
  } catch {
    throw new MediaProviderError("Kling request signing failed.", "not-submitted");
  }
}

function baseUrl(config: MediaProviderConfig): string {
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { return invalid("Invalid Kling API base URL."); }
  if (url.origin !== KLING_API_ORIGIN || url.username || url.password || url.search || url.hash) {
    return invalid("Kling API requests must use the official api-beijing.klingai.com HTTPS endpoint.");
  }
  return url.href.replace(/\/+$/, "");
}

function parseKuaishouConfig(input: MediaProviderConfig): KuaishouConfig {
  let config: MediaProviderConfig;
  try { config = MediaProviderConfig.parse(input); } catch { return invalid("Invalid Kling media configuration."); }
  if (config.protocol !== "kuaishou") return invalid("Kling provider requires the kuaishou protocol.");
  return config;
}

function parseGenerationRequest(input: MediaGenerationRequest): MediaGenerationRequest {
  try { return MediaGenerationRequest.parse(input); }
  catch { return invalid("Invalid Kling media configuration or generation input."); }
}

function parseMediaOutput(input: MediaOutput): MediaOutput {
  try { return MediaOutput.parse(input); }
  catch { return invalid("Invalid Kling media output."); }
}

function referenceData(reference: MediaReferenceImage): string {
  return "url" in reference ? reference.url : `data:${reference.mimeType};base64,${reference.base64}`;
}

function requestAspectRatio(request: MediaGenerationRequest): string | undefined {
  if (request.aspectRatio) return request.aspectRatio;
  if (request.width === undefined || request.height === undefined) return undefined;
  const ratio = request.width / request.height;
  const candidates: Array<[string, number]> = [["16:9", 16 / 9], ["9:16", 9 / 16], ["1:1", 1], ["4:3", 4 / 3], ["3:4", 3 / 4], ["21:9", 21 / 9]];
  return candidates.find(([, value]) => Math.abs(value - ratio) < 0.01)?.[0];
}

function modeFor(config: KuaishouConfig, request?: Pick<MediaGenerationRequest, "kind" | "references">): "text-to-video" | "image-to-video" | "text-to-image" {
  const configured = config.options?.mode;
  if (configured) return configured;
  if (request?.kind === "image" || config.model.startsWith("kling-image")) return "text-to-image";
  return request?.references?.length ? "image-to-video" : "text-to-video";
}

/** Legacy tasks may omit their operation; infer it only from the already-frozen request. */
export function resolveKuaishouTaskConfig(config: MediaProviderConfig, request: Pick<MediaGenerationRequest, "kind" | "references">): MediaProviderConfig {
  if (config.protocol !== "kuaishou" || config.options?.mode) return config;
  return { ...config, options: { ...config.options, mode: modeFor(config, request) } };
}

/** Validate the provider-specific operation before a paid submission is created. */
export function validateKuaishouMediaInput(configInput: MediaProviderConfig, requestInput: MediaGenerationRequest): void {
  const config = parseKuaishouConfig(configInput);
  const request = parseGenerationRequest(requestInput);
  baseUrl(config);
  const refs = request.references ?? [];
  const capabilityError = getMediaInputCapabilityError(config, request);
  if (capabilityError) invalid(capabilityError);
  const mode = modeFor(config, request);
  if (mode === "image-to-video" && !refs.length) invalid("Kling image-to-video requires a reference image.");
  if (mode !== "text-to-image" && request.kind !== "video") invalid("Kling video modes require a video request.");
  if (mode === "text-to-image" && request.kind !== "image") invalid("Kling text-to-image requires an image request.");
  if (mode === "image-to-video" && refs.length > 2) invalid("Kling image-to-video supports at most a first and last frame.");
  if (mode === "text-to-image" && refs.length > 1) invalid("This Kling image adapter supports one reference image.");
  if (request.width !== undefined && !requestAspectRatio(request)) invalid("Kling supports 16:9, 9:16, 1:1, 4:3, 3:4 and 21:9 image or video ratios.");
}

function responseError(data: JsonRecord, submitted: boolean): void {
  const code = data.code;
  if (code !== undefined && code !== 0 && code !== "0" && code !== "success") {
    throw new MediaProviderError(submitted ? "Kling rejected the generation request. Check the model, inputs and host credentials." : "Kling task query failed. Check host credentials and retry polling the existing task.", submitted ? "rejected" : "not-submitted");
  }
}

function taskData(data: JsonRecord): JsonRecord {
  return record(data.data);
}

function taskId(data: JsonRecord): string | undefined {
  return text(data.task_id) ?? text(taskData(data).task_id) ?? text(data.id);
}

function outputFromTask(data: JsonRecord, kind: "image" | "video"): MediaOutput | undefined {
  const root = taskData(data);
  const result = record(root.task_result);
  const candidates = kind === "video" ? list(result.videos) : list(result.images);
  const first = record(candidates[0]);
  const url = text(first.url) ?? text(root.url) ?? text(data.url);
  if (url) {
    const parsed = MediaOutput.safeParse({ url, mimeType: kind === "video" ? "video/mp4" : "image/png" });
    if (parsed.success) return parsed.data;
  }
  const base64 = text(first.b64_json) ?? text(first.base64);
  if (base64) {
    const parsed = MediaOutput.safeParse({ base64, mimeType: kind === "video" ? "video/mp4" : "image/png" });
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function parseTask(config: KuaishouConfig, data: JsonRecord, submitted: boolean, remoteId?: string): MediaPollResult {
  responseError(data, submitted);
  const mode = modeFor(config);
  const kind = mode === "text-to-image" ? "image" : "video";
  const id = taskId(data);
  if (remoteId && id && id !== remoteId) throw new MediaProviderError("Media query returned a different task ID.", "not-submitted");
  const root = taskData(data);
  const rawStatus = text(root.task_status) ?? text(data.task_status) ?? text(data.status);
  const status = rawStatus?.toLowerCase();
  if (status && TERMINAL_FAILURES.has(status)) {
    if (submitted) throw new MediaProviderError("Kling generation failed or was cancelled.", "rejected");
    return { status: "failed", message: "Kling generation failed or was cancelled." };
  }
  if (status === "unknown") throw new MediaProviderError("The Kling task is unknown or expired; do not automatically resubmit.", "unknown");
  const output = outputFromTask(data, kind);
  if (output) return { status: "succeeded", output };
  if (id && TASK_ID.test(id) && (!status || PENDING_STATUSES.has(status))) return { status: "running", remoteId: id };
  throw new MediaProviderError("Kling response has no recognized task or output; reconcile before retrying.", submitted ? "unknown" : "not-submitted");
}

export function createKuaishouMediaProvider(options: KuaishouProviderOptions = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const maxBytes = options.maxDownloadBytes ?? 256 * 1024 * 1024;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) invalid("Invalid Kling media transfer limits.");
  const signalFor = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

  async function json(config: MediaProviderConfig, credential: KuaishouCredential, path: string, body: JsonRecord | undefined, submitted: boolean, signal?: AbortSignal): Promise<JsonRecord> {
    if (signal?.aborted) invalid("Kling media request was cancelled before it started.");
    const target = `${baseUrl(config)}${path}`;
    const token = await createKlingJwt(credential, now());
    let response: Response;
    try {
      response = await fetcher(target, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
        signal: signalFor(signal),
      });
    } catch {
      throw new MediaProviderError(submitted ? "Kling submission result is unknown; reconcile before retrying." : "Kling task query could not be completed.", submitted ? "unknown" : "not-submitted");
    }
    if (!response.ok) {
      await response.body?.cancel();
      const definite = response.status >= 400 && response.status < 500 && response.status !== 408;
      throw new MediaProviderError(`Kling API request failed (HTTP ${response.status}).`, submitted ? (definite ? "rejected" : "unknown") : "not-submitted", response.status);
    }
    try {
      const raw = await response.text();
      if (raw.length > 100_000_000) throw new Error("response too large");
      return record(JSON.parse(raw));
    } catch {
      throw new MediaProviderError(submitted ? "Kling returned an unreadable submission response; reconcile before retrying." : "Kling returned an unreadable task response.", submitted ? "unknown" : "not-submitted");
    }
  }

  async function readBytes(response: Response): Promise<Uint8Array> {
    const declared = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel(); invalid("Kling media response exceeds the configured size limit."); }
    const body = response.body;
    if (!body) invalid("Kling media response was empty.");
    const stream = body!.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await stream.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) { await stream.cancel(); invalid("Kling media response exceeds the configured size limit."); }
        chunks.push(next.value);
      }
    } finally { stream.releaseLock(); }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }

  return {
    async submit(configInput: MediaProviderConfig, key: string | KuaishouCredential, requestInput: MediaGenerationRequest, signal?: AbortSignal): Promise<MediaSubmission> {
      const config = parseKuaishouConfig(configInput);
      const request = parseGenerationRequest(requestInput);
      validateKuaishouMediaInput(config, request);
      const credential = parseCredential(key);
      const refs = request.references ?? [];
      const mode = modeFor(config, request);
      const body: JsonRecord = { model_name: config.options?.modelName ?? config.model, prompt: request.prompt };
      const ratio = requestAspectRatio(request);
      if (ratio) body.aspect_ratio = ratio;
      if (mode === "text-to-image") {
        body.n = 1;
        if (refs[0]) body.image = referenceData(refs[0]);
      } else {
        body.duration = String(request.durationSeconds ?? 5);
        const first = refs.find(ref => ref.role === "first_frame") ?? refs[0];
        const last = refs.find(ref => ref.role === "last_frame") ?? refs[1];
        body.mode = last || config.options?.resolution === "1080p" ? "pro" : "std";
        if (first) body.image = referenceData(first);
        if (last) body.image_tail = referenceData(last);
      }
      const path = mode === "text-to-image" ? "/v1/images/generations" : mode === "image-to-video" ? "/v1/videos/image2video" : "/v1/videos/text2video";
      const data = await json(config, credential, path, body, true, signal);
      return parseTask(config, data, true) as MediaSubmission;
    },
    async poll(configInput: MediaProviderConfig, key: string | KuaishouCredential, remoteId: string, signal?: AbortSignal): Promise<MediaPollResult> {
      const config = parseKuaishouConfig(configInput);
      if (!TASK_ID.test(remoteId)) invalid("Invalid remote Kling media task ID.");
      const mode = modeFor(config);
      const path = mode === "text-to-image" ? `/v1/images/generations/${encodeURIComponent(remoteId)}` : mode === "image-to-video" ? `/v1/videos/image2video/${encodeURIComponent(remoteId)}` : `/v1/videos/text2video/${encodeURIComponent(remoteId)}`;
      const data = await json(config, parseCredential(key), path, undefined, false, signal);
      return parseTask(config, data, false, remoteId);
    },
    async download(configInput: MediaProviderConfig, _key: string | KuaishouCredential, outputInput: MediaOutput, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }> {
      const config = parseKuaishouConfig(configInput);
      const output = parseMediaOutput(outputInput);
      if ("base64" in output) {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(output.base64)) invalid("Invalid Kling media base64 output.");
        const bytes = Buffer.from(output.base64, "base64");
        if (!bytes.length || bytes.length > maxBytes) invalid("Kling media output exceeds the configured size limit or is empty.");
        return { bytes, mimeType: output.mimeType };
      }
      let url: URL;
      try { url = new URL(output.url); } catch { return invalid("Invalid Kling media URL."); }
      if (url.protocol !== "https:" || url.username || url.password || url.hash) invalid("Kling media downloads require an HTTPS URL.");
      if (signal?.aborted) invalid("Kling media download was cancelled before it started.");
      let response: Response;
      try { response = await fetcher(url.href, { method: "GET", redirect: "manual", signal: signalFor(signal) }); }
      catch { throw new MediaProviderError("Kling media download could not be completed.", "not-submitted"); }
      if (!response.ok) { await response.body?.cancel(); throw new MediaProviderError(`Kling media download failed (HTTP ${response.status}).`, "not-submitted", response.status); }
      const bytes = await readBytes(response);
      const responseType = response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
      const mimeType = responseType && responseType !== "application/octet-stream" ? responseType : output.mimeType;
      if (!["image/png", "image/jpeg", "image/webp", "video/mp4"].includes(mimeType)) invalid("Kling download did not return a supported media file.");
      if (!bytes.length) invalid("Kling download returned an empty media file.");
      return { bytes, mimeType };
    },
  };
}

export const createKlingMediaProvider = createKuaishouMediaProvider;
export type KuaishouMediaProvider = ReturnType<typeof createKuaishouMediaProvider>;
