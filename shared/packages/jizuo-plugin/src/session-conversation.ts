import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";

/** Declare the dependency inside the target session, preserving its session scope. */
export async function sendToSessionConversation(ctx: Context, text: string): Promise<void> {
  let sending: Promise<void> | undefined;
  const fiber = ctx.inject(["conversation"], scope => {
    // A dependency reload must never submit the same request twice.
    sending ??= Promise.resolve().then(() => scope.conversation.send(text));
    // Loading the injection and awaiting admission happen separately.
    void sending.catch(() => {});
  });
  try {
    await fiber;
    if (!sending) throw new Error("作品对话尚未就绪，请重试");
    await sending;
  } finally {
    await fiber.dispose();
  }
}
