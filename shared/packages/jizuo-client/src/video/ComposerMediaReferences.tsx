import { userErrorMessage } from "@jizuo/contracts";
import { ActionIcon } from "../ui/ActionIcon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { VideoDesign, VideoProject } from "@jizuo/contracts";
import type { MediaProviderConfig } from "../../../contracts/src/media.ts";
import { getMediaInputCapabilityError, resolveMediaInputCapabilities } from "../../../contracts/src/media-input-capabilities.ts";
import type { JizuoContentRemote } from "../content/remote.ts";
import { ComposerReferenceNotice } from "./ComposerReferenceNotice.tsx";
import { ComposerInlineMediaReferences } from "./ComposerInlineMediaReferences.tsx";
import { ComposerReferenceStack } from "./ComposerReferenceStack.tsx";
import { VideoAssetPreview } from "./VideoAssetPreview.tsx";
import { publishVideoProject } from "./useVideoProject.ts";
import { decodeVideoImage, draftImageRoleKey, VIDEO_IMAGE_SOURCE, VIDEO_VIDEO_SOURCE, type ComposerSnapshot, type MainVideoComposer, type VideoImageRole } from "./main-video-composer.ts";
import { designReferenceGroups, formatDesignReferenceLabel } from "./design-reference-assets.ts";
import { requestVideoComposer } from "./video-composer-request.ts";
import { resolveComposerReferenceInputs } from "./composer-reference-inputs.ts";

function ReferencePickerPopover({anchor, close, label, children, preview = false}: {anchor: RefObject<HTMLElement>; close: () => void; label: string; children: ReactNode; preview?: boolean}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({visibility: "hidden"});
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(420, window.innerWidth - 24), above = rect.top - 18, below = window.innerHeight - rect.bottom - 18;
      setPosition({width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), maxHeight: Math.max(0, Math.min(360, Math.max(above, below))), ...(above > below ? {bottom: window.innerHeight - rect.top + 6} : {top: rect.bottom + 6})});
    };
    place();
    const dismiss = (event: PointerEvent) => {if (!panel.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) close();};
    const escape = (event: KeyboardEvent) => {if (event.key === "Escape") {event.stopPropagation(); close(); (anchor.current?.matches("button") ? anchor.current : anchor.current?.querySelector("button"))?.focus();}};
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", escape, true);
    return () => {window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape, true);};
  }, [anchor, close]);
  return createPortal(<div ref={panel} className={`jz-composer-asset-picker jz-composer-asset-popover${preview ? " jz-reference-image-popover" : ""}`} role={preview ? "dialog" : "region"} aria-label={label} style={position}>{children}</div>, document.body);
}

export interface ComposerDraftImages {
  read(ids: readonly string[]): readonly { id: string; previewUrl: string; file: {name: string} }[];
  remove(id: string): void;
}

