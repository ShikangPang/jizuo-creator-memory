import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { ActionIcon } from "../ui/ActionIcon.tsx";
import { useEffect, useRef, useState } from "react";
import type { VideoClip, VideoClipFrames, VideoEpisode, VideoProject } from "@jizuo/contracts";
import type { TimelineEdit } from "../../../contracts/src/video-editing.ts";
import type { VideoEditingRemote } from "./editing-remote.ts";

export function VideoJunctionEditor({ project, episode, left, right, remote, busy, apply, close }: {
  project: VideoProject; episode: VideoEpisode; left: VideoClip; right: VideoClip;
  remote: VideoEditingRemote; busy: boolean; apply: (edit: TimelineEdit) => Promise<VideoProject | undefined>; close: () => void;
}) {
  const [duration, setDuration] = useState(String(left.transitionSec ?? 0));
  const [assetId, setAssetId] = useState("");
  const [outSec, setOutSec] = useState("3");
  const [frames, setFrames] = useState<VideoClipFrames[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => { request.current++; setFrames([]); setLoading(false); setError(null); return () => { request.current++; }; }, [project.revision]);
  useEffect(() => setDuration(String(left.transitionSec ?? 0)), [left.transitionSec]);
  const maxTransition = Math.min(left.outSec - left.inSec, right.outSec - right.inSec) / 2;
  const options = project.assets.filter(asset => asset.kind === "video" || asset.kind === "image" || asset.kind === "export");
  const name = (clip: VideoClip) => project.assets.find(asset => asset.id === clip.assetId)?.label ?? "片段";
  const extract = async () => {
    if (!remote.getVideoClipFrames || loading) return;
    const current = ++request.current; setLoading(true); setError(null);
    try {
      const result = await Promise.all([left, right].map(clip => remote.getVideoClipFrames!({ workId: project.workId, episodeId: episode.id, expectedRevision: project.revision, clipId: clip.id })));
      if (request.current === current) setFrames(result);
    } catch (cause) { if (request.current === current) setError(userErrorMessage(cause, "提取首末帧失败", { operation: "VideoJunctionEditor" })); }
    finally { if (request.current === current) setLoading(false); }
  };
  return <section className="jz-junction-editor" aria-label="片段衔接编辑">
    <div className="jz-video-editor-heading"><strong>{name(left)} → {name(right)}</strong><IconButton icon="close" label={"关闭衔接设置"} type="button" onClick={close} /></div>
    <form className="jz-clip-edit-form" onSubmit={event => { event.preventDefault(); void apply({ op: "transition", clipId: left.id, transitionSec: Number(duration) }); }}>
      <label>衔接转场（秒，0 为直接切换）<input type="number" required min={0} max={maxTransition} step="any" disabled={busy} value={duration} onChange={event => setDuration(event.target.value)} /></label>
      <IconButton icon="apply" label={"应用此处转场"} type="submit" disabled={busy} />
    </form>
    <p>使用前段末帧和后段首帧构思衔接；提取范围以保存的裁剪区间为准。</p>
    {remote.getVideoClipFrames && <IconButton icon="split" label={(loading ? "正在提取首末帧…" : "提取前后片段首末帧")} type="button" disabled={loading || busy} onClick={() => { void extract(); }} />}
    {error && <p role="alert">{error}</p>}
    {frames.length === 2 && <div className="jz-junction-frames">{[
      { label: "前段末帧", src: frames[0]!.last }, { label: "后段首帧", src: frames[1]!.first },
      { label: "前段首帧", src: frames[0]!.first }, { label: "后段末帧", src: frames[1]!.last },
    ].map(frame => <figure key={frame.label}><img src={frame.src} alt={frame.label} /><figcaption>{frame.label} <a className="jz-icon-action" aria-label="保存图片" title={`保存${frame.label}`} href={frame.src} download={`${episode.title}-${frame.label}.jpg`}><ActionIcon name="download" /></a></figcaption></figure>)}</div>}
    <form className="jz-clip-edit-form" onSubmit={event => { event.preventDefault(); if (assetId) void apply({ op: "insertVisual", assetId, inSec: 0, outSec: Number(outSec), afterClipId: left.id, beforeClipId: right.id }).then(next => { if (next) close(); }); }}>
      <label>衔接镜头素材<select value={assetId} disabled={busy} onChange={event => { setAssetId(event.target.value); setOutSec(String(options.find(asset => asset.id === event.target.value)?.durationSec ?? 3)); }}><option value="">选择已有或新生成的素材</option>{options.map(asset => <option key={asset.id} value={asset.id}>{asset.label}</option>)}</select></label>
      <label>衔接镜头时长（秒）<input type="number" required min={0.05} max={options.find(asset => asset.id === assetId)?.durationSec ?? 86400} step="any" disabled={busy} value={outSec} onChange={event => setOutSec(event.target.value)} /></label>
      <IconButton icon="add" label={"插入两个片段之间"} type="submit" disabled={busy || !assetId} />
    </form>
  </section>;
}
