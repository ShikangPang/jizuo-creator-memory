import type {} from "./message-source.js";
import { renderSkillPrompt } from "../../contracts/src/skill-prompt.ts";
import { createUserMessage, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { ChapterMemoryOutputSchemaV2 } from "@jizuo/workflow-runtime";
import { z } from "zod";
import type { DreamModelSelection } from "@jizuo/memory-domain";
import { groundTypedMemoryEvidence, MemoryExtractionEvidenceInvalid } from "./workflow/memoryEvidence.ts";
import { describeDreamError, dreamProviderError, DreamProcessingError, DreamCapacityError } from "./dream-errors.ts";

export const DreamExtractionSchema = ChapterMemoryOutputSchemaV2.extend({ inferences: ChapterMemoryOutputSchemaV2.shape.facts.optional() });
export type DreamExtraction = z.infer<typeof DreamExtractionSchema>;

export interface DreamModelProgress {
  phase: "waiting_model" | "generating" | "validating";
  receivedChars: number;
}
export type DreamModelDetail =
  | { type: "request"; system: string; content: string; maxOutputTokens: number }
  | { type: "output"; text: string; reasoning: string };
export interface DreamCapacity { state: "fits" | "exceeded" | "unknown"; estimatedTokens: number; contextWindow?: number }
export class DreamEvidenceError extends DreamProcessingError {
  constructor(readonly output: string, readonly factNumbers: readonly number[]) {
    super(`第 ${factNumbers.join("、")} 条记忆的证据不是当前章节的连续原文。`, "chapter");
  }
}
export interface DreamModel {
  reservation(content: string, correction?: DreamEvidenceError): number;
  capacity?(content: string, correction?: DreamEvidenceError): DreamCapacity;
  extract(content: string, signal: AbortSignal, onUsage: (tokens: number) => void, onProgress?: (progress: DreamModelProgress) => void, onDetail?: (detail: DreamModelDetail) => void, correction?: DreamEvidenceError): Promise<DreamExtraction>;
}
export interface DreamModelFactory {
  prepare(selection: DreamModelSelection): Promise<DreamModel>;
}
const DEFAULT_OUTPUT_TOKENS = 2048;
const SYSTEM = renderSkillPrompt("memory-extraction-system",{schema:JSON.stringify(z.toJSONSchema(DreamExtractionSchema))});

export function createDreamModel(options: {
  selection: DreamModelSelection;
  maxOutputTokens?: number;
  contextWindow?: number;
  stream(input: GenerateOptions): AsyncIterable<StreamChunk>;
}): DreamModel {
  const selection = { ...options.selection };
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
  const systemFor = (correction?: DreamEvidenceError) => correction
    ? renderSkillPrompt("memory-extraction-repair",{system:SYSTEM,numbers:correction.factNumbers.join("、"),output:correction.output}) : SYSTEM;
  const reservation = (content: string, correction?: DreamEvidenceError) => Buffer.byteLength(systemFor(correction) + content, "utf8") + maxOutputTokens + 512;
  const capacity = (content: string, correction?: DreamEvidenceError): DreamCapacity => {
    const estimatedTokens = reservation(content, correction);
    const contextWindow = options.contextWindow;
    if (!contextWindow || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return { state: "unknown", estimatedTokens };
    return { state: estimatedTokens <= contextWindow ? "fits" : "exceeded", estimatedTokens, contextWindow };
  };
  return {
    // UTF-8 bytes conservatively bound tokenized text; include room for message framing.
    reservation, capacity,
    async extract(content, signal, onUsage, onProgress, onDetail, correction) {
      const check = capacity(content, correction);
      if (check.state !== "fits") throw new DreamCapacityError(check.state);
      const system = systemFor(correction);
      if (!selection.provider || !selection.model) throw new Error("请先选择可用模型");
      const blocks = new Map<number, string>();
      const reasoningBlocks = new Map<number, string>();
      const joined = (values: Map<number, string>) => [...values.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join("");
      let finished = false;
      let finishError: DreamProcessingError | undefined;
      const receivedChars = () => [...blocks.values()].reduce((count, text) => count + text.length, 0);
      try {
        signal.throwIfAborted();
        onDetail?.({ type: "request", system, content, maxOutputTokens });
        onProgress?.({ phase: "waiting_model", receivedChars: 0 });
        for await (const chunk of options.stream({ ...selection, system,
          messages: [createUserMessage({ source: { kind: "jizuo-dream", form: "instructions" }, content: [{ type: "text", text: content }] })],
          maxTokens: maxOutputTokens, signal })) {
          if (chunk.type === "usage") {
            const total = chunk.usage.totalTokens ?? chunk.usage.inputTokens + chunk.usage.outputTokens;
            if (Number.isFinite(total) && total >= 0) onUsage(Math.ceil(total));
          }
          signal.throwIfAborted();
          if (chunk.type === "text-delta") blocks.set(chunk.index, (blocks.get(chunk.index) ?? "") + chunk.text);
          if (chunk.type === "block-end" && chunk.block.type === "text") blocks.set(chunk.index, chunk.block.text);
          if (chunk.type === "reasoning-delta") reasoningBlocks.set(chunk.index, (reasoningBlocks.get(chunk.index) ?? "") + chunk.text);
          if (chunk.type === "block-end" && chunk.block.type === "reasoning") reasoningBlocks.set(chunk.index, chunk.block.text);
          // Keep response text out of the lightweight chapter report; details are loaded on demand.
          if (chunk.type === "text-delta" || chunk.type === "reasoning-delta" || chunk.type === "block-start" || chunk.type === "block-end") {
            onProgress?.({ phase: "generating", receivedChars: receivedChars() });
            onDetail?.({ type: "output", text: joined(blocks), reasoning: joined(reasoningBlocks) });
          }
          if (chunk.type === "finish") {
            if (chunk.reason.kind === "max-tokens") finishError = new DreamProcessingError(`记忆提取达到模型输出上限（${maxOutputTokens.toLocaleString()} Token），结果不完整。请调整该模型的输出上限后重试。`, "chapter");
            else if (chunk.reason.kind === "error" || chunk.reason.kind === "aborted") finishError = dreamProviderError(chunk.reason.failure);
            else if (chunk.reason.kind !== "stop") finishError = new DreamProcessingError("模型未返回完整记忆结果，本章稍后重试。", "chapter");
            finished = true;
          }
          if (receivedChars() > 100_000) throw new DreamProcessingError("本章记忆输出过长，本章稍后重试。", "chapter");
        }
      } catch (error) { signal.throwIfAborted(); throw describeDreamError(error); }
      signal.throwIfAborted();
      if (finishError) throw finishError;
      if (!finished) throw new DreamProcessingError("模型响应中断，已暂停本作品请求，稍后重试。", "work");
      onProgress?.({ phase: "validating", receivedChars: receivedChars() });
      const text = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join("").trim()
        .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      let value: unknown;
      try { value = JSON.parse(text); }
      catch { throw new DreamProcessingError("模型返回的记忆不是有效 JSON，本章稍后重试。", "chapter"); }
      const result = DreamExtractionSchema.safeParse(value);
      if (!result.success) throw new DreamProcessingError("模型返回的记忆字段不符合格式要求，本章稍后重试。", "chapter");
      try {
        const facts = groundTypedMemoryEvidence(content, { facts: result.data.facts }).facts;
        const inferences = groundTypedMemoryEvidence(content, { facts: result.data.inferences ?? [] }).facts;
        return { facts, inferences };
      } catch (error) {
        if (error instanceof MemoryExtractionEvidenceInvalid) throw new DreamEvidenceError(joined(blocks), error.factNumbers);
        throw error;
      }
    },
  };
}
