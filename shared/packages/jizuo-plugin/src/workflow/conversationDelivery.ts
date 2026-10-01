import { expandAssistantStream, ToolCallId, MessageId, createToolResultMessage, freezeMessage, type ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import { WorkflowPublicationSchema, type WorkflowPublication, type WorkflowRepository } from "@jizuo/workflow-runtime";
export type { WorkflowPublication } from "@jizuo/workflow-runtime";
type Repository = Pick<WorkflowRepository, "enqueueConversationPublication" | "listConversationPublications" | "getConversationPublication" | "acknowledgeConversationPublication">;

/** Ordinary step lifecycle and outstanding model calls both fence publication.
 * Async chunks/tool activity are log-only and cannot close or replace them. */
export function isWorkflowPublicationSafe(session: Session): boolean {
  const steps = new Set<string>();
  const calls = new Set<string>();
  for (const event of session.snapshotEvents()) {
    const data = event.data as { turn?: number; step?: number };
    if (event.type === "tool/result") calls.delete(String(event.data.message.source.callId));
    if (event.type === "turn/end") {
      for (const key of steps) if (key.startsWith(`${event.data.turn}:`)) steps.delete(key);
    }
    if (typeof data.step !== "number" || data.step >= 1_000_000_000) continue;
    const key = `${data.turn}:${data.step}`;
    if (event.type === "step/start") steps.add(key);
    if (event.type === "step/end") steps.delete(key);
    if (event.type === "assistant/message") for (const block of event.data.message.content) {
      if (block.type === "tool-call") calls.add(String(block.id));
    }
  }
  return steps.size === 0 && calls.size === 0;
}

function hasMessage(session: Session, id: string): boolean {
  return session.snapshotEvents().some((event) => event.type === "assistant/message" && event.data.message.id === id);
}

function endStep(session: Session, item: WorkflowPublication): void {
  if (!session.snapshotEvents().some((event) => event.type === "step/end" && event.data.turn === item.turn && event.data.step === item.step)) {
    session.append("step/end", { turn: item.turn, step: item.step });
  }
}

/** The SQLite outbox owns durability until the real Session store's flush
 * confirms it. All appends run in a microtask, outside session/event dispatch;
 * there are no timers, polling loops, or in-memory-only deferred payloads. */
export function createWorkflowConversationDelivery(options: Readonly<{
  repository: Repository;
  flush?: (session: Session) => Promise<boolean>;
}>) {
  const running = new WeakMap<Session, Promise<void>>();
  const requested = new WeakSet<Session>();
  let disposed = false;

  function append(item: WorkflowPublication, session: Session): "delivered" | "superseded" {
    const { turn, step } = item;
    if (!hasMessage(session, item.messageId)) {
      const content = item.kind === "text" ? [{ type: "text" as const, text: item.text }]
        : [{ type: "tool-call" as const, id: ToolCallId(item.callId), name: item.name, arguments: item.arguments }];
      const stream = session.snapshotEvents().flatMap((event) => event.type === "assistant/attempt" && event.data.turn === turn && event.data.step === step ? expandAssistantStream(event.data.stream).map(record => ({...record,type:"chunk" as const})).filter(record => (record.chunk.type === "text-delta" || record.chunk.type === "finish" || record.chunk.type === "block-start" && record.chunk.blockType === "text" || record.chunk.type === "block-end" && record.chunk.block.type === "text")) : []);
      // A non-streamed result still has an execution clock. Keep it in the
      // native stream so footer replay uses completion, not outbox delivery.
      if (stream.length === 0 && item.completedAt !== undefined) stream.push({
        type: "chunk", time: item.completedAt, chunk: { type: "finish", reason: { kind: "stop" } },
      });
      session.append("assistant/message", { turn, step, stream,
        message: freezeMessage({ id: MessageId(item.messageId), role: "assistant", content, source: { kind: "model", provider: "即作工作流", model: item.model } }),
        ...(item.kind === "text" && item.interrupted ? { interrupted: true as const } : {}),
      }, { surfaceOp: "append" });
    }
    let disposition: "delivered" | "superseded" = "delivered";
    if (item.kind === "tool") {
      const existing = session.snapshotEvents().find((event) => event.type === "tool/result" && event.data.message.source.callId === item.callId);
      if (existing?.type === "tool/result" && (existing.data.error?.code === "TOOL_NOT_STARTED" || existing.data.error?.code === "TOOL_OUTCOME_UNKNOWN")) {
        // Native crash repair owns this result identity. Preserve its uncertainty
        // card; an ordinary idempotent notice carries the saved public outcome.
        const noticeId = `${item.messageId}-recovered`;
        if (!hasMessage(session, noticeId)) session.append("assistant/message", { turn, step, stream: [],
          message: freezeMessage({ id: MessageId(noticeId), role: "assistant", content: [{ type: "text", text:
            `恢复的工具公开输出（原工具卡保留中断状态）：\n\n${item.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n") || "已保存非文本公开结果。"}` }],
          source: { kind: "model", provider: "即作工作流", model: item.model } }),
        }, { surfaceOp: "append" });
        disposition = "superseded";
      } else if (!existing) {
        const call = session.snapshotEvents().find((event) => event.type === "tool/call" && event.data.callId === item.callId)
          ?? session.append("tool/call", { turn, step, callId: ToolCallId(item.callId), name: item.name, arguments: item.arguments });
        const result = createToolResultMessage({ callId: ToolCallId(item.callId), content: item.content as ContentBlock[], isError: item.isError });
        session.append("tool/result", { turn, step, message: freezeMessage({ ...result, id: MessageId(`${item.callId}-result`) }),
          ...(item.error ? { error: item.error } : {}),
        }, { surfaceOp: "append", sourceEventSeqs: [call.seq] });
      }
    }
    endStep(session, item);
    return disposition;
  }

  function drain(session: Session): Promise<void> {
    if (disposed) return Promise.resolve();
    requested.add(session);
    const prior = running.get(session);
    if (prior) return prior;
    const task = Promise.resolve().then(async () => {
      try {
        do {
          requested.delete(session);
          if (disposed || !isWorkflowPublicationSafe(session)) return;
          const appended = options.repository.listConversationPublications(String(session.id)).map((row) => {
            const item = WorkflowPublicationSchema.parse(JSON.parse(row.payloadJson));
            return { row, disposition: append(item, session) };
          });
          if (!appended.length) return;
          // Capture this batch before awaiting. New parent steps or publications
          // may begin during the flush; the loop rechecks safety before any append.
          const durable = await options.flush?.(session);
          if (disposed) return;
          if (durable === true) for (const { row, disposition } of appended) {
            options.repository.acknowledgeConversationPublication(String(session.id), row.publicationId, disposition);
          }
        } while (requested.has(session));
      } catch { /* Retain the durable queue on persistence/publication failure. */ }
      finally { running.delete(session); }
    });
    running.set(session, task);
    return task;
  }

  return Object.freeze({
    enqueue(session: Session, runId: string, input: WorkflowPublication): void {
      if (disposed) return;
      const parsed = WorkflowPublicationSchema.parse(input);
      const previous = options.repository.getConversationPublication(String(session.id), parsed.messageId);
      const completedAt = parsed.completedAt ?? (previous
        ? WorkflowPublicationSchema.parse(JSON.parse(previous.payloadJson)).completedAt : Date.now());
      const item = completedAt === undefined ? parsed : WorkflowPublicationSchema.parse({ ...parsed, completedAt });
      options.repository.enqueueConversationPublication({ runId, sessionId: String(session.id), publicationId: item.messageId, payloadJson: JSON.stringify(item) });
      // Tool activity is immediately visible in the native tool renderer without
      // a surface message or step/start, even while the parent's tool is pending.
      if (item.kind === "tool" && !session.snapshotEvents().some((event) => event.type === "tool/call" && event.data.callId === item.callId)) {
        session.append("tool/call", { turn: item.turn, step: item.step, callId: ToolCallId(item.callId), name: item.name, arguments: item.arguments });
      }
      void drain(session);
    },
    pending: (session: Session) => options.repository.listConversationPublications(String(session.id)).map((row) => WorkflowPublicationSchema.parse(JSON.parse(row.payloadJson))),
    drain,
    dispose: () => { disposed = true; },
  });
}
export type WorkflowConversationDelivery = ReturnType<typeof createWorkflowConversationDelivery>;
