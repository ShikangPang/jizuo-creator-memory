import { randomUUID } from "node:crypto";
import { JizuoError, MediaProviderConfig, MediaLibraryView, SaveMediaProviderInput, SetDefaultMediaModelsInput, DiscoverMediaModelsInput, MEDIA_PROVIDER_PRESETS, type MediaLibraryModel, type MediaLibraryProvider, type StoredMediaLibrary, type DiscoverMediaModelsResult, type MediaSettings } from "@jizuo/contracts";
import { MediaSettingsRepository } from "./settings.ts";
import { discoverDashScopeModels } from "./dashscope-catalog.ts";
import { normalizeDashScopeModel, dashScopeGenerationBaseUrl } from "./dashscope-models.ts";

export type NativeMediaProvider = Omit<MediaLibraryProvider, "source" | "models"> & { models?: MediaLibraryModel[] };
export interface NativeMediaProviderPort {
  list(): Promise<NativeMediaProvider[]>;
  resolve(id: string): Promise<string | undefined>;
}
type Provider = StoredMediaLibrary["providers"][number];
const builtinNotice = "内置模型目录不代表账号已开通；实际可用性由服务商账号及所在区域决定。";
function invalid(message: string): never { throw new JizuoError("validation_error", message); }
const ref = () => `jizuo_media_${randomUUID().replaceAll("-", "")}`;
const catalog = (preset: Provider["preset"]): MediaLibraryModel[] => preset === "custom" ? [] : structuredClone(MEDIA_PROVIDER_PRESETS[preset].models);
const presetFor = (config: MediaProviderConfig): Provider["preset"] => config.protocol !== "nspox" && config.baseUrl.replace(/\/$/, "") === MEDIA_PROVIDER_PRESETS[config.protocol].baseUrl ? config.protocol : "custom";
const modelKey = (model: MediaLibraryModel) => `${model.kind}:${model.id}`;
function validateProvider(provider: Provider) {
  if (provider.workspaceId && provider.protocol !== "dashscope") invalid("业务空间 ID 仅用于百炼模型目录");
  // Validate endpoints even when no models have been selected yet.
  MediaProviderConfig.parse({ protocol: provider.protocol, baseUrl: provider.baseUrl, model: "validation", credentialRef: "validation", allowInsecureLoopback: provider.allowInsecureLoopback });
  const seen = new Set<string>();
  for (const model of provider.models) {
    if (seen.has(modelKey(model))) invalid("同一用途的模型不能重复");
    seen.add(modelKey(model));
    MediaProviderConfig.parse({ protocol: provider.protocol, baseUrl: provider.baseUrl, model: model.id, credentialRef: "validation", executionMode: model.executionMode, options: model.options, allowInsecureLoopback: provider.allowInsecureLoopback });
  }
}

export class MediaLibraryService {
  constructor(private readonly settings: MediaSettingsRepository, private readonly ports: { native?: NativeMediaProviderPort; fetch?: typeof fetch } = {}) {}

