import type { LlmRuntime, GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { DreamModelOption, DreamModelSelection } from "@jizuo/memory-domain";
import { createDreamModel, type DreamModel, type DreamModelFactory } from "./dream-model.ts";

export class DreamModelCatalog implements DreamModelFactory {
  constructor(private readonly llm: Pick<LlmRuntime, "listProviders" | "listConfigurableProviders" | "listModels" | "resolveModelInfo" | "stream">) {}

  async list(): Promise<DreamModelOption[]> {
    const active = this.llm.listProviders();
    const directory = this.llm.listConfigurableProviders();
    const providers = new Map(active.map((provider) => [provider.id, { name: provider.name, available: true }]));
    for (const route of directory) {
      if (!providers.has(route.provider)) providers.set(route.provider, { name: route.displayName, available: false });
    }
    const rows = await Promise.all([...providers].map(async ([provider, info]) => {
      try {
        return (await this.llm.listModels(provider)).map((model) => ({ provider, providerName: info.name, model: model.id, modelName: model.name,
          available: info.available, ...(!info.available ? { unavailableReason: "服务方尚未就绪，请检查模型设置" } : {}) }));
      } catch { return []; }
    }));
    return rows.flat();
  }

  async describe(selection: DreamModelSelection): Promise<{ selection: DreamModelSelection; maxOutputTokens?: number; contextWindow?: number }> {
    if (!this.llm.listProviders().some((item) => item.id === selection.provider)
      || !(await this.llm.listModels(selection.provider)).some((item) => item.id === selection.model)) {
      throw new Error("所选梦境模型不可用，请重新选择服务方和模型");
    }
    const info = await this.llm.resolveModelInfo(selection.provider, selection.model);
    const limit = info.defaultMaxTokens;
    const contextWindow = info.context?.contextWindow;
    return { selection: { ...selection }, ...(typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? { maxOutputTokens: limit } : {}),
      ...(typeof contextWindow === "number" && Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}) };
  }

  stream(input: GenerateOptions): AsyncIterable<StreamChunk> { return this.llm.stream(input); }

  async prepare(selection: DreamModelSelection): Promise<DreamModel> {
    return createDreamModel({ ...await this.describe(selection), stream: (input) => this.stream(input) });
  }
}
