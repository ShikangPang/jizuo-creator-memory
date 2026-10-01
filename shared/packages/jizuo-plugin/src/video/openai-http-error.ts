type ErrorContext = { credential: string; baseUrl: string; privateText?: readonly string[] | undefined };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hidden = "[已隐藏]";
function privateVariants(value: string): string[] {
  const variants = [value, JSON.stringify(value).slice(1, -1)];
  // A prompt can contain a lone UTF-16 surrogate; diagnostics must not replace the HTTP error.
  try { variants.push(encodeURIComponent(value)); } catch { /* Keep literal and JSON forms. */ }
  return variants;
}

/** Error bodies are untrusted: project only diagnostic fields, never raw JSON or HTML. */
export function openaiHttpError(status: number, headers: Headers, payload: unknown, context: ErrorContext): string {
  const data = record(payload), error = record(data.error);
  const privateValues = [context.credential, context.credential.trim(), context.baseUrl, new URL(context.baseUrl).host,
    ...(context.privateText ?? []).flatMap(value => [value, ...value.split(/\r?\n/).filter(line => line.trim().length >= 8)])]
    .filter(Boolean).flatMap(privateVariants)
    .sort((a, b) => b.length - a.length);
  const redact = (input: string): string => {
    let text = input;
    for (const value of privateValues) text = text.replaceAll(value, hidden);
    return text
      .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, hidden)
      .replace(/\bsk-[a-z0-9_-]+/gi, hidden)
      .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|token|cookie|prompt)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, `$1=${hidden}`)
      .replace(/data:[^\s,]+,[a-z0-9+/_=-]+/gi, hidden)
      .replace(/https?:\/\/[^\s<>"']+/gi, hidden)
      .replace(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, hidden)
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, hidden)
      .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)?/gi, hidden)
      .replace(/[a-z0-9+/_=-]{48,}/gi, hidden);
  };
  const identifier = (value: unknown, max: number): string | undefined => {
    if (typeof value !== "string" || value.length > max || !/^[a-z0-9][a-z0-9_.:-]*$/i.test(value)) return;
    // IDs are not prose: omit them entirely if any redaction is needed.
    return redact(value) === value ? value : undefined;
  };
  const code = identifier(error.code, 96) ?? identifier(data.code, 96) ?? identifier(error.type, 96);
  const requestId = [headers.get("x-request-id"), headers.get("request-id"), headers.get("x-correlation-id"),
    error.request_id, data.request_id, data.requestId].map(value => identifier(value, 128)).find(Boolean);
  const rawMessage = error.message ?? data.message;
  const reason = typeof rawMessage === "string" && rawMessage.length <= 2048 && !/<[^>]+>/.test(rawMessage)
    ? redact(rawMessage).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 320)
    : undefined;
  return [`Media API request failed (HTTP ${status}).`, code && `错误码：${code}`, reason && `原因：${reason}`, requestId && `请求标识：${requestId}`]
    .filter(Boolean).join(" ");
}
