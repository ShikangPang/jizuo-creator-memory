// Cancel the carrier as well as the wait: abandoned HTTP requests must not
// occupy the WebView's connection pool while retries queue behind them.
export async function readVideoWithTimeout<T>(read: (signal: AbortSignal) => Promise<T>, controller: AbortController): Promise<T> {
  const { signal } = controller;
  signal.throwIfAborted();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const timeout = setTimeout(() => controller.abort(new Error("视频集加载超时，已停止本次读取。")), 15_000);
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => { signal.throwIfAborted(); return read(signal); }),
      cancelled,
    ]);
    signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}
