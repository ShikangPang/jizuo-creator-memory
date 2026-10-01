import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { VideoErrorNotice } from "./VideoErrorNotice.tsx";
import { createPanoramaRenderer, DEFAULT_PANORAMA_VIEW, normalizePanoramaView, panoramaErrorMessage, panoramaFrameSize, validatePanoramaDimensions,
  type PanoramaFrameRatio, type PanoramaRenderer, type PanoramaView } from "./panorama-projection.ts";
import "./panorama.css";

export type PanoramaCapture = { base64: string; mimeType: "image/png"; panoramaSource: { assetId: string; yaw: number; pitch: number; hfov: number } };
export interface PanoramaViewerProps {
  url: string;
  assetId: string;
  label: string;
  onCapture?: (value: PanoramaCapture) => Promise<void>;
}

export function PanoramaViewer({ url, assetId, label, onCapture }: PanoramaViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PanoramaRenderer | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const sessionRef = useRef(0);
  const captureRef = useRef(false);
  const [view, setView] = useState<PanoramaView>(DEFAULT_PANORAMA_VIEW);
  const [ratio, setRatio] = useState<PanoramaFrameRatio>("16:9");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  const helpId = useId();
  const frame = panoramaFrameSize(ratio);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let active = true;
    let renderer: PanoramaRenderer | null = null;
    sessionRef.current += 1;
    captureRef.current = false;
    dragRef.current = null;
    setReady(false); setError(null); setCaptureError(null); setSaved(false); setSaving(false);
    setView(DEFAULT_PANORAMA_VIEW);
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (!active) return;
      try {
        validatePanoramaDimensions(image.naturalWidth, image.naturalHeight);
        renderer = createPanoramaRenderer(canvas, image);
        rendererRef.current = renderer;
        setReady(true);
      } catch (cause) { setError(panoramaErrorMessage(cause, "环景预览失败，请重试。")); }
    };
    image.onerror = () => {
      if (active) setError("环景图片无法加载。请检查图片地址、网络或跨域（CORS）权限，也可重新导入本地图片。");
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      if (active) { setReady(false); setError("环景图形连接已中断，请重试环景预览。"); }
    };
    const wheel = (event: WheelEvent) => {
      if (!rendererRef.current || !active || captureRef.current) return;
      event.preventDefault();
      const delta = Math.max(-20, Math.min(20, event.deltaY * (event.deltaMode === 0 ? 0.05 : 1)));
      setView((current) => normalizePanoramaView({ ...current, hfov: current.hfov + delta }));
      setSaved(false);
    };
    canvas.addEventListener("webglcontextlost", contextLost);
    canvas.addEventListener("wheel", wheel, { passive: false });
    image.src = url;
    return () => {
      active = false;
      sessionRef.current += 1;
      image.onload = null; image.onerror = null;
      image.removeAttribute("src");
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("wheel", wheel);
      renderer?.dispose();
      rendererRef.current = null;
      dragRef.current = null;
    };
  }, [url, assetId, retry]);

  useEffect(() => {
    if (!ready || !rendererRef.current) return;
    try { rendererRef.current.draw(view, frame); }
    catch (cause) { setReady(false); setError(panoramaErrorMessage(cause, "环景预览失败，请重试。")); }
  }, [ready, view, frame.width, frame.height]);

  const changeView = (update: Partial<PanoramaView>) => {
    setView((current) => normalizePanoramaView({ ...current, ...update }));
    setSaved(false);
  };
  const rotate = (yaw: number, pitch: number) => {
    setView((current) => normalizePanoramaView({ ...current, yaw: current.yaw + yaw, pitch: current.pitch + pitch }));
    setSaved(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (!ready || captureRef.current) return;
    const step = event.shiftKey ? 15 : 5;
    switch (event.key) {
      case "ArrowLeft": rotate(-step, 0); break;
      case "ArrowRight": rotate(step, 0); break;
      case "ArrowUp": rotate(0, step); break;
      case "ArrowDown": rotate(0, -step); break;
      case "+": case "=": changeView({ hfov: view.hfov - 5 }); break;
      case "-": case "_": changeView({ hfov: view.hfov + 5 }); break;
      case "Home": changeView(DEFAULT_PANORAMA_VIEW); break;
      default: return;
    }
    event.preventDefault();
  };

  const capture = async () => {
    if (!ready || !onCapture || !rendererRef.current || captureRef.current) return;
    const session = sessionRef.current;
    captureRef.current = true;
    setSaving(true); setCaptureError(null); setSaved(false);
    try {
      const base64 = rendererRef.current.capture(view, frame);
      await onCapture({ base64, mimeType: "image/png", panoramaSource: { assetId, ...view } });
      if (sessionRef.current === session) setSaved(true);
    } catch (cause) {
      if (sessionRef.current === session) setCaptureError(panoramaErrorMessage(cause, "取景图保存失败，请重试。"));
    } finally {
      if (sessionRef.current === session) { captureRef.current = false; setSaving(false); }
    }
  };

  return <section className="jz-panorama" aria-label={`${label} 环景取景`}>
    <div className="jz-panorama-stage">
      <div className="jz-panorama-frame" style={{ aspectRatio: `${frame.width} / ${frame.height}`, maxWidth: `${420 * frame.width / frame.height}px` }}>
        <canvas key={`${assetId}:${url}:${retry}`} ref={canvasRef} width={frame.width} height={frame.height} hidden={!ready}
          role="application" aria-label={`${label} 360°环景`} aria-describedby={helpId} tabIndex={ready ? 0 : -1} onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            if (!ready || captureRef.current || event.button !== 0) return;
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            dragRef.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerMove={(event) => {
            if (!ready || captureRef.current || !dragRef.current) return;
            const previous = dragRef.current;
            dragRef.current = { x: event.clientX, y: event.clientY };
            const width = event.currentTarget.getBoundingClientRect().width || frame.width;
            const degreesPerPixel = view.hfov / width;
            rotate((previous.x - event.clientX) * degreesPerPixel, (event.clientY - previous.y) * degreesPerPixel);
          }}
          onPointerUp={(event) => {
            dragRef.current = null;
            if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { dragRef.current = null; }} onLostPointerCapture={() => { dragRef.current = null; }} />
        {!ready && !error && <span role="status" className="jz-panorama-loading">正在加载环景…</span>}
      </div>
    </div>
    {error && <VideoErrorNotice title="环景预览失败" message={error}><div className="jz-video-tools"><IconButton icon="reset" label={"重试环景"} type="button" onClick={() => setRetry((value) => value + 1)} /></div></VideoErrorNotice>}
    <div className="jz-panorama-controls">
      <label className="jz-panorama-ratio">取景比例<select aria-label="取景比例" value={ratio} disabled={!ready || saving} onChange={(event) => { setRatio(event.target.value as PanoramaFrameRatio); setSaved(false); }}>
        <option value="16:9">16:9 横屏</option><option value="9:16">9:16 竖屏</option><option value="1:1">1:1 方形</option>
      </select></label>
      <label className="jz-panorama-fov">水平视场角 <span>{Math.round(view.hfov)}°</span><input aria-label="水平视场角" type="range" min="30" max="120" step="1" value={view.hfov} disabled={!ready || saving} onChange={(event) => changeView({ hfov: Number(event.target.value) })} /></label>
      <div className="jz-video-tools"><IconButton icon="fit" label={"重置视角"} type="button" disabled={!ready || saving} onClick={() => changeView(DEFAULT_PANORAMA_VIEW)} />
        {onCapture && <IconButton icon="save" label={(saving ? "正在保存…" : "保存取景图")} type="button" disabled={!ready || saving} onClick={() => { void capture(); }} />}</div>
    </div>
    <p className="jz-panorama-position">方位 {Math.round(view.yaw)}° · 俯仰 {Math.round(view.pitch)}° · 输出 {frame.width} × {frame.height}</p>
    <p id={helpId} className="jz-panorama-help">拖动环视，滚轮缩放；聚焦画面后用方向键转动、＋／－缩放、Home 复位。观察点固定。请检查接缝和场景布局后保存取景图。</p>
    {captureError && <VideoErrorNotice title="取景图保存失败" message={captureError} />}
    {saved && <span role="status">取景图已保存</span>}
  </section>;
}
