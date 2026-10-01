import { randomUUID } from "node:crypto";

type Message = { dream: 1; kind: "call" | "result" | "error" | "cancel" | "event"; id: string; method?: string; value?: unknown; name?: string; details?: Record<string, unknown> };
function errorDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return {};
  const value = error as Record<string, unknown>;
  const details: Record<string, unknown> = {};
  if (typeof value.code === "string") details.code = value.code;
  if (value.failure && typeof value.failure === "object") {
    const failure = value.failure as Record<string, unknown>;
    details.failure = Object.fromEntries(["code", "status", "message", "providerRetryAfterMs"].flatMap((key) =>
      typeof failure[key] === "string" || typeof failure[key] === "number" ? [[key, failure[key]]] : []));
  }
  return details;
}
export interface DreamIpcTransport {
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "message", listener: (message: unknown) => void): unknown;
}
export type DreamIpcHandler = (method: string, input: any, signal: AbortSignal) => unknown | Promise<unknown>;

/** One IPC channel, independently correlated calls. Pulling stream chunks bounds queued output. */
export class DreamIpcPeer {
  private closed = false;
  private readonly pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; cleanup: () => void }>();
  private readonly incoming = new Map<string, AbortController>();
  constructor(private readonly transport: DreamIpcTransport, private readonly handle: DreamIpcHandler,
    private readonly onEvent: (method: string, value: any) => void = () => {}) { transport.on("message", this.receive); }
  private send(message: Message): void {
    if (this.closed) throw new Error("梦境后台进程已断开");
    this.transport.send(message, (error) => { if (error) this.close(error); });
  }
  event(method: string, value?: unknown): void {
    if (!this.closed) this.send({ dream: 1, kind: "event", id: "", method, value });
  }
  call<T>(method: string, value?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("梦境后台进程已断开"));
    options.signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const cancel = (error: Error) => {
        if (!this.pending.delete(id)) return;
        cleanup(); reject(error); this.send({ dream: 1, kind: "cancel", id });
      };
      const abort = () => cancel(new DOMException("梦境请求已取消", "AbortError"));
      const timer = setTimeout(() => cancel(new Error(`梦境后台请求超时（${method}）`)), options.timeoutMs ?? 60_000);
      timer.unref?.();
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
      options.signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup });
      try { this.send({ dream: 1, kind: "call", id, method, value }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }
  close(error = new Error("梦境后台进程已断开")): void {
    if (this.closed) return; this.closed = true; this.transport.off("message", this.receive);
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear(); for (const controller of this.incoming.values()) controller.abort(); this.incoming.clear();
  }
  private readonly receive = (raw: unknown): void => {
    if (this.closed || !raw || typeof raw !== "object") return;
    const message = raw as Message;
    if (message.dream !== 1 || typeof message.id !== "string") return;
    if (message.kind === "event") { if (typeof message.method === "string") this.onEvent(message.method, message.value); return; }
    if (message.kind === "cancel") { this.incoming.get(message.id)?.abort(); return; }
    if (message.kind === "result" || message.kind === "error") {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); pending.cleanup();
      if (message.kind === "result") pending.resolve(message.value);
      else { const error = new Error(String(message.value)); error.name = message.name ?? "Error"; Object.assign(error, message.details); pending.reject(error); }
      return;
    }
    if (message.kind !== "call" || typeof message.method !== "string" || this.incoming.has(message.id)) return;
    const controller = new AbortController(); this.incoming.set(message.id, controller);
    void Promise.resolve().then(() => this.handle(message.method!, message.value, controller.signal)).then(
      (value) => { if (!this.closed && !controller.signal.aborted) this.send({ dream: 1, kind: "result", id: message.id, value }); },
      (error: unknown) => { if (!this.closed && !controller.signal.aborted) this.send({ dream: 1, kind: "error", id: message.id, value: error instanceof Error ? error.message : "梦境后台处理失败", name: error instanceof Error ? error.name : "Error", details: errorDetails(error) }); },
    ).catch(() => {}).finally(() => this.incoming.delete(message.id));
  };
}
