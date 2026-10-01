import { VideoTextInput } from "./VideoTextInput.tsx";
import { useVideoFont } from "./useVideoFont.ts";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { VideoTextOverlay } from "@jizuo/contracts";

export function VideoCanvasText({ text, selected, disabled, onSelect, onChange }: {
  text: VideoTextOverlay; selected: boolean; disabled: boolean;
  onSelect?: ((text: VideoTextOverlay) => void) | undefined;
  onChange?: ((text: VideoTextOverlay) => void) | undefined;
}) {
  useVideoFont(text.style.fontFamily);
  const [editing, setEditing] = useState(false);
  const beforeEdit = useRef(text.text);

  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editing) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) { container.current?.querySelector("textarea")?.blur(); setEditing(false); }
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [editing]);
  useEffect(() => {
    const input = container.current?.querySelector("textarea");
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [editing, text.text, text.style.width]);
  const drag = useRef<{ text: VideoTextOverlay; x: number; y: number; width: number; height: number; original?: VideoTextOverlay; edge?: "left" | "right" }>();
  const interactive = Boolean(onSelect && onChange) && !disabled;
  const edit = () => { if (!interactive || editing) return; drag.current = undefined; onSelect?.(text); beforeEdit.current = text.text; setEditing(true); };
  const angle = text.style.direction === "rotate90" ? 90 : text.style.direction === "rotate270" ? -90 : 0;
  const boxed = text.style.width !== undefined;
  const anchor = text.style.align === "left" ? 0 : text.style.align === "right" ? 1 : 0.5;
  return <div ref={container} className="jz-text-overlay" data-selected={selected} data-interactive={interactive} data-editing={editing} data-snap-x={selected && text.style.x === 50} data-snap-y={selected && [10, 50, 90].includes(text.style.y)}
    role={interactive ? "button" : undefined} tabIndex={interactive ? 0 : undefined} aria-label={interactive ? `画面文本 ${text.text}` : undefined}
    title={interactive ? "拖动调整位置，拖动两侧调整宽度，双击编辑文本" : undefined}
    style={{ fontFamily: `"${text.style.fontFamily ?? "Arial"}", sans-serif`, left: `${text.style.x}%`, top: `${text.style.y}%`, fontSize: `${text.style.fontSize}cqh`, color: text.style.color,
      width: boxed ? `${text.style.width}%` : undefined, maxWidth: boxed ? "100%" : "90%",
      fontWeight: text.style.bold ? 700 : 400, textAlign: text.style.align,
      transformOrigin: `${anchor * 100}% ${boxed ? "0" : "50%"}`,
      transform: `translate(${-anchor * 100}%, ${boxed ? "0" : "-50%"}) rotate(${angle}deg)`,
      WebkitTextStroke: text.style.outline ? "0.15cqh black" : "0", paintOrder: "stroke fill" }}
    onClick={() => { if (interactive && !editing) onSelect?.(text); }} onDoubleClick={event => { event.stopPropagation(); edit(); }}
    onPointerDown={event => {
      if (!interactive || editing || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const bounds = event.currentTarget.closest(".jz-timeline-screen")?.getBoundingClientRect();
      onSelect?.(text);
      if (!bounds?.width || !bounds.height) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { text, x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height };
    }} onPointerMove={event => {
      const current = drag.current; if (!current) return;
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) <= 4) return;
      if (current.edge) {
        const radians = angle * Math.PI / 180;
        const delta = ((event.clientX - current.x) * Math.cos(radians) + (event.clientY - current.y) * Math.sin(radians)) / current.width * 100;
        const oldWidth = current.text.style.width ?? 90;
        const width = Math.max(5, Math.min(100, oldWidth + (current.edge === "right" ? delta : -delta)));
        const shift = (width - oldWidth) * (current.edge === "right" ? anchor : anchor - 1);
        onChange?.({ ...current.text, style: { ...current.text.style, width: Number(width.toFixed(2)),
          x: Math.max(0, Math.min(100, current.text.style.x + shift * Math.cos(radians))),
          y: Math.max(0, Math.min(100, current.text.style.y + shift * current.width / current.height * Math.sin(radians))),
        } });
        return;
      }
      let x = Math.max(0, Math.min(100, current.text.style.x + (event.clientX - current.x) / current.width * 100));
      let y = Math.max(0, Math.min(100, current.text.style.y + (event.clientY - current.y) / current.height * 100));
      if (!event.altKey) {
        if (Math.abs(x - 50) <= 1.5) x = 50;
        for (const guide of [10, 50, 90]) if (Math.abs(y - guide) <= 1.5) { y = guide; break; }
      }
      onChange?.({ ...current.text, style: { ...current.text.style, x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) } });
    }} onPointerUp={event => { drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { if (drag.current) onChange?.(drag.current.original ?? drag.current.text); drag.current = undefined; }}
    onLostPointerCapture={() => { drag.current = undefined; }}
    onKeyDown={event => {
      if (!interactive || editing) return;
      if (event.key === "Enter") { event.preventDefault(); edit(); return; }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault(); onSelect?.(text);
      const step = event.shiftKey ? 5 : 0.5;
      onChange?.({ ...text, style: { ...text.style,
        x: Math.max(0, Math.min(100, text.style.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0))),
        y: Math.max(0, Math.min(100, text.style.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0))),
      } });
    }}>
    {editing ? <VideoTextInput aria-label="画面文本内容" autoFocus rows={Math.max(1, text.text.split("\n").length)} maxLength={50000}
      value={text.text} style={{ width: "100%", fieldSizing: "content" } as CSSProperties}
      onTextChange={value => onChange?.({ ...text, text: value })} onDoubleClick={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") { onChange?.({ ...text, text: beforeEdit.current }); setEditing(false); }
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); setEditing(false); }
      }} /> : text.text}
    {selected && interactive && !editing && (["left", "right"] as const).map(edge => <span key={edge} role="slider" tabIndex={0} aria-label={edge === "left" ? "调整文本框左边界" : "调整文本框右边界"} aria-valuemin={5} aria-valuemax={100} aria-valuenow={text.style.width ?? 90}
      className={`jz-text-resize jz-text-resize-${edge}`}
      onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onKeyDown={event => { event.stopPropagation(); if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); onChange?.({ ...text, style: { ...text.style, width: Math.max(5, Math.min(100, (text.style.width ?? 90) + (event.key === "ArrowRight" ? 1 : -1))) } }); }}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation();
        const bounds = container.current?.closest(".jz-timeline-screen")?.getBoundingClientRect();
        if (!bounds?.width || !bounds.height) return;
        container.current!.setPointerCapture(event.pointerId);
        const width = text.style.width ?? (container.current!.getBoundingClientRect()[angle ? "height" : "width"] / bounds.width * 100);
        const rect = container.current!.getBoundingClientRect();
        const halfHeight = (angle ? rect.width : rect.height) / 2;
        const radians = angle * Math.PI / 180;
        drag.current = { original: text, text: { ...text, style: { ...text.style,
          ...(!boxed ? { x: text.style.x + Math.sin(radians) * halfHeight / bounds.width * 100, y: text.style.y - Math.cos(radians) * halfHeight / bounds.height * 100 } : {}),
          width: Math.max(5, Math.min(100, width)) } }, x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height, edge };
      }} />)}
  </div>;
}
