import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./video-image-viewer.css";

export function VideoImageViewer({ url, label, onClose }: { url: string; label: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const changeZoom = (delta: number) => setZoom(current => Math.max(0.25, Math.min(4, (current ?? 1) + delta)));
  return createPortal(<dialog ref={dialog} className="jz-video-image-viewer" aria-label={`${label} 大图`}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header className="jz-video-image-toolbar">
      <strong title={label}>{label}</strong>
      {size && <span>{size.width} × {size.height}</span>}
      <div className="jz-video-image-actions">
        <IconButton icon="fit" label={"适应窗口"} type="button" onClick={() => setZoom(null)} aria-pressed={zoom === null} />
        <IconButton icon="focus" label={"原图尺寸"} type="button" onClick={() => setZoom(1)} aria-pressed={zoom === 1} />
        <IconButton icon="zoomOut" label={"缩小图片"} type="button" aria-label="缩小图片" disabled={zoom !== null && zoom <= 0.25} onClick={() => changeZoom(-0.25)} />
        <span aria-live="polite">{zoom === null ? "适应" : `${Math.round(zoom * 100)}%`}</span>
        <IconButton icon="zoomIn" label={"放大图片"} type="button" aria-label="放大图片" disabled={zoom !== null && zoom >= 4} onClick={() => changeZoom(0.25)} />
        <IconButton icon="close" label={"关闭大图"} type="button" aria-label="关闭大图" autoFocus onClick={onClose} />
      </div>
    </header>
    <div className={`jz-video-image-stage${zoom === null ? " is-fit" : ""}`} tabIndex={0} aria-label="图片查看区域">
      {failed ? <p role="alert">大图加载失败，请关闭后重试。</p> : <img src={url} alt={label} draggable={false}
        style={zoom !== null && size ? { width: size.width * zoom, height: size.height * zoom } : undefined}
        onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => setFailed(true)} />}
    </div>
  </dialog>, document.body);
}
