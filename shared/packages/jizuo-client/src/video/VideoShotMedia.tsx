import { ErrorText } from "../ui/ErrorText.tsx";
import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { isDiscardedMediaJob } from "../../../contracts/src/media-job-policy.ts";
import { useEffect, useRef, useState } from "react";
import type { VideoAsset, VideoJob } from "@jizuo/contracts";
import type { ControlVideoJobInput } from "../../../contracts/src/media-operations.ts";
import type { VideoAssetsRemote } from "./assets-remote.ts";
import "./ChatImageGenerationCard.css";
import { VideoErrorNotice } from "./VideoErrorNotice.tsx";

const states: Record<VideoJob["status"], string> = { queued: "等待生成", running: "生成中", succeeded: "已完成", failed: "生成失败", uncertain: "待核对", cancelled: "已停止跟进" };

type MediaPreviewProps = { remote: VideoAssetsRemote; workId: string; asset: VideoAsset };

/** Decode a frame while paused and provide an explicit poster for WebKit. */
function FirstFrameVideo({ url, label, onError }: { url: string; label: string; onError: () => void }) {
  const [poster, setPoster] = useState<string>();
  const started = useRef(false);
  const captured = useRef(false);
  const capture = (video: HTMLVideoElement) => {
    if (captured.current || started.current || video.seeking || video.currentTime > 0.01 || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    try {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL("image/jpeg", 0.85);
      if (!image.startsWith("data:image/")) return;
      captured.current = true;
      setPoster(image);
    } catch {
      // A poster failure must not prevent playback of the decoded video.
    }
  };
  return <video aria-label={label} src={url} crossOrigin="anonymous" controls playsInline preload={poster ? "metadata" : "auto"} poster={poster}
    onLoadedMetadata={event => {
      const video = event.currentTarget;
      if (started.current || captured.current || !video.paused || video.currentTime !== 0) return;
      // WebKit may leave time zero blank until a seek decodes the opening frame.
      if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.min(0.001, video.duration / 2);
      else capture(video);
    }}
    onLoadedData={event => capture(event.currentTarget)} onSeeked={event => capture(event.currentTarget)}
    onPlay={() => { started.current = true; }} onError={onError} />;
}

export function VideoMediaPreview(props: MediaPreviewProps) {
  // Switching candidates also clears the old URL, error and poster before rendering.
  return <MediaPreviewContent key={JSON.stringify([props.workId, props.asset.id])} {...props} />;
}

function MediaPreviewContent({ remote, workId, asset }: MediaPreviewProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true; setUrl(null); setError(null);
    if (!remote.getVideoAssetUrl) { setError("当前运行时无法预览视频"); return; }
    void remote.getVideoAssetUrl({ workId, assetId: asset.id }).then((result) => { if (active) setUrl(result.url); })
      .catch((cause: unknown) => { if (active) setError(userErrorMessage(cause, "视频加载失败", { operation: "VideoShotMedia", effect: "read" })); });
    return () => { active = false; };
  }, [remote, workId, asset.id, retry]);
  return <div className="jz-video-media-preview">{error ? <VideoErrorNotice title="视频预览失败" message={error}><IconButton icon="reset" label={"重试预览"} type="button" onClick={() => setRetry((value) => value + 1)} /></VideoErrorNotice>
    : url ? asset.kind === "audio" ? <audio aria-label={asset.label} src={url} controls preload="metadata" onError={() => setError("音频无法播放")}/> : <FirstFrameVideo key={url} label={asset.label} url={url} onError={() => setError("视频无法播放，请重试或检查素材格式")} /> : <span role="status">正在加载视频…</span>}</div>;
}

