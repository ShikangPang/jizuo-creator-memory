import { expandAssistantStream, type StreamChunk } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";

/** Public workflow relay batches have no model surface until the durable outbox settles them. */
export function appendWorkflowChunk(session: Session, data: {turn: number; step: number; chunk: StreamChunk}) {
  if (data.step < 1_000_000_000) throw new Error("Workflow stream requires a reserved step");
  return session.append("assistant/attempt", {turn:data.turn, step:data.step,
    stream:[{type:"chunk",time:Date.now(),chunk:data.chunk}]});
}
export function workflowChunks(event: SessionEvent): StreamChunk[] {
  if(event.type !== "assistant/attempt" || event.data.step < 1_000_000_000) return [];
  return expandAssistantStream(event.data.stream).map(record => record.chunk);
}
