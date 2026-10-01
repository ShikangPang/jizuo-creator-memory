import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useState } from "react";
import type { VideoClip, VideoProject } from "@jizuo/contracts";
import { clipSubtitleCues, type TimelineEdit } from "../../../contracts/src/video-editing.ts";

type Row = { text: string; start: string; end: string };
const rowsOf = (clip: VideoClip): Row[] => clipSubtitleCues(clip).map(cue => ({ text: cue.text, start: String(Number(cue.startSec.toFixed(3))), end: String(Math.min(clip.outSec - clip.inSec, Number(cue.endSec.toFixed(3)))) }));

export function VideoSubtitleEditor({ clip, revision, busy, position, apply }: {
  clip: VideoClip; revision: number; busy: boolean; position: number;
  apply: (edit: TimelineEdit, expectedRevision: number) => Promise<VideoProject | undefined>;
}) {
  const incoming = JSON.stringify(rowsOf(clip));
  const [base, setBase] = useState({ incoming, revision, inSec: clip.inSec, outSec: clip.outSec });
  const [rows, setRows] = useState(() => rowsOf(clip));
  const [error, setError] = useState("");
  const dirty = JSON.stringify(rows) !== base.incoming;
  const rangeChanged = clip.inSec !== base.inSec || clip.outSec !== base.outSec;
  const conflict = dirty && (incoming !== base.incoming || rangeChanged);
  const duration = clip.outSec - clip.inSec;
  const at = Math.min(duration, Number(Math.max(0, Math.min(duration, position)).toFixed(3)));
  useEffect(() => {
    if (!dirty) { setRows(JSON.parse(incoming) as Row[]); setBase({ incoming, revision, inSec: clip.inSec, outSec: clip.outSec }); }
    else if (!rangeChanged && base.incoming === incoming && base.revision !== revision) setBase({ incoming, revision, inSec: clip.inSec, outSec: clip.outSec });
  }, [incoming, revision, dirty, base.incoming, base.revision, rangeChanged, clip.inSec, clip.outSec]);
  const change = (index: number, patch: Partial<Row>) => { setError(""); setRows(current => current.map((row, i) => i === index ? { ...row, ...patch } : row)); };
  return <form className="jz-subtitle-editor" aria-label="字幕时间设置" onSubmit={event => {
    event.preventDefault(); if (busy || conflict) return;
    const sorted = [...rows].sort((a, b) => Number(a.start) - Number(b.start));
    if (sorted.some(row => !row.text.trim() || row.start.trim() === "" || row.end.trim() === "" || !Number.isFinite(Number(row.start)) || !Number.isFinite(Number(row.end)) || Number(row.start) < 0 || Number(row.end) > duration || Number(row.end) <= Number(row.start))) {
      setError(`请填写字幕文本，时间须在 0–${duration.toFixed(3)} 秒内，且结束晚于开始。`); return;
    }
    if (sorted.some((row, i) => i > 0 && Number(row.start) < Number(sorted[i - 1]!.end))) { setError("字幕显示时间不能重叠。"); return; }
    setError("");
    void apply({ op: "subtitleCues", clipId: clip.id, cues: sorted.map(row => ({ text: row.text.trim(), startSec: clip.inSec + Number(row.start), endSec: Math.min(clip.outSec, clip.inSec + Number(row.end)) })) }, base.revision).then(project => {
      const saved = project?.episodes.flatMap(episode => episode.timeline).find(item => item.id === clip.id);
      if (saved && project) { const next = rowsOf(saved); setRows(next); setBase({ incoming: JSON.stringify(next), revision: project.revision, inSec: saved.inSec, outSec: saved.outSec }); }
    });
  }}>
    <p className="jz-editing-guide">时间从当前片段开头的 0 秒算起。保存后，预览和导出按设置显示；可换行填写译文。</p>
    {rows.map((row, index) => <fieldset key={index} disabled={busy}><legend>字幕 {index + 1}</legend>
      <label>字幕文本 {index + 1}<textarea rows={2} maxLength={5000} value={row.text} onChange={event => change(index, { text: event.target.value })} /></label>
      <div className="jz-subtitle-times"><label>开始时间 {index + 1}（秒）<input type="number" step="any" min={0} max={duration} required value={row.start} onChange={event => change(index, { start: event.target.value })} /></label>
      <label>结束时间 {index + 1}（秒）<input type="number" step="any" min={0} max={duration} required value={row.end} onChange={event => change(index, { end: event.target.value })} /></label></div>
      <div className="jz-video-tools"><IconButton icon="left" label={"用播放位置设为开始"} type="button" onClick={() => change(index, { start: String(at) })} /><IconButton icon="right" label={"用播放位置设为结束"} type="button" onClick={() => change(index, { end: String(at) })} /><IconButton icon="delete" label={"删除字幕 " + (index + 1)} type="button" onClick={() => setRows(current => current.filter((_, i) => i !== index))} /></div>
    </fieldset>)}
    <div className="jz-video-tools"><IconButton icon="add" label={"添加字幕"} type="button" disabled={busy || rows.length >= 500} onClick={() => setRows(current => [...current, { text: "", start: String(at), end: String(duration) }])} /><IconButton icon="save" label={"保存字幕"} type="submit" disabled={busy || conflict} /></div>
    {error && <p role="alert">{error}</p>}
    {conflict && <p role="alert">字幕或裁剪已更新，本地输入已保留。<IconButton icon="reset" label={"载入最新字幕"} type="button" onClick={() => { setRows(rowsOf(clip)); setBase({ incoming, revision, inSec: clip.inSec, outSec: clip.outSec }); setError(""); }} /></p>}
  </form>;
}
