import { IconButton } from "../ui/IconButton.tsx";
import { useEditorPreference, validTimelineZoom } from "./editor-preferences.ts";
import { VideoClipFilmstrip } from "./VideoClipFilmstrip.tsx";
import { useVideoClipDrag } from "./useVideoClipDrag.ts";
import type { VideoAssetPreviewRemote } from "./assets-remote.ts";
import type { TimelineClipboard } from "./timeline-clipboard.ts";
import { VideoToolIcon } from "./VideoToolIcon.tsx";
import { snapTime } from "./timeline-snapping.ts";
import { createPortal } from "react-dom";
import { MATERIAL_DRAG_TYPE } from "./VideoMaterialLibrary.tsx";
import { VideoTextTrack } from "./VideoTextTrack.tsx";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import type { VideoClip, VideoProject, VideoTextOverlay } from "@jizuo/contracts";
import { timelineLayout, TimelineEdit } from "../../../contracts/src/video-editing.ts";

type TrimDraft = { clip: VideoClip; edge: "in" | "out"; x: number; scale: number; inSec: number; outSec: number; revision: number };

/** One ruler and playhead for every shot; excluded pieces retain their original source ranges. */
export function VideoEditingTimeline({ project, clips, position, selectedId, busy, onSeek, onSelect, onJunction, apply, texts = [], selectedTextId, onSelectText, onContextText, onEditClip, onAddText, textTracks = [], onAddTextTrack, onRemoveTextTrack, onPause, videoTrackCount = 0, videoTrackBelowCount = 0, batchProperties, remote }: {
  remote?: VideoAssetPreviewRemote | undefined;
  batchProperties?: HTMLElement | null;
  onEditClip?: (id:string, x:number, y:number) => void;
  onContextText?: (text: VideoTextOverlay, x: number, y: number) => void;
  textTracks?: Array<{id:string;name:string}>;
  videoTrackCount?: number;
  videoTrackBelowCount?: number;
  onAddTextTrack?: () => void;
  onRemoveTextTrack?: ((id:string) => void) | undefined;
  onPause?: () => number;
  texts?: VideoTextOverlay[]; selectedTextId?: string | undefined; onSelectText?: (text: VideoTextOverlay) => void; onAddText?: (time?: number, trackId?: string) => void;
  project: VideoProject; clips: VideoClip[]; position: number; selectedId?: string | undefined; busy: boolean;
  onSeek: (time: number) => void; onSelect: (id: string) => void; onJunction: (left: string, right: string) => void;
  apply: (edit: TimelineEdit, revision?: number) => Promise<unknown>;
}) {
  const trackCount = videoTrackCount + videoTrackBelowCount;
  const trackName = (layer:number) => layer < 0 ? `下方视频轨道 ${-layer}` : layer ? `视频轨道 ${layer}` : "主视频轨道";
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; time: number; revision: number }>();
  const [insertMenu, setInsertMenu] = useState<{x:number;y:number;time:number;videoLayer?:number}>();
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLElement>();
  useEffect(() => {
    if (!menu && !insertMenu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const close = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) { setMenu(undefined); setInsertMenu(undefined); } };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setMenu(undefined); setInsertMenu(undefined); menuTrigger.current?.focus(); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", key); window.removeEventListener("resize", close); };
  }, [menu, insertMenu]);
  useEffect(() => { setMenu(undefined); }, [project.revision]);
  const [dropPosition, setDropPosition] = useState<number>();
  const [trackInsertion, setTrackInsertion] = useState<{ layer: number; top: number }>();
  const trackDropSaving = useRef(false);
  const materialDrop = (event: React.DragEvent<HTMLDivElement>, commit: boolean, layer=0) => {
    if (busy || !Array.from(event.dataTransfer?.types ?? []).includes(MATERIAL_DRAG_TYPE)) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const time = bounds.width ? Math.max(0, (event.clientX - bounds.left) / bounds.width * span) : duration;
    const target = layout.mainClips.find(item => time < item.startSec + item.durationSec / 2);
    setDropPosition(layer ? time : target?.startSec ?? duration);
    if (!commit) return;
    setDropPosition(undefined);
    try {
      const payload = JSON.parse(event.dataTransfer.getData(MATERIAL_DRAG_TYPE));
      if (payload.workId !== project.workId || payload.revision !== project.revision) return;
      const edit = TimelineEdit.parse({ op: "placeVisual", source: payload.source, ...(layer ? {videoLayer:layer,atSec:time} : target ? { beforeClipId: target.clip.id } : {}) });
      void apply(edit, payload.revision);
    } catch { /* Ignore unrelated or malformed drag data. */ }
  };
  const [multiTexts, setMultiTexts] = useState<string[]>([]);
  const [groupBox, setGroupBox] = useState<{left:number;top:number;width:number;height:number}>();
  const groupStart = useRef<{x:number;y:number}>();
  const [multiClips, setMultiClips] = useState<string[]>([]);
  useEffect(() => { setMultiClips(ids => ids.filter(id => clips.some(clip => clip.id === id && !clip.excluded))); }, [clips]);
  const movingClips = useRef(false);
  const [clipSelectionBox, setClipSelectionBox] = useState<{ left: number; top: number; width: number; height: number }>();
  const marqueeClips = useRef<{ x: number; y: number }>();
  const moveSelected = (direction: number, selection = multiClips) => {
    if (busy || movingClips.current || !selection.length) return;
    const selectedFrames=layout.clips.filter(item=>selection.includes(item.clip.id));
    if (selectedFrames.some(item=>item.clip.videoLayer)) {
      const layer=selectedFrames[0]?.clip.videoLayer;
      if (!layer || selectedFrames.some(item=>item.clip.videoLayer!==layer)) return;
      const startSec=Math.max(0,Math.min(...selectedFrames.map(item=>item.startSec))+direction*0.5);
      onPause?.(); movingClips.current=true;
      void Promise.resolve(apply({op:"moveVideoClips",clipIds:selection,layer,startSec})).finally(()=>{movingClips.current=false;}); return;
    }
    const visual = clips.filter(clip => clip.track !== "audio" && !clip.videoLayer && !clip.excluded).map(clip => clip.id);
    const ids = [...visual], selected = new Set(selection);
    if (direction < 0) { for (let i = 1; i < ids.length; i++) if (selected.has(ids[i]!) && !selected.has(ids[i - 1]!)) [ids[i - 1], ids[i]] = [ids[i]!, ids[i - 1]!]; }
    else { for (let i = ids.length - 2; i >= 0; i--) if (selected.has(ids[i]!) && !selected.has(ids[i + 1]!)) [ids[i], ids[i + 1]] = [ids[i + 1]!, ids[i]!]; }
    if (ids.every((id, index) => id === visual[index])) return;
    let index = 0;
    const ordered = clips.map(clip => clip.track !== "audio" && !clip.videoLayer && !clip.excluded ? ids[index++]! : clip.id);
    onPause?.(); movingClips.current = true;
    void Promise.resolve(apply({ op: "reorder", clipIds: ordered })).finally(() => { movingClips.current = false; });
  };
  const layout = (() => { try { return timelineLayout(clips); } catch { return { clips: [], mainClips: [], overlays: [], durationSec: 0 }; } })();
  const duration = layout.durationSec, span = Math.max(duration, 1);
  const defaultZoom = Math.max(1, Math.min(64, Math.ceil(span / 15 * 2) / 2));
  const [savedZoom, setSavedZoom] = useEditorPreference<number | null>("zoom", null, validTimelineZoom);
  const [zoom, setZoom] = useState(savedZoom ?? defaultZoom);
  const zoomChosen = useRef(savedZoom !== null);
  useEffect(() => { if (!zoomChosen.current) setZoom(defaultZoom); }, [defaultZoom]);
  const [draft, setDraft] = useState<TrimDraft>();
  const trim = useRef<TrimDraft>();
  const trimSaving = useRef(false);
  const canvas = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pointerDrag = useVideoClipDrag({canvas,scroller,clips,span,revision:project.revision,busy,trackCount,selected:multiClips,pause:onPause,apply});
  const pointerTarget=pointerDrag.preview?.target;
  const openedTrack=pointerDrag.preview?.gap;
  const insertion=pointerTarget?.insert ? pointerTarget : trackInsertion;
  const rowShift=(layer:number)=>openedTrack && (openedTrack.layer>0 ? layer<openedTrack.layer : layer<=openedTrack.layer) ? openedTrack.height : 0;
  const insertTrackDrop = (event: React.DragEvent<HTMLElement>, commit: boolean) => {
    const material = Array.from(event.dataTransfer?.types ?? []).includes(MATERIAL_DRAG_TYPE);
    const area = canvas.current;
    if (busy || trackDropSaving.current || !area || !material) { setTrackInsertion(undefined); return; }
    const bounds = area.getBoundingClientRect();
    const rows = Array.from(area.querySelectorAll<HTMLElement>("[data-video-layer]")).map(row => ({ layer: Number(row.dataset.videoLayer), bounds: row.getBoundingClientRect() }));
    const first = rows[0], last = rows.at(-1);
    if (!first || !last || !bounds.width || !first.bounds.height || event.clientX < bounds.left || event.clientX > bounds.right) { setTrackInsertion(undefined); return; }
    const edge = rows.find(row => Math.abs(event.clientY - row.bounds.top) <= 7);
    const below = event.clientY >= last.bounds.bottom - 7;
    const outside = below || event.clientY >= first.bounds.top - 14 && event.clientY < first.bounds.top;
    if (!edge && !outside) { setTrackInsertion(undefined); return; }
    const target = {
      layer: edge ? edge.layer >= 0 ? edge.layer + 1 : edge.layer : below ? last.layer - 1 : first.layer + 1,
      top: (edge?.bounds.top ?? (below ? last.bounds.bottom : first.bounds.top)) - bounds.top,
    };
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = trackCount >= 8 ? "none" : "copy";
    setTrackInsertion(target); setDropPosition(undefined);
    if (!commit) return;
    setTrackInsertion(undefined);
    if (trackCount >= 8) return;
    const atSec = Math.max(0, (event.clientX - bounds.left) / bounds.width * span);
    let edit: TimelineEdit;
    let revision = project.revision;
    try {
      const payload = JSON.parse(event.dataTransfer.getData(MATERIAL_DRAG_TYPE));
      if (payload.workId !== project.workId || payload.revision !== project.revision) return;
      revision = payload.revision;
      edit = TimelineEdit.parse({ op: "placeVisual", source: payload.source, newVideoTrack: true, videoLayer: target.layer, atSec });
    } catch { return; }
    onPause?.(); trackDropSaving.current = true;
    void Promise.resolve(apply(edit, revision)).then(() => { trackDropSaving.current = false; }, () => { trackDropSaving.current = false; });
  };
  useEffect(() => {
    const clear = () => { setTrackInsertion(undefined); setDropPosition(undefined); };
    document.addEventListener("dragend", clear);
    return () => document.removeEventListener("dragend", clear);
  }, []);
  const pendingScroll = useRef<number>();
  const syncTrackGutter = () => {
    canvas.current?.style.setProperty("--jz-track-scroll-left", `${Math.max(0, scroller.current?.scrollLeft ?? 0)}px`);
  };
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.deltaX !== 0) return;
      event.preventDefault();
      element.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1);
      syncTrackGutter();
    };
    element.addEventListener("wheel", wheel, {passive:false});
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  useLayoutEffect(() => {
    if (scroller.current && pendingScroll.current !== undefined) {
      scroller.current.scrollLeft = pendingScroll.current; pendingScroll.current = undefined;
      syncTrackGutter();
    }
  }, [zoom]);
  const changeZoom = (value: number, center = position) => {
    zoomChosen.current = true;
    const next = Math.max(1, Math.min(64, Math.round(value * 2) / 2));
    const viewport = scroller.current;
    if (viewport && canvas.current) {
      const width = canvas.current.getBoundingClientRect().width / zoom * next;
      const scroll = Math.max(0, center / span * width - viewport.clientWidth / 2);
      if (next === zoom) { viewport.scrollLeft = scroll; syncTrackGutter(); }
      else pendingScroll.current = scroll;
    }
    setSavedZoom(next); setZoom(next);
  };
  const selectedText = texts.find(text => text.id === selectedTextId);
  const selectedClip = layout.clips.find(item => item.clip.id === selectedId);
  const selectedRange = selectedText ? { start: selectedText.startSec, length: selectedText.endSec - selectedText.startSec }
    : selectedClip ? { start: selectedClip.startSec, length: selectedClip.durationSec } : undefined;
  const tickStep = [0.1,0.2,0.5,1,2,5,10,15,30,60,120,300,600,1800,3600,7200,14400].find(step => step >= span / (zoom * 10)) ?? 14400;
  const ticks = Array.from({length:Math.floor(duration / tickStep) + 1}, (_, index) => Number((index * tickStep).toFixed(2)));
  const timeLabel = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2,"0")}:${Math.floor(seconds % 60).toString().padStart(2,"0")}${tickStep < 1 ? `.${Math.round(seconds % 1 * 10)}` : ""}`;
  const visuals = clips.filter(clip => clip.track !== "audio");
  const audio = clips.filter(clip => clip.track === "audio" && !clip.excluded);
  const label = (clip: VideoClip) => project.assets.find(asset => asset.id === clip.assetId)?.label ?? "素材";
  const number = (clip: VideoClip) => visuals.findIndex(item => item.id === clip.id) + 1;
  type Action = "split" | "mute" | "exclude";
  const sourceTime = (clip: VideoClip, time: number) => {
    const item = layout.clips.find(item => item.clip.id === clip.id);
    return item ? Number((clip.inSec + time - item.startSec).toFixed(4)) : clip.inSec;
  };
  const inside = (clip: VideoClip, time: number) => {
    const source = sourceTime(clip, time);
    return source >= clip.inSec + 0.05 && source <= clip.outSec - 0.05;
  };
  const action = (clip: VideoClip, kind: Action, time: number, revision = project.revision) => {
    setMenu(undefined);
    if (busy || trim.current || trimSaving.current || revision !== project.revision) return;
    if (kind === "split" && !inside(clip, time)) return;
    const atSec = sourceTime(clip, time);
    const edit: TimelineEdit = kind === "split" ? { op: "split", clipId: clip.id, atSec }
      : kind === "mute" ? { op: "volume", clipId: clip.id, volume: clip.volume === 0 ? 1 : 0 }
      : { op: "include", clipId: clip.id, included: false };
    void apply(edit, revision);
  };
  const clipboard = useRef<TimelineClipboard>();
  const clipboardSaving = useRef(false);
  const shortcuts = (event: React.KeyboardEvent) => {
    if (!event.defaultPrevented && !event.ctrlKey && !event.metaKey && !event.altKey &&
      !(event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true], [role=menu]") && ["+", "=", "-"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); changeZoom(event.key === "-" ? zoom / 1.5 : zoom * 1.5); return;
    }
    const target = event.target as HTMLElement;
    const command = event.ctrlKey || event.metaKey;
    const commandKey = event.key.toLowerCase();
    if (command && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing && ["c","v","d"].includes(commandKey) && !target.closest("input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=menu],[aria-label='文本时间线']")) {
      event.preventDefault(); event.stopPropagation();
      if (event.repeat || busy || clipboardSaving.current) return;
      const focused = target.closest<HTMLElement>("[data-clip-id]")?.dataset.clipId ?? selectedId;
      const ids = multiClips.length ? multiClips : focused ? [focused] : [];
      const items = layout.clips.filter(item => ids.includes(item.clip.id));
      if (commandKey === "c") { if (items.length) clipboard.current = {kind:"clips",items:structuredClone(items.map(item=>item.clip))}; return; }
      const data = commandKey === "d" ? (items.length ? {kind:"clips" as const,items:items.map(item=>item.clip)} : undefined) : clipboard.current;
      if (!data) return;
      const atSec = commandKey === "d" ? Math.max(...items.map(item=>item.startSec+item.durationSec)) : (onPause?.() ?? position);
      clipboardSaving.current = true;
      const edit:TimelineEdit = data.kind === "clips" ? {op:"pasteClips",clips:data.items,atSec} : {op:"pasteTexts",texts:data.items,atSec};
      void apply(edit, project.revision).finally(()=>{clipboardSaving.current=false;});
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && !target.closest("input, textarea, select, [contenteditable=true], [aria-label='文本时间线'], [role=menu]")) {
      const focusedId = target.closest<HTMLElement>("[data-clip-id]")?.dataset.clipId;
      if (["a", " ", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        if (event.key === "a") setMultiClips(layout.clips.map(item => item.clip.id));
        else if (event.key === " " && focusedId) setMultiClips(ids => ids.includes(focusedId) ? ids.filter(id => id !== focusedId) : [...ids, focusedId]);
        else if (["ArrowUp", "ArrowDown"].includes(event.key)) {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".jz-track-clip-body"));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
        }
        return;
      }
    }
    if (event.defaultPrevented || event.altKey || event.repeat || busy || event.nativeEvent.isComposing) return;
    const splitShortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "b";
    if ((event.ctrlKey || event.metaKey) && !splitShortcut && !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true], .jz-text-track, [role=menu]")) return;
    if (event.key === "Escape") { event.preventDefault(); setMultiClips([]); setMultiTexts([]); return; }
    if (["Delete", "Backspace"].includes(event.key) && (multiClips.length || multiTexts.length)) {
      event.preventDefault(); event.stopPropagation();
      void (async () => {
        if (multiClips.length) {
          const result = await apply({ op: "batchClips", clipIds: multiClips, included: false });
          if (!result) return;
        }
        if (multiTexts.length) await apply({op:"batchText", textIds:multiTexts, action:{kind:"remove"}});
      })(); return;
    }
    const id = (event.target as HTMLElement).closest<HTMLElement>("[data-clip-id]")?.dataset.clipId ?? selectedId;
    const clip = layout.clips.find(item => item.clip.id === id)?.clip;
    if (!clip && !multiClips.length) return;
    if (!clip) { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); moveSelected(event.key === "ArrowLeft" ? -1 : 1); } return; }
    const key = event.key.toLowerCase();
    const kind = splitShortcut ? "split" : ({ m: "mute", delete: "exclude", backspace: "exclude" } as Record<string, Action>)[key];
    if (kind) { event.preventDefault(); action(clip, kind, onPause?.() ?? position); }
    else if (key === "arrowleft" || key === "arrowright") {
      event.preventDefault(); event.stopPropagation(); moveSelected(key === "arrowleft" ? -1 : 1, multiClips.length ? multiClips : [clip.id]);
    }
  };
  const startTrim = (event: PointerEvent<HTMLButtonElement>, clip: VideoClip, edge: "in" | "out") => {
    event.stopPropagation(); event.preventDefault();
    if (busy || trimSaving.current || !canvas.current || canvas.current.getBoundingClientRect().width <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    trim.current = { clip, edge, x: event.clientX, scale: canvas.current.getBoundingClientRect().width / span, inSec: clip.inSec, outSec: clip.outSec, revision: project.revision };
    setDraft(trim.current);
  };
  const moveTrim = (event: PointerEvent<HTMLButtonElement>) => {
    const current = trim.current;
    if (!current) return;
    const delta = (event.clientX - current.x) / current.scale;
    const sourceDuration = project.assets.find(asset => asset.id === current.clip.assetId)?.durationSec ?? Math.max(current.clip.outSec, 86400);
    if (current.edge === "in") current.inSec = Math.max(0, Math.min(current.clip.outSec - 0.05, Math.round((current.clip.inSec + delta) * 20) / 20));
    else current.outSec = Math.min(sourceDuration, Math.max(current.clip.inSec + 0.05, Math.round((current.clip.outSec + delta) * 20) / 20));
    const item = layout.clips.find(item => item.clip.id === current.clip.id);
    if (item) {
      const targets = [0, duration, position, ...layout.clips.filter(item => item.clip.id !== current.clip.id).flatMap(item => [item.startSec, item.startSec + item.durationSec]), ...texts.flatMap(text => [text.startSec, text.endSec])];
      if (current.edge === "in") current.inSec = Math.max(0, Math.min(current.outSec - 0.05, current.clip.inSec + snapTime(item.startSec + current.inSec - current.clip.inSec, targets, current.scale, event.altKey) - item.startSec));
      else current.outSec = Math.max(current.inSec + 0.05, Math.min(sourceDuration, current.clip.inSec + snapTime(item.startSec + current.outSec - current.clip.inSec, targets, current.scale, event.altKey) - item.startSec));
    }
    setDraft({ ...current });
  };
  const endTrim = (event: PointerEvent<HTMLButtonElement>) => {
    const current = trim.current; trim.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (current && (current.inSec !== current.clip.inSec || current.outSec !== current.clip.outSec)) {
      trimSaving.current = true;
      void apply({ op: "trim", clipId: current.clip.id, inSec: current.inSec, outSec: current.outSec }, current.revision).finally(() => { trimSaving.current = false; setDraft(undefined); });
    } else setDraft(undefined);
  };
  const handleKey = (event: React.KeyboardEvent, clip: VideoClip, edge: "in" | "out") => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault(); event.stopPropagation();
    const delta = event.key === "ArrowRight" ? 0.05 : -0.05;
    const inSec = edge === "in" ? Math.max(0, Math.min(clip.outSec - 0.05, clip.inSec + delta)) : clip.inSec;
    const limit = project.assets.find(asset => asset.id === clip.assetId)?.durationSec ?? 86400;
    const outSec = edge === "out" ? Math.min(limit, Math.max(clip.inSec + 0.05, clip.outSec + delta)) : clip.outSec;
    void apply({ op: "trim", clipId: clip.id, inSec, outSec });
  };
  const deleteClip = clips.find(clip => clip.id === selectedId && !clip.excluded);
  const toolbarClip = layout.clips.find(item => item.clip.id === selectedId)?.clip;
  const clipBatchTools = <div className="jz-video-tools"><small>已选 {multiClips.length} 个画面片段</small>
      <button className="jz-video-icon-button" aria-label="所选片段前移" title="所选片段前移" type="button" disabled={busy} onClick={() => moveSelected(-1)}><VideoToolIcon name="left" /></button>
      <button className="jz-video-icon-button" aria-label="所选片段后移" title="所选片段后移" type="button" disabled={busy} onClick={() => moveSelected(1)}><VideoToolIcon name="right" /></button>
      <button className="jz-video-icon-button" aria-label="所选片段移入素材库" title="所选片段移入素材库" type="button" disabled={busy} onClick={() => { void apply({ op: "batchClips", clipIds: multiClips, included: false }); }}><VideoToolIcon name="library" /></button>
      <button className="jz-video-icon-button" aria-label="取消片段多选" title="取消片段多选" type="button" onClick={() => setMultiClips([])}><VideoToolIcon name="close" /></button>
    </div>;
  return <section className="jz-editing-timeline" data-marquee={Boolean(groupBox)} data-clip-dragging={Boolean(pointerDrag.preview)} aria-label="全部画面片段" tabIndex={0} onKeyDown={shortcuts}
    onDragOverCapture={event => insertTrackDrop(event, false)} onDropCapture={event => insertTrackDrop(event, true)}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTrackInsertion(undefined); }}>
    <div className="jz-timeline-toolbar">
      <button type="button" className="jz-video-icon-button" aria-label="时间线轨道操作" title="轨道操作 · 也可右键轨道" aria-haspopup="menu" aria-expanded={Boolean(insertMenu)} disabled={busy} onClick={event => {
        if (insertMenu) { setInsertMenu(undefined); return; }
        const bounds = event.currentTarget.getBoundingClientRect();
        setMenu(undefined); setInsertMenu({x:Math.min(bounds.left,window.innerWidth-256),y:Math.min(bounds.bottom+4,window.innerHeight-100),time:position});
      }}><VideoToolIcon name="track" /></button>
      <div className="jz-timeline-edit-tools" data-active={Boolean(toolbarClip || selectedTextId || multiClips.length || multiTexts.length)} role="group" aria-label="片段快捷操作">
      <button className="jz-video-icon-button" type="button" aria-label="切分选中片段" title="切分 · ⌘/Ctrl+B" disabled={busy || !toolbarClip || !inside(toolbarClip,position)} onClick={() => { if (toolbarClip) action(toolbarClip,"split",onPause?.() ?? position); }}><VideoToolIcon name="split" /></button>
      <button className="jz-video-icon-button" type="button" aria-label="删除选中内容" title="删除 · Delete" disabled={busy || (!deleteClip && !selectedTextId && !multiClips.length && !multiTexts.length)} onClick={() => { void (async () => {
        const clipIds = multiClips.length ? multiClips : !selectedTextId && deleteClip ? [deleteClip.id] : [];
        const textIds = multiTexts.length ? multiTexts : selectedTextId ? [selectedTextId] : [];
        if (clipIds.length && !await apply({op:"batchClips",clipIds,included:false})) return;
        if (textIds.length) await apply({op:"batchText",textIds,action:{kind:"remove"}});
      })(); }}><VideoToolIcon name="delete"/></button>
      <button className="jz-video-icon-button" type="button" aria-label="裁剪选中片段" title="裁剪片段" disabled={busy || !toolbarClip || !onEditClip} onClick={event => { if (toolbarClip) { onPause?.(); const rect=event.currentTarget.getBoundingClientRect(); onEditClip?.(toolbarClip.id,rect.left,rect.bottom); } }}><VideoToolIcon name="crop" /></button>
    </div>
      <div className="jz-timeline-zoom" role="group" aria-label="时间线比例">
        <IconButton icon="zoomOut" label={"缩小时间线"} type="button" aria-label="缩小时间线" title="缩小（-）" disabled={zoom <= 1} onClick={() => changeZoom(zoom / 1.5)} />
        <label><input aria-label="时间线缩放" type="range" min={1} max={64} step={0.5} value={zoom} onChange={event => changeZoom(event.target.valueAsNumber)} /></label>
        <IconButton icon="zoomIn" label={"放大时间线"} type="button" aria-label="放大时间线" title="放大（+）" disabled={zoom >= 64} onClick={() => changeZoom(zoom * 1.5)} />
        <output aria-label="时间线缩放比例">{zoom}×</output>
        <button className="jz-video-icon-button" aria-label="放大选中块" title="放大选中块" type="button" hidden={!selectedRange} disabled={!selectedRange} onClick={() => { if (selectedRange) changeZoom(span / Math.max(0.05, selectedRange.length) / 1.5, selectedRange.start + selectedRange.length / 2); }}><VideoToolIcon name="focus" /></button>
        <button className="jz-video-icon-button" aria-label="适应全部" title="适应全部" type="button" onClick={() => changeZoom(1, 0)}><VideoToolIcon name="fit" /></button>
      </div></div>
    {multiClips.length > 0 && (batchProperties ? createPortal(clipBatchTools, batchProperties) : clipBatchTools)}
    <div ref={scroller} className="jz-track-scroll" onScroll={syncTrackGutter}><div ref={canvas} className="jz-track-canvas" tabIndex={0}
      onPointerDownCapture={event => {
        const target = event.target as HTMLElement;
        if (event.button !== 0 || busy || !target.matches(".jz-track-canvas, .jz-visual-track, .jz-text-track")) return;
        event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        groupStart.current = {x:event.clientX,y:event.clientY}; setMultiClips([]); setMultiTexts([]);
      }} onPointerMoveCapture={event => {
        const start=groupStart.current; if (!start) return;
        event.stopPropagation();
        const left=Math.min(start.x,event.clientX), right=Math.max(start.x,event.clientX), top=Math.min(start.y,event.clientY), bottom=Math.max(start.y,event.clientY);
        const bounds=event.currentTarget.getBoundingClientRect();
        setGroupBox({left:left-bounds.left,top:top-bounds.top,width:right-left,height:bottom-top});
        const hits=Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-clip-id], [data-text-id]")).filter(element => {
          const rect=element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.right>=left && rect.left<=right && rect.bottom>=top && rect.top<=bottom;
        });
        setMultiClips(hits.flatMap(element => element.dataset.clipId ? [element.dataset.clipId] : []));
        setMultiTexts(hits.flatMap(element => element.dataset.textId ? [element.dataset.textId] : []));
      }} onPointerUpCapture={event => {
        if (!groupStart.current) return;
        event.stopPropagation(); groupStart.current=undefined; setGroupBox(undefined);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }} onPointerCancel={() => {groupStart.current=undefined;setGroupBox(undefined);}}
      onLostPointerCapture={() => {groupStart.current=undefined;setGroupBox(undefined);}} onContextMenu={event => {
      if ((event.target as HTMLElement).closest(".jz-track-clip, .jz-text-block, button") || busy) return;
      event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect();
      const time = bounds.width ? Math.max(0, Math.min(duration, (event.clientX - bounds.left) / bounds.width * duration)) : position;
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-video-layer]");
      setMenu(undefined); setInsertMenu({x: Math.max(8, Math.min(event.clientX, window.innerWidth - 256)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 100)), time, ...(row ? {videoLayer:Number(row.dataset.videoLayer)} : {})});
    }} style={{ width: `${zoom * 100}%`, paddingBottom:openedTrack ? openedTrack.height+8 : undefined }}>
      <div className="jz-track-gutter" aria-hidden="true" onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} />
      {groupBox && <div className="jz-track-selection-box" aria-hidden="true" style={groupBox} />}
      <div className="jz-track-ruler">{ticks.map(time => <span key={time} data-end={time === duration} style={{ left: `${time / span * 100}%` }}>{timeLabel(time)}</span>)}
        <input aria-label="时间线播放头" type="range" min={0} max={duration} step={0.01} value={position} disabled={!duration} onChange={event => onSeek(event.target.valueAsNumber)} />
      </div>

      <VideoTextTrack batchProperties={batchProperties} selectedIds={multiTexts} onSelectionChange={setMultiTexts} clipboard={clipboard} position={position} onRemoveTrack={onRemoveTextTrack} tracks={textTracks} onAddText={(_time, trackId) => onAddText?.(position, trackId)} snapTargets={[position, ...layout.clips.flatMap(item => [item.startSec, item.startSec + item.durationSec])]} texts={texts} duration={duration} selectedId={selectedTextId} busy={busy} revision={project.revision} onSelect={text => onSelectText?.(text)} onContextText={onContextText} apply={apply} />
      {insertion && <div className="jz-track-insertion" role="status" aria-label="轨道插入位置" data-expanded={Boolean(openedTrack)} data-blocked={trackCount >= 8} style={{top:insertion.top,height:openedTrack?.height}}><span>{trackCount >= 8 ? "视频轨道已达上限" : "新视频轨道"}</span></div>}
      {pointerDrag.preview && pointerTarget && !pointerTarget.blocked && <div ref={pointerDrag.landingRef} className="jz-clip-landing" aria-label="片段落点预览" role="status" style={{top:pointerTarget.top+2+(pointerTarget.insert?0:rowShift(pointerTarget.layer)),left:`${pointerDrag.preview.startSec/span*100}%`,width:`${pointerDrag.preview.durationSec/span*100}%`,height:pointerTarget.height-4}} />}
      {Array.from({length:trackCount+1},(_,index)=>videoTrackCount-index).map(layer => <div key={layer} data-video-layer={layer} className="jz-visual-track" style={{transform:rowShift(layer)?`translateY(${rowShift(layer)}px)`:undefined}} aria-label={layer ? trackName(layer) : "画面时间线"} tabIndex={0} onPointerDown={event => {
          if (event.target !== event.currentTarget || event.button !== 0 || busy) return;
          event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
          marqueeClips.current = { x: event.clientX, y: event.clientY }; setMultiClips([]);
        }} onPointerMove={event => {
          const start = marqueeClips.current; if (!start) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          setClipSelectionBox({ left: Math.min(start.x, event.clientX) - bounds.left, top: Math.min(start.y, event.clientY) - bounds.top, width: Math.abs(start.x - event.clientX), height: Math.abs(start.y - event.clientY) });
          setMultiClips(Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-clip-id]")).filter(element => {
            const box = element.getBoundingClientRect(); return box.right >= Math.min(start.x, event.clientX) && box.left <= Math.max(start.x, event.clientX) && box.bottom >= Math.min(start.y, event.clientY) && box.top <= Math.max(start.y, event.clientY);
          }).map(element => element.dataset.clipId!));
        }} onPointerUp={event => { if (!marqueeClips.current) return; marqueeClips.current = undefined; setClipSelectionBox(undefined); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { marqueeClips.current = undefined; setClipSelectionBox(undefined); }} onDragOver={event => materialDrop(event, false, layer)} onDrop={event => materialDrop(event, true, layer)} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropPosition(undefined); }}>
        <div className="jz-track-fixed-controls"><button type="button" className="jz-track-select-node" aria-label={layer ? `全选${trackName(layer)}` : "全选视频轨道"} aria-pressed={layout.clips.some(item=>(item.clip.videoLayer ?? 0)===layer) && layout.clips.filter(item=>(item.clip.videoLayer ?? 0)===layer).every(item => multiClips.includes(item.clip.id))} onClick={() => setMultiClips(ids => layout.clips.filter(item=>(item.clip.videoLayer ?? 0)===layer).every(item => ids.includes(item.clip.id)) ? [] : layout.clips.filter(item=>(item.clip.videoLayer ?? 0)===layer).map(item => item.clip.id))} onContextMenu={event => {event.preventDefault();event.stopPropagation();if (!busy) {setMenu(undefined);setInsertMenu({x:Math.max(8,Math.min(event.clientX,window.innerWidth-256)),y:Math.max(8,Math.min(event.clientY,window.innerHeight-100)),time:position,videoLayer:layer});}}} title={`${trackName(layer)} · 单击全选，右键操作`}>V{layer + videoTrackBelowCount + 1}</button></div>
        {clipSelectionBox && <div className="jz-track-selection-box" aria-hidden="true" style={clipSelectionBox} />}
        {dropPosition !== undefined && <div className="jz-material-drop-marker" style={{ left: `${dropPosition / span * 100}%` }} /> }
        {layout.clips.filter(item=>(item.clip.videoLayer ?? 0)===layer).map(({ clip, startSec, durationSec }, index) => {
          const next = layer ? undefined : layout.mainClips[index + 1];
          const range = draft?.clip.id === clip.id ? draft : clip;
          return <div className="jz-track-clip" key={clip.id} data-clip-id={clip.id} data-drag-source={pointerDrag.preview?.ids.includes(clip.id)} onContextMenu={event => { event.preventDefault(); setInsertMenu(undefined); if (busy) return; menuTrigger.current = event.currentTarget.querySelector<HTMLButtonElement>(".jz-track-clip-body") ?? undefined; setMenu({ id: clip.id, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 256)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 260)), time: onPause?.() ?? position, revision: project.revision }); }} data-selected={selectedId === clip.id || multiClips.includes(clip.id)} data-current={position >= startSec && position < startSec + durationSec}
            style={{ left: `${(startSec + range.inSec - clip.inSec) / span * 100}%`, width: `${(range.outSec - range.inSec) / span * 100}%`,transform:pointerDrag.preview?.shifts[clip.id] ? `translateX(${pointerDrag.preview.shifts[clip.id]}px)` : undefined }}>
            <button type="button" className="jz-track-clip-body" title={`${label(clip)} · ${range.inSec.toFixed(2)}–${range.outSec.toFixed(2)} 秒${clip.subtitle ? ` · ${clip.subtitle}` : ""}`} draggable={false} aria-label={`查看片段 ${number(clip)} ${label(clip)}`} aria-pressed={selectedId === clip.id || multiClips.includes(clip.id)}
              onPointerDown={event=>pointerDrag.begin(event,clip)} onPointerMove={pointerDrag.move} onPointerUp={pointerDrag.end} onPointerCancel={pointerDrag.cancel} onLostPointerCapture={pointerDrag.cancel}
              onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); if (!busy) { setMultiClips([]); onPause?.(); onEditClip?.(clip.id,event.clientX,event.clientY); } }}
              onClick={event => { if(pointerDrag.suppressClick.current){event.preventDefault();event.stopPropagation();pointerDrag.suppressClick.current=false;return;} if (event.shiftKey) { setMultiClips(ids => ids.includes(clip.id) ? ids.filter(id => id !== clip.id) : [...ids, clip.id]); } else { setMultiClips([]); onSelect(clip.id); } }}><strong>{label(clip)}</strong><VideoClipFilmstrip remote={remote} workId={project.workId} assetId={clip.assetId} image={project.assets.find(asset=>asset.id===clip.assetId)?.kind === "image"} start={range.inSec} end={range.outSec}/></button>
            {(["in", "out"] as const).map(edge => <button key={edge} type="button" className={`jz-trim-handle jz-trim-${edge}`} aria-label={`片段 ${number(clip)} ${edge === "in" ? "入点" : "出点"}`} title="拖动裁剪，或用方向键微调" disabled={busy}
              onPointerDown={event => startTrim(event, clip, edge)} onPointerMove={moveTrim} onPointerUp={endTrim} onPointerCancel={() => { trim.current = undefined; setDraft(undefined); }} onLostPointerCapture={() => { if (trim.current) { trim.current = undefined; setDraft(undefined); } }} onKeyDown={event => handleKey(event, clip, edge)} />)}

            {next && <button type="button" className="jz-track-junction" data-transition={Boolean(clip.transitionSec)} aria-label={`编辑衔接 ${number(clip)} 到 ${number(next.clip)}`} onClick={() => onJunction(clip.id, next.clip.id)} title={clip.transitionSec ? `淡化 ${clip.transitionSec} 秒` : "添加转场或衔接镜头"} />}
          </div>;
        })}
        {!layout.clips.length && <p className="jz-track-empty">将视频加入时间线</p>}
      </div>)}

      {audio.map(clip => <div className="jz-audio-track" key={clip.id} style={{transform:openedTrack?`translateY(${openedTrack.height}px)`:undefined}}><button type="button" data-selected={selectedId === clip.id} onClick={() => onSelect(clip.id)} style={{ left: `${(clip.startSec ?? 0) / span * 100}%`, width: `${Math.min(clip.outSec - clip.inSec, Math.max(0, duration - (clip.startSec ?? 0))) / span * 100}%` }}>{label(clip)}</button></div>)}
      {duration > 0 && <div className="jz-playhead" style={{ left: `${Math.min(position, duration) / span * 100}%` }}><span /></div>}
    </div></div>

    {insertMenu && createPortal(<div ref={menuRef} className="jz-timeline-context-menu" role="menu" aria-label="时间线操作" style={{left:insertMenu.x,top:insertMenu.y}}>
      <IconButton icon="video" label="添加视频轨道" role="menuitem" disabled={busy || trackCount>=8} onClick={() => {void apply({op:"addVideoTrack"});setInsertMenu(undefined);}} />
      {onAddTextTrack && <IconButton icon="track" label="＋ 文本轨道" role="menuitem" disabled={busy || textTracks.length>=16} onClick={() => {onAddTextTrack();setInsertMenu(undefined);}} />}
      {onAddText && <IconButton icon="text" label="在此处新增文本" role="menuitem" disabled={busy || duration<0.5} onClick={() => {onAddText(insertMenu.time);setInsertMenu(undefined);}} />}
      {Boolean(insertMenu.videoLayer) && <IconButton icon="delete" label={`删除${trackName(insertMenu.videoLayer!)}`} role="menuitem" disabled={busy} onClick={() => {void apply({op:"removeVideoTrack",layer:insertMenu.videoLayer!});setInsertMenu(undefined);}} />}
    </div>, document.body)}
    {menu && createPortal(<div ref={menuRef} className="jz-timeline-context-menu" role="menu" aria-label="片段操作" style={{ left: menu.x, top: menu.y }} onKeyDown={event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }}>
      {([ ["split", "在播放头处分为两段", "⌘/Ctrl+B"], ["mute", "切换静音", "M"], ["exclude", "移入素材库", "Delete"] ] as const).map(([kind, title, key]) => {
        const clip = clips.find(item => item.id === menu.id);
        return <IconButton icon={kind === "split" ? "split" : kind === "mute" ? "music" : "library"} label={title} title={`${title} · ${key}`} role="menuitem" key={kind} disabled={busy || !clip || (kind === "split" && !inside(clip, menu.time))} onClick={() => { if (clip) action(clip, kind, menu.time, menu.revision); menuTrigger.current?.focus(); }} />;
      })}
      <small>切分和裁剪需将播放头移到片段内部</small>
    </div>, document.body)}
  </section>;
}