  private async library(settings: MediaSettings): Promise<StoredMediaLibrary> {
    const library: StoredMediaLibrary = settings.library ? structuredClone(settings.library) : { providers: [], defaults: { image: null, video: null } };
    if (!settings.library) {
      for (const kind of ["image", "video"] as const) {
        const config = settings[kind];
        if (!config || config.protocol === "nspox") continue;
        // Preserve each legacy credential and every protocol-specific option verbatim.
        const id = `media:legacy-${kind}`;
        const preset = presetFor(config);
        const models = catalog(preset).filter(model => modelKey(model) !== `${kind}:${config.model}`);
        models.push({ id: config.model, name: config.model, kind, ...(config.executionMode ? { executionMode: config.executionMode } : {}), ...(config.options ? { options: Object.fromEntries(Object.entries(config.options).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)) } : {}) });
        library.providers.push({ id, name: `${preset === "custom" ? "自定义" : MEDIA_PROVIDER_PRESETS[preset].name}（原${kind === "image" ? "图片" : "视频"}配置）`, preset, protocol: config.protocol, baseUrl: config.baseUrl, credentialRef: config.credentialRef, models, source: "media", ...(config.allowInsecureLoopback ? { allowInsecureLoopback: true } : {}) });
        library.defaults[kind] = { providerId: id, modelId: config.model };
      }
    }
    const native = await this.ports.native?.list() ?? [];
    for (const item of native) {
      if (!item.id.startsWith("text:")) invalid("文字服务商标识必须由主机命名");
      const old = library.providers.find(provider => provider.id === item.id && provider.source === "text");
      const provider: Provider = { id: item.id, name: item.name, preset: item.preset, protocol: item.protocol, baseUrl: item.baseUrl, models: old?.protocol === item.protocol && old.baseUrl === item.baseUrl ? old.models : item.models ?? catalog(item.preset), source: "text" };
      provider.workspaceId = old?.protocol === item.protocol && old.baseUrl === item.baseUrl ? old.workspaceId : item.workspaceId;
      validateProvider(provider);
      const index = library.providers.findIndex(entry => entry.id === item.id);
      if (index < 0) library.providers.push(provider); else library.providers[index] = provider;
    }
    // Deleted native providers no longer appear or provide selectable capabilities.
    library.providers = library.providers.filter(provider => provider.source === "media" || native.some(item => item.id === provider.id));
    // Refresh old cached statuses on read; selecting/saving persists the inferred protocol.
    for (const provider of library.providers) if (provider.protocol === "dashscope") provider.models = provider.models.map(normalizeDashScopeModel);
    return library;
  }

  async get(): Promise<MediaLibraryView> {
    const settings = await this.settings.read();
    const library = await this.library(settings);
    const providers = await Promise.all(library.providers.map(async ({ credentialRef, allowInsecureLoopback: _loopback, ...provider }) => ({ ...provider, keyConfigured: provider.source === "text" ? Boolean(await this.ports.native?.resolve(provider.id)) : Boolean(credentialRef && await this.settings.vault.resolve(credentialRef)) })));
    return MediaLibraryView.parse({ revision: settings.revision, providers, defaults: library.defaults });
  }

  async saveProvider(raw: SaveMediaProviderInput): Promise<MediaLibraryView> {
    const input = SaveMediaProviderInput.parse(raw);
    await this.settings.update(input.expectedRevision, async previous => {
      const library = await this.library(previous);
      const previousDefaults = structuredClone(library.defaults);
      const old = input.id ? library.providers.find(provider => provider.id === input.id) : undefined;
      if (input.id && !old) invalid("服务商不存在，请刷新");
      let provider: Provider;
      if (old?.source === "text") {
        if (input.apiKey || input.preset !== old.preset || (input.baseUrl && input.baseUrl !== old.baseUrl) || (input.protocol && input.protocol !== old.protocol)) invalid("请在文字模型设置中修改此服务商连接");
        provider = { ...old, models: input.models ?? old.models };
      } else {
        const defaults = input.preset === "custom" ? null : MEDIA_PROVIDER_PRESETS[input.preset];
        const protocol = defaults?.protocol ?? input.protocol ?? invalid("请选择自定义接口协议");
        const baseUrl = defaults?.baseUrl ?? input.baseUrl ?? invalid("请填写自定义接口地址");
        const compatible = old && old.protocol === protocol && new URL(old.baseUrl).origin === new URL(baseUrl).origin;
        provider = { id: old?.id ?? `media:${randomUUID()}`, name: input.name, preset: input.preset, protocol, baseUrl, models: input.models ?? (old?.preset === input.preset ? old.models : catalog(input.preset)), source: "media", credentialRef: compatible ? old.credentialRef : undefined, ...(old?.allowInsecureLoopback && old.baseUrl === baseUrl ? { allowInsecureLoopback: true } : {}) };
        validateProvider(provider);
        if (input.apiKey?.trim()) {
          provider.credentialRef = ref();
          await this.settings.vault.set(provider.credentialRef, input.apiKey.trim());
        }
      }
      provider.workspaceId = input.workspaceId !== undefined ? input.workspaceId || undefined : old?.protocol === provider.protocol && old.baseUrl === provider.baseUrl ? old.workspaceId : undefined;
      if (provider.protocol === "dashscope") provider.models = provider.models.map(normalizeDashScopeModel);
      validateProvider(provider);
      const index = library.providers.findIndex(entry => entry.id === provider.id);
      if (index < 0) library.providers.push(provider); else library.providers[index] = provider;
      // A model removed from the directory also clears its active default.
      for (const kind of ["image", "video"] as const) {
        const selection = library.defaults[kind];
        if (selection?.providerId === provider.id && !provider.models.some(model => model.kind === kind && model.id === selection.modelId)) library.defaults[kind] = null;
      }
      const refresh = (["image", "video"] as const).filter(kind => previousDefaults[kind]?.providerId === provider.id || library.defaults[kind]?.providerId === provider.id);
      return this.derive(previous, library, false, refresh);
    });
    return this.get();
  }

  async setDefaults(raw: SetDefaultMediaModelsInput): Promise<MediaLibraryView> {
    const input = SetDefaultMediaModelsInput.parse(raw);
    await this.settings.update(input.expectedRevision, async previous => {
      const library = await this.library(previous);
      const changed = (["image", "video"] as const).filter(kind => JSON.stringify(library.defaults[kind]) !== JSON.stringify(input[kind]));
      library.defaults = { image: input.image, video: input.video };
      // A per-kind credential refresh must not depend on the other provider's health.
      // Still apply every actual selection change, even when refreshKind is provided.
      const refresh = input.refreshKind ? [...new Set([...changed, input.refreshKind])] : changed.length ? changed : ["image", "video"] as const;
      return this.derive(previous, library, true, refresh);
    });
    return this.get();
  }

  private async derive(previous: MediaSettings, library: StoredMediaLibrary, requireKey = false, refresh: readonly ("image" | "video")[] = ["image", "video"]): Promise<MediaSettings> {
    const next: MediaSettings = { ...previous, library };
    const nativeRefs = new Map<string, string>();
    for (const kind of ["image", "video"] as const) {
      if (!refresh.includes(kind)) continue;
      const selection = library.defaults[kind];
      if (!selection) { next[kind] = null; continue; }
      const provider = library.providers.find(entry => entry.id === selection.providerId);
      if (!provider) invalid("默认媒体服务商不存在，请重新选择");
      const model = provider.models.find(entry => entry.kind === kind && entry.id === selection.modelId);
      if (!model) invalid("请选择对应图片或视频用途的模型");
      if (model.unavailableReason) invalid(`此模型${model.unavailableReason}，请选择已适配的模型`);
      let credentialRef = provider.credentialRef;
      if (provider.source === "text") {
        credentialRef = nativeRefs.get(provider.id);
        if (!credentialRef) {
          const key = await this.ports.native?.resolve(provider.id);
          if (!key) invalid("文字服务商尚未配置有效密钥");
          const current = (await this.ports.native?.list())?.find(entry => entry.id === provider.id);
          if (!current || current.protocol !== provider.protocol || current.baseUrl !== provider.baseUrl) throw new JizuoError("revision_conflict", "文字服务商连接已变化，请刷新后重新选择");
          credentialRef = ref();
          await this.settings.vault.set(credentialRef, key);
          nativeRefs.set(provider.id, credentialRef);
        }
      }
      if ((!credentialRef || !await this.settings.vault.resolve(credentialRef)) && requireKey) invalid("请先配置服务商密钥");
      if (!credentialRef) { credentialRef = ref(); provider.credentialRef = credentialRef; }
      const baseUrl = provider.protocol === "dashscope" ? dashScopeGenerationBaseUrl({ ...provider, keyConfigured: true }, model) : provider.baseUrl;
      next[kind] = MediaProviderConfig.parse({ protocol: provider.protocol, baseUrl, model: model.id, credentialRef, ...(model.executionMode ? { executionMode: model.executionMode } : {}), ...(model.options ? { options: model.options } : {}), ...(provider.allowInsecureLoopback ? { allowInsecureLoopback: true } : {}) });
    }
    return next;
  }

  async discover(raw: DiscoverMediaModelsInput): Promise<DiscoverMediaModelsResult> {
    const input = DiscoverMediaModelsInput.parse(raw);
    const library = await this.library(await this.settings.read());
    const provider = library.providers.find(entry => entry.id === input.providerId);
    if (!provider) invalid("服务商不存在，请刷新");
    if (provider.protocol !== "openai" && provider.protocol !== "dashscope") return { models: catalog(provider.preset), source: "builtin", notice: builtinNotice };
    const key = provider.source === "text" ? await this.ports.native?.resolve(provider.id) : provider.credentialRef && await this.settings.vault.resolve(provider.credentialRef);
    if (!key) invalid("请先配置服务商密钥");
    validateProvider(provider);
    if (provider.source === "text") {
      const current = (await this.ports.native?.list())?.find(entry => entry.id === provider.id);
      if (!current || current.protocol !== provider.protocol || current.baseUrl !== provider.baseUrl) throw new JizuoError("revision_conflict", "文字服务商连接已变化，请刷新后获取模型");
    }
    if (provider.protocol === "dashscope") return discoverDashScopeModels({ ...provider, keyConfigured: true }, key, this.ports.fetch ?? fetch, [...catalog(provider.preset), ...provider.models]);
    let response: Response;
    try {
      response = await (this.ports.fetch ?? fetch)(`${provider.baseUrl.replace(/\/$/, "")}/models`, { headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
    } catch { throw new JizuoError("validation_error", "模型列表获取失败；可使用内置目录或手动添加"); }
    if (!response.ok) { await response.body?.cancel(); invalid("模型列表获取失败；请检查服务商连接或使用内置目录"); }
    const reader = response.body?.getReader();
    if (!reader) invalid("服务商未返回模型列表");
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) { const result = await reader.read(); if (result.done) break; length += result.value.byteLength; if (length > 2_000_000) { await reader.cancel(); invalid("模型列表响应过大"); } chunks.push(result.value); }
      const bytes = Buffer.concat(chunks);
      const payload = JSON.parse(bytes.toString("utf8"));
      if (!Array.isArray(payload.data) || payload.data.length > 10000) invalid("模型列表格式不受支持");
      const known = [...catalog(provider.preset), ...provider.models];
      const models: MediaLibraryModel[] = [];
      for (const entry of payload.data) {
        if (!entry || typeof entry.id !== "string") continue;
        // Only exact catalog or user-declared identities can be classified; text compatibility is not evidence of media capability.
        for (const model of known.filter(model => model.id === entry.id)) if (!models.some(item => modelKey(item) === modelKey(model))) models.push(model);
      }
      return { models, source: "remote", notice: "仅显示已知或手动标注用途的图片、视频模型；列表不保证账号拥有生成权限。" };
    } catch (error) { if (error instanceof JizuoError) throw error; throw new JizuoError("validation_error", "模型列表格式不受支持"); }
    finally { reader.releaseLock(); }
  }
}
