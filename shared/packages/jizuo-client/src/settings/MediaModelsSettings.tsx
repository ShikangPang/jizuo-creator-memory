import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useRef, useState } from "react";
import type { MediaSettingsView, SaveMediaSettingsInput, SaveMediaConnectionInput, ManageMediaConnectionInput } from "../../../contracts/src/media-settings.ts";
import type { MediaProviderConfig } from "../../../contracts/src/media.ts";
import type { DiscoverMediaModelsInput, DiscoverMediaModelsResult, MediaLibraryView, SaveMediaProviderInput, SetDefaultMediaModelsInput } from "../../../contracts/src/media-library.ts";
import { SpeechModelsSettings, type SpeechSettingsRemote } from "./SpeechModelsSettings.tsx";
import "./model-output.css";

export interface MediaSettingsRemote {
  getMediaSettings(): Promise<MediaSettingsView>;
  saveMediaSettings(input: SaveMediaSettingsInput): Promise<MediaSettingsView>;
  saveMediaConnection(input: SaveMediaConnectionInput): Promise<MediaSettingsView>;
  manageMediaConnection(input: ManageMediaConnectionInput): Promise<MediaSettingsView>;
}
/** Kept for older clients; the direct connection form never loads a model catalog. */
export interface MediaLibraryRemote {
  getMediaLibrary(): Promise<MediaLibraryView>;
  saveMediaProvider(input: SaveMediaProviderInput): Promise<MediaLibraryView>;
  setDefaultMediaModels(input: SetDefaultMediaModelsInput): Promise<MediaLibraryView>;
  discoverMediaModels(input: DiscoverMediaModelsInput): Promise<DiscoverMediaModelsResult>;
}
type Kind = "image" | "video";
type Remote = MediaSettingsRemote & Partial<SpeechSettingsRemote>;
const labels = { image: "图片", video: "视频" };
const failure = (error: unknown) => userErrorMessage(error, "模型配置操作失败", { operation: "MediaModelsSettings" });

