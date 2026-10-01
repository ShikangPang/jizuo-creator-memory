import { IconButton } from "../ui/IconButton.tsx";
import type { TimelineClipboard } from "./timeline-clipboard.ts";
import type { MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { VideoToolIcon } from "./VideoToolIcon.tsx";
import { snapTime } from "./timeline-snapping.ts";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { VideoTextFont, videoTextFontLabels, type VideoTextOverlay } from "@jizuo/contracts";
import type { TimelineEdit } from "../../../contracts/src/video-editing.ts";

type TrackTarget = { kind: "new"; beforeTrackId?: string; top: number } | { kind: "existing"; trackId?: string; lane: number };
type Drag = { group: VideoTextOverlay[]; original: VideoTextOverlay; text: VideoTextOverlay; edge: "start" | "end" | "move"; x: number; y: number; scale: number; revision: number; target?: TrackTarget; gap?:Extract<TrackTarget,{kind:"new"}>; outside?: boolean };
export function VideoTextTrack({ texts, duration, selectedId, busy, revision, onSelect, onContextText, apply, tracks = [], clipboard: sharedClipboard, position = 0, onRemoveTrack, onAddText, snapTargets = [], selectedIds, onSelectionChange, batchProperties }: {
  batchProperties?: HTMLElement | null | undefined;
  selectedIds?: string[];
  onSelectionChange?: import("react").Dispatch<import("react").SetStateAction<string[]>>;
  onContextText?: ((text: VideoTextOverlay, x: number, y: number) => void) | undefined;
  clipboard?: MutableRefObject<TimelineClipboard | undefined>;
  position?: number;
  onRemoveTrack?: ((id:string) => void) | undefined;
  tracks?: Array<{id:string;name:string}>;
  onAddText?: ((time:number, trackId?:string) => void) | undefined;
  snapTargets?: number[];
  texts: VideoTextOverlay[]; duration: number; selectedId?: string | undefined; busy: boolean; revision: number;
  onSelect: (text: VideoTextOverlay) => void; apply: (edit: TimelineEdit, revision?: number) => Promise<unknown>;
}) {
  const localClipboard = useRef<TimelineClipboard>();
  const clipboard = sharedClipboard ?? localClipboard;
  const clipboardSaving = useRef(false);
  const [trackMenu, setTrackMenu] = useState<{id?:string;name:string;x:number;y:number}>();
  const trackMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!trackMenu) return;
    trackMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: Event) => { if (!trackMenuRef.current?.contains(event.target as Node)) setTrackMenu(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setTrackMenu(undefined); };
    window.addEventListener("pointerdown", dismiss); window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", dismiss); window.removeEventListener("keydown", escape); };
  }, [trackMenu]);
  const [localSelected, setLocalSelected] = useState<string[]>([]);
  const selected = selectedIds ?? localSelected;
  const setSelected = onSelectionChange ?? setLocalSelected;
  const [font, setFont] = useState<VideoTextOverlay["style"]["fontFamily"]>("Arial");
  const [size, setSize] = useState(4);
  const [offset, setOffset] = useState(1);
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number }>();
  const marquee = useRef<{ x: number; y: number }>();
  const toggle = (id: string) => setSelected(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);
  useEffect(() => { setSelected(ids => { const valid = ids.filter(id => texts.some(text => text.id === id)); return valid.length === ids.length ? ids : valid; }); }, [texts]);
  const batch = (action: Extract<TimelineEdit, { op: "batchText" }>["action"]) => {
    if (busy || saving || !selected.length) return;
    setSaving(true);
    void apply({ op: "batchText", textIds: selected, action }, revision).finally(() => setSaving(false));
  };
  const drag = useRef<Drag>();
  const moved = useRef(false);
  const [saving, setSaving] = useState(false);
  const [trackTarget, setTrackTarget] = useState<TrackTarget>();
  const [dragOffsetY,setDragOffsetY]=useState(0);
  const [openedGap,setOpenedGap]=useState<Extract<TrackTarget,{kind:"new"}>>();
  const cancel = () => { if (drag.current) { drag.current = undefined; setDraft(undefined); setGroupDraft([]); setTrackTarget(undefined);setDragOffsetY(0);setOpenedGap(undefined); } };
  const [draft, setDraft] = useState<VideoTextOverlay>();
  const [groupDraft, setGroupDraft] = useState<VideoTextOverlay[]>([]);
  const start = (event: PointerEvent<HTMLButtonElement>, text: VideoTextOverlay, edge: Drag["edge"]) => {
    if (busy || saving || duration < 0.5 || event.button !== 0 || event.shiftKey) return;
    event.preventDefault(); event.stopPropagation(); moved.current = false;
    event.currentTarget.focus({ preventScroll: true });
    const width = event.currentTarget.closest(".jz-text-track")!.getBoundingClientRect().width;
    if (!width) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { group: edge === "move" && selected.includes(text.id) ? texts.filter(item => selected.includes(item.id)) : [text], original: text, text, edge, x: event.clientX, y: event.clientY, scale: width / Math.max(1, duration), revision };
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const state = drag.current; if (!state) return;
    if (!moved.current && Math.abs(event.clientX - state.x) <= 4 && (state.edge !== "move" || Math.abs(event.clientY - state.y) <= 4)) return;
    const delta = Math.round((event.clientX - state.x) / state.scale * 100) / 100;
    const original = state.original;
    moved.current = true;
    if (state.edge === "move") {
      setDragOffsetY(event.clientY-state.y);
      const area = event.currentTarget.closest(".jz-text-track")!;
      const bounds = area.getBoundingClientRect();
      const timelineBounds = area.closest(".jz-editing-timeline")?.getBoundingClientRect() ?? bounds;
      state.outside = Boolean(bounds.height && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top - 7 || event.clientY > timelineBounds.bottom + 14));
      const previousTarget=state.gap;
      delete state.target;
      if (bounds.height && !state.outside && Math.abs(event.clientY - state.y) > 4) {
        let y = event.clientY - bounds.top;
        if(previousTarget?.kind==="new" && tracks.length<16) {
          if(y>=previousTarget.top-6 && y<=previousTarget.top+36)state.target=previousTarget;
          else if(y>previousTarget.top+30)y-=30;
        }
        const boundaries = laneTracks.flatMap((id, lane) => lane > 0 && id !== laneTracks[lane - 1] ? [{id, top:lane * 30}] : []);
        const edge = boundaries.find(item => Math.abs(y - item.top) <= 6);
        if(state.target) { /* Keep the opened insertion row under the pointer. */ }
        else if (edge || y >= laneTracks.length * 30 - 6 || y < 0) {
          const firstNamed = boundaries[0];
          const before = edge ?? (y < 0 ? firstNamed : undefined);
          state.target = { kind:"new", ...(before?.id ? {beforeTrackId:before.id} : {}), top:before?.top ?? laneTracks.length * 30 };
        } else {
          const lane = Math.max(0, Math.min(laneTracks.length - 1, Math.floor(y / 30)));
          const trackId = laneTracks[lane];
          state.target = { kind:"existing", ...(trackId ? {trackId} : {}), lane };
        }
      }
      if(state.target?.kind==="new" && tracks.length<16)state.gap=state.target;
      if(state.outside)delete state.gap;
      setOpenedGap(state.gap);
      setTrackTarget(state.target);
    }
    if (state.edge === "move") {
      const length = Math.min(duration, Math.max(0.5, original.endSec - original.startSec));
      const startSec = Math.max(0, Math.min(duration - length, original.startSec + delta));
      state.text = { ...original, startSec, endSec: startSec + length };
    } else if (state.edge === "start") state.text = { ...original, startSec: Math.max(0, Math.min(Math.min(duration, original.endSec) - 0.5, original.startSec + delta)), endSec: Math.min(duration, original.endSec) };
    else state.text = { ...original, endSec: Math.max(original.startSec + 0.5, Math.min(duration, original.endSec + delta)) };
    const targets = [0, duration, ...snapTargets, ...texts.filter(text => !state.group.some(item => item.id === text.id)).flatMap(text => [text.startSec, text.endSec])];
    if (state.edge === "move") {
      const length = state.text.endSec - state.text.startSec;
      const start = snapTime(state.text.startSec, targets, state.scale, event.altKey);
      const end = snapTime(state.text.endSec, targets, state.scale, event.altKey);
      const shifted = Math.max(0, Math.min(duration - length, start !== state.text.startSec ? start : end - length));
      state.text = { ...state.text, startSec: shifted, endSec: shifted + length };
    } else if (state.edge === "start") state.text.startSec = Math.max(0, Math.min(state.text.endSec - 0.5, snapTime(state.text.startSec, targets, state.scale, event.altKey)));
    else state.text.endSec = Math.min(duration, Math.max(state.text.startSec + 0.5, snapTime(state.text.endSec, targets, state.scale, event.altKey)));
    if (state.edge === "move" && state.group.length > 1) {
      const lower = -Math.min(...state.group.map(item => item.startSec));
      const upper = duration - Math.max(...state.group.map(item => item.endSec));
      const shift = Math.max(lower, Math.min(upper, state.text.startSec - original.startSec));
      const group = state.group.map(item => ({ ...item, startSec: item.startSec + shift, endSec: item.endSec + shift }));
      state.text = group.find(item => item.id === original.id)!;
      setGroupDraft(group);
    }
    setDraft(state.text);
  };
  const end = (event: PointerEvent<HTMLButtonElement>) => {
    const state = drag.current; drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (state && state.edge === "move" && !moved.current) {
      setSelected([]);
      onSelect(state.original);
    }
    const target = state?.target;
    const changeTrack = target?.kind === "new" || target?.kind === "existing" && state?.group.some(item => item.trackId !== target.trackId);
    if (state && moved.current && !state.outside && !(target?.kind === "new" && tracks.length >= 16) && (changeTrack || state.text.startSec !== state.original.startSec || state.text.endSec !== state.original.endSec)) {
      setSaving(true);
      const finished = () => { setDraft(undefined); setGroupDraft([]); setSaving(false);setTrackTarget(undefined);setDragOffsetY(0);setOpenedGap(undefined); };
      const edit: TimelineEdit = changeTrack && target ? {op:"moveTextsToTrack", textIds:state.group.map(item => item.id), deltaSec:state.text.startSec-state.original.startSec,
        target:target.kind === "new" ? {kind:"new", track:{id:crypto.randomUUID(),name:`文本轨道 ${tracks.length + 2}`}, ...(target.beforeTrackId ? {beforeTrackId:target.beforeTrackId} : {})} : {kind:"existing", ...(target.trackId ? {trackId:target.trackId} : {})}}
        : state.edge === "move" && state.group.length > 1 ? { op: "batchText", textIds: state.group.map(item => item.id), action: { kind: "move", deltaSec: state.text.startSec - state.original.startSec } } : { op: "saveText", text: state.text };
      void apply(edit, state.revision).then(finished, finished);
    } else { setDraft(undefined); setGroupDraft([]);setTrackTarget(undefined);setDragOffsetY(0);setOpenedGap(undefined); }
  };
  const laneEnds: number[] = [];
  const laneTracks: Array<string | undefined> = [];
  const lanes = new Map<string, number>();
  // Each named track owns its rows, including an empty row for new tracks.
  for (const trackId of [undefined, ...tracks.map(track => track.id)]) {
    const first = laneEnds.length;
    const ends: number[] = [];
    texts.filter(text => text.startSec < duration && text.trackId === trackId).sort((a,b) => a.startSec - b.startSec || a.id.localeCompare(b.id)).forEach(text => {
      const start = Math.min(text.startSec, Math.max(0, duration - 0.05));
      let lane = ends.findIndex(end => end <= start);
      if (lane < 0) lane = ends.length;
      ends[lane] = start + Math.max(0.05, Math.min(text.endSec, duration) - text.startSec);
      lanes.set(text.id, first + lane);
    });
    if (!ends.length) ends.push(0);
    laneEnds.push(...ends); laneTracks.push(...ends.map(() => trackId));
  }
  const outside = texts.filter(text => text.startSec >= duration);
  const insertionTop=openedGap?.top;
  const blocks = texts.filter(text => text.startSec < duration).map(text => {
    const shown = groupDraft.find(item => item.id === text.id) ?? (draft?.id === text.id ? draft : text);
    const start = Math.min(shown.startSec, Math.max(0, duration - 0.05));
    const length = Math.max(0.05, Math.min(shown.endSec, duration) - shown.startSec);
    const lane = trackTarget?.kind === "existing" && drag.current?.group.some(item => item.id === text.id) ? trackTarget.lane : lanes.get(text.id) ?? 0;
    return { text, shown, start, length, lane };
  });
  const batchTools = <div className="jz-text-batch-tools" onKeyDown={event => event.stopPropagation()}>

      {selected.length > 0 && <small>已选 {selected.length} 项</small>}
      {selected.length > 0 && <><button className="jz-video-icon-button" aria-label="取消多选" title="取消多选" type="button" onClick={() => setSelected([])}><VideoToolIcon name="close" /></button>
        <label>批量移动（秒）<input aria-label="批量移动秒数" type="number" step={0.1} value={offset} onChange={event => setOffset(event.target.valueAsNumber)} /></label>
        <button className="jz-video-icon-button" aria-label="移动所选文本" title="移动所选文本" type="button" disabled={busy || saving || !Number.isFinite(offset)} onClick={() => batch({ kind: "move", deltaSec: offset })}><VideoToolIcon name="move" /></button>
        <select aria-label="所选文本字体" value={font} onChange={event => setFont(VideoTextFont.parse(event.target.value))}>{VideoTextFont.options.map(font => <option key={font} value={font}>{videoTextFontLabels[font]}</option>)}</select>
        <input aria-label="所选文本字号" type="number" min={1} max={20} value={size} onChange={event => setSize(event.target.valueAsNumber)} />
        <button className="jz-video-icon-button" aria-label="设置所选字体字号" title="设置所选字体字号" type="button" disabled={busy || saving || size < 1 || size > 20 || !Number.isFinite(size)} onClick={() => batch({ kind: "font", style: { fontFamily: font, fontSize: size } })}><VideoToolIcon name="apply" /></button>
        {!batchProperties && <button className="jz-video-icon-button" aria-label="删除所选文本" title="删除所选文本" type="button" disabled={busy || saving} onClick={() => batch({ kind: "remove" })}><VideoToolIcon name="delete" /></button>}</>}
    </div>;
  return <div aria-label="文本时间线" tabIndex={0} onKeyDown={event => {
    if (event.nativeEvent.isComposing || (event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true], .jz-trim-handle")) return;
    if (["Backspace", "Delete"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || busy || saving) return;
      const focused = (event.target as HTMLElement).closest<HTMLElement>("[data-text-id]")?.dataset.textId ?? selectedId;
      const ids = selected.length ? selected : focused ? [focused] : [];
      if (!ids.length) return;
      setSaving(true);
      void apply({ op: "batchText", textIds: ids, action: { kind: "remove" } }, revision).finally(() => setSaving(false));
      return;
    }
    const control = event.ctrlKey || event.metaKey;
    const focusedId = (event.target as HTMLElement).closest<HTMLElement>("[data-text-id]")?.dataset.textId;
    if (control && !event.altKey && !event.shiftKey && ["c","v","d"].includes(event.key.toLowerCase())) {
      event.preventDefault(); event.stopPropagation();
      if (event.repeat || busy || saving || clipboardSaving.current) return;
      const ids = selected.length ? selected : focusedId ? [focusedId] : selectedId ? [selectedId] : [];
      const items = texts.filter(text => ids.includes(text.id));
      const key = event.key.toLowerCase();
      if (key === "c") { if (items.length) clipboard.current = {kind:"texts",items:structuredClone(items)}; return; }
      const data = key === "d" ? (items.length ? {kind:"texts" as const,items} : undefined) : clipboard.current;
      if (!data) return;
      const atSec = key === "d" && data.kind === "texts" ? Math.min(...data.items.map(text=>text.startSec)) : position;
      clipboardSaving.current = true;
      const edit:TimelineEdit = data.kind === "texts" ? {op:"pasteTexts",texts:data.items,atSec} : {op:"pasteClips",clips:data.items,atSec};
      void apply(edit, revision).finally(()=>{clipboardSaving.current=false;});
      return;
    }
    if (control && ["a", " ", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (event.key === "a") {
        const nodeLane = (event.target as HTMLElement).closest<HTMLElement>("[data-lane]")?.dataset.lane;
        const lane = nodeLane !== undefined ? Number(nodeLane) : lanes.get(focusedId ?? selectedId ?? "") ?? 0;
        setSelected(blocks.filter(block => block.lane === lane).map(block => block.text.id));
      }
      else if (event.key === " " && focusedId) toggle(focusedId);
      else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".jz-text-block-body"));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
      }
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); setSelected([]); return; }
    if (!["ArrowLeft", "ArrowRight"].includes(event.key) || event.altKey) return;
    event.preventDefault(); event.stopPropagation();
    if (busy || saving) return;
    const focused = (event.target as HTMLElement).closest<HTMLElement>("[data-text-id]")?.dataset.textId ?? selectedId;
    const ids = selected.length ? selected : focused ? [focused] : [];
    const group = texts.filter(text => ids.includes(text.id)); if (!group.length) return;
    const requested = (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 5 : 0.5);
    const delta = Math.max(-Math.min(...group.map(text => text.startSec)), Math.min(duration - Math.max(...group.map(text => text.endSec)), requested));
    if (!delta) return;
    setSaving(true);
    const edit: TimelineEdit = { op: "batchText", textIds: group.map(text => text.id), action: { kind: "move", deltaSec: delta } };
    void Promise.resolve(apply(edit)).finally(() => setSaving(false));
  }}>
    {trackMenu && createPortal(<div ref={trackMenuRef} className="jz-timeline-context-menu" role="menu" aria-label="文本轨道操作" style={{left:trackMenu.x,top:trackMenu.y}}>
      {onAddText && <IconButton icon="text" label={`在${trackMenu.name}新增文本`} type="button" disabled={busy || saving} onClick={() => {onAddText(position,trackMenu.id);setTrackMenu(undefined);}} />}
      {trackMenu.id && onRemoveTrack && <IconButton icon="delete" label="删除轨道" type="button" disabled={busy} onClick={() => {
        onRemoveTrack(trackMenu.id!); setTrackMenu(undefined);
      }} />}
      <IconButton icon="close" label={"取消"} type="button" onClick={() => setTrackMenu(undefined)} />
    </div>, document.body)}
    {!texts.length && !tracks.length && <div className="jz-text-track jz-text-track-empty">暂无文本</div>}
    {(texts.length > 0 || tracks.length > 0) && <div className="jz-text-track" onPointerDown={event => {
      if (event.target !== event.currentTarget || event.button !== 0 || busy || saving) return;
      event.preventDefault(); event.currentTarget.parentElement?.focus(); event.currentTarget.setPointerCapture(event.pointerId); marquee.current = { x: event.clientX, y: event.clientY }; setSelected([]);
    }} onPointerMove={event => {
      if (!marquee.current) return;
      const left = Math.min(marquee.current.x, event.clientX), right = Math.max(marquee.current.x, event.clientX);
      const top = Math.min(marquee.current.y, event.clientY), bottom = Math.max(marquee.current.y, event.clientY);
      const bounds = event.currentTarget.getBoundingClientRect();
      setSelectionBox({ left: left - bounds.left, top: top - bounds.top, width: right - left, height: bottom - top });
      setSelected(Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-text-id]")).filter(element => {
        const box = element.getBoundingClientRect(); return box.right >= left && box.left <= right && box.bottom >= top && box.top <= bottom;
      }).map(element => element.dataset.textId!));
    }} onPointerUp={event => { if (!marquee.current) return; marquee.current = undefined; setSelectionBox(undefined); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { marquee.current = undefined; setSelectionBox(undefined); }} style={{ height: `${Math.max(1, laneEnds.length) * 30+(insertionTop!==undefined?30:0)}px` }}>
    <div className="jz-text-fixed-controls" style={{height:laneEnds.length*30}}>{laneEnds.map((_, index) => {
      const lane = 0 + index;
      const ids = blocks.filter(block => block.lane === lane).map(block => block.text.id);
      const name = tracks.find(track => track.id === laneTracks[lane])?.name ?? "默认文本";
      return <div key={lane} className="jz-text-lane-controls"><button type="button" className="jz-track-select-node" data-lane={lane} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); const id = laneTracks[lane]; if ((onAddText || id && onRemoveTrack) && !busy && !saving) setTrackMenu({...(id ? {id} : {}),name,x:Math.max(8,Math.min(event.clientX,window.innerWidth-260)),y:Math.max(8,Math.min(event.clientY,window.innerHeight-150))}); }} style={{ top: index * 30 + 2,transform:insertionTop!==undefined && index*30>=insertionTop?"translateY(30px)":undefined }} aria-label={`全选文本轨道 ${lane + 1}`} title={`${name} · 单击全选，右键操作`} aria-pressed={ids.length > 0 && ids.every(id => selected.includes(id))} onClick={() => setSelected(current => ids.every(id => current.includes(id)) ? current.filter(id => !ids.includes(id)) : ids)}>T{lane + 1}</button></div>;
    })}
    </div>
    {trackTarget?.kind === "new" && <div className="jz-track-insertion" role="status" aria-label="轨道插入位置" data-expanded={insertionTop!==undefined} data-blocked={tracks.length >= 16} style={{top:trackTarget.top,height:insertionTop!==undefined?30:undefined}}><span>{tracks.length >= 16 ? "文本轨道已达上限" : "新文本轨道"}</span></div>}
    {selectionBox && <div className="jz-track-selection-box" aria-hidden="true" style={selectionBox} />}
    {blocks.map(({ text, shown, start: blockStart, length, lane }) => {
      const beyond = shown.startSec >= duration;
      const dragging=draft?.id===text.id || groupDraft.some(item=>item.id===text.id);
      const shift=dragging ? dragOffsetY-((lane-(lanes.get(text.id) ?? 0))*30) : insertionTop!==undefined && lane*30>=insertionTop ? 30 : 0;
      return <div className="jz-text-block" onContextMenu={event => { if (!onContextText) return; event.preventDefault(); event.stopPropagation(); if (!busy && !saving) onContextText(text, event.clientX, event.clientY); }} data-text-id={text.id} data-multi-selected={selected.includes(text.id)} key={text.id} data-selected={selectedId === text.id} data-dragging={dragging} style={{ top: `${lane * 30 + 2}px`,transform:shift?`translateY(${shift}px)`:undefined, left: `${blockStart / Math.max(1, duration) * 100}%`, width: `${length / Math.max(1, duration) * 100}%` }}>
        <button type="button" className="jz-text-block-body" title={`${text.text}（${shown.startSec.toFixed(2)}–${shown.endSec.toFixed(2)} 秒）`} disabled={busy || saving} aria-label={`编辑文本 ${text.text}`} aria-pressed={selectedId === text.id || selected.includes(text.id)} onClick={event => { if (event.shiftKey) { toggle(text.id); return; } if (event.detail === 0) { setSelected([]); onSelect(text); } moved.current = false; }}
          onPointerDown={event => start(event, text, "move")} onPointerMove={move} onPointerUp={end} onPointerCancel={cancel} onLostPointerCapture={cancel}
          >{beyond ? "超出成片 · " : ""}{text.text}</button>
        {(["start", "end"] as const).map(edge => <button type="button" key={edge} disabled={busy || saving || beyond} className={`jz-trim-handle jz-trim-${edge === "start" ? "in" : "out"}`} aria-label={`文本${edge === "start" ? "开始" : "结束"} ${text.text}`}
          onPointerDown={event => start(event, text, edge)} onPointerMove={move} onPointerUp={end} onPointerCancel={cancel} onLostPointerCapture={cancel} />)}
      </div>;
    })}
    </div>}
    {selected.length > 0 && (batchProperties ? createPortal(batchTools, batchProperties) : batchTools)}
    {outside.length > 0 && <details className="jz-outside-texts"><summary>超出成片文本 · {outside.length} 条</summary>
      <p>这些文本不在当前成片范围内，不参与播放。可删除残留，或编辑时间后使用。</p>
      <IconButton icon="delete" label={"清理全部超出成片文本"} type="button" disabled={busy || saving} onClick={() => {
        setSaving(true);
        void apply({ op: "batchText", textIds: outside.map(text => text.id), action: { kind: "remove" } }, revision).finally(() => setSaving(false));
      }} />
      {outside.map(text => <div key={text.id} className="jz-video-tools">
        <button type="button" aria-label={`编辑超出成片文本 ${text.text}`} onClick={() => onSelect(text)}>{text.startSec.toFixed(1)} 秒 · {text.text}</button>
        <IconButton icon="delete" label={(`删除超出成片文本 ${text.text}`)} type="button" aria-label={`删除超出成片文本 ${text.text}`} disabled={busy || saving} onClick={() => {
          setSaving(true); void apply({ op: "removeText", textId: text.id }, revision).finally(() => setSaving(false));
        }} />
      </div>)}
    </details>}
  </div>;
}
