import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { VideoToolIcon } from "./VideoToolIcon.tsx";
import { flushSync } from "react-dom";
import { subtitleSentences } from "../../../contracts/src/video-text-segmentation.ts";
import { VideoTextInput } from "./VideoTextInput.tsx";
import { useVideoFont } from "./useVideoFont.ts";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { VideoTextFont, videoTextFontLabels, VideoTextOverlay, type VideoProject } from "@jizuo/contracts";
import type { TimelineEdit } from "../../../contracts/src/video-editing.ts";

export interface TextEditorHandle { flush(): Promise<boolean>; needsSave(): boolean }

export function VideoTextEditor({ saved, draft, revision, duration, busy, onChange, close, apply, formId, controllerRef, onStatus, tracks = [] }: {
  tracks?: Array<{id:string;name:string}>;
  controllerRef?: Ref<TextEditorHandle>; onStatus?: (status: string) => void;
  formId: string; saved: VideoTextOverlay; draft: VideoTextOverlay; revision: number; duration: number; busy: boolean;
  onChange: (text: VideoTextOverlay) => void; close: () => void;
  apply: (edit: TimelineEdit, revision?: number) => Promise<VideoProject | undefined>;
}) {
  const fontStatus = useVideoFont(draft.style.fontFamily);
  const incoming = JSON.stringify(saved);
  const [base, setBase] = useState({ incoming, revision });
  const persisted = useRef({ incoming, revision });
  const [error, setError] = useState("");
  const dirty = JSON.stringify(draft) !== base.incoming;
  const conflict = incoming !== base.incoming && dirty;
  useEffect(() => {
    if (!dirty && incoming !== base.incoming) onChange(saved);
    if (!dirty || incoming === base.incoming) { setBase({ incoming, revision }); persisted.current = { incoming, revision }; }
  }, [incoming, revision]);
  const style = (patch: Partial<VideoTextOverlay["style"]>) => onChange({ ...draft, style: { ...draft.style, ...patch } });
  const inFlight = useRef(false);
  const failed = useRef("");
  const latest = useRef(draft); latest.current = draft;
  const [status, setStatus] = useState("");
  const saving = useRef<Promise<boolean | undefined>>();
  // Saving a snapshot must not disable inputs for the next draft.
  const inputBusy = busy && !saving.current;
  const saveCore = async () => {
    if (busy || conflict || inFlight.current) return;
    const snapshot = latest.current;
    const parsed = VideoTextOverlay.safeParse(snapshot);
    if (!parsed.success || snapshot.endSec > duration || snapshot.endSec - snapshot.startSec < 0.5 - 1e-8) { setError("请填写文本，并确保起止时间在成片范围内、每段至少显示 0.5 秒。"); return; }
    const signature = JSON.stringify(snapshot);
    if (signature === persisted.current.incoming) return true;
    inFlight.current = true; setStatus("正在保存…"); setError("");
    try {
      const project = await apply({ op: "saveText", text: parsed.data }, persisted.current.revision);
      const text = project?.episodes.flatMap(episode => episode.texts ?? []).find(text => text.id === snapshot.id);
      if (text && project) {
        if (JSON.stringify(latest.current) === signature) onChange(text);
        persisted.current = { incoming: JSON.stringify(text), revision: project.revision };
        setBase(persisted.current);
        failed.current = ""; setStatus("已保存"); return true;
      } else { failed.current = signature; setStatus("保存失败，修改已保留，请重试"); }
    } catch { failed.current = signature; setStatus("保存失败，修改已保留，请重试"); }
    finally { inFlight.current = false; }
  };
  const save = () => {
    if (saving.current) return saving.current;
    const task = saveCore(); saving.current = task;
    void task.finally(() => { if (saving.current === task) saving.current = undefined; });
    return task;
  };
  useImperativeHandle(controllerRef, () => ({ needsSave: () => {
    flushSync(() => document.dispatchEvent(new Event("jizuo:flush-text-input")));
    return Boolean(saving.current) || JSON.stringify(latest.current) !== persisted.current.incoming;
  }, flush: async () => {
    flushSync(() => document.dispatchEvent(new Event("jizuo:flush-text-input")));
    if (saving.current) await saving.current;
    if (JSON.stringify(latest.current) === persisted.current.incoming) return true;
    return Boolean(await saveRef.current());
  } }));
  useEffect(() => { onStatus?.(error || (dirty ? "有未保存修改" : status || "已保存")); }, [error, dirty, status, onStatus]);
  const [splitPreview, setSplitPreview] = useState<string[]>();
  const [stripSpeaker, setStripSpeaker] = useState(true);
  const [precise, setPrecise] = useState(false);
  const applyFont = async () => {
    if (busy || conflict || inFlight.current) return;
    inFlight.current = true; setError(""); setStatus("正在统一字体和字号…");
    const snapshot = latest.current;
    try {
      const project = await apply({ op: "applyTextFont", text: snapshot }, base.revision);
      const updated = project?.episodes.flatMap(episode => episode.texts ?? []).find(text => text.id === snapshot.id);
      if (project && updated) {
        if (JSON.stringify(latest.current) === JSON.stringify(snapshot)) onChange(updated);
        setBase({ incoming: JSON.stringify(updated), revision: project.revision });
        failed.current = ""; setStatus("已统一本集全部文本的字体和字号，可继续单独调整");
      } else setError("统一设置失败，修改已保留，请重试。");
    } catch { setError("统一设置失败，修改已保留，请重试。"); }
    finally { inFlight.current = false; }
  };
  const fontRef = useRef(applyFont); fontRef.current = applyFont;
  const split = async () => {
    if (busy || conflict || inFlight.current) return;
    inFlight.current = true; setError("");
    try {
      const result = await apply({ op: "splitText", text: latest.current, parts: splitPreview, stripSpeaker }, base.revision);
      if (result) close();
      else setError("断句失败，原文本已保留，请重试。");
    } catch (cause) { setError(userErrorMessage(cause, "断句失败，原文本已保留。", { operation: "VideoTextEditor" })); }
    finally { inFlight.current = false; }
  };
  const splitRef = useRef(split); splitRef.current = split;
  const saveRef = useRef(save); saveRef.current = save;
  const signature = JSON.stringify(draft);
  useEffect(() => {
    if (!dirty || busy || conflict || failed.current === signature) return;
    const timer = setTimeout(() => { void saveRef.current(); }, 800);
    return () => clearTimeout(timer);
  }, [signature, dirty, busy, conflict, base.revision]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s" || event.isComposing) return;
      event.preventDefault(); event.stopPropagation();
      document.dispatchEvent(new Event("jizuo:flush-text-input"));
      clearTimeout(timer); timer = setTimeout(() => { void saveRef.current(); }, 0);
    };
    window.addEventListener("keydown", shortcut, true);
    return () => { window.removeEventListener("keydown", shortcut, true); clearTimeout(timer); };
  }, []);
  return <form id={formId} className="jz-text-editor" aria-label="文本样式与位置" onSubmit={event => {
    event.preventDefault();
    document.dispatchEvent(new Event("jizuo:flush-text-input"));
    setTimeout(() => { void saveRef.current(); }, 0);
  }}>
    <div className="jz-video-editor-heading"><strong>文本</strong><button className="jz-video-icon-button" aria-label="关闭文本编辑" title="关闭文本编辑" type="button" disabled={busy} onClick={() => {
      document.dispatchEvent(new Event("jizuo:flush-text-input"));
      setTimeout(() => { void saveRef.current().then(success => { if (success) close(); }); }, 0);
    }}><VideoToolIcon name="close" /></button></div>
    <label className="jz-text-content-field">文本内容<VideoTextInput rows={2} required maxLength={50000} disabled={inputBusy} value={draft.text} onTextChange={text => onChange({ ...draft, text })} /></label>
    <div className="jz-text-settings-row">
    {tracks.length > 0 && <label>轨道<select aria-label="文本所属轨道" value={draft.trackId ?? ""} disabled={inputBusy} onChange={event => { const {trackId, ...text} = draft; onChange({...text,...(event.target.value ? {trackId:event.target.value} : {})}); }}><option value="">默认文本</option>{tracks.map(track => <option key={track.id} value={track.id}>{track.name}</option>)}</select></label>}
    <div className="jz-video-tools"><button className="jz-video-icon-button" aria-label="自动断句为时间块" title="自动断句为时间块" type="button" disabled={busy || conflict} onClick={() => {
      document.dispatchEvent(new Event("jizuo:flush-text-input"));
      setTimeout(() => { setSplitPreview(subtitleSentences(latest.current.text, stripSpeaker)); }, 0);
    }}><VideoToolIcon name="split" /></button></div>
    <div className="jz-text-timing-row"><div className="jz-subtitle-times">{(["startSec", "endSec"] as const).map(key => <label key={key}>{key === "startSec" ? "开始（秒）" : "结束（秒）"}<input aria-label={key === "startSec" ? "文本开始（秒）" : "文本结束（秒）"} type="number" required min={0} max={duration} step={precise ? 0.01 : 1} inputMode={precise ? "decimal" : "numeric"} disabled={inputBusy} value={Number.isFinite(draft[key]) ? (precise ? Number(draft[key].toFixed(2)) : Math.floor(draft[key])) : ""}
      onKeyDown={event => { if (!precise && [".", ",", "e", "E", "+", "-"].includes(event.key)) event.preventDefault(); }}
      onPaste={event => { if (!precise && !/^\d+$/.test(event.clipboardData.getData("text").trim())) event.preventDefault(); }}
      onChange={event => { const value = event.target.valueAsNumber; if ((precise ? Number.isFinite(value) : Number.isInteger(value)) && value >= 0) onChange({ ...draft, [key]: value }); }} /></label>)}</div>
