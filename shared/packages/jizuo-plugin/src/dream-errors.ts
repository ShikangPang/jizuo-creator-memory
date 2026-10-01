import type { LlmFailure } from "@deepseek-ai/dsh-llm";

export const DREAM_RETRY_DELAY_MS = 10 * 60_000;

/** Only safe, actionable summaries cross the progress-report boundary. */
export class DreamProcessingError extends Error {
  constructor(message: string, readonly scope: "chapter" | "work", readonly retryAfterMs = DREAM_RETRY_DELAY_MS) {
    super(message);
    this.name = "DreamProcessingError";
  }
}

export class DreamCapacityError extends DreamProcessingError {
  constructor(readonly capacityState: "exceeded" | "unknown") {
    super(capacityState === "exceeded" ? "完整章节与提示词、输出预留超过所选模型上下文容量，已跳过本章。" : "无法确认所选模型上下文容量，已跳过本章；请配置模型容量后重试。", "chapter");
  }
}
function isContextLimit(value: { code?: unknown; message?: unknown }): boolean {
  return /context[_ -]?(?:length|window|limit)|max(?:imum)?[_ -]?context|prompt.{0,25}too long|too many (?:input )?tokens|上下文.{0,10}(?:超|限)/i.test(`${String(value.code ?? "")} ${String(value.message ?? "")}`);
}
export function dreamProviderError(failure: Pick<LlmFailure, "code" | "status" | "providerRetryAfterMs"> & { message?: string }): DreamProcessingError {
  if (isContextLimit(failure)) return new DreamCapacityError("exceeded");
  const delay = failure.providerRetryAfterMs;
  const retryAfterMs = typeof delay === "number" && Number.isFinite(delay) && delay > 0
    ? Math.max(DREAM_RETRY_DELAY_MS, Math.min(delay, 24 * 60 * 60_000)) : DREAM_RETRY_DELAY_MS;
  const message = failure.status === 401 || failure.status === 403 || failure.code === "AUTH"
    ? "模型服务拒绝访问，请检查该服务方的凭据和模型权限。"
    : failure.status === 429 || failure.code === "RATE_LIMIT"
      ? "模型服务限流，已暂停本作品请求，稍后重试。"
      : failure.code === "TIMEOUT" ? "模型请求超时，已暂停本作品请求，稍后重试。"
        : failure.code === "NETWORK" ? "无法连接模型服务，请检查网络后重试。"
          : "模型服务请求失败，已暂停本作品请求，请检查服务状态后重试。";
  return new DreamProcessingError(message, "work", retryAfterMs);
}

export function describeDreamError(error: unknown): DreamProcessingError {
  if (error instanceof DreamProcessingError) return error;
  if (error instanceof SyntaxError) return new DreamProcessingError("模型返回的记忆不是有效 JSON，本章稍后重试。", "chapter");
  if (typeof error === "object" && error !== null) {
    const value = error as { code?: unknown; message?: unknown; failure?: LlmFailure };
    if (isContextLimit(value)) return new DreamCapacityError("exceeded");
    if (value.failure && typeof value.failure.code === "string") return dreamProviderError(value.failure);
    if (["AUTH", "RATE_LIMIT", "NETWORK", "TIMEOUT"].includes(String(value.code))) return dreamProviderError({ code: String(value.code) });
    if (value.code === "validation_error" || value.code === "revision_conflict") return new DreamProcessingError("本章记忆与当前正文不一致或证据校验未通过，请检查正文后重试。", "chapter");
    if (["EACCES", "EPERM", "ENOSPC", "EROFS"].includes(String(value.code))) return new DreamProcessingError("作品目录无法写入，请检查目录权限和剩余磁盘空间。", "work");
  }
  return new DreamProcessingError("梦境整理未完成。请检查模型、额度和作品目录后重试。", "work");
}
