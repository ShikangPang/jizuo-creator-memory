import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JizuoError } from "@jizuo/contracts";
import { MediaSettings, SaveMediaSettingsInput, SaveMediaConnectionInput, ManageMediaConnectionInput, type MediaSettingsView } from "../../../contracts/src/media-settings.ts";
import { MediaProviderConfig } from "../../../contracts/src/media.ts";
import { resolveMediaConnection } from "./media-connection.ts";
import { resolveMediaExecution } from "./media-execution.ts";

import type { HostedMediaDirectory, HostedMediaConnection } from "./nspox-media.ts";

const sameConfig = (a: unknown, b: unknown) => a == null || b == null ? a === b : JSON.stringify(MediaProviderConfig.parse(a)) === JSON.stringify(MediaProviderConfig.parse(b));
/** Migrate only configured defaults, never unconfigured vendor catalog entries. */
function withConnections(settings: MediaSettings): MediaSettings {
  const connections = settings.connections ?? [];
  for (const kind of ["image", "video"] as const) {
    const config = settings[kind];
    if (config && config.protocol !== "nspox" && !connections.some(item => item.kind === kind && sameConfig(item.config, config))) {
      const id = `imported-${kind}-${createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 32)}`;
      connections.push({ id, kind, config: structuredClone(config) });
    }
  }
  return { ...settings, ...(connections.length || settings.connections ? { connections } : {}) };
}

function syncLibraryDefault(next: MediaSettings, kind: "image" | "video") {
  const config = next[kind];
  if (next.library) {
    if (config?.protocol === "nspox") { next.library.defaults[kind] = null; return; }
    // Retain old catalogs for compatibility, but only update the selected media kind.
    const id = `media:direct-${kind}`;
    next.library.defaults[kind] = config ? { providerId: id, modelId: config.model } : null;
    if (config) {
      const options = config.options ? Object.fromEntries(Object.entries(config.options).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)) : undefined;
      const provider = { id, name: kind === "image" ? "图片模型" : "视频模型", preset: "custom" as const, protocol: config.protocol, baseUrl: config.baseUrl, source: "media" as const, credentialRef: config.credentialRef, ...(config.allowInsecureLoopback ? { allowInsecureLoopback: true } : {}), models: [{ id: config.model, name: config.model, kind, ...(config.executionMode ? { executionMode: config.executionMode } : {}), ...(options ? { options } : {}) }] };
      const index = next.library.providers.findIndex(item => item.id === id);
      if (index < 0) next.library.providers.push(provider); else next.library.providers[index] = provider;
    }
  }
}

export interface MediaCredentialVault {
  resolve(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<unknown>;
}

export class MediaSettingsRepository {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string, readonly vault: MediaCredentialVault, private readonly hosted?: HostedMediaDirectory) {}

  async read(): Promise<MediaSettings> {
    try { return withConnections(MediaSettings.parse(JSON.parse(await readFile(join(this.root, "media-settings.json"), "utf8")))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: 0, image: null, video: null };
      throw new JizuoError("validation_error", "媒体模型配置读取失败，请检查配置文件");
    }
  }

  /** Resolve the submitted selection without mutating defaults or crossing model kinds. */
  async resolveConnection(kind: "image" | "video", connectionId?: string): Promise<MediaProviderConfig | null> {
    const settings = await this.read();
    if (!connectionId) return settings[kind];
    const saved = settings.connections?.find(item => item.id === connectionId && item.kind === kind);
    if (saved) return saved.config;
    const hosted = (await this.hosted?.list())?.find(item => item.id === connectionId && item.kind === kind);
    if (hosted) return hosted.config;
    throw new JizuoError("validation_error", "所选模型已移除或不属于当前生成类型，请重新选择模型");
  }

