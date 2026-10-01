/** User feedback is separate from diagnostic data. Never pass request payloads here. */
export type ErrorCategory = "cancelled" | "network" | "timeout" | "auth" | "permission" | "quota" | "conflict" | "validation" | "unknown_result" | "internal";
export interface ErrorContext { operation?: string | undefined; fallback?: string | undefined; effect?: "read" | "write" | undefined }
export interface ErrorFeedback { category: ErrorCategory; message: string; retryable: boolean }
export interface ClientDiagnostic {
  timestamp: string;
  operation: string;
  category: ErrorCategory;
  code: string;
  message: string;
  stack: string;
}
const technical = /client api:|\bjizuo\/|\b(?:TypeError|ReferenceError|SyntaxError|Error):|\bHTTP\s*\d|gateway\/|\bat\s+.*:\d|https?:\/\/|(?:[A-Za-z]:\\|\/(?:Users|home|var|tmp)\/)|SQLSTATE|ENOENT|EACCES|(?:api[_-]?key|token|password|secret|authorization|cookie)\s*[=:]|\bBearer\s|\bsk-|[\r\n]|\{.*\}/i;
function fields(error: unknown): { message: string; code: string; name: string; stack: string } {
  const object = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const string = (value: unknown) => typeof value === "string" ? value : "";
  return { message: typeof error === "string" ? error : string(object.message), code: string(object.code), name: string(object.name), stack: string(object.stack) };
}
function safeBusinessMessage(message: string): boolean {
  return message.length <= 500 && /[\u3400-\u9fff]/.test(message) && !technical.test(message);
}
export function errorFeedback(error: unknown, context: ErrorContext = {}): ErrorFeedback {
  const { message, code, name } = fields(error);
  const text = `${code} ${name} ${message}`;
  const fallback = context.fallback && safeBusinessMessage(context.fallback) ? context.fallback : "操作暂未完成，请核对当前状态。";
  let category: ErrorCategory = "internal";
  let friendly = fallback;
  if (name === "AbortError" || code === "cancelled") { category = "cancelled"; friendly = "操作已取消。"; }
  else if (/media_result_unknown|submission_unknown|submission result|reconcile|结果.*(?:未知|不确定|未确认)|无法确认.*结果/i.test(text)) {
    category = "unknown_result"; friendly = "暂时无法确认处理结果，请先核对任务状态，避免重复提交。";
  } else if (code === "revision_conflict") { category = "conflict"; friendly = "内容已被更新，请先核对最新版本，再处理当前修改。"; }
  else if (/subscription_required|quota_exceeded|insufficient_credits/.test(code)) { category = "quota"; friendly = code === "subscription_required" ? "当前功能需要有效订阅，请查看订阅状态。" : "可用额度不足，请查看余额或额度设置。"; }
  else if (/credential_required|unauthorized|invalid_api_key|session_expired/.test(code) || /\b401\b/.test(text)) { category = "auth"; friendly = "身份验证未通过，请检查登录状态或服务密钥。"; }
  else if (/denied|forbidden/.test(code) || /\b403\b/.test(text)) { category = "permission"; friendly = "服务拒绝了本次请求，请检查账号权限和模型配置。"; }
  else if (/timeout|timed out|超时/i.test(text)) { category = "timeout"; friendly = "请求超时，请检查连接后重试。"; }
  else if (/Load failed|Failed to fetch|fetch failed|network|ECONN|ENOTFOUND|runtime_unavailable|连接失败/i.test(text)) { category = "network"; friendly = "暂时无法连接服务，请检查网络或稍后重试。"; }
  else if (code === "validation_error") { category = "validation"; friendly = "输入内容不符合要求，请检查后再试。"; }
  if (safeBusinessMessage(message) && category !== "cancelled") friendly = message;
  // A transport failure cannot establish whether a write or paid request reached the server.
  if ((category === "network" || category === "timeout") && context.effect !== "read") {
    friendly = `${category === "timeout" ? "请求超时" : "连接失败"}，操作结果尚未确认。请先核对保存结果或任务状态，避免重复提交。`;
  }
  return { category, message: friendly, retryable: context.effect === "read" && ["network", "timeout", "internal"].includes(category) };
}
/** Strip credentials, URL parameters, payloads and local user paths before leaving the UI. */
export function sanitizeDiagnosticText(text: string): string {
  return text.slice(0, 16000)
    .replace(/https?:\/\/[^\s<>"']+/gi, "[URL]")
    .replace(/(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)[^\s)]+/g, "[LOCAL_PATH]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/(["']?(?:[\w-]*(?:token|secret|password|api[_-]?key)|authorization|cookie|prompt|content|prose|excerpt|workText)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\n,;]+)/gi, "$1[REDACTED]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[EMAIL]")
    .slice(0, 4000);
}
type DiagnosticSink = (entry: ClientDiagnostic) => void | Promise<void>;
let sink: DiagnosticSink | undefined;
const recent = new Map<string, number>();
const pending: ClientDiagnostic[] = [];
let draining = false;
async function drain(): Promise<void> {
  if (draining || !sink) return;
  draining = true;
  try {
    while (pending.length && sink) {
      const entry = pending.shift()!;
      try { await sink(entry); }
      catch { console.warn("[jizuo] Diagnostic file unavailable", entry); }
    }
  } finally { draining = false; }
}
export function installDiagnosticSink(next: DiagnosticSink): () => void {
  const previous = sink;
  sink = next;
  void drain();
  return () => { if (sink === next) sink = previous; };
}
export function reportClientError(error: unknown, context: ErrorContext = {}): void {
  const feedback = errorFeedback(error, context);
  if (feedback.category === "cancelled") return;
  const source = fields(error);
  const entry: ClientDiagnostic = {
    timestamp: new Date().toISOString(),
    operation: sanitizeDiagnosticText(context.operation ?? "client").slice(0, 120),
    category: feedback.category,
    code: sanitizeDiagnosticText(source.code).slice(0, 120),
    message: sanitizeDiagnosticText(source.message),
    stack: sanitizeDiagnosticText(source.stack),
  };
  const key = `${entry.operation}:${entry.code}:${entry.message}`;
  const now = Date.now();
  if (now - (recent.get(key) ?? 0) < 30_000) return;
  recent.set(key, now);
  if (recent.size > 200) recent.delete(recent.keys().next().value!);
  if (pending.length >= 100) pending.shift();
  pending.push(entry);
  void drain();
}
export function userErrorMessage(error: unknown, fallback?: string, context: ErrorContext = {}): string {
  reportClientError(error, context);
  return errorFeedback(error, { ...context, fallback }).message;
}
