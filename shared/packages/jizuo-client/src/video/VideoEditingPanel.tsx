import { VideoExportControl } from "./VideoExportControl.tsx";
import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useEditorPreference, validLayout, validPanelWidths, validTimelineHeight } from "./editor-preferences.ts";
import { VideoVoiceRecorder } from "./VideoVoiceRecorder.tsx";
import { VideoEditorFrame } from "./VideoEditorFrame.tsx";
import { VideoToolIcon } from "./VideoToolIcon.tsx";
import { VideoMaterialInsertDialog } from "./VideoMaterialInsertDialog.tsx";
import { VideoTextPopover } from "./VideoTextPopover.tsx";
import { VideoMaterialLibrary, VideoAssetImport } from "./VideoMaterialLibrary.tsx";
import { VideoTextEditor, type TextEditorHandle } from "./VideoTextEditor.tsx";
import { VideoTextStyle, type VideoTextOverlay, type VideoEpisodeSummary } from "@jizuo/contracts";
import { VideoEditingTimeline } from "./VideoEditingTimeline.tsx";
import { VideoTimelinePreview, timelinePreviewFrames, type VideoTimelinePlayer } from "./VideoTimelinePreview.tsx";
import { VideoJunctionEditor } from "./VideoJunctionEditor.tsx";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import type { VideoClip, VideoEpisode, VideoProject } from "@jizuo/contracts";
import { episodeTextOverlays, TimelineEdit, timelineLayout, shotVideoCandidates, type ExportVideoInput } from "../../../contracts/src/video-editing.ts";
import type { ImportVideoAssetInput } from "../../../contracts/src/media-operations.ts";
import type { VideoEditingRemote } from "./editing-remote.ts";
import { publishVideoProject } from "./useVideoProject.ts";
import { VideoMediaPreview } from "./VideoShotsPanel.tsx";
import { requestVideoComposer } from "./video-composer-request.ts";
import "./video-editing.css";

function ClipEditForm({ clip, revision, busy, label, fields, valuesOf, editFor, apply }: {
  clip: VideoClip; revision: number; busy: boolean; label: string; fields: Array<{ label: string; shortLabel?: string; text?: boolean }>;
  valuesOf: (clip: VideoClip) => string[]; editFor: (values: string[]) => TimelineEdit;
  apply: (edit: TimelineEdit, expectedRevision: number) => Promise<VideoProject | undefined>;
}) {
  const incoming = JSON.stringify(valuesOf(clip));
  const [base, setBase] = useState({ incoming, revision });
  const [values, setValues] = useState(() => valuesOf(clip));
  const latestValues = useRef(values); latestValues.current = values;
  const dirty = JSON.stringify(values) !== base.incoming;
  const conflict = incoming !== base.incoming && dirty;
  useEffect(() => {
    if (!dirty) { setValues(JSON.parse(incoming) as string[]); setBase({ incoming, revision }); }
    else if (base.incoming === incoming && base.revision !== revision) setBase({ incoming, revision });
  }, [incoming, revision, dirty, base.incoming, base.revision]);
  return <form className="jz-clip-edit-form" onSubmit={(event) => {
    event.preventDefault(); if (conflict || busy) return;
    const snapshot = JSON.stringify(values);
    void apply(editFor(values), base.revision).then((project) => {
      const saved = project?.episodes.flatMap((episode) => episode.timeline).find((item) => item.id === clip.id);
      if (saved && project) { const next = valuesOf(saved); if (JSON.stringify(latestValues.current) === snapshot) setValues(next); setBase({ incoming: JSON.stringify(next), revision: project.revision }); }
    });
  }}>
    {fields.map((field, index) => <label key={field.label} title={field.label}>{field.shortLabel ?? field.label}{field.text ? <textarea rows={2} maxLength={50000} value={values[index] ?? ""} onChange={(event) => setValues((current) => current.map((item, position) => position === index ? event.target.value : item))} />
      : <input aria-label={field.label} type="number" required step="any" value={values[index] ?? ""} onChange={(event) => setValues((current) => current.map((item, position) => position === index ? event.target.value : item))} />}</label>)}
    <IconButton icon="apply" label={(label)} type="submit" disabled={busy || conflict} />
    {conflict && <p role="alert">该项已被更新，本地输入已保留。<IconButton icon="reset" label={"载入最新值"} type="button" onClick={() => { setValues(valuesOf(clip)); setBase({ incoming, revision }); }} /></p>}
  </form>;
}

