import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useState } from "react";
import type { VideoAsset } from "@jizuo/contracts";
import type { VideoAssetPreviewRemote } from "./assets-remote.ts";
import { VideoImageViewer } from "./VideoImageViewer.tsx";
import { writeWorkImageDrag } from "./work-image-drag.ts";

export function VideoAssetPreview({ remote, workId, asset, onPreview }: { remote: VideoAssetPreviewRemote; workId: string; asset: VideoAsset; onPreview?: (url: string, anchor: HTMLButtonElement) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const draggable = asset.kind === "image" && !asset.panorama;
  useEffect(() => {
    let active = true;
    setUrl(null); setError(null); setExpanded(false);
    if (!remote.getVideoAssetUrl) { setError("当前运行时无法预览素材"); return; }
    void remote.getVideoAssetUrl({ workId, assetId: asset.id }).then((result) => {
      if (active) setUrl(result.url);
    }).catch((cause: unknown) => { if (active) setError(userErrorMessage(cause, "素材预览失败", { operation: "VideoAssetPreview", effect: "read" })); });
    return () => { active = false; };
  }, [remote, workId, asset.id, retry]);
  return <div className="jz-video-asset-preview">
    {error ? <div role="alert">{error}<IconButton icon="reset" label={"重试预览"} type="button" onClick={() => setRetry((value) => value + 1)} /></div>
      : url ? <button type="button" className="jz-video-image-trigger" aria-label={`查看${asset.label}大图`} title={draggable ? "点击查看大图，拖到聊天框添加参考图片" : "点击查看大图"}
        draggable={draggable} onDragStart={event => { if (draggable) writeWorkImageDrag(event.dataTransfer, { workId, assetId: asset.id }); else event.preventDefault(); }}
        onClick={event => onPreview ? onPreview(url, event.currentTarget) : setExpanded(true)}>
        <img src={url} alt={asset.label} loading="lazy" draggable={false} onError={() => setError("图片无法加载")} /></button> : <span role="status">正在加载图片…</span>}
    {expanded && url && !error && <VideoImageViewer key={`${workId}/${asset.id}/${url}`} url={url} label={asset.label} onClose={() => setExpanded(false)}/>}
  </div>;
}
