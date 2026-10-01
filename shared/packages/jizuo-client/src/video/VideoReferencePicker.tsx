import { IconButton } from "../ui/IconButton.tsx";
import { useState } from "react";
import type { VideoAsset } from "@jizuo/contracts";
import type { VideoAssetPreviewRemote } from "./assets-remote.ts";
import { VideoAssetPreview } from "./VideoAssetPreview.tsx";
import "./video-references.css";

export interface VideoReferencePickerProps {
  assets: VideoAsset[];
  selected: string[];
  onChange: (ids: string[]) => void;
  remote: VideoAssetPreviewRemote;
  workId: string;
  disabled?: boolean;
  max?: number;
  label?: string;
}

export function VideoReferencePicker({ assets, selected, onChange, remote, workId, disabled = false, max = 14, label = "参考图" }: VideoReferencePickerProps) {
  const [expanded, setExpanded] = useState(false);
  const [limitError, setLimitError] = useState(false);
  const images = assets.filter((asset) => asset.kind === "image" && !asset.panorama);
  const available = images.filter((asset) => !selected.includes(asset.id));
  const overLimit = selected.length > max;
  const add = (id: string) => {
    if (disabled) return;
    if (selected.length >= max) { setLimitError(true); return; }
    setLimitError(false); onChange([...selected, id]);
  };
  return <fieldset className="jz-video-references"><legend>{label}</legend>
    <div className="jz-video-reference-grid">{selected.map((id, index) => {
      const asset = images.find((item) => item.id === id);
      return <figure key={`${id}/${index}`}>
        {asset ? <VideoAssetPreview remote={remote} workId={workId} asset={asset} /> : <span className="jz-video-reference-missing">{assets.some((item) => item.id === id && item.panorama) ? "全景原图请先取景" : "参考图已不可用"}</span>}
        <figcaption>{asset?.label ?? `参考图 ${index + 1}`}</figcaption>
        <IconButton icon="close" label={(`移除${asset?.label ?? `参考图 ${index + 1}`}`)} type="button" disabled={disabled} aria-label={`移除${asset?.label ?? `参考图 ${index + 1}`}`} onClick={() => { setLimitError(false); onChange(selected.filter((_, position) => position !== index)); }} />
      </figure>;
    })}</div>
    {!selected.length && <small>尚未选择参考图</small>}
    {(overLimit || limitError) && <p role="alert">最多选择 {max} 张参考图，已选内容保留，请先移除多余图片。</p>}
    <IconButton icon="add" label={(expanded ? "收起可选图片" : "添加参考图")} type="button" disabled={disabled} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} />
    {expanded && <div className="jz-video-reference-grid jz-video-reference-options">{available.map((asset) => <figure key={asset.id}>
      <VideoAssetPreview remote={remote} workId={workId} asset={asset} /><figcaption>{asset.label}</figcaption>
      <IconButton icon="add" label={(`添加${asset.label}`)} type="button" disabled={disabled} aria-label={`添加${asset.label}`} onClick={() => add(asset.id)} />
    </figure>)}{!available.length && <small>暂无可选图片，可在设定库导入图片或保存全景取景图。</small>}</div>}
  </fieldset>;
}
