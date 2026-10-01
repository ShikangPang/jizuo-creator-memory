import {appendWorkflowChunk, workflowChunks} from "./harnessStream.ts";
import { createHash } from "node:crypto";

import { ToolCallId, MessageId } from "@deepseek-ai/dsh-llm";
import { SessionId, type Session } from "@deepseek-ai/dsh-session";
import type { WorkflowToolTranscriptEntry, WorkflowTranscriptEntry, WorkflowTranscriptPort } from "@jizuo/workflow-runtime";

import type { WorkflowAgentConversationPort, WorkflowAgentConversationStream } from "./agentAdapter.ts";
import type { WorkflowConversationDelivery, WorkflowPublication } from "./conversationDelivery.ts";
export { createWorkflowConversationDelivery } from "./conversationDelivery.ts";

const labels: Readonly<Record<string, string>> = Object.freeze({
  plan: "章节策划",
  write: "小说写作",
  revise: "正文修订",
  continuity: "连续性审查",
  style: "文风审查",
  "ai-trace": "AI 痕迹审查",
  "extract-memory": "记忆提取",
});

function fingerprint(entry: WorkflowTranscriptEntry): string {
  return createHash("sha256")
    .update(JSON.stringify([entry.runId, entry.nodeId, entry.attempt, entry.status]))
    .digest("hex");
}

function currentTurn(session: Session): number {
  let turn = 1;
  for (const event of session.snapshotEvents()) {
    const data = event.data as { turn?: unknown };
    if (typeof data.turn === "number" && Number.isSafeInteger(data.turn) && data.turn > turn) turn = data.turn;
  }
  return turn;
}

function transcriptText(entry: WorkflowTranscriptEntry, label: string): string {
  const content = entry.status === "failed" ? `执行失败：${entry.content}` : entry.content;
  return `### ${label}\n\n${content}`;
}

function nodeToolCallId(entry: WorkflowToolTranscriptEntry): ReturnType<typeof ToolCallId> {
  const digest = createHash("sha256")
    .update(JSON.stringify([entry.runId, entry.nodeId, entry.attempt, entry.name]))
    .digest("hex");
  return ToolCallId(`jizuo-workflow-node-tool-${digest.slice(0, 32)}`);
}

function appendCompletedTool(session: Session, delivery: WorkflowConversationDelivery, runId: string, input: Readonly<{
  callId: ReturnType<typeof ToolCallId>;
  name: string;
  content: string;
  model: string;
}>): void {
  if (session.snapshotEvents().some((event) => event.type === "tool/call" && event.data.callId === input.callId)) { void delivery.drain(session); return; }
  const turn = currentTurn(session);
  const digest = createHash("sha256").update(input.callId).digest("hex");
  const step = 1_500_000_000 + Number.parseInt(digest.slice(0, 7), 16);
  delivery.enqueue(session, runId, { kind: "tool", turn, step, messageId: `${input.callId}-message`, model: input.model,
    callId: input.callId, name: input.name, arguments: "{}", content: [{ type: "text", text: input.content }], isError: false });
}

/**
 * Publishes workflow model results through Harness' normal assistant-message
 * event path, so the existing chat renderer and durable model history consume
 * exactly the same message. Workflow identifiers never enter visible content.
 */
export function createWorkflowTranscriptPublisher(
  sessions: Readonly<{ get(id: string): Session | undefined }>,
  delivery: WorkflowConversationDelivery,
): WorkflowTranscriptPort {
  return Object.freeze({
    publishesLiveModelOutput: true,
    publish(entry: WorkflowTranscriptEntry) {
      const label = labels[entry.nodeId];
      if (!label) return;
      const session = sessions.get(SessionId(entry.sessionId));
      if (!session) return;
      const hash = fingerprint(entry);
      const messageId = MessageId(`jizuo-workflow-${hash.slice(0, 32)}`);
      if (session.snapshotEvents().some((event) => event.type === "assistant/message" && event.data.message.id === messageId)) return;
      const turn = currentTurn(session);
      // Agent-loop steps start at 1. A deterministic reserved range prevents
      // an async workflow message from colliding with the parent's next step.
      const step = 1_000_000_000 + Number.parseInt(hash.slice(0, 8), 16);
      if (!delivery.pending(session).some((item) => item.messageId === messageId)) {
        const text = transcriptText(entry, label);
        delivery.enqueue(session, entry.runId, { kind: "text", turn, step, messageId, model: label, text });
        appendWorkflowChunk(session, { turn, step, chunk: { type: "block-end", index: 0, block: { type: "text", text } } });
      }
      return delivery.drain(session);
    },
    publishTool(entry: WorkflowToolTranscriptEntry) {
      const session = sessions.get(SessionId(entry.sessionId));
      if (!session) return;
      appendCompletedTool(session, delivery, entry.runId, {
        callId: nodeToolCallId(entry),
        name: entry.name,
        content: entry.content,
        model: labels[entry.nodeId] ?? "章节工作流",
      });
      return delivery.drain(session);
    },
  });
}