export function VideoJobControls({ job, busy, control }: { job: VideoJob; busy: boolean; control?: ((input: Pick<ControlVideoJobInput, "action" | "remoteId">) => void) | undefined }) {
  const [remoteId, setRemoteId] = useState("");
  const [ending, setEnding] = useState(false);
  if(isDiscardedMediaJob(job))return <div className="jz-video-shot-job"><p>{job.state?.endedLocally === true ? "本地任务已结束，可以重新生成。" : "本次请求已失败，可检查原因后重新生成。"}</p>{job.error&&<small>{<ErrorText error={job.error} operation="VideoShotMedia" />}</small>}</div>;
  const errorTitle = job.status === "uncertain" ? "任务结果待核对" : job.status === "failed" ? job.kind === "video" ? "视频生成失败" : job.kind === "image" ? "图片生成失败" : job.kind === "audio" ? "配音任务失败" : "导出任务失败" : "任务需要处理";
  const media = job.kind === "image" || job.kind === "video";
  const restartReason = typeof job.state?.restartReason === "string" ? job.state.restartReason : null;
  const hasReceipt = typeof job.state?.hasReceipt === "boolean" ? job.state.hasReceipt : Boolean(job.remoteId);
  const missingReceipt = typeof job.state?.needsReconciliation === "boolean" ? job.state.needsReconciliation : job.kind !== "export" && !hasReceipt && (job.status === "uncertain" || job.status === "cancelled" && (job.attempt ?? 0) > 0);
  const resumeLabel = job.kind === "export" ? "继续导出" : job.kind === "audio" ? hasReceipt ? "继续处理音频" : "继续生成配音" : hasReceipt ? "继续查询结果" : "继续生成";
  const summary = job.state?.generationSummary;
  const parameters = summary && typeof summary === "object" && !Array.isArray(summary) ? summary : {};
  const ratio = typeof parameters.aspectRatio === "string" && /^[1-9]\d{0,2}:[1-9]\d{0,2}$/.test(parameters.aspectRatio) ? parameters.aspectRatio.replace(":", " / ") : "16 / 9";
  const tags = [parameters.model, parameters.resolution, parameters.aspectRatio,
    typeof parameters.durationSeconds === "number" ? `${parameters.durationSeconds} 秒` : undefined,
    typeof parameters.generateAudio === "boolean" ? parameters.generateAudio ? "有声" : "无声" : undefined].filter((value): value is string => typeof value === "string");
  return <div className="jz-video-shot-job">{job.kind === "video" && (job.status === "queued" || job.status === "running") && <><div className="jz-video-tools">{tags.map((tag,index)=><span key={index}>{tag}</span>)}</div><div className="jz-chat-image-placeholder" aria-label="视频生成结果占位" aria-busy="true" style={{aspectRatio:ratio}}><span className="jz-chat-image-placeholder-glow" aria-hidden="true"/><span className="jz-chat-image-placeholder-status">{states[job.status]}</span><span className="jz-chat-image-placeholder-hint">生成完成后将保存到素材库</span></div></>}<div className="jz-video-editor-heading"><span>{states[job.status]}</span><div className="jz-video-tools">
    {control && (job.status === "queued" || job.status === "running") && <IconButton icon="pause" label={"停止跟进"} type="button" disabled={busy} onClick={() => control({ action: "cancel" })} />}
    {control && missingReceipt && job.state?.canRecoverSubmission === true && job.status !== "running" && job.status !== "queued" && <IconButton icon="undo" label={"恢复原请求结果"} type="button" disabled={busy} onClick={() => control({action:"resume"})} />}
    {control && !restartReason && !missingReceipt && job.status === "failed" && <IconButton icon="reset" label={(hasReceipt ? resumeLabel : "重试任务")} type="button" disabled={busy} onClick={() => control({ action: "retry" })} />}
    {control && !restartReason && !missingReceipt && (job.status === "cancelled" || job.status === "uncertain") && <IconButton icon="reset" label={(resumeLabel)} type="button" disabled={busy} onClick={() => control({ action: "resume" })} />}
  </div></div>{job.error && <VideoErrorNotice title={errorTitle} message={job.error} />}
    {restartReason && <p>{restartReason}</p>}
    {media && !restartReason && !hasReceipt && !missingReceipt && job.status === "failed" && <small>重试会沿用本次任务的模型与提示词。使用当前模型请回到生成页面重新生成。</small>}
    {media && control && ["uncertain", "cancelled", "failed"].includes(job.status) && <div className="jz-video-tools">
      {ending ? <div><p>仅结束本地跟进，不会取消服务方任务。原请求可能已计费，重新生成会发起新的请求。</p>
        <IconButton icon="apply" label={"确认结束，允许重新生成"} type="button" disabled={busy} onClick={() => control({action:"abandon"})} />
        <IconButton icon="left" label={"返回"} type="button" disabled={busy} onClick={() => setEnding(false)} />
      </div> : <IconButton icon="close" label={"结束本地任务并允许重新生成"} type="button" disabled={busy} onClick={() => setEnding(true)} />}
    </div>}
    {missingReceipt && job.kind === "audio" && <p>配音请求可能已计费，请在服务方核对记录。同步配音不支持任务 ID 查询；取得音频后可在剪辑页导入。</p>}
    {missingReceipt && media && job.state?.reconciliationUnsupported === true && <p>当前连接使用同步图片接口，无法按任务 ID 查询。上游可能已经生成并计费，请到上游核对、下载图片后导入素材库，确认结果前不要重复生成。</p>}
    {missingReceipt && media && job.state?.canRecoverSubmission === true && <p>提交回执未收到，上游可能已完成。恢复会使用本次请求的原标识找回结果。</p>}
    {missingReceipt && media && job.state?.canRecoverSubmission !== true && job.state?.reconciliationUnsupported !== true && <details><summary>核对服务方任务</summary><p>请求可能已被服务方接收。请在服务方控制台找到对应任务，再填写任务 ID 查询结果。</p>
      <label>服务方任务 ID<input value={remoteId} maxLength={512} disabled={busy} onChange={(event) => setRemoteId(event.target.value)} /></label>
      {control && <IconButton icon="search" label={"核对并继续查询"} type="button" disabled={busy || !/^[a-zA-Z0-9_-]{1,512}$/.test(remoteId.trim())} onClick={() => control({ action: "reconcile", remoteId: remoteId.trim() })} />}
    </details>}
  </div>;
}
