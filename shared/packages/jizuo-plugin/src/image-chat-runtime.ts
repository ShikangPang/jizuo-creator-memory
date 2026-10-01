/** Activity only: image prompts/results stay in the session's durable media jobs. */
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "conversation.chat.media": { kind: "list"; scope: "session" };
  }
}

export interface ImageChatActivitySource {
  isActive(sessionId: string): boolean;
  ensure?(sessionId: string): void | Promise<void>;
  subscribe(listener: (sessionId: string) => void): () => void;
}

/** Answer the maintained native shell bridge without changing text-chat history. */
export function bindImageChatActivity(source: ImageChatActivitySource): () => void {
  const queried = new Set<string>();
  let disposed = false;
  const publish = (sessionId: string) => {
    if (disposed) return;
    window.dispatchEvent(new CustomEvent("jizuo:image-chat-activity", {
      detail: { sessionId, active: source.isActive(sessionId) },
    }));
  };
  const query = (event: Event) => {
    const detail = (event as CustomEvent<{ sessionId?: unknown; active?: boolean }>).detail;
    if (!detail || typeof detail.sessionId !== "string" || !detail.sessionId) return;
    const sessionId = detail.sessionId;
    queried.add(sessionId);
    detail.active = source.isActive(sessionId);
    // The owner reports refresh failures in its card; they must not escape a
    // render-time shell query as an unhandled promise rejection.
    Promise.resolve().then(() => disposed ? undefined : source.ensure?.(sessionId)).catch(() => undefined);
  };
  window.addEventListener("jizuo:image-chat-query", query);
  const stop = source.subscribe(publish);
  return () => {
    disposed = true;
    stop();
    window.removeEventListener("jizuo:image-chat-query", query);
    for (const sessionId of queried) window.dispatchEvent(new CustomEvent("jizuo:image-chat-activity", {
      detail: { sessionId, active: false },
    }));
    queried.clear();
  };
}
