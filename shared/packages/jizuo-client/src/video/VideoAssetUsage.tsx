import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "../ui/IconButton.tsx";
import { DeleteVideoItemButton } from "./DeleteVideoItemButton.tsx";
import type { VideoAsset, VideoProject } from "@jizuo/contracts";
import { setSelection } from "../content/selection.ts";
import type { VideoAssetsRemote } from "./assets-remote.ts";
import { openWorkStyle } from "./open-work-style.ts";

export function VideoAssetUsage({project, asset, remote, busy, run, showAsset}: {
  project: VideoProject; asset: VideoAsset; remote: VideoAssetsRemote; busy: boolean;
  run: (operation: () => Promise<VideoProject>) => Promise<void>;
  showAsset: (label: string) => void;
}) {
  const links: {key: string; label: string; open: () => void; unlink?: () => void; locked?: boolean}[] = [];
  const navigate = (section: "assets" | "shots" | "editing", episodeId: string | null = null, shotId: string | null = null, designId: string | null = null) =>
    setSelection({workId: project.workId, episodeId, shotId, designId, videoSection: section, overlay: "video"});
  if (project.visualStyle?.referenceAssetIds.includes(asset.id)) links.push({key: "style", label: "作品画风 · 参考图", open: () => openWorkStyle(project.workId)});
  for (const design of project.designs ?? []) if (!design.deletedAt && design.referenceAssetIds.includes(asset.id)) {
    links.push({key: design.id, label: `${design.kind === "character" ? "人物" : "场景"} · ${design.name} · 参考图`, open: () => navigate("assets", null, null, design.id)});
  }
  for (const episode of project.episodes) if (!episode.deletedAt) {
    for (const shot of episode.shots) if (!shot.archived) {
      const selected = shot.imageAssetId === asset.id || shot.videoAssetId === asset.id;
      const reference = shot.referenceAssetIds.includes(asset.id);
      if (!selected && !reference) continue;
      const roles = [shot.imageAssetId === asset.id ? "选用图片" : "", shot.videoAssetId === asset.id ? "选用视频" : "", reference ? "参考图" : ""].filter(Boolean).join("、");
      links.push({key: shot.id, label: `${episode.title} / ${shot.title} · ${roles}`, locked: shot.locked,
        open: () => navigate("shots", episode.id, shot.id),
        ...(selected && remote.updateVideoEpisode ? {unlink: () => void run(() => remote.updateVideoEpisode!({workId: project.workId, episodeId: episode.id, expectedRevision: project.revision,
          patch: {shots: episode.shots.map(item => {
            if (item.id !== shot.id) return item;
            const next = {...item};
            if (next.imageAssetId === asset.id) delete next.imageAssetId;
            if (next.videoAssetId === asset.id) delete next.videoAssetId;
            return next;
          })}}))} : {}),
      });
    }
    episode.timeline.forEach((clip, index) => {
      if (clip.assetId === asset.id) links.push({key: clip.id, label: `${episode.title} / 剪辑 · 片段 ${index + 1}`, open: () => navigate("editing", episode.id, clip.shotId ?? null)});
    });
  }
  for (const derived of project.assets) if (!derived.deletedAt && derived.panoramaSource?.assetId === asset.id) {
    links.push({key: derived.id, label: `取景素材 · ${derived.label}`, open: () => showAsset(derived.label)});
  }
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    if (!open || !links.length) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(340, window.innerWidth - 24);
      const above = rect.top - 20, below = window.innerHeight - rect.bottom - 20;
      const up = above >= Math.min(240, below);
      setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        maxHeight: Math.max(0, Math.min(320, up ? above : below)),
        ...(up ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }) });
    };
    place();
    panel.current?.focus();
    const outside = (event: Event) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target) && !panel.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); anchor.current?.focus(); }
    };
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open, links.length]);
  if (!links.length) return <div className="jz-video-asset-usage"><DeleteVideoItemButton remote={remote} input={{workId:project.workId,expectedRevision:project.revision,kind:"asset",id:asset.id}} label={asset.label} detail="将从素材库移除；原文件和生成记录保留。" disabled={busy}/></div>;
  return <div className="jz-video-asset-usage" role="group" aria-label={`${asset.label}的引用位置`}>
    <button ref={anchor} type="button" className="jz-video-usage-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>引用位置 · {links.length}</button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label={`${asset.label}的引用位置`} tabIndex={-1} className="jz-video-usage-popover" style={position}>
    <div className="jz-video-usage-heading"><strong>引用位置 · {links.length}</strong><IconButton icon="close" label="关闭引用位置" onClick={() => { setOpen(false); anchor.current?.focus(); }} /></div>
    <div className="jz-video-usage-list">
    {links.map(link => <div key={link.key}>
      <button type="button" className="jz-video-usage-location" title={link.label} onClick={() => { setOpen(false); anchor.current?.focus(); link.open(); }}>{link.label}</button>
      {link.unlink && <IconButton icon="close" label={"解除镜头选用"} type="button" disabled={busy || link.locked} title={link.locked ? "镜头已锁定，请先在镜头中解锁" : undefined} onClick={link.unlink} />}
    </div>)}
    </div></div>, document.body)}
    <DeleteVideoItemButton remote={remote} input={{workId:project.workId,expectedRevision:project.revision,kind:"asset",id:asset.id,detachReferences:true}}
      label={asset.label} buttonLabel="取消引用并删除" disabled={busy}
      detail="将取消上方所有引用，移除使用此素材的剪辑片段，并从素材库删除此素材。原文件、其他素材和历史记录保留。"/>
  </div>;
}
