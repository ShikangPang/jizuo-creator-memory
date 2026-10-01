import { IconButton } from "../ui/IconButton.tsx";
import { VideoToolIcon } from "./VideoToolIcon.tsx";
import type { VideoAssetPreviewRemote } from "./assets-remote.ts";
import { useEffect, useRef, useState, type ReactNode, type ChangeEvent } from "react";
import type { VideoClip, VideoProject, VideoEpisodeSummary } from "@jizuo/contracts";
import type { TimelineEdit } from "../../../contracts/src/video-editing.ts";

function MaterialPreview({ workId, assetId, image, remote, label, children }: { children?: ReactNode; workId: string; assetId: string; image: boolean; remote?: VideoAssetPreviewRemote | undefined; label: string }) {
  const [url, setUrl] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true; setUrl(""); setError(""); setReady(false);
    remote?.getVideoAssetUrl?.({ workId, assetId }).then(result => { if (alive) setUrl(result.url); }).catch(() => { if (alive) setError("预览加载失败"); });
    return () => { alive = false; };
  }, [workId, assetId, remote]);
  const drawFirstFrame = (video: HTMLVideoElement) => {
    const target = canvas.current;
    if (ready || !target || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    try {
      target.width = Math.max(1, Math.round(110 * video.videoWidth / video.videoHeight)); target.height = 110;
      const context = target.getContext("2d");
      if (!context) { setError("缩略图加载失败"); return; }
      context.drawImage(video, 0, 0, target.width, target.height);
      setReady(true); setError("");
    } catch { setError("缩略图加载失败"); }
  };
  return <div className="jz-material-thumbnail">
    {remote?.getVideoAssetUrl && (url ? image ? <img src={url} alt={label} loading="lazy" /> : <>
      <canvas ref={canvas} aria-label={label} role="img" />
      {!ready && !error && <small>加载缩略图…</small>}
      {!ready && <video hidden src={url} muted preload="auto" playsInline
        onLoadedMetadata={event => {
          // A tiny seek requests the first decoded frame in WebKit without playback.
          const video = event.currentTarget;
          video.currentTime = Number.isFinite(video.duration) ? Math.min(0.001, video.duration / 2) : 0.001;
        }}
        onLoadedData={event => drawFirstFrame(event.currentTarget)}
        onSeeked={event => drawFirstFrame(event.currentTarget)}
        onCanPlay={event => drawFirstFrame(event.currentTarget)}
        onError={() => setError("缩略图加载失败")} />}
    </> : <small>{error || "加载缩略图…"}</small>)}
    {error && <small role="status">{error}</small>}
    {children}
  </div>;
}

