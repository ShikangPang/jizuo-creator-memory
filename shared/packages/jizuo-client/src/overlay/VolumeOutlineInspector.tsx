import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useMemo, useState } from "react";

import type { VolumeSummary } from "@jizuo/contracts";

import type { JizuoContentRemote } from "../content/remote.ts";
import { setSelection, useSelection } from "../content/selection.ts";
import { applyConversationInset, clearConversationInset } from "./shellChrome.ts";
import "./overlay.css";

type VolumeTab = "outline" | "detailed-outline";
type SaveState = "idle" | "saving" | "saved" | "error";

function messageOf(error: unknown): string {
  return userErrorMessage(error, "分卷大纲操作失败，请重试", { operation: "VolumeOutlineInspector" });
}

export function VolumeOutlineInspector({
  remote,
  close,
}: {
  remote: JizuoContentRemote;
  close?: () => void;
}) {
  const selection = useSelection();
  const target = useMemo(() => (
    selection.workId === null || selection.volumeId === null
      ? null
      : { workId: selection.workId, volumeId: selection.volumeId }
  ), [selection.volumeId, selection.workId]);
  const [volume, setVolume] = useState<VolumeSummary | null>(null);
  const [outline, setOutline] = useState("");
  const [detailedOutline, setDetailedOutline] = useState("");
  const [activeTab, setActiveTab] = useState<VolumeTab>("outline");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  useEffect(() => {
    applyConversationInset(620);
    return clearConversationInset;
  }, []);

  useEffect(() => {
    if (target === null) {
      setVolume(null);
      setOutline("");
      setDetailedOutline("");
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    remote.listVolumes({ workId: target.workId }).then((items) => {
      if (!active) return;
      const next = items.find((item) => item.id === target.volumeId);
      if (next === undefined) throw new Error("分卷不存在或已被删除");
      setVolume(next);
      setOutline(next.outline);
      setDetailedOutline(next.detailedOutline);
      setSaveState("idle");
    }).catch((cause: unknown) => {
      if (active) setError(messageOf(cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [remote, target]);

  const save = async (): Promise<void> => {
    if (target === null || volume === null) return;
    setSaveState("saving");
    setError(null);
    try {
      const next = await remote.saveVolumeOutline({ ...target, outline, detailedOutline });
      setVolume(next);
      setOutline(next.outline);
      setDetailedOutline(next.detailedOutline);
      setSaveState("saved");
    } catch (cause) {
      setSaveState("error");
      setError(messageOf(cause));
    }
  };

  const closeInspector = (): void => {
    setSelection({ overlay: null });
    close?.();
  };
  const dirty = volume !== null
    && (outline !== volume.outline || detailedOutline !== volume.detailedOutline);

  return (
    <section data-plugin="jizuo" data-surface="volume-outline" aria-label="分卷大纲编辑器">
      <header className="jz-inspector-header">
        <div>
          <p>{activeTab === "outline" ? "卷大纲" : "卷细纲"}</p>
          <h2>{volume?.title ?? "正在读取分卷"}</h2>
        </div>
        <IconButton icon="close" label={"关闭分卷大纲"} type="button" aria-label="关闭分卷大纲" onClick={closeInspector} />
      </header>

      <div className="jz-outline-tabs" role="tablist" aria-label="分卷大纲类型">
        <IconButton icon="outline" label={"卷大纲"} type="button" role="tab" aria-selected={activeTab === "outline"} onClick={() => { setActiveTab("outline"); }} />
        <IconButton icon="list" label={"卷细纲"} type="button" role="tab" aria-selected={activeTab === "detailed-outline"} onClick={() => { setActiveTab("detailed-outline"); }} />
      </div>

      {target === null && <div className="jz-inspector-empty">请先选择一个分卷。</div>}
      {target !== null && loading && <div className="jz-inspector-empty">正在加载分卷大纲…</div>}
      {target !== null && !loading && error !== null && volume === null && (
        <div className="jz-inspector-error" role="alert">{error}</div>
      )}

      {volume !== null && (
        <div className="jz-inspector-body">
          <div className="jz-inspector-save-row">
            <span aria-live="polite">
              {saveState === "saving" && "正在保存"}
              {saveState === "saved" && "已保存"}
              {saveState === "error" && "保存失败"}
              {saveState === "idle" && (dirty ? "尚未保存" : "已同步")}
            </span>
            <IconButton icon="save" label={(activeTab === "outline" ? "保存卷大纲" : "保存卷细纲")} type="button" disabled={saveState === "saving" || !dirty} onClick={() => { void save(); }} />
          </div>
          {error !== null && <p className="jz-inspector-error" role="alert">{error}</p>}

          {activeTab === "outline" ? (
            <label className="jz-inspector-editor jz-outline-editor">
              <span>卷大纲</span>
              <textarea
                aria-label="卷大纲"
                value={outline}
                spellCheck={false}
                placeholder="概括本卷的主线目标、核心冲突和结局"
                onChange={(event) => { setOutline(event.target.value); setSaveState("idle"); }}
              />
            </label>
          ) : (
            <label className="jz-inspector-editor jz-outline-editor">
              <span>卷细纲</span>
              <textarea
                aria-label="卷细纲"
                value={detailedOutline}
                spellCheck={false}
                placeholder="按章节或阶段拆分本卷的情节推进"
                onChange={(event) => { setDetailedOutline(event.target.value); setSaveState("idle"); }}
              />
            </label>
          )}
        </div>
      )}
    </section>
  );
}