export function VideoEditingPanel({ project, episode, remote, active, selectedClipId, onSelectClip, episodes }: {
  episodes?: VideoEpisodeSummary[];
  project: VideoProject; episode: VideoEpisode; remote: VideoEditingRemote; active?: boolean | undefined;
  selectedClipId?: string | undefined; onSelectClip?: (clipId: string | undefined) => void;
}) {
  const allTexts = useMemo(() => { try { return episodeTextOverlays(episode); } catch { return episode.texts ?? []; } }, [episode.timeline, episode.texts]);
  const [materialInsert, setMaterialInsert] = useState<{ source: Extract<TimelineEdit, {op:"placeVisual"}>["source"]; revision: number; targetId?: string; nextId?: string; title?: string }>();
  useEffect(() => setMaterialInsert(undefined), [project.workId, episode.id]);
  const [fullscreen, setFullscreen] = useState(false);
  const exitFullscreen = useCallback(() => setFullscreen(false), []);
  useEffect(() => { setFullscreen(false); }, [active, project.workId, episode.id]);
  const [batchProperties, setBatchProperties] = useState<HTMLDivElement | null>(null);
  const [sidePanel, setSidePanel] = useState<"library" | "properties">();
  const [timelineHeight, setTimelineHeight] = useEditorPreference("timelineHeight", 260, validTimelineHeight);
  const [layoutMode, setLayoutMode] = useEditorPreference("layout", "default", validLayout);
  const [panelWidths, setPanelWidths] = useEditorPreference("panelWidths", { library: 240, properties: 280 }, validPanelWidths);
  const workbench = useRef<HTMLDivElement>(null);
  const columnDrag = useRef<{side: "library" | "properties"; x: number; width: number}>();
  const columnLimit = () => Math.max(180, Math.min(480, (workbench.current?.clientWidth ?? 1100) * 0.32));
  const setColumnWidth = (side: "library" | "properties", width: number) => setPanelWidths(current => ({ ...current, [side]: Math.max(180, Math.min(columnLimit(), width)) }));
  const columnDivider = (side: "library" | "properties") => <div className={`jz-video-column-divider jz-video-column-${side}`} role="separator" aria-label={layoutMode === "portrait-left" && side === "library" || layoutMode === "portrait-right" && side === "properties" ? "调整播放器宽度" : side === "library" ? "调整素材库宽度" : "调整属性栏宽度"} aria-orientation="vertical" aria-valuemin={180} aria-valuemax={columnLimit()} aria-valuenow={Math.min(panelWidths[side], columnLimit())} tabIndex={0}
    onDoubleClick={() => setColumnWidth(side, side === "library" ? 240 : 280)}
    onKeyDown={event => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); event.stopPropagation(); const direction = (event.key === "ArrowRight" ? 1 : -1) * (side === "library" ? 1 : -1); setColumnWidth(side, Math.min(panelWidths[side], columnLimit()) + direction * 20); }}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); columnDrag.current = { side, x: event.clientX, width: Math.min(panelWidths[side], columnLimit()) }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { const start = columnDrag.current; if (start?.side === side) setColumnWidth(side, start.width + (event.clientX - start.x) * (side === "library" ? 1 : -1)); }}
    onPointerUp={event => { columnDrag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { columnDrag.current = undefined; }} onLostPointerCapture={() => { columnDrag.current = undefined; }}/>;

  const resizeStart = useRef<{y:number;height:number}>();
  const [clipPopup, setClipPopup] = useState<{id:string;x:number;y:number}>();
  useEffect(() => { setClipPopup(undefined); }, [project.workId, episode.id, active]);
  useEffect(() => { if (clipPopup && !episode.timeline.some(clip => clip.id === clipPopup.id)) setClipPopup(undefined); }, [episode.timeline, clipPopup]);
  const [textPopup, setTextPopup] = useState<{x:number;y:number}>();
  const [textDraft, setTextDraft] = useState<VideoTextOverlay>();
  const textEditor = useRef<TextEditorHandle>(null);
  const [saveStatus, setSaveStatus] = useState("已保存");
  const currentProject = useRef(project);
  if (project.workId !== currentProject.current.workId || project.revision >= currentProject.current.revision) currentProject.current = project;
  const undo = useRef<number[]>([]), redo = useRef<number[]>([]);
  const [, refreshHistoryButtons] = useState(0);
  useEffect(() => { undo.current = []; redo.current = []; refreshHistoryButtons(value => value + 1); }, [project.workId, episode.id]);
  const withSavedText = (action: () => void) => {
    if (!textEditor.current || !textEditor.current.needsSave()) { action(); return; }
    void textEditor.current.flush().then(saved => { if (saved) action(); });
  };
  useEffect(() => {
    if (active === false) return;
    // WebKit treats Backspace outside an editable field as history back.
    // Run after editor handlers so their normal deletion still takes precedence.
    const preventHistoryBack = (event: KeyboardEvent) => {
      if (event.key !== "Backspace" || !(event.target instanceof Element)) return;
      if (event.target.closest("input, textarea, [contenteditable]:not([contenteditable=false])")) return;
      event.preventDefault();
    };
    window.addEventListener("keydown", preventHistoryBack);
    return () => window.removeEventListener("keydown", preventHistoryBack);
  }, [active]);
  const player = useRef<VideoTimelinePlayer>(null);
  const [playhead, setPlayhead] = useState(0);
  const [sourcePosition, setSourcePosition] = useState(0);
  const [junction, setJunction] = useState<{ left: string; right: string }>();
  const [loopRequest, setLoopRequest] = useState<{ id: string }>();
  useEffect(() => { if (loopRequest) player.current?.loopClip(loopRequest.id); }, [loopRequest]);
  const [localClipId, setLocalClipId] = useState<string>();
  const [selectionRequest, setSelectionRequest] = useState(0);
  const clipId = onSelectClip ? selectedClipId : localClipId;
  const selectedClip = episode.timeline.find(clip => clip.id === clipId);
  const sourceClip = selectedClip?.excluded && selectedClip.track !== "audio" ? selectedClip : undefined;
  useEffect(() => { setSourcePosition(0); }, [sourceClip?.id]);
  const selectClip = (id: string | undefined) => {
    if (active === false) return;
    player.current?.clearLoop();
    setLoopRequest(undefined);
    setTextDraft(undefined);
    if (onSelectClip) onSelectClip(id); else setLocalClipId(id);
    setSelectionRequest(value => value + 1);
    setJunction(undefined);
  };
  useEffect(() => {
    if (active === false || active === undefined && !selectionRequest) return;
    const asset = project.assets.find(item => item.id === selectedClip?.assetId);
    requestVideoComposer({ workId: project.workId, episodeId: episode.id, editing: true,
      ...(selectedClip ? { clipId: selectedClip.id } : {}),
      title: selectedClip ? `${asset?.label ?? "素材"} · 剪辑片段` : `${episode.title} · 剪辑`,
      kind: "video", action: "select", promptMode: "reference" });
  }, [project.workId, episode.id, selectedClip?.id, active, selectionRequest]);
  const [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [transitionDuration, setTransitionDuration] = useState("0.5");
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const rebuildConfirmation = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (confirmRebuild) {
      rebuildConfirmation.current?.focus();
      rebuildConfirmation.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [confirmRebuild]);
  const [roughCutChoices, setRoughCutChoices] = useState<Record<string, string>>({});
  const roughCutSources = episode.shots.filter(shot => !shot.archived).map(shot => {
    const candidates = shotVideoCandidates(project, episode.id, shot);
    const preferred = roughCutChoices[shot.id] ?? shot.videoAssetId ?? (!shot.locked && candidates.length === 1 ? candidates[0]!.id : "");
    return { shot, candidates, value: candidates.some(asset => asset.id === preferred) ? preferred : "" };
  });
  const unresolvedSources = roughCutSources.filter(source => source.candidates.length && !source.value);
  const sourceSelections = roughCutSources.filter(source => source.value && source.value !== source.shot.videoAssetId).map(source => ({ shotId: source.shot.id, assetId: source.value }));
  const [audioId, setAudioId] = useState("");
  const [audioStart, setAudioStart] = useState("0"), [audioIn, setAudioIn] = useState("0"), [audioOut, setAudioOut] = useState("5");
  const [speech, setSpeech] = useState("");
  const [exportId, setExportId] = useState("");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<Array<{ revision: number; clipCount: number; durationSec: number }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyRequest = useRef(0);
  useEffect(() => () => { historyRequest.current += 1; }, []);
  const [aspectRatio, setAspectRatio] = useState<NonNullable<ExportVideoInput["aspectRatio"]>>(episode.aspectRatio ?? "9:16");
  useEffect(() => { setAspectRatio(episode.aspectRatio ?? "9:16"); }, [episode.aspectRatio]);
  const exports = project.assets.filter((asset) => asset.kind === "export" && asset.episodeId === episode.id);
  const selectedExport = exports.find((asset) => asset.id === exportId) ?? exports.at(-1);
  const exportJob = project.jobs.find((job) => job.id === selectedExport?.sourceJobId);
  const audioAssets = project.assets.filter((asset) => asset.kind === "audio");
  const jobs = project.jobs.filter((job) => job.episodeId === episode.id && (job.kind === "audio" || job.kind === "export") && job.status !== "succeeded");
  const layout = useMemo(() => { try { return timelineLayout(episode.timeline); } catch { return { clips: [], mainClips: [], overlays: [], durationSec: 0 }; } }, [episode.timeline]);
  const left = layout.clips.find(item => item.clip.id === junction?.left)?.clip;
  const right = left ? layout.clips[layout.clips.findIndex(item => item.clip.id === left.id) + 1]?.clip : undefined;
  const validJunction = left && right && right.id === junction?.right;
  const inspectedId = selectedClip?.id;
  useEffect(() => {
    let active = true; setDownloadUrl(null);
    if (selectedExport && remote.getVideoAssetUrl && !remote.saveVideoExport) void remote.getVideoAssetUrl({ workId: project.workId, assetId: selectedExport.id })
      .then((result) => { if (active) setDownloadUrl(result.url); }).catch(() => { if (active) setError("无法获取导出文件，请重新选择版本后重试"); });
    return () => { active = false; };
  }, [selectedExport?.id, project.workId, remote]);
  const run = async (operation: () => Promise<VideoProject>): Promise<VideoProject | undefined> => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try { const next = await operation(); if (!next) throw new Error("保存未返回结果，请重试"); currentProject.current = next; publishVideoProject(next); return next; }
    catch (cause) { setError(userErrorMessage(cause, "操作失败，输入已保留", { operation: "VideoEditingPanel" })); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const apply = async (edit: TimelineEdit, expectedRevision = currentProject.current.revision) => {
    const beforeFlush = currentProject.current.revision;
    if (!["saveText", "removeText", "splitText", "applyTextFont"].includes(edit.op) && textEditor.current) {
      if (!await textEditor.current.flush()) return;
      if (expectedRevision === beforeFlush) expectedRevision = currentProject.current.revision;
    }
    return run(async () => {
    if (!remote.editVideoTimeline) throw new Error("当前运行时尚不支持剪辑");
    const next = await remote.editVideoTimeline({ workId: project.workId, episodeId: episode.id, expectedRevision, edit: TimelineEdit.parse(edit) });
    undo.current.push(expectedRevision); redo.current = []; refreshHistoryButtons(value => value + 1);
    if (edit.op === "removeText" && textDraft?.id === edit.textId) setTextDraft(undefined);
    if (edit.op === "batchText" && edit.action.kind === "remove" && textDraft && edit.textIds.includes(textDraft.id)) setTextDraft(undefined);
    if (edit.op === "split") {
      const index = episode.timeline.findIndex(clip => clip.id === edit.clipId);
      selectClip(next.episodes.find(item => item.id === episode.id)?.timeline[index]?.id);
    }
    return next;
    });
  };
  const travel = async (direction: "undo" | "redo") => {
    if (!remote.restoreVideoTimeline || busyRef.current) return;
    if (textEditor.current?.needsSave() && !await textEditor.current.flush()) return;
    const from = direction === "undo" ? undo : redo, to = direction === "undo" ? redo : undo;
    const revision = from.current.at(-1); if (revision === undefined) return;
    const current = currentProject.current.revision;
    const result = await run(() => remote.restoreVideoTimeline!({ workId: project.workId, episodeId: episode.id, expectedRevision: current, revision }));
    if (result) { from.current.pop(); to.current.push(current); setTextDraft(undefined); refreshHistoryButtons(value => value + 1); }
  };
  const addText = async (atTime?: number, trackId?: string) => {
    if (textEditor.current?.needsSave() && !await textEditor.current.flush()) return;
    if (layout.durationSec < 0.5) { setError("成片不足 0.5 秒，请先延长视频再添加文本"); return; }
    const position = player.current?.pauseAtCurrentPosition() ?? playhead;
    const block = layout.clips.find(item => item.clip.id === selectedClip?.id);
    const startSec = Math.min(Math.max(0, atTime ?? block?.startSec ?? position), Math.max(0, layout.durationSec - 0.5));
    const text = { id: crypto.randomUUID(), text: "新文本", ...(trackId ? {trackId} : {}), startSec,
      endSec: Math.min(layout.durationSec, startSec + Math.max(0.5, (atTime === undefined ? block?.durationSec : undefined) ?? 3)), style: VideoTextStyle.parse({ width: 90, ...(trackId ? {y:74} : {}) }) };
    const next = await apply({ op: "saveText", text });
    if (next) { selectClip(undefined); setPlayhead(startSec); setTextDraft(text); }
  };
  const addTextTrack = async () => {
    const tracks = episode.textTracks ?? [];
    const track = {id:crypto.randomUUID(),name:`文本轨道 ${tracks.length + 2}`};
    const next = await apply({op:"addTextTrack",track});
    if (next) setNotice(`已添加「${track.name}」轨道，点击轨道左侧 + 添加文字。`);
  };
  const dropOnPlayer = (payload: string) => {
    if (shared.busy) return;
    try {
      const data = JSON.parse(payload);
      if (data.workId !== project.workId) return;
      if (data.revision !== currentProject.current.revision) { setError("素材列表已更新，请重新拖入素材"); return; }
      const edit = TimelineEdit.parse({op:"placeVisual",source:data.source});
      if (edit.op !== "placeVisual") return;
      const pausedTime = player.current?.pauseAtCurrentPosition() ?? playhead;
      const time = sourceClip ? playhead : pausedTime;
      withSavedText(() => {
        const current = currentProject.current;
        const timeline = current.episodes.find(item => item.id === episode.id)?.timeline ?? [];
        const currentLayout = timelineLayout(timeline);
        const target = currentLayout.clips.filter(item => time >= item.startSec && time < item.startSec + item.durationSec).at(-1) ?? currentLayout.clips.at(-1);
        const index = target ? currentLayout.clips.indexOf(target) : -1;
        const next = index >= 0 ? currentLayout.clips[index + 1] : undefined;
        setError(null);
        setMaterialInsert({source:edit.source,revision:current.revision,...(target ? {targetId:target.clip.id,title:current.assets.find(asset => asset.id === target.clip.assetId)?.label ?? "当前片段"} : {}),...(next ? {nextId:next.clip.id} : {})});
      });
    } catch { setError("素材信息无效，请从素材库重新拖入"); }
  };
  const insertMaterial = async (side: "before" | "after") => {
    if (!materialInsert || shared.busy) return;
    const beforeClipId = side === "before" ? materialInsert.targetId : materialInsert.nextId;
    const result = await apply({op:"placeVisual",source:materialInsert.source,...(beforeClipId ? {beforeClipId} : {})},materialInsert.revision);
    if (result) setMaterialInsert(undefined);
  };
  const selectText = (text: VideoTextOverlay) => {
    if (textDraft?.id === text.id) return;
    withSavedText(() => {
    const position = player.current?.pauseAtCurrentPosition() ?? playhead; selectClip(undefined); setTextDraft(text);
    setPlayhead(position >= text.startSec && position < text.endSec ? position : Math.min(text.startSec, layout.durationSec));
    });
  };
  const loadHistory = async () => {
    if (!remote.getVideoTimelineHistory) return;
    const request = ++historyRequest.current; setHistoryLoading(true); setHistoryError(null);
    try { const result = await remote.getVideoTimelineHistory({ workId: project.workId, episodeId: episode.id }); if (request === historyRequest.current) setHistory(result.versions.slice(0, 20)); }
    catch (cause) { if (request === historyRequest.current) setHistoryError(userErrorMessage(cause, "剪辑历史加载失败", { operation: "VideoEditingPanel", effect: "read" })); }
    finally { if (request === historyRequest.current) setHistoryLoading(false); }
  };
  const reorder = (clipId: string, delta: number) => {
    const ids = episode.timeline.map((clip) => clip.id), visual = episode.timeline.filter((clip) => clip.track !== "audio" && !clip.excluded);
    const adjacent = visual[visual.findIndex((clip) => clip.id === clipId) + delta];
    if (!adjacent) return;
    const a = ids.indexOf(clipId), b = ids.indexOf(adjacent.id); [ids[a], ids[b]] = [ids[b]!, ids[a]!];
    void apply({ op: "reorder", clipIds: ids });
  };
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (file) await importAsset(file);
  };
  const importAsset = async (file: File) => {
    if (!remote.importVideoAsset || busyRef.current) return;
    const supported = ["audio/mpeg", "audio/wav", "audio/mp4", "audio/ogg", "video/mp4", "video/webm"];
    const mimeType = file.type === "audio/x-wav" ? "audio/wav" : file.type;
    if (!supported.includes(mimeType) || !file.size || file.size > 20 * 1024 * 1024) { setError("请选择不超过 20 MB 的 MP3、WAV、M4A、OGG、MP4 或 WebM 文件"); return; }
    await run(async () => {
      const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === "string" ? resolve(reader.result.slice(reader.result.indexOf(",") + 1)) : reject(new Error("读取素材失败")); reader.onerror = () => reject(new Error("读取素材失败")); reader.readAsDataURL(file); });
      return remote.importVideoAsset!({ workId: project.workId, expectedRevision: project.revision, kind: mimeType.startsWith("audio/") ? "audio" : "video", label: file.name.slice(0, 120), mimeType: mimeType as ImportVideoAssetInput["mimeType"], base64 });
    });
  };
  const assemble = () => run(() => remote.roughCutVideo!({ workId: project.workId, episodeId: episode.id, expectedRevision: project.revision,
    ...(sourceSelections.length ? { selections: sourceSelections } : {}) }));
  const shared = { revision: project.revision, busy: busy || !remote.editVideoTimeline, apply };
  const seek = (time: number) => {
    setPlayhead(time);
    if (!textDraft) selectClip(timelinePreviewFrames(episode.timeline, Math.min(time, Math.max(0, layout.durationSec - 0.001))).at(-1)?.clip.id);
  };
  const seekClip = (id: string) => { withSavedText(() => {
    if (loopRequest?.id === id) { selectClip(undefined); return; }
    const item = layout.clips.find(item => item.clip.id === id);
    const audio = episode.timeline.find(clip => clip.id === id && clip.track === "audio");
    if (item) setPlayhead(item.startSec);
    else if (audio) setPlayhead(Math.min(layout.durationSec, audio.startSec ?? 0));
    selectClip(id);
    if (item) setLoopRequest({ id });
  }); };
  const playheadFrames = (() => { try { return timelinePreviewFrames(episode.timeline, playhead); } catch { return []; } })();
  const splitFrame = sourceClip ? { clip: sourceClip, sourceSec: sourceClip.inSec + sourcePosition }
    : playheadFrames.find(frame => frame.clip.id === selectedClip?.id) ?? playheadFrames.at(-1);
  const splitAtPlayhead = () => {
    const position = player.current?.pauseAtCurrentPosition() ?? (sourceClip ? sourcePosition : playhead);
    const frames = timelinePreviewFrames(episode.timeline, position);
    const frame = sourceClip ? { clip: sourceClip, sourceSec: sourceClip.inSec + position } : frames.find(item => item.clip.id === selectedClip?.id) ?? frames.at(-1);
    if (frame && frame.sourceSec > frame.clip.inSec + 0.001 && frame.sourceSec < frame.clip.outSec - 0.001) {
      void apply({ op: "split", clipId: frame.clip.id, atSec: Number(frame.sourceSec.toFixed(4)) });
    }
  };
  const canSplit = splitFrame && splitFrame.sourceSec > splitFrame.clip.inSec + 0.001 && splitFrame.sourceSec < splitFrame.clip.outSec - 0.001;

  return <VideoEditorFrame fullscreen={fullscreen} exit={exitFullscreen}><section className="jz-video-editing jz-video-editor" aria-label="视频剪辑" tabIndex={0} onKeyDown={event => {
    if (["Backspace", "Delete"].includes(event.key) && !(event.target as HTMLElement).closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) {
      if (event.defaultPrevented || !(event.target as HTMLElement).closest(".jz-editing-timeline")) return;
      event.preventDefault(); event.stopPropagation();
      if (event.repeat || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey || shared.busy) return;
      if ((event.target as HTMLElement).closest("[role=menu], [role=dialog]")) return;
      if (textDraft) void apply({ op: "removeText", textId: textDraft.id });
      else if (selectedClip && !selectedClip.excluded) void apply({ op: "include", clipId: selectedClip.id, included: false });
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.nativeEvent.isComposing &&
      !(event.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) {
      event.preventDefault(); if (!event.repeat) void travel(event.shiftKey ? "redo" : "undo"); return;
    }
    if (event.key === " " && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing && active !== false) {
      if (event.defaultPrevented || (event.target as HTMLElement).closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=menu], [role=dialog]")) return;
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) player.current?.togglePlayback();
      return;
    }
    if (event.defaultPrevented || event.repeat || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.nativeEvent.isComposing || active === false || event.key.toLowerCase() !== "b" || shared.busy) return;
    if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true], [role=menu]")) return;
    event.preventDefault(); splitAtPlayhead();
  }}>
    {materialInsert && <VideoMaterialInsertDialog target={materialInsert.title} busy={shared.busy} error={error} insert={side => { void insertMaterial(side); }} close={() => setMaterialInsert(undefined)}/>}

    {error && !clipPopup && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="jz-video-editor-heading jz-editing-header">
      <small className="jz-editing-save-status" role="status">{busy ? "正在保存…" : saveStatus}</small>
      <div className="jz-video-tools jz-editing-header-actions">
      <IconButton icon="settings" label="选择整集剪辑" title="整集 · 画幅、转场与历史" aria-pressed={!selectedClip && !textDraft && !validJunction} onClick={() => withSavedText(() => {
        selectClip(undefined); setClipPopup(undefined); setTextPopup(undefined); setSidePanel("properties");
      })} />
      <button type="button" className="jz-video-icon-button" aria-label={fullscreen ? "退出剪辑全屏" : "全屏剪辑与导出"} aria-pressed={fullscreen} title={fullscreen ? "退出全屏 · Esc" : "全屏剪辑与导出"} onClick={() => setFullscreen(value => !value)}><VideoToolIcon name={fullscreen ? "focus" : "fit"} /></button>
      <select aria-label="剪辑布局" title="切换布局" value={layoutMode} onChange={event => { const mode = event.target.value; setLayoutMode(mode); setPanelWidths(mode === "materials" ? {library:400,properties:240} : mode === "properties" ? {library:200,properties:400} : mode === "portrait-left" ? {library:360,properties:280} : mode === "portrait-right" ? {library:240,properties:360} : {library:240,properties:280}); setTimelineHeight(260); }}><option value="default">默认布局</option><option value="portrait-left">竖屏左侧</option><option value="portrait-right">竖屏右侧</option><option value="materials">素材优先</option><option value="properties">属性优先</option></select>
      {remote.restoreVideoTimeline && <><button className="jz-video-icon-button" aria-label="撤销" type="button" disabled={busy || !undo.current.length} title="撤销 · Cmd/Ctrl+Z" onClick={() => { void travel("undo"); }}><VideoToolIcon name="undo" /></button><button className="jz-video-icon-button" aria-label="重做" type="button" disabled={busy || !redo.current.length} title="重做 · Cmd/Ctrl+Shift+Z" onClick={() => { void travel("redo"); }}><VideoToolIcon name="redo" /></button></>}
      {textDraft && <button className="jz-video-icon-button" aria-label="保存文本" type="submit" form={`jz-video-text-${episode.id}`} disabled={shared.busy} title="保存文本 · Cmd/Ctrl＋S"><VideoToolIcon name="save" /></button>}
      {remote.roughCutVideo && <button className="jz-video-icon-button" aria-label={episode.timeline.length ? "按镜头重新组装（重置剪辑）" : "按镜头组装粗剪"} title={episode.timeline.length ? "按镜头重新组装（重置剪辑）" : "按镜头组装粗剪"} type="button" disabled={busy || unresolvedSources.length > 0} onClick={() => { if (episode.timeline.length) setConfirmRebuild(true); else void assemble(); }}><VideoToolIcon name="reset" /></button>}
      {remote.exportVideo && <VideoExportControl check={remote.checkVideoRuntime} styled={Boolean(episode.texts?.length)} wrap={(episode.texts ?? []).some(text => text.style.width !== undefined)} disabled={busy || !layout.clips.length || jobs.some((job) => job.kind === "export" && (job.status === "running" || job.status === "queued"))} onExport={() => withSavedText(() => { void run(() => remote.exportVideo!({ workId: project.workId, episodeId: episode.id, expectedRevision: currentProject.current.revision, aspectRatio })); })} />}

    </div></div>
    {confirmRebuild && <div className="jz-editing-confirm" ref={rebuildConfirmation} tabIndex={-1} role="group" aria-label="确认重新组装">
      <p>重新组装会重置当前裁剪、字幕、转场和音轨，使用所选的视频版本。</p>
      <IconButton icon="apply" label={"确认重新组装"} type="button" disabled={busy || unresolvedSources.length > 0} onClick={() => { void assemble().then(next => { if (next) setConfirmRebuild(false); }); }} />
      <IconButton icon="close" label={"保留当前剪辑"} type="button" disabled={busy} onClick={() => setConfirmRebuild(false)} />
    </div>}

    <div className="jz-video-layout-panels" role="group" aria-label="剪辑侧栏">
      <button className="jz-video-icon-button" type="button" title="素材库" aria-label="切换素材库" aria-pressed={sidePanel === "library"} onClick={() => setSidePanel(value => value === "library" ? undefined : "library")}><VideoToolIcon name="library" /></button>
      <button className="jz-video-icon-button" type="button" title="属性" aria-label="切换属性栏" aria-pressed={sidePanel === "properties"} onClick={() => setSidePanel(value => value === "properties" ? undefined : "properties")}><VideoToolIcon name="track" /></button>
    </div>
    <div ref={workbench} className="jz-editing-with-library jz-cut-workbench" data-panel={sidePanel} data-layout={layoutMode} style={{"--jz-timeline-height":`${timelineHeight}px`, "--jz-library-width":`${panelWidths.library}px`, "--jz-properties-width":`${panelWidths.properties}px`} as CSSProperties}>
    {columnDivider("library")}{columnDivider("properties")}
    <VideoMaterialLibrary position={playhead} audioControls={<>
{remote.importVideoAsset && <VideoAssetImport label="上传音乐" accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/ogg" busy={busy} onImport={event => { void importFile(event); }}/>}<VideoVoiceRecorder key={`${project.workId}/${episode.id}`} active={active} busy={busy || !remote.importVideoAsset} save={importAsset}/>
    <div className="jz-library-audio-controls">
      <div className="jz-video-tools">{episode.timeline.filter(clip => clip.track === "audio").map(clip => <button type="button" key={clip.id} onClick={() => selectClip(clip.id)}>编辑音轨：{project.assets.find(asset => asset.id === clip.assetId)?.label ?? "音频"}</button>)}</div>
      {remote.generateVideoSpeech && <><label>配音文本<textarea rows={3} maxLength={4096} disabled={busy} placeholder="留空则使用已保存镜头的对白 / 旁白" value={speech} onChange={(event) => setSpeech(event.target.value)} /></label>
        <IconButton icon="mic" label={"生成 AI 配音"} type="button" disabled={busy || jobs.some((job) => job.kind === "audio" && (job.status === "running" || job.status === "queued"))} onClick={() => { void run(() => remote.generateVideoSpeech!({ workId: project.workId, episodeId: episode.id, expectedRevision: project.revision, ...(speech.trim() ? { text: speech.trim() } : {}) })); }} /></>}
      {audioAssets.length > 0 && <form onSubmit={(event) => { event.preventDefault(); if (audioId) void apply({ op: "insertAudio", assetId: audioId, inSec: Number(audioIn), outSec: Number(audioOut), startSec: Number(audioStart), volume: 1 }); }}>
        <label>音频素材<select value={audioId} disabled={shared.busy} onChange={(event) => { setAudioId(event.target.value); const asset = audioAssets.find((item) => item.id === event.target.value); setAudioOut(String(Math.min(asset?.durationSec ?? 5, Math.max(0, layout.durationSec - Number(audioStart))))); }}>{<option value="">选择音频</option>}{audioAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.label}</option>)}</select></label>
        <div className="jz-audio-placement"><label>音频入点（秒）<input type="number" step="any" min={0} disabled={shared.busy} value={audioIn} onChange={(event) => setAudioIn(event.target.value)} /></label><label>音频出点（秒）<input type="number" step="any" disabled={shared.busy} value={audioOut} onChange={(event) => setAudioOut(event.target.value)} /></label><label>插入时间（秒）<input type="number" step="any" min={0} disabled={shared.busy} value={audioStart} onChange={(event) => setAudioStart(event.target.value)} /></label></div>
        <IconButton icon="add" label={"加入音轨"} type="submit" disabled={shared.busy || !audioId || !layout.durationSec} />
      </form>}
    </div>

</>} onImport={remote.importVideoAsset ? importFile : undefined} onAddText={() => { setTextPopup(undefined); void addText(player.current?.pauseAtCurrentPosition() ?? playhead); }} episodeId={episode.id} episodes={episodes} project={project} clips={episode.timeline} busy={shared.busy} onSelect={id => withSavedText(() => selectClip(id))} remote={remote} apply={apply} />
    <div className="jz-editing-workspace">
      <VideoTimelinePreview onMaterialDrop={dropOnPlayer} controllerRef={player} project={project} episode={sourceClip ? { ...episode, texts: [], timeline: [{ ...sourceClip, excluded: false, transitionSec: 0, videoLayer: undefined, startSec: undefined, transform: undefined }] } : episode} remote={remote} active={active !== false}
        onSelectText={sourceClip ? undefined : selectText} onChangeText={sourceClip ? undefined : setTextDraft} textBusy={shared.busy} textDraft={sourceClip ? undefined : textDraft} position={sourceClip ? sourcePosition : playhead} onPositionChange={sourceClip ? setSourcePosition : setPlayhead} onSelectClip={id => { if (!textDraft) selectClip(id); }}
        toolbar={<>{sourceClip && <IconButton icon="left" label={"返回成片"} type="button" onClick={() => selectClip(undefined)} />}<button type="button" aria-label="在播放头处分割" title="切分 · ⌘/Ctrl+B" disabled={shared.busy || !canSplit} onClick={splitAtPlayhead}><VideoToolIcon name="split"/></button></>} />
      <div className="jz-timeline-dock">
      <div className="jz-video-layout-divider" role="separator" aria-label="调整时间线高度" aria-orientation="horizontal" aria-valuemin={180} aria-valuemax={600} aria-valuenow={timelineHeight} tabIndex={0}
        onKeyDown={event => { if (["ArrowUp","ArrowDown"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); setTimelineHeight(value => Math.max(180,Math.min(600,value+(event.key === "ArrowUp" ? 20 : -20)))); } }}
        onPointerDown={event => { event.preventDefault(); resizeStart.current={y:event.clientY,height:timelineHeight}; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (resizeStart.current) setTimelineHeight(Math.max(180,Math.min(600,resizeStart.current.height+resizeStart.current.y-event.clientY))); }}
        onPointerUp={event => { resizeStart.current=undefined; if(event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => {resizeStart.current=undefined;}} onLostPointerCapture={() => {resizeStart.current=undefined;}} />
      <VideoEditingTimeline remote={remote} batchProperties={batchProperties} videoTrackCount={episode.videoTrackCount ?? 0} videoTrackBelowCount={episode.videoTrackBelowCount ?? 0} key={`${project.workId}:${episode.id}`} onEditClip={(id,x,y) => withSavedText(() => { selectClip(id); setTextPopup(undefined); setClipPopup({id,x,y}); })} onPause={() => { const time = player.current?.pauseAtCurrentPosition() ?? playhead; return sourceClip ? playhead : time; }} texts={allTexts} selectedTextId={textDraft?.id} onSelectText={selectText} textTracks={episode.textTracks ?? []} onRemoveTextTrack={trackId => withSavedText(() => { void apply({op:"removeTextTrack",trackId}).then(next => { if (next && textDraft?.trackId === trackId) { setTextDraft(undefined); setTextPopup(undefined); } }); })} onAddTextTrack={() => { void addTextTrack(); }} onAddText={(time, trackId) => { setTextPopup(undefined); void addText(time, trackId); }} onContextText={(text, x, y) => withSavedText(() => { selectText(text); setTextPopup({x,y}); })} project={project} clips={episode.timeline} position={playhead} selectedId={textDraft ? undefined : inspectedId} busy={shared.busy} onSeek={seek} onSelect={seekClip} onJunction={(left, right) => withSavedText(() => { selectClip(left); setPlayhead(layout.clips.find(item => item.clip.id === right)?.startSec ?? playhead); setJunction({ left, right }); })} apply={apply} />
      </div>
      <div className="jz-editing-properties">
        <div ref={setBatchProperties} className="jz-batch-properties"/>
        {!textDraft && !inspectedId && !validJunction && <section className="jz-episode-properties" aria-label="整集属性"><h3>整集</h3>    <div className="jz-video-output-ratio"><label>成片画幅<select value={aspectRatio} disabled={busy} onChange={(event) => setAspectRatio(event.target.value as NonNullable<ExportVideoInput["aspectRatio"]>)}><option value="9:16">竖屏 9:16</option><option value="16:9">横屏 16:9</option><option value="1:1">方形 1:1</option><option value="4:3">4:3</option><option value="3:4">3:4</option><option value="21:9">宽屏 21:9</option></select></label>
      {remote.updateVideoEpisode && <IconButton icon="apply" label={"应用到预览"} type="button" disabled={busy || aspectRatio === (episode.aspectRatio ?? "9:16")} onClick={() => { void run(() => remote.updateVideoEpisode!({ workId: project.workId, episodeId: episode.id, expectedRevision: project.revision, patch: { aspectRatio } })); }} />}
      {aspectRatio !== (episode.aspectRatio ?? "9:16") && <small>导出会使用所选画幅；应用后同步预览画框。</small>}
    </div><small className="jz-episode-summary">{layout.durationSec.toFixed(1)} 秒 · {layout.clips.length} 个画面片段</small>
    {remote.roughCutVideo && roughCutSources.length > 0 && <details className="jz-roughcut-sources" open={!episode.timeline.length || confirmRebuild}>
      <summary>组装视频版本 · {roughCutSources.filter(source => source.value).length} / {roughCutSources.length} 个镜头可用</summary>
      <p>生成的视频先保留为备选。单一版本已填入下方；点击“按镜头组装粗剪”后选用并加入时间线。多个版本请先选择。</p>
      {roughCutSources.map(({ shot, candidates, value }) => <div className="jz-roughcut-source" key={shot.id}>
        {candidates.length ? <><label>{shot.title}的视频版本<select value={value} disabled={busy || shot.locked} onChange={event => { setRoughCutChoices(current => ({ ...current, [shot.id]: event.target.value })); setError(null); }}><option value="">请选择视频版本</option>{candidates.map((asset, index) => <option key={asset.id} value={asset.id}>版本 {index + 1} · {asset.label}{asset.id === shot.videoAssetId ? "（当前选用）" : ""}</option>)}</select></label><small>{shot.locked && !value ? "镜头已锁定，请先解锁后选用视频。" : value === shot.videoAssetId ? "沿用当前选用版本" : value ? "组装时选用此版本" : "已有生成视频，请选择用于剪辑的版本"}</small></>
          : <p>{shot.title}：{shot.imageAssetId || project.assets.some(asset => asset.kind === "image" && asset.episodeId === episode.id && asset.shotId === shot.id) ? "已有图片，尚无视频；可先生成视频，或将图片加入时间线。" : "尚无可用视频，组装时会跳过。"}</p>}
      </div>)}
      {unresolvedSources.length > 0 && <p role="status">还有 {unresolvedSources.length} 个镜头需要选择视频版本。</p>}
    </details>}

    <section className="jz-editing-add-controls" aria-label="素材与转场">

    {layout.clips.length > 1 && <>
      <form className="jz-clip-edit-form" onSubmit={event => { event.preventDefault(); void apply({ op: "transitions", transitionSec: Number(transitionDuration) }); }}>
        <label>统一转场时长（秒）<input type="number" min={0.05} max={60} step="any" required value={transitionDuration} disabled={shared.busy} onChange={event => setTransitionDuration(event.target.value)} /></label>
        <IconButton icon="sparkles" label={"生成全部淡化转场"} type="submit" disabled={shared.busy} />
        <IconButton icon="apply" label={"全部改为直接拼接"} type="button" disabled={shared.busy} onClick={() => { void apply({ op: "transitions", transitionSec: 0 }); }} />
      </form>

    </>}
    </section>


    {!episode.timeline.length && <p>{roughCutSources.some(source => source.candidates.length) ? "已有视频素材。选好上方版本后按镜头组装，即可开始剪辑。" : "可从已有素材加入视频或图片；镜头图片也可用于制作静态画面片段。"}</p>}
    {jobs.some((job) => job.status === "running" || job.status === "queued") && <small role="status">任务进行中，可在任务记录中查看进度。</small>}

    {remote.getVideoTimelineHistory && <details open={historyOpen}><summary onClick={(event) => { event.preventDefault(); setHistoryOpen((value) => !value); if (!historyOpen) void loadHistory(); }}>剪辑历史</summary>
      <small>显示最近 20 个不同的剪辑版本，恢复只修改时间线。</small>
      <IconButton icon="history" label={"刷新历史"} type="button" disabled={historyLoading} onClick={() => { void loadHistory(); }} />
      {historyLoading && <p role="status">正在加载剪辑历史…</p>}{historyError && <p role="alert">{historyError}</p>}
      {!historyLoading && !historyError && !history.length && <p>暂无可恢复的剪辑版本。</p>}
      {history.map((version, index) => <div className="jz-video-editor-heading" key={version.revision}><span>历史版本 {index + 1} · {version.clipCount} 个片段 · {version.durationSec.toFixed(1)} 秒</span>
        {remote.restoreVideoTimeline && <IconButton icon="undo" label={"恢复此剪辑"} type="button" disabled={busy} onClick={() => { void run(() => remote.restoreVideoTimeline!({ workId: project.workId, episodeId: episode.id, expectedRevision: project.revision, revision: version.revision })); }} />}
      </div>)}
    </details>}
    {selectedExport && <details><summary>导出历史 · {exports.length} 个版本</summary><p>这里保留每次导出的成片。后续剪辑不会改写已导出文件，请重新导出以保存新剪辑。</p><label>成片版本<select value={selectedExport.id} onChange={(event) => setExportId(event.target.value)}>{exports.map((asset, index) => <option key={asset.id} value={asset.id}>{index + 1}. {asset.label}</option>)}</select></label>
      {exportJob?.state?.stale && <p>此成片来自较早的剪辑版本，当前时间线已有更新。</p>}
      {exportJob?.state?.subtitleMode === "embedded" && <p>字幕已嵌入 MP4；请在播放器中开启字幕轨道。</p>}
      {exportJob?.state?.subtitleMode === "burned" && <small>字幕已渲染进画面。</small>}
      <VideoMediaPreview remote={remote} workId={project.workId} asset={selectedExport} />
      {remote.saveVideoExport ? <IconButton icon="download" label={"保存 MP4"} type="button" disabled={busy} onClick={() => {
        if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(null); setNotice(null);
        void remote.saveVideoExport!({ workId: project.workId, assetId: selectedExport.id, title: episode.title }).then((result) => { if (result) setNotice("MP4 已保存到所选位置。"); }).catch((cause: unknown) => setError(userErrorMessage(cause, "保存 MP4 失败", { operation: "VideoEditingPanel" }))).finally(() => { busyRef.current = false; setBusy(false); });
      }} /> : downloadUrl && <a className="jz-icon-action" aria-label="下载 MP4" title="下载 MP4" href={downloadUrl} download={`${episode.title}.mp4`}><VideoToolIcon name="download" /></a>}
    </details>}
        </section>}
        {textDraft && (textPopup ? <VideoTextPopover {...textPopup} close={() => withSavedText(() => setTextPopup(undefined))}><VideoTextEditor tracks={episode.textTracks ?? []} controllerRef={textEditor} onStatus={setSaveStatus} formId={`jz-video-text-${episode.id}`} key={textDraft.id} saved={allTexts.find(text => text.id === textDraft.id) ?? textDraft} draft={textDraft}
          revision={project.revision} duration={layout.durationSec} busy={shared.busy} onChange={setTextDraft} close={() => { setTextDraft(undefined); setTextPopup(undefined); }} apply={apply} /></VideoTextPopover> : <VideoTextEditor tracks={episode.textTracks ?? []} controllerRef={textEditor} onStatus={setSaveStatus} formId={`jz-video-text-${episode.id}`} key={textDraft.id} saved={allTexts.find(text => text.id === textDraft.id) ?? textDraft} draft={textDraft}
          revision={project.revision} duration={layout.durationSec} busy={shared.busy} onChange={setTextDraft} close={() => { setTextDraft(undefined); setTextPopup(undefined); }} apply={apply} />)}

        {!textDraft && validJunction && <VideoJunctionEditor key={`${left.id}/${right.id}`} project={project} episode={episode} left={left} right={right} remote={remote} busy={shared.busy} apply={apply} close={() => setJunction(undefined)} />}
    {episode.timeline.map((clip) => {
      const asset = project.assets.find((item) => item.id === clip.assetId), visualIndex = layout.clips.findIndex((item) => item.clip.id === clip.id);
      const editor = <article className="jz-clip-toolbar" hidden={Boolean(textDraft) || Boolean(validJunction) || clip.id !== inspectedId} key={clip.id} id={`clip-${clip.id}`} aria-label={`剪辑片段 ${asset?.label ?? clip.id}`} data-selected={selectedClip?.id === clip.id} onClick={() => selectClip(clip.id)}><div className="jz-video-editor-heading"><button type="button" className="jz-clip-target" aria-pressed={selectedClip?.id === clip.id} aria-label={`选择剪辑片段 ${asset?.label ?? "素材"}`}><strong>{clip.track === "audio" ? "音频" : `${episode.timeline.filter(item => item.track !== "audio").findIndex(item => item.id === clip.id) + 1}.`} {asset?.label ?? "素材"}{clip.excluded ? " · 未参与成片" : ""}</strong></button><span>{(clip.outSec - clip.inSec).toFixed(1)} 秒</span></div>
        <div className="jz-video-tools">{clip.track !== "audio" && <><IconButton icon="up" label={"前移"} type="button" disabled={shared.busy || clip.excluded || visualIndex === 0} onClick={() => reorder(clip.id, -1)} /><IconButton icon="down" label={"后移"} type="button" disabled={shared.busy || clip.excluded || visualIndex === layout.clips.length - 1} onClick={() => reorder(clip.id, 1)} /></>}
          <IconButton icon="eye" label={(clip.excluded ? "恢复参与成片" : "暂不参与成片")} type="button" disabled={shared.busy} onClick={() => { void apply({ op: "include", clipId: clip.id, included: Boolean(clip.excluded) }); }} /></div>
        {clip.track !== "audio" && !clip.videoLayer && !clip.excluded && layout.mainClips.findIndex(item=>item.clip.id===clip.id) < layout.mainClips.length - 1 && <div className="jz-clip-transition">

          <ClipEditForm {...shared} clip={clip} label="保存转场" fields={[{ label: "与下一片段淡化重叠（秒）", shortLabel: "淡化（秒）" }]} valuesOf={(item) => [String(item.transitionSec ?? 0)]} editFor={(values) => ({ op: "transition", clipId: clip.id, transitionSec: Number(values[0]) })} />
        </div>}
          <ClipEditForm {...shared} clip={clip} label="拆分片段" fields={[{ label: "素材拆分位置（秒）", shortLabel: "拆分（秒）" }]} valuesOf={(item) => [String((item.inSec + item.outSec) / 2)]} editFor={(values) => ({ op: "split", clipId: clip.id, atSec: Number(values[0]) })} />
        <div className="jz-clip-extra-controls">
          <ClipEditForm {...shared} clip={clip} label="保存裁剪" fields={[{ label: "素材入点（秒）", shortLabel: "入点（秒）" }, { label: "素材出点（秒）", shortLabel: "出点（秒）" }]} valuesOf={(item) => [String(item.inSec), String(item.outSec)]} editFor={(values) => ({ op: "trim", clipId: clip.id, inSec: Number(values[0]), outSec: Number(values[1]) })} />

          <ClipEditForm {...shared} clip={clip} label="保存音量" fields={[{ label: "音量（%，0–400）", shortLabel: "音量 %" }]} valuesOf={(item) => [String(item.volume * 100)]} editFor={(values) => ({ op: "volume", clipId: clip.id, volume: Number(values[0]) / 100 })} />
          {clip.track !== "audio" && ((episode.videoTrackCount ?? 0)+(episode.videoTrackBelowCount ?? 0))>0 && <ClipEditForm {...shared} clip={clip} label="保存画面位置" fields={[{label:"视频轨道（0 为主轨）",shortLabel:"轨道"},{label:"视频起点（秒）",shortLabel:"起点"},{label:"画面缩放（%）",shortLabel:"缩放 %"},{label:"画面水平位置（%）",shortLabel:"X %"},{label:"画面垂直位置（%）",shortLabel:"Y %"}]} valuesOf={item=>[String(item.videoLayer ?? 0),String(item.startSec ?? 0),String(item.transform?.scale ?? 100),String(item.transform?.x ?? 50),String(item.transform?.y ?? 50)]} editFor={values=>({op:"videoPlacement",clipId:clip.id,layer:Number(values[0]),startSec:Number(values[1]),transform:{scale:Number(values[2]),x:Number(values[3]),y:Number(values[4])}})} />}
          {clip.track === "audio" ? <ClipEditForm {...shared} clip={clip} label="移动音频" fields={[{ label: "时间线起点（秒）", shortLabel: "起点（秒）" }]} valuesOf={(item) => [String(item.startSec ?? 0)]} editFor={(values) => ({ op: "moveAudio", clipId: clip.id, startSec: Number(values[0]) })} /> : null}
        </div>
      </article>;
      return clipPopup?.id === clip.id && !textDraft && !validJunction ? <VideoTextPopover key={clip.id} {...clipPopup} label="视频片段编辑" close={() => setClipPopup(undefined)}>
        <div className="jz-video-editor-heading"><strong>视频片段</strong><IconButton icon="close" label={"关闭视频编辑"} type="button" aria-label="关闭视频编辑" title="关闭" onClick={() => setClipPopup(undefined)} /></div>
        {error && <p role="alert">{error}</p>}{editor}
      </VideoTextPopover> : editor;
    })}
      </div>

    </div>
    </div>

  </section></VideoEditorFrame>;
}