type Occurrence = { source: string; ref: string; invalid?: boolean };
export function ComposerMediaReferences({ remote, project, composer, sessionId, state, config, occurrences, draftImageIds = [], draftImages, disabled }: {
  remote: JizuoContentRemote; project: VideoProject; composer: MainVideoComposer; sessionId: string; state: ComposerSnapshot;
  draftImages?: ComposerDraftImages | undefined;
  config: MediaProviderConfig; occurrences: readonly Occurrence[]; draftImageIds?: readonly string[] | undefined; disabled: boolean;
}) {
  const kind = state.kind === "image" ? "image" : "video";
  const caps = resolveMediaInputCapabilities(config, kind);
  const addAnchor = useRef<HTMLDivElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const previewAnchor = useRef<HTMLElement | null>(null);
  const [preview, setPreview] = useState<{url: string; label: string; assetId: string} | null>(null);
  const [picker, setPicker] = useState<"image" | "video" | null>(null);
  useEffect(() => { setPicker(null); setPreview(null); }, [kind, config.protocol, config.model]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const { referenceAssetIds: imageIds, referenceVideoAssetIds: videoIds } = resolveComposerReferenceInputs(project, state, occurrences);
  for (const item of occurrences) {
    const ref = decodeVideoImage(item.ref);
    if (ref?.workId !== project.workId) continue;
    const list = item.source === VIDEO_IMAGE_SOURCE ? imageIds : item.source === VIDEO_VIDEO_SOURCE ? videoIds : undefined;
    if (list && !list.includes(ref.assetId)) list.push(ref.assetId);
  }
  const defaultRole = caps.firstFrame && !caps.referenceImages.max ? "first_frame" : "reference_image";
  const roles = imageIds.map(id => state.imageRoles[id] ?? state.inputs.videoImageRoles?.[state.inputs.referenceAssetIds?.indexOf(id) ?? -1] ?? defaultRole);
  const draftRoles = draftImageIds.map(id => state.imageRoles[draftImageRoleKey(id)] ?? defaultRole);
  const capabilityError = getMediaInputCapabilityError(config, { kind,
    references: [...imageIds.map((id, i) => ({ url: `https://reference.invalid/${encodeURIComponent(id)}`, ...(kind === "video" ? { role: roles[i]! } : {}) })),
      ...draftImageIds.map((id, i) => ({ url: `https://reference.invalid/draft/${encodeURIComponent(id)}`, ...(kind === "video" ? { role: draftRoles[i]! } : {}) }))],
    videoReferences: videoIds,
  });
  const run = async (operation: () => Promise<void>) => {
    if (busy || disabled) return;
    setBusy(true); setError("");
    try { await operation(); } catch (cause) { setError(userErrorMessage(cause, "素材添加失败", { operation: "ComposerMediaReferences" })); }
    finally { setBusy(false); }
  };
  const add = (id: string) => void run(async () => { await composer.insertAsset(sessionId, id); setPicker(null); });
  const useDesignPrompt = (design: VideoDesign) => {
    if (busy || disabled) return;
    requestVideoComposer({ workId: project.workId, designId: design.id, view: design.kind === "character" ? "character-sheet" : "panorama",
      title: `${design.name}`, kind: "image", action: "select", promptMode: "reference", aspectRatio: "16:9" });
    setPicker(null);
  };
  const importImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || !remote.importVideoAsset) return;
    void run(async () => {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024) throw new Error("请选择不超过 10 MB 的 PNG、JPEG 或 WebP 图片");
      const target = state.target;
      const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === "string" ? resolve(reader.result.slice(reader.result.indexOf(",") + 1)) : reject(new Error("读取图片失败")); reader.onerror = () => reject(new Error("读取图片失败")); reader.readAsDataURL(file); });
      if (JSON.stringify(composer.getSnapshot(sessionId).target) !== JSON.stringify(target)) throw new Error("镜头已切换，请重新添加图片");
      const latest = await remote.getVideoProject!({ workId: project.workId });
      const saved = await remote.importVideoAsset!({ workId: project.workId, expectedRevision: latest.revision, kind: "image", label: file.name.slice(0, 120), mimeType: file.type as "image/png" | "image/jpeg" | "image/webp", base64 });
      publishVideoProject(saved);
      const asset = saved.assets.find(item => !latest.assets.some(previous => previous.id === item.id) && item.kind === "image");
      if (!asset) throw new Error("图片已保存到素材库，请从素材库选择");
      const current = composer.getSnapshot(sessionId);
      if (JSON.stringify(current.target) !== JSON.stringify(target)) throw new Error("镜头已切换，图片已保存到原作品素材库");
      if (current.kind !== state.kind || current.connectionId !== state.connectionId) throw new Error("模型已切换，图片已保存到素材库，请按当前模型重新选择参考图");
      await composer.insertAsset(sessionId, asset.id); setPicker(null);
    });
  };
  const attachments = draftImages?.read(draftImageIds) ?? [];
  const selected = [...imageIds.map((id, index) => ({ id, kind: "image" as const, index })), ...attachments.map((image, index) => ({id: image.id, kind: "draft" as const, index: imageIds.length + index})), ...videoIds.map((id, index) => ({ id, kind: "video" as const, index }))];
  useEffect(() => { if (preview && !imageIds.includes(preview.assetId) && !draftImageIds.includes(preview.assetId)) setPreview(null); }, [imageIds.join("/"), draftImageIds.join("/"), preview]);
  const canImages = caps.referenceImages.max > 0 || caps.firstFrame;
  const available = project.assets.filter(asset => asset.kind === picker && !asset.panorama && asset.view !== "panorama" && (picker !== "video" || asset.mimeType === "video/mp4" && asset.sourceUrl) && !selected.some(item => item.id === asset.id));
  const designGroups = designReferenceGroups(project);
  const groupedIds = new Set(designGroups.flatMap(group => group.assets.map(asset => asset.id)));
  const ungrouped = available.filter(asset => !groupedIds.has(asset.id));
  const roleLabels = { reference_image: "参考图", first_frame: "首帧", last_frame: "尾帧" };
  const allowedRoles: VideoImageRole[] = [...(caps.referenceImages.max ? ["reference_image" as const] : []), ...(caps.firstFrame ? ["first_frame" as const] : []), ...(caps.lastFrame ? ["last_frame" as const] : [])];
  return <div className="jz-composer-media-references">
    <ComposerInlineMediaReferences remote={remote} project={project} occurrences={occurrences} imageIds={imageIds} videoIds={videoIds} />
    <ComposerReferenceStack count={selected.length} pinned={Boolean(preview || picker)} add={<div ref={addAnchor} className="jz-composer-reference-additions">
      {(canImages || caps.referenceVideos.max > 0) && <IconButton icon="add" label={canImages ? "添加参考图" : "添加参考视频"} className="jz-composer-reference-add" title="添加参考素材，也可拖入图片或输入 @ 引用作品素材" disabled={disabled || busy} aria-expanded={Boolean(picker)} onClick={() => setPicker(value => value ? null : canImages ? "image" : "video")} />}
    </div>}>

    {!!selected.length && <div className="jz-composer-media-strip" aria-label="已选参考素材">{selected.map(item => {
      const asset = project.assets.find(asset => asset.id === item.id);
      const attachment = item.kind === "draft" ? attachments.find(image => image.id === item.id) : undefined;
      const label = attachment?.file.name ?? asset?.label;
      const value = item.kind === "draft" ? draftRoles[item.index - imageIds.length] ?? defaultRole : roles[item.index] ?? defaultRole;
      return <figure key={`${item.kind}/${item.id}`} style={{"--reference-index": selected.length - 1 - selected.indexOf(item)} as CSSProperties}>
        {attachment ? <button type="button" className="jz-video-asset-preview" aria-label={`预览${label}`} onClick={event => {previewAnchor.current = event.currentTarget; setPreview({url: attachment.previewUrl, label: label!, assetId: item.id});}}><img src={attachment.previewUrl} alt={label}/></button> : asset && item.kind === "image" ? <VideoAssetPreview remote={remote} workId={project.workId} asset={asset} onPreview={(url, anchor) => { previewAnchor.current = anchor; setPreview({url, label: asset.label, assetId: asset.id}); }}/> : <span className="jz-composer-video-tile">{item.kind === "video" ? "▶" : "图片"}</span>}
        <figcaption title={label} aria-label={`@${item.kind !== "video" ? "图片" : "视频"}${item.index + 1} · ${label ?? "素材已不可用"}`}><span>{item.kind !== "video" ? "图片" : "视频"}{item.index + 1}</span><span className="jz-reference-asset-name"> · {label ?? "素材已不可用"}</span></figcaption>
        {kind === "video" && item.kind !== "video" && <select aria-label={`图片用途 ${label ?? item.id}`} value={value} disabled={disabled || busy} onChange={event => composer.setImageRole(sessionId, item.kind === "draft" ? draftImageRoleKey(item.id) : item.id, event.target.value as VideoImageRole)}>
          {!allowedRoles.includes(value) && <option value={value} disabled>{roleLabels[value]}（不支持）</option>}
          {allowedRoles.map(role => <option key={role} value={role}>{roleLabels[role]}</option>)}
        </select>}
        <IconButton icon="close" label={(`移除${label ?? item.id}`)} type="button" className="jz-composer-reference-remove" aria-label={`移除${label ?? item.id}`} disabled={disabled || busy} onClick={() => { if (attachment) {draftImages!.remove(item.id); return;} if (!composer.removeReference(sessionId, item.id, imageIds)) setError("无法移除，请在输入框中删除对应引用后重试"); }} />
      </figure>;
    })}</div>}
    </ComposerReferenceStack>
    {!caps.known && <small>当前模型能力未识别，请使用完整模型 ID。</small>}
    {preview && <ReferencePickerPopover anchor={previewAnchor} close={() => setPreview(null)} label={`预览${preview.label}`} preview><IconButton icon="close" label={"关闭参考图预览"} type="button" className="jz-reference-preview-close" aria-label="关闭参考图预览" onClick={() => setPreview(null)} /><img src={preview.url} alt={preview.label}/></ReferencePickerPopover>}
    {kind === "video" && !draftImages && draftImageIds.length > 0 && <div className="jz-composer-media-actions" aria-label="上传图片用途">{draftImageIds.map((id, index) => {
      const role = draftRoles[index]!;
      return <label key={id}>上传图片 {index + 1} <select aria-label={`上传图片 ${index + 1} 用途`} value={role} disabled={disabled || busy} onChange={event => composer.setImageRole(sessionId, draftImageRoleKey(id), event.target.value as VideoImageRole)}>
        {!allowedRoles.includes(role) && <option value={role} disabled>{roleLabels[role]}（不支持）</option>}
        {allowedRoles.map(value => <option key={value} value={value}>{roleLabels[value]}</option>)}
      </select></label>;
    })}</div>}
    {picker && <ReferencePickerPopover anchor={addAnchor} close={() => setPicker(null)} label={picker === "image" ? "选择参考图" : "选择参考视频"}>
      <div className="jz-composer-picker-heading"><strong>{picker === "image" ? "作品图片" : "作品视频"}</strong><IconButton icon="close" label={"关闭素材选择"} type="button" aria-label="关闭素材选择" onClick={() => setPicker(null)} /></div>
      {canImages && kind === "video" && caps.referenceVideos.max > 0 && <div className="jz-composer-media-actions">
        <IconButton icon="image" label={"参考图片"} type="button" aria-pressed={picker === "image"} onClick={() => setPicker("image")} />
        <IconButton icon="video" label={"添加参考视频"} type="button" aria-label="添加参考视频" aria-pressed={picker === "video"} onClick={() => setPicker("video")} />
      </div>}
      {picker === "image" && remote.importVideoAsset && <div className="jz-composer-upload">
        <input ref={uploadInput} hidden aria-label="上传参考图片" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || disabled} onChange={importImage}/>
        <button className="jz-composer-upload-button" type="button" disabled={busy || disabled} onClick={() => uploadInput.current?.click()}><ActionIcon name="image"/><span>{busy ? "正在上传…" : "上传图片"}</span></button>
        <small>PNG、JPEG 或 WebP，最大 10 MB</small>
      </div>}
      {picker === "image" && (["character", "scene"] as const).map(designKind => {
        const groups = designGroups.filter(group => group.design.kind === designKind);
        return groups.length > 0 && <section key={designKind} aria-label={designKind === "character" ? "人物参考图" : "场景参考图"}>
          <strong>{designKind === "character" ? "人物" : "场景"}</strong>
          {groups.map(({ design, assets }) => <div key={design.id} role="group" aria-label={`${design.name}`}>
            <div className="jz-composer-picker-heading"><span>{design.name}</span><small>{assets.length ? `${assets.length} 张参考图` : "暂无可用参考图"}</small></div>
            <div className="jz-composer-asset-options">{assets.filter(asset => available.some(item => item.id === asset.id)).map(asset => <button key={asset.id} type="button" title={asset.label} disabled={busy || disabled} onClick={() => add(asset.id)}>▧ {formatDesignReferenceLabel(asset, design)}</button>)}</div>
            {assets.length > 0 && assets.every(asset => selected.some(item => item.id === asset.id)) && <small>参考图已添加</small>}
            {!assets.length && <IconButton icon="apply" label={"使用" + (design.name) + "提示词"} type="button" disabled={busy || disabled} onClick={() => useDesignPrompt(design)} />}
          </div>)}
        </section>;
      })}
      {picker === "image" && ungrouped.length > 0 && designGroups.length > 0 && <strong>其他图片</strong>}
      <div className="jz-composer-asset-options">{(picker === "image" ? ungrouped : available).map(asset => <button key={asset.id} type="button" disabled={busy || disabled} onClick={() => add(asset.id)}>{asset.kind === "video" ? "▶ " : "▧ "}{asset.label}</button>)}</div>
      {!available.length && (picker !== "image" || !designGroups.length) && <small className="jz-composer-picker-empty">暂无可选{picker === "image" ? "图片，可上传参考图。" : "视频。生成的视频可用作下一镜头的参考。"}</small>}
      {picker === "video" && <small>支持带有效远程链接的 MP4 生成视频；单段 2–15 秒，合计不超过 15 秒。服务方链接过期后需重新获取，本地片段暂不支持上传。</small>}
    </ReferencePickerPopover>}
    {(error || capabilityError) && <ComposerReferenceNotice message={error || capabilityError!}/>}
  </div>;
}