function MediaConnectionForm({ remote, kind, active }: { remote: Remote; kind: Kind; active: boolean }) {
  const label = labels[kind];
  const [view, setView] = useState<MediaSettingsView>();
  const [editorId, setEditorId] = useState<string | null>(null);
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [protocol, setProtocol] = useState<"auto" | Exclude<MediaProviderConfig["protocol"], "nspox">>("auto");
  const [options, setOptions] = useState("{}");
  const [executionMode, setExecutionMode] = useState<"auto" | "sync" | "async">("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const dirty = useRef(false);
  const sequence = useRef(0);
  const fillConfig = (config: MediaProviderConfig | null) => {
    setBaseUrl(config?.baseUrl ?? ""); setModel(config?.protocol === "kuaishou" ? config.options?.modelName ?? config.model : config?.model ?? "");
    setProtocol(config?.protocol === "nspox" ? "auto" : config?.protocol ?? "auto"); setOptions(JSON.stringify(config?.options ?? {}, null, 2));
    setExecutionMode(config?.executionMode ?? "auto");
    setApiKey("");
  };
  const apply = (next: MediaSettingsView) => {
    setView(next); setEditorId(next.connections?.some(item => item.kind === kind) ? null : "new");
    fillConfig(null); setHasSavedKey(false); dirty.current = false;
  };
  const openEditor = (id: string) => {
    const entry = view?.connections?.find(item => item.id === id);
    setEditorId(id); fillConfig(entry?.config ?? null); setHasSavedKey(entry?.keyConfigured ?? false);
    dirty.current = true; setError(""); setMessage("");
  };
  const reload = async (discardDraft = false) => {
    const current = ++sequence.current;
    try {
      const next = await remote.getMediaSettings();
      if (current !== sequence.current) return;
      if (discardDraft || !dirty.current) { apply(next); setError(""); }
    } catch (cause) { if (current === sequence.current) setError(failure(cause)); }
  };
  useEffect(() => { if (active) void reload(); return () => { sequence.current++; }; }, [remote, active]);
  const edit = (action: () => void) => { dirty.current = true; action(); setMessage(""); };
  const save = async (disable = false) => {
    if (!view || busy) return;
    setBusy(true); setError(""); setMessage(""); sequence.current++;
    try {
      let parsedOptions: unknown = {};
      if (!disable) {
        if (!baseUrl.trim() || !model.trim()) throw new Error("请填写接口地址和模型名称。");
        try { parsedOptions = JSON.parse(options || "{}"); } catch { throw new Error("高级参数必须是合法 JSON。"); }
        if (!parsedOptions || typeof parsedOptions !== "object" || Array.isArray(parsedOptions) || Object.values(parsedOptions).some(value => !["string", "number", "boolean"].includes(typeof value))) throw new Error("高级参数需要是包含字符串、数字或布尔值的 JSON 对象。");
      }
      const next = await remote.saveMediaConnection({ expectedRevision: view.settings.revision, kind, ...(!disable ? editorId === "new" ? { create: true } : { connectionId: editorId! } : {}), connection: disable ? null : { baseUrl: baseUrl.trim(), model: model.trim(), protocol, ...(executionMode !== "auto" ? { executionMode } : {}), options: parsedOptions as Record<string, string | number | boolean> }, ...(apiKey.trim() && !disable ? { apiKey: apiKey.trim() } : {}) });
      sequence.current++; apply(next); setMessage(disable ? `${label}生成已停用` : `${label}模型已保存`);
    } catch (cause) { setError(failure(cause)); } finally { setBusy(false); }
  };
  const manage = async (id: string, action: ManageMediaConnectionInput["action"]) => {
    if (!view || busy) return;
    setBusy(true); setError(""); setMessage(""); sequence.current++;
    try {
      const next = await remote.manageMediaConnection({ expectedRevision: view.settings.revision, id, action });
      sequence.current++; apply(next); setMessage(action === "set-default" ? `默认${label}模型已更新` : "模型已移除");
    } catch (cause) { setError(failure(cause)); } finally { setBusy(false); }
  };
  const entries = view?.connections?.filter(item => item.kind === kind) ?? [];
  if (!active && !view) return null;
  return <section className="jz-model-output jz-media-library" aria-label={`${label}模型设置`}>
    <header><h2>{label}模型</h2><IconButton icon="reset" label={"重新加载配置"} type="button" disabled={busy} onClick={() => { void reload(true); }} /></header>
    <p>登录后可选择 NSPOX 模型，也可手动添加。作品生成时使用当前默认模型。</p>
    {view?.hostedNotice && <p role="status">{view.hostedNotice}</p>}
    <ul className="jz-media-model-list" aria-label={`${label}模型列表`}>{entries.map(entry => <li key={entry.id} aria-label={entry.config.model}>
      <div><strong>{entry.config.model}</strong><span>{entry.config.protocol === "nspox" ? "NSPOX · 使用账号登录" : entry.config.baseUrl}</span>{entry.billing && <span>{entry.billing.creditsPerUnit} 点 / {({ image: "张", second: "秒", video: "个视频" } as Record<string, string>)[entry.billing.unit] ?? entry.billing.unit}</span>}{!entry.keyConfigured && <span>{entry.config.protocol === "nspox" ? "请登录 NSPOX" : "需要配置 API Key"}</span>}</div>
      <div className="jz-media-model-actions">
        <IconButton icon="apply" label={(entry.isDefault ? "当前默认" : "设为默认")} type="button" disabled={busy || editorId !== null || entry.isDefault || !entry.keyConfigured} onClick={() => { void manage(entry.id, "set-default"); }} />
        {entry.config.protocol !== "nspox" && <><IconButton icon="edit" label={"编辑"} type="button" disabled={busy || editorId !== null} onClick={() => openEditor(entry.id)} />
        <IconButton icon="delete" label={"移除"} type="button" disabled={busy || editorId !== null} onClick={() => { void manage(entry.id, "remove"); }} /></>}
      </div>
    </li>)}</ul>
    {view && entries.length > 0 && !entries.some(entry => entry.isDefault) && <p>尚未选择默认{label}模型，生成前请将列表中的一个模型设为默认。</p>}
    {editorId === null && <div className="jz-output-controls"><button className="jz-model-form-button" type="button" disabled={!view || busy} onClick={() => openEditor("new")}><span aria-hidden="true">＋</span> 添加{label}模型</button>{view?.settings[kind] && <IconButton icon="pause" label={"停用" + (label) + "生成"} type="button" disabled={busy} onClick={() => { void save(true); }} />}</div>}
    {editorId !== null && <fieldset className="jz-media-connection-editor" disabled={!view || busy}><legend>{editorId === "new" ? `添加${label}模型` : `编辑${label}模型`}</legend>
      <p className="jz-model-form-description">配置模型名称、接口地址和密钥，用于{label}生成。</p>
      <div className="jz-media-config-fields">
        <label><span>模型名称</span><input aria-label={`${label}模型名称`} value={model} placeholder="填写服务商提供的模型 ID" spellCheck={false} onChange={event => edit(() => setModel(event.target.value))}/></label>
        <label><span>Base URL</span><input aria-label={`${label} Base URL`} value={baseUrl} placeholder="https://api.example.com/v1" spellCheck={false} onChange={event => edit(() => { setBaseUrl(event.target.value); setProtocol("auto"); })}/></label>
        <label><span>API Key</span><input aria-label={`${label} API Key`} type="password" autoComplete="new-password" value={apiKey} placeholder={hasSavedKey ? "已保存，留空保留原密钥" : "输入 API Key"} onChange={event => edit(() => setApiKey(event.target.value))}/></label>
        <label><span>API 格式</span><select aria-label={`${label}接口协议`} value={protocol} onChange={event => edit(() => setProtocol(event.target.value as typeof protocol))}><option value="auto">自动识别（未知地址按 OpenAI 兼容）</option><option value="openai">OpenAI 兼容</option><option value="ark">火山方舟</option><option value="dashscope">阿里云 DashScope</option><option value="tencent">腾讯混元</option><option value="kuaishou">快手可灵</option></select></label>
        <details className="jz-model-form-advanced"><summary>高级设置</summary><div className="jz-media-config-fields">
          <label>执行方式<select aria-label={`${label}执行方式`} value={executionMode} onChange={event => edit(() => setExecutionMode(event.target.value as typeof executionMode))}><option value="auto">自动识别</option><option value="sync">同步：直接返回结果</option><option value="async">异步：提交任务后查询结果</option></select></label>
          <p>默认自动选择。手动切换需接口支持；异步任务由应用自动查询并保存结果。</p>
          <label>请求参数（JSON）<textarea aria-label={`${label}请求参数`} value={options} onChange={event => edit(() => setOptions(event.target.value))}/></label>
          <p>URL 可填写 API 基础地址或常见生成接口的完整地址。代理接口按其文档选择协议。</p>
          {protocol === "tencent" && <p>腾讯原生接口的 API Key 栏需填写 SecretId、SecretKey 的 JSON 凭据。</p>}
          {protocol === "kuaishou" && <p>可灵原生接口的 API Key 栏需填写 accessKey、secretKey 的 JSON 凭据。</p>}
        </div></details>
      </div>
      <div className="jz-model-form-actions">
        <button className="jz-model-form-button jz-model-form-button--primary" aria-label={busy ? "保存中…" : `保存${label}模型`} type="button" disabled={!view || busy} onClick={() => { void save(); }}>{busy ? "保存中…" : editorId === "new" ? "添加模型" : "保存修改"}</button>
        <button className="jz-model-form-button" type="button" disabled={busy} onClick={() => { if (view) { apply(view); setEditorId(null); setError(""); } }}>取消</button>
      </div>
    </fieldset>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {kind === "video" && remote.getSpeechSettings && remote.saveSpeechSettings && <details className="jz-media-speech"><summary>配音模型（可选）</summary><SpeechModelsSettings remote={remote as SpeechSettingsRemote}/></details>}
  </section>;
}

export function MediaModelsSettings({ remote, kind: suppliedKind, active = true }: { remote: Remote; kind?: Kind; active?: boolean; onManageTextProviders?: () => void }) {
  const [localKind, setLocalKind] = useState<Kind>("image");
  if (suppliedKind) return <MediaConnectionForm key={suppliedKind} remote={remote} kind={suppliedKind} active={active}/>;
  return <div><nav className="jz-media-tabs" aria-label="模型类型">{(["image", "video"] as const).map(kind => <button key={kind} type="button" aria-pressed={localKind === kind} onClick={() => setLocalKind(kind)}>{labels[kind]}</button>)}</nav>{(["image", "video"] as const).map(kind => <div key={kind} hidden={localKind !== kind}><MediaConnectionForm remote={remote} kind={kind} active={active && localKind === kind}/></div>)}</div>;
}
