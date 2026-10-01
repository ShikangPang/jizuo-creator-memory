import { SpeechProviderConfig, SpeechText } from "../../../contracts/src/video-speech.ts";

export class SpeechProviderError extends Error {
  constructor(message: string, readonly submission: "not-submitted" | "rejected" | "unknown") { super(message); this.name = "SpeechProviderError"; }
}
export type SpeechOutput = { bytes: Uint8Array; mimeType: "audio/wav" | "audio/mpeg" };

/** https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create */
export function createSpeechProvider(options: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {}) {
  const fetcher = options.fetch ?? globalThis.fetch, maxBytes = options.maxBytes ?? 256 * 1024 * 1024, timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid speech transfer limits");
  return {
    async synthesize(raw: SpeechProviderConfig, key: string, rawText: string, signal?: AbortSignal): Promise<SpeechOutput> {
      const parsed = SpeechProviderConfig.safeParse(raw), text = SpeechText.safeParse(rawText);
      if (!parsed.success || !text.success || !key.trim() || /[\r\n]/.test(key) || signal?.aborted) throw new SpeechProviderError("语音配置、文本或凭据无效，或任务已停止", "not-submitted");
      const config = parsed.data, boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await fetcher(`${config.baseUrl.replace(/\/+$/, "")}/audio/speech`, {
          method: "POST", redirect: "manual", signal: boundedSignal,
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: config.model, input: text.data, voice: config.voice, response_format: "wav", ...(config.speed !== undefined ? { speed: config.speed } : {}) }),
        });
      } catch { throw new SpeechProviderError("语音提交结果未确认，请核对服务方记录，不能自动重复提交", "unknown"); }
      if (!response.ok) {
        await response.body?.cancel();
        throw new SpeechProviderError(`语音请求失败（HTTP ${response.status}）`, response.status >= 400 && response.status < 500 && ![408, 409].includes(response.status) ? "rejected" : "unknown");
      }
      if (Number(response.headers.get("Content-Length")) > maxBytes) { await response.body?.cancel(); throw new SpeechProviderError("语音响应超过大小限制，请核对服务方生成结果", "unknown"); }
      const reader = response.body?.getReader();
      if (!reader) throw new SpeechProviderError("语音响应为空，请核对服务方生成结果", "unknown");
      const chunks: Uint8Array[] = []; let total = 0;
      try {
        while (true) {
          boundedSignal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
          total += value.byteLength;
          if (total > maxBytes) { await reader.cancel(); throw new Error("oversized"); }
          chunks.push(value);
        }
      } catch { throw new SpeechProviderError("语音响应未完整接收，请核对服务方结果，不能自动重复提交", "unknown"); }
      finally { reader.releaseLock(); }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const head = new TextDecoder().decode(bytes.subarray(0, 12));
      const mimeType = head.startsWith("RIFF") && head.slice(8, 12) === "WAVE" ? "audio/wav"
        : head.startsWith("ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) ? "audio/mpeg" : undefined;
      if (!mimeType) throw new SpeechProviderError("语音接口没有返回 WAV 或 MP3 文件，请核对服务方结果", "unknown");
      return { bytes, mimeType };
    },
  };
}