  async get(): Promise<MediaSettingsView> {
    const settings = await this.read();
    let hosted: HostedMediaConnection[] = []; let hostedNotice: string | undefined;
    let mediaCredits: MediaSettingsView["mediaCredits"];
    if (this.hosted) {
      try {
        hosted = await this.hosted.list();
        const counts = (kind: "image" | "video") => hosted.filter(item => item.kind === kind).length;
        hostedNotice = hosted.length ? `NSPOX 当前可用：${counts("image")} 个图片模型，${counts("video")} 个视频模型。`
          : "NSPOX 暂无可用媒体模型；请确认已登录后刷新。也可以手动添加模型。";
      } catch { hostedNotice = "NSPOX 媒体模型暂时无法加载，请检查网络或重新登录后刷新。手动模型仍可使用。"; }
      try { mediaCredits = await this.hosted.getCredits?.(); } catch { /* Unavailable balance stays unknown; manual models remain usable. */ }
    }
    const configured = async (config: MediaSettings["image"]) => {
      if (!config) return false;
      try { return Boolean(await this.vault.resolve(config.credentialRef)); } catch { return false; }
    };
    return { settings, ...(hostedNotice ? { hostedNotice } : {}), ...(mediaCredits ? { mediaCredits } : {}), connections: [
      ...await Promise.all((settings.connections ?? []).map(async item => ({ ...item, isDefault: sameConfig(settings[item.kind], item.config), keyConfigured: await configured(item.config) }))),
      ...hosted.map(item => ({ ...item, isDefault: sameConfig(settings[item.kind], item.config) })),
    ], keyConfigured: { image: await configured(settings.image), video: await configured(settings.video) } };
  }

  /** Serializes library and legacy settings mutations through the same CAS boundary. */
  update(expectedRevision: number, mutate: (previous: MediaSettings) => Promise<MediaSettings>): Promise<MediaSettingsView> {
    const operation = this.tail.catch(() => undefined).then(async () => {
      const previous = await this.read();
      if (previous.revision !== expectedRevision) throw new JizuoError("revision_conflict", "媒体模型配置已变化，请刷新后再保存");
      const next = MediaSettings.parse(await mutate(previous));
      next.revision = previous.revision + 1;
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = join(this.root, `.media-settings-${randomUUID()}.json`);
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(temporary, join(this.root, "media-settings.json"));
      return this.get();
    });
    this.tail = operation;
    return operation;
  }

  saveConnection(raw: SaveMediaConnectionInput): Promise<MediaSettingsView> {
    const input = SaveMediaConnectionInput.parse(raw);
    return this.update(input.expectedRevision, async previous => {
      const connections = previous.connections ?? [];
      const entry = input.connectionId ? connections.find(item => item.id === input.connectionId && item.kind === input.kind)
        : !input.create ? connections.find(item => item.kind === input.kind && sameConfig(item.config, previous[input.kind])) : undefined;
      if (input.connectionId && !entry) throw new JizuoError("validation_error", "模型不存在，请刷新列表");
      if (!entry && input.connection && connections.length >= 1000) throw new JizuoError("validation_error", "模型数量已达上限，请先移除不再使用的模型");
      const old = entry?.config ?? (input.create ? null : previous[input.kind]);
      const config = resolveMediaConnection(input, old);
      if (config?.protocol === "nspox") throw new JizuoError("validation_error", "请从 NSPOX 模型列表选择默认模型");
      if (config) {
        const compatible = old && old.protocol === config.protocol && new URL(old.baseUrl).origin === new URL(config.baseUrl).origin;
        config.credentialRef = compatible ? old.credentialRef : `jizuo_media_${randomUUID().replaceAll("-", "")}`;
        const key = input.apiKey?.trim();
        if (key) {
          config.credentialRef = `jizuo_media_${randomUUID().replaceAll("-", "")}`;
          await this.vault.set(config.credentialRef, key);
        } else if (!await this.vault.resolve(config.credentialRef)) {
          throw new JizuoError("validation_error", "请填写 API Key；更换接口来源后需要重新填写凭据。");
        }
      }
      const changeDefault = (!input.create && !input.connectionId)
        || (!!entry && sameConfig(previous[input.kind], entry.config))
        || (input.create && !previous[input.kind] && !connections.some(item => item.kind === input.kind));
      if (config) {
        if (entry) entry.config = config;
        else connections.push({ id: randomUUID(), kind: input.kind, config });
      }
      const next = { ...previous, connections, ...(changeDefault ? { [input.kind]: config } : {}) };
      if (changeDefault) syncLibraryDefault(next, input.kind);
      return next;
    });
  }

