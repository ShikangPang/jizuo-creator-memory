import type { LlmRuntime, LlmConfigurableProvider } from "@deepseek-ai/dsh-llm";
import type { SettingsForms } from "@deepseek-ai/dsh-settings";
import { JizuoError, ModelOutputLimit, SaveModelOutputLimit } from "@jizuo/contracts";

export interface ModelOutputSettingsPort {
  list(provider?: string): Promise<ModelOutputLimit[]>;
  save(input: SaveModelOutputLimit): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function at(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, key) => record(current)[key], value);
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function modelEntry(profile: Record<string, unknown>, model: string): Record<string, unknown> {
  return Array.isArray(profile.models) && profile.models.length > 0
    ? record(profile.models.find((entry: unknown) => record(entry).id === model))
    : record(record(profile.modelOverrides)[model]);
}
function supported(route: LlmConfigurableProvider): boolean {
  return route.settingsNs === "llm-pi-ai" || route.settingsNs === "llm-deepseek";
}

/** Edits the adapter's canonical settings, so chats and child agents share one per-model default. */
export class HarnessModelOutputSettings {
  constructor(
    private readonly llm: Pick<LlmRuntime, "listProviders" | "listConfigurableProviders" | "listModels" | "resolveModelInfo" | "discoverModels">,
    private readonly settings: Pick<SettingsForms, "describe" | "mutate" | "writable">,
  ) {}

  async list(onlyProvider?: string): Promise<ModelOutputLimit[]> {
    const descriptors = this.settings.describe(); // Host-local; only whitelisted numeric/display facts are returned.
    const directory = this.llm.listConfigurableProviders();
    const activeProviders = this.llm.listProviders();
    const identities = new Map(activeProviders.map((provider) => [provider.id, { id: provider.id, name: provider.name }]));
    for (const route of directory) {
      const descriptor = descriptors.find((entry) => entry.ns === route.settingsNs);
      const profile = record(at(descriptor?.value, route.settingsPath));
      if (Object.keys(profile).length > 0 && !identities.has(route.provider)) {
        identities.set(route.provider, { id: route.provider, name: route.displayName });
      }
    }
    const providers = [...identities.values()].filter((provider) => onlyProvider === undefined || provider.id === onlyProvider);
    const rows = await Promise.allSettled(providers.map(async (provider) => {
      const route = directory.find((entry) => entry.provider === provider.id);
      const descriptor = descriptors.find((entry) => entry.ns === route?.settingsNs);
      const profile = record(at(descriptor?.value, route?.settingsPath ?? []));
      const user = record(at(descriptor?.user, route?.settingsPath ?? []));
      const base = record(at(descriptor?.base, route?.settingsPath ?? []));
      // Installed pi-ai catalogs are local. Never probe custom endpoints or resolve credentials to show this page.
      const catalog = route?.settingsNs === "llm-pi-ai" && route.declared === false
        ? await this.llm.discoverModels(route.settingsNs, { provider: provider.id }) : [];
      let models: Array<{ id: string; name: string }>;
      try {
        models = (await this.llm.listModels(provider.id)).map((model) => ({ id: model.id, name: model.name }));
      } catch {
        models = [];
      }
      if (models.length === 0) {
        const explicit = Array.isArray(profile.models) ? profile.models.map(record) : [];
        const overrides = Object.entries(record(profile.modelOverrides)).map(([id, value]) => ({ id, ...record(value) }));
        models = [...explicit, ...overrides]
          .filter((entry, index, entries) => typeof entry.id === "string" && entries.findIndex((other) => other.id === entry.id) === index)
          .map((entry) => {
            const fields = record(entry);
            return { id: String(fields.id), name: typeof fields.name === "string" ? fields.name : String(fields.id) };
          });
      }
      return Promise.all(models.map(async (model) => {
        const own = modelEntry(profile, model.id);
        let contextWindow = count(own.contextWindow);
        let resolvedMaxTokens: number | null = null;
        try {
          const info = await this.llm.resolveModelInfo(provider.id, model.id);
          contextWindow = count(info.context?.contextWindow) ?? contextWindow;
          resolvedMaxTokens = count(info.defaultMaxTokens);
        } catch {
          // A configured but inactive route may not resolve runtime metadata; its saved model remains visible.
        }
        const defaultMaxTokens = count(modelEntry(base, model.id).maxTokens)
          ?? count(catalog.find((entry) => entry.id === model.id)?.maxTokens)
          ?? count(profile.defaultMaxTokens) ?? count(profile.maxTokens);
        const storedMaxTokens = count(modelEntry(user, model.id).maxTokens);
        const baseMaxTokens = count(modelEntry(base, model.id).maxTokens);
        return ModelOutputLimit.parse({
          provider: provider.id, providerName: provider.name, model: model.id, modelName: model.name,
          contextWindow,
          maxTokens: resolvedMaxTokens ?? count(own.maxTokens) ?? defaultMaxTokens,
          defaultMaxTokens,
          configuredMaxTokens: storedMaxTokens === baseMaxTokens ? null : storedMaxTokens,
          writable: this.settings.writable && route !== undefined && supported(route) && descriptor !== undefined,
        });
      }));
    }));
    return rows.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  }