<small title="每块最短 0.5 秒，修改后自动保存">{Math.max(0, draft.endSec - draft.startSec).toFixed(2)} 秒 <IconButton icon="settings" label={(precise ? "整数时间" : "精确时间")} type="button" onClick={() => setPrecise(value => !value)} /></small></div>
    <div className="jz-text-appearance-row"><label>字体<select value={draft.style.fontFamily ?? "Arial"} disabled={inputBusy} onChange={event => style({ fontFamily: VideoTextFont.parse(event.target.value) })}>
      <optgroup label="内置开源字体 · 无需安装">{VideoTextFont.options.slice(0, 3).map(font => <option key={font} value={font}>{videoTextFontLabels[font]}</option>)}</optgroup>
      <optgroup label="本机字体">{VideoTextFont.options.slice(3).map(font => <option key={font} value={font}>{videoTextFontLabels[font]}</option>)}</optgroup>
    </select></label>

    {fontStatus && <small role="status" title="自动保存 · Cmd/Ctrl＋S 立即保存">{fontStatus}</small>}
    <div className="jz-subtitle-times"><label title="字号占画面高度的百分比">字号 %<input aria-label="字号（画面高度 %）" type="number" min={1} max={20} step="any" required disabled={inputBusy} value={draft.style.fontSize} onChange={event => style({ fontSize: event.target.valueAsNumber })} /></label><label>颜色<input aria-label="文字颜色" type="color" disabled={inputBusy} value={draft.style.color} onChange={event => style({ color: event.target.value })} /></label></div>
    <div className="jz-video-tools"><button className="jz-video-icon-button" type="button" aria-label="将字体和字号应用到本集全部文本" title="将字体和字号应用到本集全部文本" disabled={busy || conflict} onClick={() => {
      document.dispatchEvent(new Event("jizuo:flush-text-input"));
      setTimeout(() => { void fontRef.current(); }, 0);
    }}><VideoToolIcon name="apply" /></button></div></div>
    </div>
    {splitPreview && <fieldset className="jz-split-preview"><legend>断句预览</legend>
      <label><input type="checkbox" checked={stripSpeaker} onChange={event => { setStripSpeaker(event.target.checked); setSplitPreview(subtitleSentences(latest.current.text, event.target.checked)); }} />去掉说话人标签</label>
      {splitPreview.map((part, index) => <label key={index}>第 {index + 1} 块<input value={part} onChange={event => setSplitPreview(parts => parts?.map((value, i) => i === index ? event.target.value : value))} /></label>)}
      <IconButton icon="apply" label={"确认断句"} type="button" disabled={busy || !splitPreview.length || splitPreview.some(part => !part.trim())} onClick={() => { void splitRef.current(); }} />
      <IconButton icon="close" label={"取消断句"} type="button" onClick={() => setSplitPreview(undefined)} />
    </fieldset>}
    <section className="jz-text-advanced" aria-label="样式与位置">
    <div className="jz-text-position-row">
    <div className="jz-video-tools"><label><input type="checkbox" disabled={inputBusy} checked={draft.style.bold} onChange={event => style({ bold: event.target.checked })} />加粗</label><label><input type="checkbox" disabled={inputBusy} checked={draft.style.outline} onChange={event => style({ outline: event.target.checked })} />黑色描边</label></div>
    <label>文本框宽度（%）<input aria-label="文本框宽度（%）" type="number" min={5} max={100} step="any" required disabled={inputBusy} value={draft.style.width ?? 90} onChange={event => style({ width: event.target.valueAsNumber })} /></label>
    <label>文字方向<select aria-label="文字方向" value={draft.style.direction ?? "horizontal"} disabled={inputBusy} onChange={event => style({ width: draft.style.width ?? 90, direction: event.target.value as NonNullable<VideoTextOverlay["style"]["direction"]> })}><option value="horizontal">横排</option><option value="rotate90">顺时针旋转 90°</option><option value="rotate270">逆时针旋转 90°</option></select></label>
    <label>对齐方式<select value={draft.style.align} disabled={inputBusy} onChange={event => style({ align: event.target.value as VideoTextOverlay["style"]["align"] })}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
    <div className="jz-video-tools">{[["顶部", 10], ["中央", 50], ["底部", 90]].map(([name, y]) => <button type="button" key={name} disabled={inputBusy} onClick={() => style({ x: 50, y: Number(y), align: "center" })}>{name}</button>)}</div>
    <div className="jz-subtitle-times">{(["x", "y"] as const).map(key => <label key={key}>{key === "x" ? "水平位置（%）" : "垂直位置（%）"}<input type="number" min={0} max={100} step="any" required disabled={inputBusy} value={draft.style[key]} onChange={event => style({ [key]: event.target.valueAsNumber })} /></label>)}</div>
    </div></section>
    <small role="status" title="自动保存 · Cmd/Ctrl＋S 立即保存">{dirty && !status.includes("失败") ? "待保存" : status || "已保存"}</small>
    {error && <p role="alert">{error}</p>}
    {conflict && <p role="alert">文本已在别处更新，草稿已保留。<IconButton icon="reset" label={"载入最新文本"} type="button" onClick={() => { onChange(saved); setBase({ incoming, revision }); }} /></p>}
  </form>;
}
