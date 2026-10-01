import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ModelOutputLimit, SaveModelOutputLimit } from "@jizuo/contracts";
import "./model-output.css";

export interface ModelOutputSettingsRemote {
  list(provider?: string): Promise<ModelOutputLimit[]>;
  save(input: SaveModelOutputLimit): Promise<void>;
  subscribe?(listener: () => void): () => void;
}

const format = (value: number | null) => value === null ? "由模型提供方决定" : value.toLocaleString("en-US");

export function ModelLimitRow({ model, remote, compact = false, readOnlyReason }: {
  model: ModelOutputLimit;
  remote: ModelOutputSettingsRemote;
  compact?: boolean;
  readOnlyReason?: string;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState(String(model.configuredMaxTokens ?? ""));
  const [saved, setSaved] = useState(model.configuredMaxTokens);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [expanded, setExpanded] = useState(!compact);
  const persistedVersion = useRef(0);
  const savedRef = useRef(model.configuredMaxTokens);
  const editable = model.writable && readOnlyReason === undefined;
  useEffect(() => {
    persistedVersion.current += 1;
    savedRef.current = model.configuredMaxTokens;
    setSaved(model.configuredMaxTokens);
    if (!dirty) setDraft(String(model.configuredMaxTokens ?? ""));
  }, [model.configuredMaxTokens]);
  const save = async (reset = false) => {
    setError(undefined); setMessage(undefined);
    const value = reset || draft.trim() === "" ? null : Number(draft);
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0 || (model.contextWindow !== null && value > model.contextWindow))) {
      setError("请输入不超过上下文容量的正整数，或留空恢复默认");
      return;
    }
    const startingPersistedVersion = persistedVersion.current;
    setBusy(true);
    try {
      await remote.save({ provider: model.provider, model: model.model, maxTokens: value });
      if (persistedVersion.current === startingPersistedVersion) {
        savedRef.current = value;
        setSaved(value);
        setDraft(String(value ?? ""));
      } else {
        setDraft(String(savedRef.current ?? ""));
      }
      setDirty(false);
      setMessage(value === null ? "已恢复默认，从后续模型请求生效" : "已保存，从后续模型请求生效");
    } catch (reason) {
      setError(userErrorMessage(reason, "保存失败，请重试", { operation: "ModelOutputSettings" }));
    } finally { setBusy(false); }
  };
  return (
    <fieldset className={`jz-output-model${compact ? " jz-output-model--compact" : ""}`} aria-label={`${model.providerName} / ${model.modelName}`}>
      <legend>
        {compact ? <button className="jz-output-row-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          <span>{model.modelName}</span><span className="jz-output-identity">{model.model}</span>
          <span>{format(saved ?? model.defaultMaxTokens ?? model.maxTokens)} tokens</span>
        </button> : <>{model.modelName}<span>{model.providerName}</span></>}
      </legend>
      {!compact && <p className="jz-output-identity">{model.model}</p>}
      {expanded && <div className="jz-output-details">
      <p>上下文容量：{format(model.contextWindow)} tokens</p>
      {!compact && <p>当前输出上限：{format(saved ?? model.defaultMaxTokens ?? model.maxTokens)} tokens</p>}
      <div className="jz-output-controls">
        <label htmlFor={inputId}>最大输出 tokens</label>
        <input id={inputId} type="number" inputMode="numeric" min={1} step={1} max={model.contextWindow ?? undefined}
          disabled={!editable || busy}
          placeholder={`默认：${format(model.defaultMaxTokens)}`} value={draft}
          onChange={(event) => { setDraft(event.target.value); setDirty(true); setError(undefined); setMessage(undefined); }} />
        <IconButton icon="save" label={(busy ? "保存中…" : "保存")} type="button" disabled={!editable || busy} onClick={() => { void save(); }} />
        <IconButton icon="reset" label={"恢复默认"} type="button" disabled={!editable || busy} onClick={() => { void save(true); }} />
      </div>
      {readOnlyReason && <p className="jz-output-readonly">{readOnlyReason}</p>}
      {!model.writable && !readOnlyReason && <p className="jz-output-readonly">此模型的设置只读，请在提供方配置中调整。</p>}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      </div>}
    </fieldset>
  );
}

export function ModelOutputSettings({ remote }: { remote: ModelOutputSettingsRemote }) {
  const [models, setModels] = useState<ModelOutputLimit[]>();
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const requestReload = useCallback(() => {
    if (timer.current !== undefined) return;
    timer.current = setTimeout(() => { timer.current = undefined; setReload((value) => value + 1); }, 0);
  }, []);
  useEffect(() => {
    let active = true;
    setError(undefined);
    remote.list().then((rows) => { if (active) setModels(rows); }, (reason) => {
      if (active) setError(userErrorMessage(reason, "模型列表加载失败", { operation: "ModelOutputSettings", effect: "read" }));
    });
    return () => { active = false; };
  }, [remote, reload]);
  useEffect(() => {
    const unsubscribe = remote.subscribe?.(requestReload);
    return () => { unsubscribe?.(); if (timer.current !== undefined) clearTimeout(timer.current); };
  }, [remote, requestReload]);
  return (
    <section className="jz-model-output" aria-label="模型输出设置" aria-busy={!models && !error}>
      <header><h2>模型输出</h2><IconButton icon="reset" label={"刷新"} type="button" onClick={requestReload} /></header>
      <p>每个提供方下的模型独立设置，普通聊天与工作流 Agent 共用。留空使用模型默认值。</p>
      <p>上下文容量不等于单次输出上限。实际输出仍受模型能力和剩余上下文限制；提高上限可能增加耗时和用量，不会续写已中断的回复。</p>
      {error ? <p role="alert">{error}</p> : !models ? <p role="status">正在加载模型…</p> : models.length === 0 ? <p>暂无已配置模型，请先在“模型”设置中添加提供方。</p> : models.map((model) => (
        <ModelLimitRow key={JSON.stringify([model.provider, model.model])} model={model} remote={remote} />
      ))}
    </section>
  );
}
