import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelOutputLimit } from "@jizuo/contracts";
import { ModelLimitRow, type ModelOutputSettingsRemote } from "./ModelOutputSettings.tsx";
import "./model-output.css";

export interface ProviderModelsSettingsOwner {
  provider: {
    provider: string;
    displayName: string;
    settingsNs: string;
    settingsPath: readonly string[];
    active: boolean;
  };
  configured: boolean;
  keyConfigured: boolean;
}

export interface ProviderModelsSettingsProps extends ProviderModelsSettingsOwner {
  remote: ModelOutputSettingsRemote;
}

export function ProviderModelsSettings({ provider, configured, keyConfigured, remote }: ProviderModelsSettingsProps) {
  const [models, setModels] = useState<ModelOutputLimit[]>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const generation = useRef(0);
  const refresh = () => {
    const current = ++generation.current;
    setError(undefined);
    remote.list(provider.provider).then((rows) => {
      if (generation.current === current) setModels(rows);
    }, (reason) => {
      if (generation.current === current) setError(userErrorMessage(reason, "模型列表加载失败", { operation: "ProviderModelsSettings", effect: "read" }));
    });
  };
  useEffect(() => {
    if (!configured) return;
    refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = remote.subscribe?.(() => {
      if (timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; refresh(); }, 0);
    });
    return () => {
      generation.current += 1;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [configured, provider.provider, remote]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized === "" ? models ?? [] : (models ?? []).filter((model) =>
      model.model.toLocaleLowerCase().includes(normalized) || model.modelName.toLocaleLowerCase().includes(normalized));
  }, [models, query]);
  const visible = query.trim() !== "" || showAll ? filtered : filtered.slice(0, 5);
  if (!configured) return <div className="jz-provider-models"><p>保存提供方后可配置实际模型的输出上限。</p></div>;
  // keyConfigured describes the native editor's credential join. Active keyless routes are valid,
  // so runtime activity and per-model writability remain the editing authority.
  void keyConfigured;
  const reason = !provider.active ? "当前提供方未启用，模型输出设置暂时只读。" : undefined;
  return <section className="jz-provider-models" aria-label={`${provider.displayName} 模型输出`}>
    <div className="jz-provider-models-head">
      <strong>模型输出上限</strong>
      <IconButton icon="reset" label={"刷新"} type="button" onClick={refresh} />
    </div>
    {error ? <p role="alert">{error}</p> : !models ? <p role="status">正在加载模型…</p> : models.length === 0 ?
      <p>尚未发现已配置模型。请使用上方提供方的获取或添加模型入口。</p> : <>
        {models.length > 5 && <input type="search" aria-label={`搜索 ${provider.displayName} 模型`} placeholder="搜索模型名称或 ID" value={query} onChange={(event) => setQuery(event.target.value)} />}
        <div className="jz-provider-model-list">{visible.map((model) => <ModelLimitRow
          key={`${model.provider}\0${model.model}`} model={model} remote={remote} compact
          {...(reason === undefined ? {} : { readOnlyReason: reason })} />)}</div>
        {query.trim() === "" && filtered.length > 5 && <IconButton icon="list" label={(showAll ? "收起模型列表" : `显示全部 ${filtered.length} 个模型`)} className="jz-provider-models-more" type="button" onClick={() => setShowAll((value) => !value)} />}
      </>}
  </section>;
}