  async save(raw: SaveModelOutputLimit): Promise<void> {
    const parsed = SaveModelOutputLimit.safeParse(raw);
    if (!parsed.success) throw new JizuoError("validation_error", "最大输出 tokens 必须是正整数，留空可恢复默认");
    const input = parsed.data;
    const route = this.llm.listConfigurableProviders().find((entry) => entry.provider === input.provider);
    if (!this.settings.writable || !route || !supported(route)) throw new JizuoError("denied", "此模型的输出设置不可修改");
    // Capture the revision before asynchronous model validation so removals or metadata changes cannot pass as a successful save.
    const descriptor = this.settings.describe().find((entry) => entry.ns === route.settingsNs);
    if (!descriptor) throw new JizuoError("runtime_unavailable", "模型设置尚未就绪");
    if (!(await this.llm.listModels(input.provider)).some((model) => model.id === input.model)) {
      throw new JizuoError("validation_error", "模型不存在，请刷新模型列表");
    }
    const info = await this.llm.resolveModelInfo(input.provider, input.model);
    if (input.maxTokens !== null && info.context && input.maxTokens > info.context.contextWindow) {
      throw new JizuoError("validation_error", "最大输出 tokens 不能超过模型上下文容量");
    }
    const profile = record(at(descriptor.value, route.settingsPath));
    const user = record(at(descriptor.user, route.settingsPath));
    const base = record(at(descriptor.base, route.settingsPath));
    const ns = route.settingsNs;
    try {
      if (Array.isArray(profile.models) && profile.models.length > 0) {
        // Native settings replaces arrays atomically. Copy all fields and use CAS to preserve concurrent edits.
        const originalModels = Array.isArray(user.models) ? user.models : Array.isArray(base.models) ? base.models : profile.models;
        const models = originalModels.map((entry: unknown) => {
          const next = { ...record(entry) };
          if (next.id === input.model) {
            const inherited = count(modelEntry(base, input.model).maxTokens);
            if (input.maxTokens === null && inherited !== null) next.maxTokens = inherited;
            else if (input.maxTokens === null) delete next.maxTokens;
            else next.maxTokens = input.maxTokens;
          }
          return next;
        });
        await this.settings.mutate(ns, [{ op: "set", path: [...route.settingsPath, "models"], value: models }], descriptor.revision);
      } else {
        const path = [...route.settingsPath, "modelOverrides", input.model, "maxTokens"];
        await this.settings.mutate(ns, [input.maxTokens === null ? { op: "unset", path } : { op: "set", path, value: input.maxTokens }], descriptor.revision);
      }
    } catch (error) {
      if ((error as { code?: string }).code === "SETTINGS_CONFLICT") {
        throw new JizuoError("validation_error", "模型设置已被其他窗口修改，请刷新后重试");
      }
      throw error;
    }
  }
}
