import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { VideoAssetUsage } from "./VideoAssetUsage.tsx";
import { VideoMediaPreview } from "./VideoShotMedia.tsx";
import { useRef, useState, type ChangeEvent } from "react";
import type { VideoEpisode, VideoProject } from "@jizuo/contracts";
import type { GenerateVideoMediaInput, ImportVideoAssetInput } from "../../../contracts/src/media-operations.ts";
import { VideoAssetPreview } from "./VideoAssetPreview.tsx";
import { VideoReferencePicker } from "./VideoReferencePicker.tsx";
import { VideoAssetLabelEditor } from "./VideoAssetLabelEditor.tsx";
import { VideoErrorNotice } from "./VideoErrorNotice.tsx";
import type { VideoAssetsRemote } from "./assets-remote.ts";
export type { VideoAssetsRemote } from "./assets-remote.ts";
import { publishVideoProject } from "./useVideoProject.ts";
import { MediaGenerationInfo } from "./MediaGenerationInfo.tsx";
import { useMediaGenerationSettings } from "./useMediaGenerationSettings.ts";
import { estimateMediaGeneration } from "./media-generation-estimate.ts";
import "./video-assets.css";

const imageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

export function VideoAssetsPanel({ project, episode: suppliedEpisode, remote }: { project: VideoProject; episode?: VideoEpisode | undefined; remote: VideoAssetsRemote }) {
  const [selectedEpisodeId, setSelectedEpisodeId] = useState("");
  const episode = suppliedEpisode ?? project.episodes.find(item => !item.deletedAt && item.id === selectedEpisodeId);
  const mediaState = useMediaGenerationSettings(remote);
  const estimate = estimateMediaGeneration(mediaState.view, "image");
  const [label, setLabel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [referenceAssetIds, setReferenceAssetIds] = useState<string[]>([]);
  const [aspectRatio, setAspectRatio] = useState<GenerateVideoMediaInput["aspectRatio"]>(episode?.aspectRatio ?? "9:16");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [targetShotId, setTargetShotId] = useState("");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const visibleAssets = project.assets.filter(asset => (kind === "all" || asset.kind === kind) && asset.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const images = project.assets.filter((asset) => asset.kind === "image");
  const shots = episode?.shots.filter((shot) => !shot.archived) ?? [];
  const targetShot = shots.find((shot) => shot.id === targetShotId);
  const run = async (operation: () => Promise<VideoProject>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { publishVideoProject(await operation()); }
    catch (cause) { setError(userErrorMessage(cause, "操作失败，请重试", { operation: "VideoAssetsPanel" })); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || !remote.importVideoAsset || busyRef.current) return;
    const kind = imageTypes.has(file.type) ? "image" : ["video/mp4", "video/webm"].includes(file.type) ? "video" : ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/ogg"].includes(file.type) ? "audio" : null;
    if (!kind) { setError("请选择 PNG、JPEG、WebP 图片，MP4、WebM 视频或 MP3、WAV、M4A、OGG 音频"); return; }
    if (!file.size || file.size > 20 * 1024 * 1024) { setError("素材大小应大于 0 且不超过 20 MB"); return; }
    await run(async () => {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result.slice(reader.result.indexOf(",") + 1)) : reject(new Error("读取图片失败"));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(file);
      });
      return remote.importVideoAsset!({ workId: project.workId, expectedRevision: project.revision, kind,
        label: file.name.slice(0, 120), mimeType: (file.type === "audio/x-wav" ? "audio/wav" : file.type) as ImportVideoAssetInput["mimeType"], base64 });
    });
  };
  return <section className="jz-video-assets jz-video-editor" aria-label="素材管理">
    {error && <VideoErrorNotice title="素材操作未完成" message={error} />}
    <p className="jz-video-assets-note">作品的图片、视频和音频集中保存在这里。</p>
    {remote.importVideoAsset && <label className="jz-video-import">导入素材<input type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/ogg" disabled={busy} onChange={(event) => { void importFile(event); }} /></label>}
    {remote.generateVideoMedia && <details><summary>生成其他图片</summary>
      <label>素材名称<input value={label} maxLength={120} disabled={busy} placeholder="例如：女主角定妆图" onChange={(event) => setLabel(event.target.value)} /></label>
      <label>图片提示词<textarea value={prompt} rows={3} maxLength={32000} disabled={busy} onChange={(event) => setPrompt(event.target.value)} /></label>
      <label>画面比例<select value={aspectRatio} disabled={busy} onChange={(event) => setAspectRatio(event.target.value as GenerateVideoMediaInput["aspectRatio"])}><option value="9:16">竖屏 9:16</option><option value="16:9">横屏 16:9</option><option value="1:1">方形 1:1</option></select></label>
      <VideoReferencePicker assets={project.assets} selected={referenceAssetIds} onChange={setReferenceAssetIds} remote={remote} workId={project.workId} disabled={busy} />
      <MediaGenerationInfo disabled={busy} state={mediaState} kind="image" referenceCount={referenceAssetIds.length} />
      <IconButton icon="image" label={"生成图片"} type="button" disabled={busy || mediaState.switching || estimate.insufficientCredits || !prompt.trim() || !label.trim() || referenceAssetIds.length > 14 || referenceAssetIds.some((id) => !images.some((asset) => asset.id === id && !asset.panorama))} onClick={() => { if (mediaState.switching || estimate.insufficientCredits) return; void run(() => remote.generateVideoMedia!({ workId: project.workId,
        expectedRevision: project.revision, kind: "image", prompt: prompt.trim(), label: label.trim(), aspectRatio, referenceAssetIds })); }} />
    </details>}
    <div className="jz-video-tools"><label>搜索素材<input type="search" value={search} onChange={event=>setSearch(event.target.value)} placeholder="素材名称"/></label>
      <label>素材类型<select value={kind} onChange={event=>setKind(event.target.value)}><option value="all">全部</option><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option><option value="export">成片</option></select></label></div>
    {visibleAssets.length > 0 && <>
      {!suppliedEpisode && remote.selectVideoAsset && project.episodes.some(item => !item.deletedAt) && <label>视频集<select value={selectedEpisodeId} onChange={event => {setSelectedEpisodeId(event.target.value); setTargetShotId("");}} disabled={busy}><option value="">选择视频集以应用素材</option>{project.episodes.filter(item => !item.deletedAt).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
      {episode && remote.selectVideoAsset && <label>应用到镜头<select value={targetShotId} disabled={busy} onChange={(event) => setTargetShotId(event.target.value)}><option value="">选择镜头</option>{shots.map((shot, index) => <option key={shot.id} value={shot.id} disabled={shot.locked}>{index + 1}. {shot.title}{shot.locked ? "（已锁定）" : ""}</option>)}</select></label>}
      <div className="jz-video-asset-grid">{visibleAssets.map((asset) => <figure key={asset.id}>{asset.kind === "image" ? <VideoAssetPreview remote={remote} workId={project.workId} asset={asset} /> : <VideoMediaPreview remote={remote} workId={project.workId} asset={asset}/>}
        <VideoAssetLabelEditor asset={asset} workId={project.workId} revision={project.revision} remote={remote} />
        {episode && remote.selectVideoAsset && targetShot && (asset.kind === "image" || asset.kind === "video") && <IconButton icon="apply" label={(asset.panorama ? "全景原图请先取景" : (asset.kind === "image" ? targetShot.imageAssetId : targetShot.videoAssetId) === asset.id ? "当前素材" : "选用素材")} type="button" disabled={busy || targetShot.locked || Boolean(asset.panorama) || (asset.kind === "image" ? targetShot.imageAssetId : targetShot.videoAssetId) === asset.id} onClick={() => { void run(() => remote.selectVideoAsset!({ workId: project.workId,
          episodeId: episode.id, shotId: targetShot.id, assetId: asset.id, kind: asset.kind as "image" | "video", expectedRevision: project.revision })); }} />}
        <VideoAssetUsage project={project} asset={asset} remote={remote} busy={busy} run={run} showAsset={label=>{setKind("all");setSearch(label);}}/>
      </figure>)}</div>
    </>}
    {!visibleAssets.length && <p className="jz-video-assets-note">{project.assets.length ? "没有匹配的素材" : "暂无素材。可以导入文件，或在聊天框中生成。"}</p>}
  </section>;
}
