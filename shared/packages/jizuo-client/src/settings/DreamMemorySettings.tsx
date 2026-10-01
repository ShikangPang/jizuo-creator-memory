import { userErrorMessage } from "@jizuo/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkSummary } from "@jizuo/contracts";
import { DreamSettings } from "../memory/DreamSettings.tsx";
import { createDreamSettingsRemote, type DreamRemoteSource } from "../memory/dreamRemote.ts";
import { getSelection } from "../content/selection.ts";
import "../memory/memory.css";

export interface DreamMemorySettingsRemote extends DreamRemoteSource {
  listWorks(): Promise<WorkSummary[]>;
}

export function DreamMemorySettings({ remote, subscribeWorksChanges }: {
  remote: DreamMemorySettingsRemote;
  subscribeWorksChanges?: (listener: () => void) => (() => void) | Promise<() => void>;
}) {
  const [works, setWorks] = useState<WorkSummary[]>([]);
  const [workId, setWorkId] = useState<string>();
  const [error, setError] = useState<string>();
  const request = useRef(0);
  const refresh = async () => {
    const id = ++request.current;
    try {
      const items = await remote.listWorks();
      if (request.current !== id) return;
      setWorks(items); setWorkId((current) => {
        if (current && items.some((item) => item.id === current)) return current;
        const selectedWorkId = getSelection().workId;
        return selectedWorkId && items.some((item) => item.id === selectedWorkId) ? selectedWorkId : items[0]?.id;
      });
    } catch (reason) { if (request.current === id) setError(userErrorMessage(reason, "作品列表加载失败", { operation: "DreamMemorySettings", effect: "read" })); }
  };
  useEffect(() => { void refresh(); return () => { request.current += 1; }; }, [remote]);
  useEffect(() => {
    if (!subscribeWorksChanges) return;
    let dispose: (() => void) | undefined; let active = true;
    Promise.resolve().then(() => subscribeWorksChanges(() => { void refresh(); })).then((value) => { if (active) dispose = value; else value(); }).catch((reason: unknown) => {
      if (active) setError(userErrorMessage(reason, "作品变更订阅失败", { operation: "DreamMemorySettings" }));
    });
    return () => { active = false; dispose?.(); };
  }, [remote, subscribeWorksChanges]);
  const workRemote = useMemo(() => workId ? createDreamSettingsRemote(remote, workId) : undefined, [remote, workId]);
  return <section className="jz-dream-settings-page" aria-label="梦境记忆">
    <header><div><h2>梦境记忆</h2><p>每部作品独立保存开关、模型和额度。</p></div>{works.length > 0 && <label><span>作品</span><select aria-label="选择作品" value={workId ?? ""} onChange={(event) => { setWorkId(event.target.value); }} >{works.map((work) => <option key={work.id} value={work.id}>{work.title}</option>)}</select></label>}</header>
    {error && <p role="alert">{error}</p>}
    {!error && works.length === 0 ? <p className="jz-dream-empty">创建或导入作品后，可以在这里配置梦境记忆。</p> : workRemote && workId ? <DreamSettings key={workId} remote={workRemote} showHeader={false} /> : null}
  </section>;
}
