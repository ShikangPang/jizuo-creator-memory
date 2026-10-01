import { ActionIcon } from "../ui/ActionIcon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useMemo, useRef, useState } from "react";

import { DreamSettings } from "../memory/DreamSettings.tsx";
import { createDreamSettingsRemote } from "../memory/dreamRemote.ts";
import {
  MemoryPalace,
  type MemoryGraphControllerFactory,
  type MemoryPalaceOverlayRemote,
} from "../memory/MemoryPalace.tsx";
import { setSelection, useSelection } from "../content/selection.ts";
import {
  applyConversationInset,
  clearConversationInset,
  getInspectorWidth,
  setInspectorWidth,
} from "./shellChrome.ts";
import "./overlay.css";

type MemoryTab = "graph" | "dream";

function CloseIcon() {
  return (
    <ActionIcon name="close" className="jz-native-icon" />
  );
}

export function MemoryPalaceOverlay({
  remote,
  close,
  controllerFactory,
}: {
  remote: MemoryPalaceOverlayRemote;
  close?: () => void;
  controllerFactory?: MemoryGraphControllerFactory;
}) {
  const selection = useSelection();
  const [tab, setTab] = useState<MemoryTab>("graph");
  const [panelWidth, setPanelWidth] = useState(getInspectorWidth);
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const shownWidth = expanded ? panelWidth : 0;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { setExpanded(true); });
    return () => { window.cancelAnimationFrame(frame); };
  }, []);

  useEffect(() => {
    applyConversationInset(shownWidth, !dragging);
    return clearConversationInset;
  }, [shownWidth, dragging]);

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      if (drag.current === null) return;
      setPanelWidth(setInspectorWidth(drag.current.startWidth + event.clientX - drag.current.startX));
    };
    const up = (): void => {
      if (drag.current === null) return;
      drag.current = null;
      setDragging(false);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
  }, []);

  const workId = selection.workId;
  const dreamRemote = useMemo(() => workId === null ? null : createDreamSettingsRemote(remote, workId), [remote, workId]);

  const closeOverlay = (): void => {
    setSelection({ overlay: null });
    close?.();
  };

  return (
    <section
      data-plugin="jizuo"
      data-surface="memory-overlay"
      className={[
        "jz-native-inspector",
        "docked",
        expanded ? "open" : "",
        dragging ? "dragging" : "",
        panelWidth >= 620 ? "wide" : "",
      ].filter(Boolean).join(" ")}
      aria-label="记忆宫殿面板"
      style={{ width: shownWidth }}
    >
      <header className="jz-native-inspector-header">
        <div className="jz-native-title-row">
          <div>
            <h2>记忆宫殿</h2>
            <p>当前作品 · 仅展示已确认且未越过章节边界的记忆</p>
          </div>
          <button type="button" className="jz-native-close" aria-label="关闭记忆宫殿" onClick={closeOverlay}>
            <CloseIcon />
          </button>
        </div>
        <div className="jz-native-tabs" role="tablist" aria-label="记忆宫殿视图">
          <IconButton icon="memory" label={"记忆图谱"}
            type="button"
            role="tab"
            aria-selected={tab === "graph"}
            className={tab === "graph" ? "active" : ""}
            onClick={() => { setTab("graph"); }}
           />
          <IconButton icon="sparkles" label={"梦境记忆"}
            type="button"
            role="tab"
            aria-selected={tab === "dream"}
            className={tab === "dream" ? "active" : ""}
            onClick={() => { setTab("dream"); }}
           />
        </div>
      </header>

      <div className={tab === "graph" ? "jz-native-inspector-body graph" : "jz-native-inspector-body"}>
        {workId === null ? (
          <div className="jz-inspector-empty">请先选择作品</div>
        ) : tab === "graph" ? (
          <MemoryPalace
            key={workId}
            workId={workId}
            remote={remote}
            {...(controllerFactory === undefined ? {} : { controllerFactory })}
            initialQuery={{ mode: "current", identities: [] }}
          />
        ) : dreamRemote === null ? null : (
          <DreamSettings remote={dreamRemote} />
        )}
      </div>

      <div
        className="jz-native-resize"
        aria-hidden="true"
        onPointerDown={(event) => {
          event.preventDefault();
          drag.current = { startX: event.clientX, startWidth: panelWidth };
          setDragging(true);
        }}
      />
    </section>
  );
}