  manageConnection(raw: ManageMediaConnectionInput): Promise<MediaSettingsView> {
    const input = ManageMediaConnectionInput.parse(raw);
    return this.update(input.expectedRevision, async previous => {
      const entry = previous.connections?.find(item => item.id === input.id) ?? (await this.hosted?.list())?.find(item => item.id === input.id);
      if (!entry) throw new JizuoError("validation_error", "模型不存在，请刷新列表");
      if (entry.config.protocol === "nspox" && input.action === "remove") throw new JizuoError("validation_error", "NSPOX 模型由账号目录管理，可停用生成或更换默认模型");
      if (input.action === "set-default") {
        resolveMediaExecution(entry.config, entry.kind);
        if (!await this.vault.resolve(entry.config.credentialRef)) throw new JizuoError("validation_error", "请先编辑模型并配置 API Key");
        previous[entry.kind] = structuredClone(entry.config);
      } else {
        previous.connections = previous.connections!.filter(item => item.id !== entry.id);
        if (sameConfig(previous[entry.kind], entry.config)) previous[entry.kind] = null;
        // Frozen jobs retain their immutable credential references after a list entry is removed.
      }
      if (input.action === "set-default" || previous[entry.kind] === null) syncLibraryDefault(previous, entry.kind);
      return previous;
    });
  }

  save(raw: SaveMediaSettingsInput): Promise<MediaSettingsView> {
    const input = SaveMediaSettingsInput.parse(raw);
    const operation = this.tail.catch(() => undefined).then(async () => {
      const previous = await this.read();
      if (previous.revision !== input.expectedRevision) throw new JizuoError("revision_conflict", "媒体模型配置已变化，请刷新后再保存");
      const next = MediaSettings.parse({ revision: previous.revision + 1, image: input.image, video: input.video, ...(previous.connections ? { connections: previous.connections } : {}) });
      for (const kind of ["image", "video"] as const) {
        const key = input.apiKeys?.[kind]?.trim();
        const config = next[kind];
        if (config?.protocol === "nspox") {
          if (key || !sameConfig(config, previous[kind])) throw new JizuoError("validation_error", "请从 NSPOX 模型列表选择默认模型");
          continue;
        }
        if (config) {
          const old = previous[kind];
          // Credential references are capabilities owned by the host, never selected by a caller.
          config.credentialRef = old && old.protocol === config.protocol && new URL(old.baseUrl).origin === new URL(config.baseUrl).origin
            ? old.credentialRef : `jizuo_media_${kind}_${randomUUID().replaceAll("-", "")}`;
        }
        if (key && config) {
          // A new ref prevents a failed settings write from rotating the previously active key.
          config.credentialRef = `jizuo_media_${kind}_${randomUUID().replaceAll("-", "")}`;
          await this.vault.set(config.credentialRef, key);
        }
      }
      if (previous.library) {
        // Older clients may still save image/video directly. Keep the expanded directory
        // and represent their chosen settings as host-owned legacy entries.
        next.library = structuredClone(previous.library);
        for (const kind of ["image", "video"] as const) {
          const config = next[kind];
          if (!config || config.protocol === "nspox") { next.library.defaults[kind] = null; continue; }
          const id = `media:legacy-${kind}`;
          const provider = {
            id, name: `原${kind === "image" ? "图片" : "视频"}配置`, preset: "custom" as const,
            protocol: config.protocol, baseUrl: config.baseUrl, source: "media" as const,
            credentialRef: config.credentialRef, allowInsecureLoopback: config.allowInsecureLoopback,
            models: [{ id: config.model, name: config.model, kind, ...(config.executionMode ? { executionMode: config.executionMode } : {}),
              ...(config.options ? { options: Object.fromEntries(Object.entries(config.options).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)) } : {}) }],
          };
          const index = next.library.providers.findIndex(entry => entry.id === id);
          if (index < 0) next.library.providers.push(provider); else next.library.providers[index] = provider;
          next.library.defaults[kind] = { providerId: id, modelId: config.model };
        }
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = join(this.root, `.media-settings-${randomUUID()}.json`);
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(temporary, join(this.root, "media-settings.json"));
      return this.get();
    });
    this.tail = operation;
    return operation;
  }
}
