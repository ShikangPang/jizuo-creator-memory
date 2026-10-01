import type {} from "../message-source.js";
import { createUserMessage, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { JizuoError } from "@jizuo/contracts";
import type { VideoTextGenerator } from "./authoring.ts";

/** Uses the same selected text model as the existing native AI composer. */
export function createVideoTextGenerator(runtime: {
  selection(): Pick<GenerateOptions, "provider" | "model" | "reasoningEffort">;
  stream(input: GenerateOptions): AsyncIterable<StreamChunk>;
}): VideoTextGenerator {
  return async ({ system, prompt, signal }) => {
    const selection = runtime.selection();
    if (!selection.provider || !selection.model) throw new JizuoError("credential_required", "请先配置并选择默认文字模型");
    const blocks = new Map<number, string>();
    let finished = false;
    const requestSignal = signal ?? AbortSignal.timeout(300_000);
    for await (const chunk of runtime.stream({ ...selection, system,
      messages: [createUserMessage({ source: { kind: "jizuo-video", form: "instructions" }, content: [{ type: "text", text: prompt }] })],
      maxTokens: 16_384, signal: requestSignal })) {
      requestSignal.throwIfAborted();
      if (chunk.type === "text-delta") blocks.set(chunk.index, (blocks.get(chunk.index) ?? "") + chunk.text);
      if (chunk.type === "block-end" && chunk.block.type === "text") blocks.set(chunk.index, chunk.block.text);
      if ([...blocks.values()].reduce((sum, text) => sum + text.length, 0) > 600_000) throw new JizuoError("model_repair", "制作稿输出过长，请减少章节后重试");
      if (chunk.type === "finish") {
        if (chunk.reason.kind !== "stop") throw new JizuoError("model_repair", chunk.reason.kind === "max-tokens" ? "制作稿达到输出上限，请缩小改编范围" : "文字模型未完成制作稿，请检查模型连接后重试");
        finished = true;
      }
    }
    requestSignal.throwIfAborted();
    if (!finished) throw new JizuoError("model_repair", "模型响应中断，制作稿未保存");
    return [...blocks.entries()].sort(([a],[b])=>a-b).map(([,text])=>text).join("");
  };
}