function liveMessageId(runId: string, nodeId: string, content: string): ReturnType<typeof MessageId> {
  const digest = createHash("sha256").update(JSON.stringify([runId, nodeId, content])).digest("hex");
  return MessageId(`jizuo-workflow-live-${digest.slice(0, 32)}`);
}

function liveToolCallId(runId: string, nodeId: string, childCallId: string): ReturnType<typeof ToolCallId> {
  const digest = createHash("sha256").update(JSON.stringify([runId, nodeId, childCallId])).digest("hex");
  return ToolCallId(`jizuo-workflow-tool-${digest.slice(0, 32)}`);
}

/** Settle an orphaned public stream from a previous process, not a live writer.
 * Ownership comes from the workflow database's exact initiating session ID;
 * firstLiveSeq is Harness' constructor replay cutoff; inheritedEventCount excludes
 * copied fork history even after the fork starts a workflow of its own.
 * This repairs presentation only: it neither retries nor rolls back domain writes. */
export function repairWorkflowConversation(session: Session, ownerSessionId: string, delivery: WorkflowConversationDelivery, runId: string): void {
  if (session.id !== ownerSessionId || session.firstLiveSeq === 0) return;
  const queued = new Set(delivery.pending(session).map((item) => `${item.turn}:${item.step}`));
  const pending = new Map<string, { turn: number; step: number; blocks: Map<number, string>; final?: Extract<WorkflowPublication, { kind: "text" }> }>();
  for (const event of session.snapshotEvents()) {
    if (!("turn" in event.data) || !("step" in event.data)) continue;
    const { turn, step } = event.data;
    if (typeof turn !== "number" || typeof step !== "number" || !Number.isSafeInteger(step) || step < 1_000_000_000) continue;
    const key = `${turn}:${step}`;
    if (event.seq >= session.firstLiveSeq) { pending.delete(key); continue; }
    if (event.type === "step/end") {
      // Native cold repair may have already closed a pre-upgrade reserved step
      // without synthesizing its public text. Its chunks still need a surface.
      if (pending.get(key)?.final) pending.delete(key);
      continue;
    }
    if (!pending.has(key) && !queued.has(key) && (event.type === "step/start" || event.type === "assistant/attempt" || event.type === "assistant/message") && event.seq >= session.inheritedEventCount) {
      pending.set(key, { turn, step, blocks: new Map() });
    }
    const item = pending.get(key);
    if (!item) continue;
    if (event.type === "assistant/message") item.final = { kind: "text", turn, step, messageId: String(event.data.message.id), model: "恢复的部分输出", completedAt: event.time,
      text: event.data.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n"), interrupted: true };
    for (const chunk of workflowChunks(event)) {
      if (chunk.type === "text-delta") {
        item.blocks.set(chunk.index, (item.blocks.get(chunk.index) ?? "") + chunk.text);
      } else if (chunk.type === "block-end" && chunk.block.type === "text") {
        item.blocks.set(chunk.index, chunk.block.text);
      }
    }
  }
  for (const item of pending.values()) {
    const { turn, step } = item;
    const content = [...item.blocks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join("\n");
    if (item.final || content.trim() !== "") delivery.enqueue(session, runId, item.final ?? {
      kind: "text", turn, step, messageId: `jizuo-workflow-recovered-${turn}-${step}`, text: content, model: "恢复的部分输出", interrupted: true,
    });
  }
  void delivery.drain(session);
}

/**
 * Mirrors public child Agent text and completed tool activity into the
 * initiating conversation. Graph status remains in its own projection; child
 * scratch reasoning never enters the normal assistant transcript.
 */
export function createWorkflowAgentConversationPublisher(delivery: WorkflowConversationDelivery): WorkflowAgentConversationPort {
  const publisher: WorkflowAgentConversationPort = {
    start(input): WorkflowAgentConversationStream {
      const { runId, nodeId, label, parent } = input;
      const session = parent.session;
      let closed = false;
      let active: { turn: number; step: number; text: string; chunkSeqs: number[] } | undefined;
      const published = new Set<string>();
      const appendText = (text: string) => {
        if (closed || text === "") return;
        try {
          if (!active) {
            active = { turn: currentTurn(session), step: 1_000_000_000 + session.seq, text: "", chunkSeqs: [] };
            active.chunkSeqs.push(appendWorkflowChunk(session, {
              turn: active.turn, step: active.step, chunk: { type: "block-start", index: 0, blockType: "text" },
            }).seq);
          }
          const { turn, step, chunkSeqs } = active;
          const delta = active.text === "" ? `### ${label}\n\n${text}` : text;
          active.text += text;
          chunkSeqs.push(appendWorkflowChunk(session, {
            turn, step, chunk: { type: "text-delta", index: 0, text: delta },
          }).seq);
        } catch { /* Observational: never change the durable workflow outcome. */ }
      };
      const flushText = (interrupted = false) => {
        if (!active) return;
        const { turn, step, text, chunkSeqs } = active;
        active = undefined;
        const visible = `### ${label}\n\n${text}`;
        try {
          chunkSeqs.push(appendWorkflowChunk(session, {
            turn, step, chunk: { type: "block-end", index: 0, block: { type: "text", text: visible } },
          }).seq);
          chunkSeqs.push(appendWorkflowChunk(session, {
            turn, step, chunk: { type: "finish", reason: interrupted
              ? { kind: "aborted", failure: { code: "WORKFLOW_INTERRUPTED", message: "工作流输出已中断" } }
              : { kind: "stop" } },
          }).seq);
          delivery.enqueue(session, runId, { kind: "text", turn, step, messageId: liveMessageId(runId, nodeId, `${step}:${visible}`),
            text: visible, model: label, ...(interrupted ? { interrupted: true } : {}) });
          published.add(text.trim());
        } catch {
          // Conversation rendering is observational and never owns workflow success.
        }
      };
      const finishText = (content?: string, interrupted = false) => {
        if (closed) return;
        if (content !== undefined && content.trim() !== "" && !published.has(content.trim())) {
          if (active && content.trimStart().startsWith(active.text.trimStart())) {
            appendText(content.trimStart().slice(active.text.trimStart().length));
          }
          else if (active?.text.trim() !== content.trim()) {
            // A tool-written candidate can differ from earlier commentary.
            // Preserve that commentary; never rewrite what was already shown.
            flushText();
            appendText(content);
          }
        }
        flushText(interrupted);
      };
      const complete = (content: string) => { if (!closed) { finishText(content); closed = true; } };

      return Object.freeze({
        appendText,
        finishText,
        appendTool: (activity: Parameters<WorkflowAgentConversationStream["appendTool"]>[0]) => {
          if (closed) return;
          flushText();
          try {
            const callId = liveToolCallId(runId, nodeId, activity.callId);
            if (session.snapshotEvents().some((event) => event.type === "tool/call" && event.data.callId === callId)) return;
            const turn = currentTurn(session);
            const stepHash = createHash("sha256").update(callId).digest("hex");
            const step = 1_500_000_000 + Number.parseInt(stepHash.slice(0, 7), 16);
            delivery.enqueue(session, runId, { kind: "tool", turn, step, messageId: `${callId}-message`, callId, model: label,
              name: activity.name, arguments: activity.arguments,
              content: activity.content.filter((block) => block.type === "text" || block.type === "image"), isError: activity.isError,
              ...(activity.error === undefined ? {} : { error: activity.error }) });
          } catch {
            // Tool activity rendering is observational and never owns workflow success.
          }
        },
        complete,
        abort: () => { if (!closed) { flushText(true); closed = true; } },
      });
    },
  };
  return Object.freeze(publisher);
}