export function VideoAssetImport({ label, accept, busy, onImport }: { label: string; accept: string; busy: boolean; onImport: (event: ChangeEvent<HTMLInputElement>) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="jz-material-import"><button type="button" className="jz-video-icon-button" aria-label={label} title={label} disabled={busy} onClick={() => input.current?.click()}><VideoToolIcon name="add"/></button><input ref={input} aria-label={label} type="file" accept={accept} hidden disabled={busy} onChange={onImport}/></div>;
}

export const MATERIAL_DRAG_TYPE = "application/x-jizuo-video-material";
export type MaterialSource = Extract<TimelineEdit, { op: "placeVisual" }>["source"];
export function VideoMaterialLibrary({ project, clips, busy, apply, remote, episodeId, episodes, onAddText, audioControls, onImport, position = 0 }: {
  position?: number;
  audioControls?: ReactNode;
  onImport?: ((event: ChangeEvent<HTMLInputElement>) => void) | undefined;
  onAddText?: (() => void) | undefined;
  episodeId?: string; episodes?: VideoEpisodeSummary[] | undefined;
  remote?: VideoAssetPreviewRemote | undefined;
  project: VideoProject; clips: VideoClip[]; busy: boolean; onSelect: (id: string) => void;
  apply: (edit: TimelineEdit, revision?: number) => Promise<unknown>;
}) {
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  const [tab, setTab] = useState("video");
  const chapterOptions = episodes ?? project.episodes.filter(episode => !episode.deletedAt);
  const currentEpisodeId = episodeId ?? project.episodes[0]?.id ?? "";
  const [chapter, setChapter] = useState(currentEpisodeId);
  useEffect(() => { setChapter(currentEpisodeId); setPage(0); }, [currentEpisodeId]);
  const [imagePage, setImagePage] = useState(0);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const assets = project.assets.filter(asset => !asset.deletedAt && ["video", "image", "export"].includes(asset.kind));
  const currentEpisode = project.episodes.find(episode => episode.id === currentEpisodeId);
  const selectedEpisode = chapterOptions.find(episode => episode.id === chapter);
  const belongs = (asset: typeof assets[number]) => {
    if (asset.episodeId) return asset.episodeId === chapter;
    if (selectedEpisode?.shots.some(shot => shot.id === asset.shotId || shot.videoAssetId === asset.id || shot.imageAssetId === asset.id)) return true;
    return chapter === currentEpisodeId && clips.some(clip => clip.assetId === asset.id);
  };
  const unassigned = (asset: typeof assets[number]) => !asset.episodeId && !chapterOptions.some(episode => episode.shots.some(shot => shot.id === asset.shotId || shot.videoAssetId === asset.id || shot.imageAssetId === asset.id)) && !clips.some(clip => clip.assetId === asset.id);
  const matches = (label: string) => label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const items = [
    ...clips.filter(clip => chapter === currentEpisodeId && clip.track !== "audio" && clip.excluded && assets.some(asset => asset.id === clip.assetId && asset.kind !== "image")).map(clip => ({ source: { kind: "clip", id: clip.id } as MaterialSource, label: assets.find(asset => asset.id === clip.assetId)?.label ?? "素材", duration: clip.outSec - clip.inSec })),
    ...assets.filter(asset => asset.kind !== "image" && (chapter === "all" || (chapter === "unassigned" ? unassigned(asset) : belongs(asset)))).sort((a, b) => {
      const order = (asset: typeof a) => { const index = selectedEpisode?.shots.findIndex(shot => shot.id === asset.shotId || shot.videoAssetId === asset.id) ?? -1; return index < 0 ? 100000 : index; };
      return order(a) - order(b);
    }).map(asset => ({ source: { kind: "asset", id: asset.id, durationSec: asset.durationSec ?? 5 } as MaterialSource, label: asset.label, duration: asset.durationSec ?? 5 })),
  ].filter(item => matches(item.label));
  const images = assets.filter(asset => asset.kind === "image" && matches(asset.label));
  const imagePages = Math.max(1, Math.ceil(images.length / 6)), currentImagePage = Math.min(imagePage, imagePages - 1);
  const pages = Math.max(1, Math.ceil(items.length / 6)), current = Math.min(page, pages - 1);
  const usedAssetIds = new Set(clips.filter(clip => !clip.excluded && clip.track !== "audio").map(clip => clip.assetId));
  const card = (source: MaterialSource, label: string, duration: number) => {
    const assetId = source.kind === "asset" ? source.id : clips.find(clip => clip.id === source.id)!.assetId;
    return <div className="jz-material-card" key={`${source.kind}/${source.id}`}
    draggable={!busy} onDragStart={event => {
      event.dataTransfer.setData(MATERIAL_DRAG_TYPE, JSON.stringify({ source, revision: project.revision, workId: project.workId }));
      event.dataTransfer.effectAllowed = source.kind === "clip" ? "move" : "copy";
    }}>
    <MaterialPreview workId={project.workId} assetId={assetId} image={project.assets.find(asset => asset.id === assetId)?.kind === "image"} remote={remote} label={label}>
    <small className="jz-material-duration" title={source.kind === "clip" ? "待用片段" : "素材"}>{duration.toFixed(1)}s</small>
    {usedAssetIds.has(assetId) && <span className="jz-material-added" role="img" aria-label="已添加到时间线" title="已添加到当前时间线"><VideoToolIcon name="apply" /></span>}
    <div className="jz-material-actions"><button className="jz-video-icon-button" type="button" aria-label={source.kind === "clip" ? "恢复到新轨道" : "添加到新轨道"} title="添加到新轨道" disabled={busy || adding || (currentEpisode?.videoTrackCount ?? 0) + (currentEpisode?.videoTrackBelowCount ?? 0) >= 8} onClick={() => {
      if (addingRef.current) return;
      addingRef.current = true; setAdding(true);
      void apply({ op: "placeVisual", source, newVideoTrack: true, atSec: position }).finally(() => { addingRef.current = false; setAdding(false); });
    }}><VideoToolIcon name="add" /></button></div>
    </MaterialPreview>
    <span className="jz-material-name" title={label}>{label}</span>
  </div>;
  };
  return <aside className="jz-material-library" aria-label="素材库"><div className="jz-material-library-heading"><strong>素材库</strong><button className="jz-video-icon-button" type="button" aria-label="视频素材" title="视频素材" aria-pressed={tab === "video"} onClick={() => setTab("video")}><VideoToolIcon name="video"/></button><button className="jz-video-icon-button" type="button" aria-label="文本素材" title="文本" aria-pressed={tab === "text"} onClick={() => setTab("text")}><VideoToolIcon name="text"/></button><button className="jz-video-icon-button" type="button" aria-label="音乐与配音" title="音乐与配音" aria-pressed={tab === "audio"} onClick={() => setTab("audio")}><VideoToolIcon name="music"/></button></div><div hidden={tab !== "text"}>{onAddText && <IconButton icon="add" label={"＋ 添加文本"} type="button" className="jz-text-material-create" aria-label="＋ 添加文本" disabled={busy} onClick={onAddText} />}</div><div hidden={tab !== "audio"}>{audioControls}</div><div hidden={tab !== "video"}>
    <div className="jz-material-chapter-tools"><label title="剧情视频章节"><select aria-label="剧情视频章节" value={chapter} onChange={event => { setChapter(event.target.value); setPage(0); }}>
      {chapterOptions.map(episode => <option key={episode.id} value={episode.id}>{episode.title}{episode.id === currentEpisodeId ? "（当前章节）" : ""}</option>)}
      <option value="unassigned">未归属章节的导入视频</option><option value="all">全部章节视频</option>
    </select></label>{onImport && <VideoAssetImport label="导入视频" accept="video/mp4,video/webm" busy={busy} onImport={onImport}/>}</div>
    <label><input aria-label="搜索素材" type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); setImagePage(0); }} placeholder="搜索素材" /></label>

    <div className="jz-material-grid">{items.slice(current * 6, current * 6 + 6).map(item => card(item.source, item.label, item.duration))}</div>

    {pages > 1 && <div className="jz-material-pages"><button className="jz-video-icon-button" aria-label="上一页" title="上一页" type="button" disabled={current === 0} onClick={() => setPage(current - 1)}><VideoToolIcon name="left" /></button><small>{current + 1} / {pages}</small><button className="jz-video-icon-button" aria-label="下一页" title="下一页" type="button" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}><VideoToolIcon name="right" /></button></div>}
    {images.length > 0 && <details className="jz-material-images"><summary>图片素材 · {images.length} 项</summary>
      <div className="jz-material-grid">{clips.filter(clip => clip.excluded && images.some(asset => asset.id === clip.assetId)).map(clip => card({ kind: "clip", id: clip.id }, images.find(asset => asset.id === clip.assetId)!.label, clip.outSec - clip.inSec))}
      {images.slice(currentImagePage * 6, currentImagePage * 6 + 6).map(asset => card({ kind: "asset", id: asset.id, durationSec: asset.durationSec ?? 5 }, asset.label, asset.durationSec ?? 5))}</div>
      {imagePages > 1 && <div className="jz-material-pages"><button className="jz-video-icon-button" aria-label="上一页图片" title="上一页图片" type="button" disabled={currentImagePage === 0} onClick={() => setImagePage(currentImagePage - 1)}><VideoToolIcon name="left" /></button><small>{currentImagePage + 1} / {imagePages}</small><button className="jz-video-icon-button" aria-label="下一页图片" title="下一页图片" type="button" disabled={currentImagePage + 1 >= imagePages} onClick={() => setImagePage(currentImagePage + 1)}><VideoToolIcon name="right" /></button></div>}
    </details>}
  </div></aside>;
}
