import { ErrorText } from "../ui/ErrorText.tsx";
import { ActionIcon } from "../ui/ActionIcon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { JizuoContentRemote } from "../content/remote.ts";
import type { MainVideoComposer } from "./main-video-composer.ts";
import { useMediaGenerationSettings } from "./useMediaGenerationSettings.ts";
import "./composer-model-type-control.css";

export interface ComposerInputPhaseStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { phase?: string };
}
export interface ComposerModelTypeControlProps {
  sessionId: string;
  composer: MainVideoComposer;
  remote: JizuoContentRemote;
  inputStore?: ComposerInputPhaseStore | undefined;
  available?: boolean | undefined;
  locked?: boolean | undefined;
}
const labels = { text: "对话", image: "图片", video: "视频" } as const;
const descriptions = { text: "与 AI 讨论和优化提示词", image: "生成图片并保存到素材库", video: "生成视频并在工作区查看" } as const;
type Kind = keyof typeof labels;
type Menu = "type" | "model";
const idleInput = { getSnapshot: () => "plain", subscribe: () => () => {} };
const hostname = (url: string) => { try { return new URL(url).hostname; } catch { return "自定义接口"; } };

/** An independent input-bar action: native text-model selection remains owned by the host. */
export function ComposerModelTypeControl({ sessionId, composer, remote, inputStore, available = true, locked = false }: ComposerModelTypeControlProps) {
  const selected = useSyncExternalStore(listener => composer.subscribe(sessionId, listener), () => composer.getSnapshot(sessionId));
  const phase = useSyncExternalStore(inputStore ? listener => inputStore.subscribe(listener) : idleInput.subscribe, inputStore ? () => inputStore.getSnapshot().phase ?? "plain" : idleInput.getSnapshot);
  const media = useMediaGenerationSettings(remote);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const typeTrigger = useRef<HTMLButtonElement>(null);
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const busy = locked || phase === "submitting" || phase === "adjudicating";
  const connections = media.view?.connections ?? [];
  const current = connections.find(item => item.kind === selected.kind && (selected.connectionId ? item.id === selected.connectionId : item.isDefault));
  const modelName = current?.config.model ?? (selected.connectionId ? "模型已不可用" : `选择${labels[selected.kind]}模型`);
  const choices = connections.filter(item => item.kind === selected.kind && `${item.config.model} ${hostname(item.config.baseUrl)}`.toLowerCase().includes(query.trim().toLowerCase()));
  const close = (restoreFocus = false) => {
    if (restoreFocus) (menu === "model" ? modelTrigger : typeTrigger).current?.focus();
    setMenu(null);
  };

  useEffect(() => { setMenu(null); setError(""); setQuery(""); }, [sessionId]);
  useEffect(() => { if (busy || !available) setMenu(null); }, [busy, available]);
  useLayoutEffect(() => {
    if (!menu) return;
    const anchor = menu === "type" ? typeTrigger : modelTrigger;
    const place = () => {
      if (!anchor.current) return;
      const rect = anchor.current.getBoundingClientRect();
      const width = Math.min(menu === "type" ? 248 : 320, window.innerWidth - 24);
      const above = rect.top - 16, below = window.innerHeight - rect.bottom - 16;
      const up = above > below;
      setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), maxHeight: Math.max(0, Math.min(420, up ? above : below)), ...(up ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }) });
    };
    place();
    (menu === "type" ? popup.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') : popup.current?.querySelector<HTMLInputElement>("input"))?.focus();
    const outside = (event: Event) => {
      if (event.target instanceof Node && !popup.current?.contains(event.target) && !typeTrigger.current?.contains(event.target) && !modelTrigger.current?.contains(event.target)) setMenu(null);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenu(null); anchor.current?.focus(); }
    };
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [menu]);

  const change = (kind: Kind, connectionId?: string) => {
    if (busy) return;
    try {
      if (!composer.selectModel(sessionId, { kind, ...(connectionId ? { connectionId } : {}) })) {
        setError("输入框暂时无法切换，请稍后重试。"); return;
      }
      setError(""); close(true);
    } catch { setError("输入框暂时无法切换，请稍后重试。"); }
  };
  const chooseKind = (kind: Kind) => {
    if (kind === selected.kind) { close(true); return; }
    const candidates = connections.filter(item => item.kind === kind && item.keyConfigured);
    change(kind, (candidates.find(item => item.isDefault) ?? candidates[0])?.id);
  };
  const open = (next: Menu) => { setMenu(menu === next ? null : next); setQuery(""); setError(""); };
  const navigateTypes = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : event.key === "ArrowUp" ? (index + items.length - 1) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : undefined;
    if (next !== undefined) { event.preventDefault(); items[next]?.focus(); }
    if (event.key === "Tab") setMenu(null);
  };

  if (!available) return null;
  return <div className="jz-composer-type-control" data-jizuo-composer-kind={selected.kind}>
    <button ref={typeTrigger} type="button" className="jz-composer-type-trigger" disabled={busy} aria-haspopup="menu" aria-expanded={menu === "type"} aria-controls={menu === "type" ? id : undefined} title={`当前类型：${labels[selected.kind]}`} aria-label={`当前对话类型：${labels[selected.kind]}，切换类型`} onClick={() => open("type")}>
      <ActionIcon name={selected.kind === "text" ? "chat" : selected.kind} />
    </button>
    {selected.kind !== "text" && <button ref={modelTrigger} type="button" className="jz-composer-type-trigger jz-composer-type-model" disabled={busy} aria-haspopup="dialog" aria-expanded={menu === "model"} aria-controls={menu === "model" ? id : undefined} aria-label={`选择${labels[selected.kind]}模型，当前：${modelName}`} title={modelName} onClick={() => open("model")}>
      <span className="jz-composer-control-label">{modelName}</span>
    </button>}
    {menu && createPortal(<div ref={popup} id={id} className="jz-composer-type-popup" style={position} role={menu === "type" ? "menu" : "dialog"} aria-label={menu === "type" ? "当前对话类型" : `选择${labels[selected.kind]}模型`} onKeyDown={menu === "type" ? navigateTypes : undefined}>
      {menu === "type" ? (Object.keys(labels) as Kind[]).map(kind => <button type="button" className="jz-composer-type-option" key={kind} role="menuitemradio" aria-checked={selected.kind === kind} disabled={busy} onClick={() => chooseKind(kind)}>
        <span><span>{labels[kind]}</span><small>{descriptions[kind]}</small></span>{selected.kind === kind && <span aria-hidden="true">✓</span>}
      </button>) : <>
        <input type="search" className="jz-composer-type-search" aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="jz-composer-type-options" role="group" aria-label={`${labels[selected.kind]}模型`}>
          {choices.map(item => <button type="button" className="jz-composer-type-option" key={item.id} disabled={busy || !item.keyConfigured} aria-pressed={current?.id === item.id} onClick={() => change(item.kind, item.id)}>
            <span><span>{item.config.model}</span><small>{item.config.protocol === "nspox" ? "NSPOX" : hostname(item.config.baseUrl)}{item.isDefault ? " · 默认" : ""}{!item.keyConfigured ? " · 未配置凭据" : ""}</small></span>{current?.id === item.id && <span aria-hidden="true">✓</span>}
          </button>)}
          {media.loading && <p role="status">正在读取生成模型…</p>}
          {!media.loading && !choices.length && <p>{query ? "没有匹配的模型" : `暂无${labels[selected.kind]}模型，请前往设置中的模型页面添加。`}</p>}
          {media.error && <p role="alert">{<ErrorText error={media.error} operation="ComposerModelTypeControl" />}</p>}
        </div>
        <div className="jz-composer-type-footer"><small>仅用于当前对话</small><IconButton icon="reset" label={"刷新"} type="button" disabled={media.loading} onClick={media.refresh} /></div>
      </>}
      {error && <p role="alert">{error}</p>}
    </div>, document.body)}
  </div>;
}
