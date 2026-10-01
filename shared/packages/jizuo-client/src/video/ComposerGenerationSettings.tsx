import { ActionIcon } from "../ui/ActionIcon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { GptImageControls } from "./GptImageControls.tsx";
import { gptImageSize, isGptImage25 } from "../../../contracts/src/gpt-image.ts";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { VideoAssetView } from "@jizuo/contracts";
import { resolveVideoGenerationDuration, type MediaProviderConfig } from "../../../contracts/src/media.ts";
import { mediaGenerationControls, type GenerationRatio, type MediaGenerationSettings } from "../../../contracts/src/media-generation-controls.ts";
import type { VideoComposerInputs } from "./video-composer-request.ts";
import "./composer-generation-settings.css";

export function ComposerGenerationSettings({ config, kind, inputs, onChange, ratio = "9:16", duration = 5, view, hasReferences = false, disabled = false }: {
  config: MediaProviderConfig; kind: "image" | "video"; inputs: Partial<VideoComposerInputs>;
  onChange: (patch: Partial<VideoComposerInputs>) => void; ratio?: GenerationRatio; duration?: number;
  view?: VideoAssetView | undefined; hasReferences?: boolean; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const anchor = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const controls = mediaGenerationControls(config, kind, hasReferences);
  const settings = inputs.generationSettings ?? {};
  const panorama = kind === "image" && view === "panorama", turnaround = kind === "image" && (view === "turnaround" || view === "character-sheet");
  const ratios = controls.ratios.filter(value => !turnaround || ["16:9", "4:3", "21:9"].includes(value));
  const sizes = controls.imageSizes.filter(value => !turnaround || Number(value.split("x")[0]) > Number(value.split("x")[1]));
  const preferredRatio = inputs.aspectRatio ?? ratio;
  const selectedRatio = ratios.length && !ratios.includes(preferredRatio) ? ratios[0]! : preferredRatio;
  const defaultSize = config.protocol === "ark" ? ({ "16:9": "2688x1536", "9:16": "1536x2688", "1:1": "2048x2048", "4:3": "2368x1728", "3:4": "1728x2368", "21:9": "3072x1312" })[selectedRatio] : selectedRatio === "16:9" || turnaround ? "1536x1024" : selectedRatio === "1:1" ? "1024x1024" : "1024x1536";
  const imageSize = settings.imageSize ?? (controls.customImage ? gptImageSize(settings.imageAspectRatio ?? selectedRatio,settings.imageResolution) : defaultSize);
  const options = config.options;
  const resolution = settings.resolution ?? (options && "resolution" in options ? options.resolution?.toLowerCase() : undefined);
  const audio = settings.generateAudio ?? (options && "generateAudio" in options ? options.generateAudio : undefined);
  const quality = settings.quality ?? (options && "quality" in options ? options.quality : undefined) ?? "auto";
  const seconds = inputs.durationSeconds ?? resolveVideoGenerationDuration(config, duration);
  const qualityLabels = { auto: "自动质量", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高" };
  const summary = [panorama ? "360° · 2048 × 1024" : (sizes.length || controls.customImage) ? (imageSize === "auto" ? "智能尺寸" : imageSize.replace("x", " × ")) : ratios.length ? selectedRatio : "随参考图 / 模型", ...(controls.resolutions.length ? [resolution?.toUpperCase() ?? "默认分辨率"] : []), ...(kind === "video" && seconds !== undefined ? [`${seconds}秒`] : []), ...(controls.audio ? [audio === undefined ? "默认声音" : audio ? "有声" : "无声"] : []), ...(controls.quality ? [qualityLabels[quality]] : []), kind === "image" ? "1张" : "1条"].join(" · ");
  const patch = (value: Partial<MediaGenerationSettings>) => onChange({ generationSettings: { ...settings, ...value } });
  useEffect(() => {
    const next = { ...settings };
    if (next.resolution && !controls.resolutions.includes(next.resolution)) delete next.resolution;
    if (!controls.audio) delete next.generateAudio;
    if (!controls.quality) delete next.quality;
    if (!hasReferences || !isGptImage25(config.model)) delete next.inputFidelity;
    if (next.imageSize && (panorama || !controls.customImage && !sizes.includes(next.imageSize))) delete next.imageSize;
    if (JSON.stringify(next) !== JSON.stringify(settings)) onChange({ generationSettings: next });
  }, [config.protocol, config.model, kind, hasReferences, view, JSON.stringify(settings)]);
  useLayoutEffect(() => {
    if (!open || disabled) { setOpen(false); return; }
    const place = () => {
      if (!anchor.current) return;
      const rect = anchor.current.getBoundingClientRect(), width = Math.min(460, window.innerWidth - 24);
      const above = rect.top - 16, below = window.innerHeight - rect.bottom - 16, up = above > below;
      setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), maxHeight: Math.max(0, Math.min(480, up ? above : below)), ...(up ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }) });
    };
    place(); panel.current?.focus();
    const outside = (event: Event) => { if (event.target instanceof Node && !panel.current?.contains(event.target) && !anchor.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); anchor.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape, true);
    document.addEventListener("scroll", place, true); window.addEventListener("resize", place);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); document.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open, disabled]);
  const choices = <T extends string | number,>(label: string, values: readonly T[], selected: T | undefined, select: (value: T) => void, format: (value: T) => string = value => String(value)) => <fieldset><legend>{label}</legend><div className="jz-generation-choices">{values.map(value => <button type="button" key={value} aria-pressed={value === selected} onClick={() => select(value)}>{format(value)}</button>)}</div></fieldset>;
  return <div className="jz-composer-generation-settings">
    <button ref={anchor} type="button" disabled={disabled} title={summary} aria-label={`${kind === "image" ? "图片" : "视频"}生成设置：${summary}`} aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}><ActionIcon name="settings"/></button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label={kind === "image" ? "图片生成设置" : "视频生成设置"} tabIndex={-1} className="jz-generation-popover" style={position}>
      <div className="jz-generation-heading"><strong>{kind === "image" ? "图片" : "视频"}设置</strong><IconButton icon="close" label={"关闭生成设置"} type="button" aria-label="关闭生成设置" onClick={() => { setOpen(false); anchor.current?.focus(); }} /></div>
      {controls.customImage && <GptImageControls settings={settings} patch={patch} ratio={selectedRatio} model={config.model} panorama={panorama} turnaround={turnaround} hasReferences={hasReferences}/> }
      {panorama ? <p>360° 环景固定使用 2:1 画幅，2048 × 1024 像素。</p> : <>
        {ratios.length > 0 && choices("画幅比例", ratios, selectedRatio, value => onChange({ aspectRatio: value }))}
        {!controls.customImage && sizes.length > 0 && choices("图片尺寸", sizes, imageSize, value => patch({ imageSize: value }), value => value.replace("x", " × "))}
        {!ratios.length && !sizes.length && <p>画幅由参考图片或模型决定。</p>}
      </>}
      {controls.resolutions.length > 0 && choices("分辨率", ["default", ...controls.resolutions], settings.resolution ?? "default", value => patch({ resolution: value === "default" ? undefined : value as MediaGenerationSettings["resolution"] }), value => value === "default" ? "模型默认" : value.toUpperCase())}
      {controls.durations.length > 0 && choices("视频时长", ["shot", ...controls.durations.map(String)], inputs.durationSeconds === undefined ? "shot" : String(seconds), value => onChange({ durationSeconds: value === "shot" ? undefined : Number(value) }), value => value === "shot" ? `跟随镜头（${resolveVideoGenerationDuration(config, duration)}秒）` : `${value}秒`)}
      {controls.audio && choices("输出声音", ["default", "on", "off"], settings.generateAudio === undefined ? "default" : settings.generateAudio ? "on" : "off", value => patch({ generateAudio: value === "default" ? undefined : value === "on" }), value => ({ default: "模型默认", on: "开", off: "关" })[value]!)}
      {controls.quality && choices("图片质量", controls.qualities, quality, value => patch({ quality: value }), value => qualityLabels[value])}
      <small>每次生成{kind === "image" ? "一张图片" : "一条视频"}，可以继续生成并保留备选。</small>
    </div>, document.body)}
  </div>;
}
