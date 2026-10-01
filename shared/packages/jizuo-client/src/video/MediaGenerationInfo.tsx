import { ErrorText } from "../ui/ErrorText.tsx";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "../ui/IconButton.tsx";
import { estimateMediaGeneration } from "./media-generation-estimate.ts";
import type { MediaGenerationSettingsState } from "./useMediaGenerationSettings.ts";
import "./media-generation-info.css";

export function MediaGenerationInfo({ state, kind, durationSec, referenceCount, disabled }: {
  state: MediaGenerationSettingsState; kind: "image" | "video"; durationSec?: number; referenceCount?: number; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const container = useRef<HTMLDivElement>(null);
  const badge = useRef<HTMLButtonElement>(null);
  const details = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!badge.current || !details.current) return;
      const anchor = badge.current.getBoundingClientRect();
      const margin = 12, gap = 4;
      const width = Math.min(300, Math.max(0, window.innerWidth - margin * 2));
      const below = Math.max(0, window.innerHeight - anchor.bottom - gap - margin);
      const above = Math.max(0, anchor.top - gap - margin);
      const up = below < Math.min(320, details.current.scrollHeight || 320) && above > below;
      setPosition({ left: Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin)), width,
        maxHeight: Math.min(320, up ? above : below), ...(up ? { bottom: window.innerHeight - anchor.top + gap } : { top: anchor.bottom + gap }) });
    };
    place();
    details.current?.querySelector<HTMLButtonElement>("button")?.focus();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    if (details.current) observer?.observe(details.current);
    if (badge.current) observer?.observe(badge.current);
    return () => { window.removeEventListener("resize", place); document.removeEventListener("scroll", place, true); observer?.disconnect(); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node && (container.current?.contains(target) || details.current?.contains(target));
    const outside = (event: Event) => { if (!inside(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !inside(event.target)) return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); badge.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  if (!state.supported) return null;
  const estimate = estimateMediaGeneration(state.view, kind, durationSec);
  const label = kind === "image" ? "图片" : "视频";
  const model = estimate.config?.model ?? (state.loading ? "正在读取模型…" : state.error ? "模型暂不可用" : `尚未配置${label}模型`);
  const unitLabel = estimate.unit ? ({ image: "张", second: "秒", video: "个视频" } as Record<string, string>)[estimate.unit] ?? estimate.unit : undefined;
  return <div ref={container} className="jz-media-generation-info">
    <IconButton ref={badge} icon="settings" className="jz-media-model-badge" title={`${label}模型：${model}${estimate.insufficientCredits ? "，余额不足" : ""}`} label={`${label}模型：${model}${estimate.insufficientCredits ? "，余额不足" : ""}`} aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((value) => !value)} />
    {estimate.insufficientCredits && <span className="jz-media-model-status" role="status">余额不足</span>}
    {open && createPortal(<div ref={details} id={detailsId} className="jz-media-model-details" style={position} role="region" aria-label={`${label}模型详情`}>
    <div className="jz-media-model-heading"><strong>{model}</strong><IconButton icon="close" label={`关闭${label}模型详情`} onClick={() => { setOpen(false); badge.current?.focus(); }} /></div>
    {state.selectModel && <label className="jz-media-model-select">切换{label}模型
      <select aria-label={`切换${label}模型`} disabled={disabled || state.loading || state.switching} value={state.view?.connections?.find(item => item.kind === kind && item.isDefault)?.id ?? ""}
        onChange={event => { const id = event.target.value; void state.selectModel!(id).then(changed => { if (changed) { setOpen(false); badge.current?.focus(); } }); }}>
        <option value="" disabled>选择已配置模型</option>
        {(state.view?.connections ?? []).filter(item => item.kind === kind).map(item => <option key={item.id} value={item.id} disabled={!item.keyConfigured}>{item.config.model} · {new URL(item.config.baseUrl).hostname}{item.isDefault ? " · 当前" : ""}{!item.keyConfigured ? " · 未配置凭据" : ""}</option>)}
      </select><small>设为默认，用于后续{label}生成</small>
    </label>}
    {state.error && <p role="status">{<ErrorText error={state.error} operation="MediaGenerationInfo" />}</p>}
    {estimate.config?.protocol === "nspox" ? <>
      <p>单价：{estimate.creditsPerUnit !== undefined ? `${estimate.creditsPerUnit} 点 / ${unitLabel}` : "暂未提供"} · 本次预估：{estimate.estimatedCredits !== undefined ? `${estimate.estimatedCredits} 点` : "未知"}</p>
      <p>NSPOX 可用余额：{estimate.availableCredits !== undefined ? `${estimate.availableCredits} 点` : "未知"}{estimate.reservedCredits !== undefined ? ` · 已预留 ${estimate.reservedCredits} 点` : ""}</p>
      {estimate.insufficientCredits && <p role="alert">NSPOX 媒体点数不足，请补足余额后刷新。</p>}
      <small>预估按当前目录计算，实际费用和余额以服务方扣费结果为准。</small>
    </> : estimate.config && <p>费用由服务商计费，请查看服务商账户。</p>}
    {kind === "video" && estimate.config && <small>本次请求时长：{estimate.durationSeconds !== undefined ? `${estimate.durationSeconds} 秒${durationSec !== estimate.durationSeconds ? `（镜头 ${durationSec} 秒，已对齐）` : ""}` : "由服务商决定"}</small>}
    {referenceCount !== undefined && <small>本次参考图：{referenceCount} 张。参考图及画幅限制由所选模型校验。</small>}
    <IconButton icon="reset" label={`刷新${label}模型与余额`} className="jz-media-model-refresh" disabled={state.loading} onClick={state.refresh} />
    </div>, document.body)}
  </div>;
}
