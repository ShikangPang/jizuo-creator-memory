import { ErrorText } from "../ui/ErrorText.tsx";
import { errorFeedback, userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useId, useRef, useState } from "react";
import type { VideoJob, VideoJsonValue, VideoProject } from "@jizuo/contracts";
import type { JizuoContentRemote } from "../content/remote.ts";
import type { ControlVideoJobInput } from "../../../contracts/src/media-operations.ts";
import { VideoAssetPreview } from "./VideoAssetPreview.tsx";
import { VideoJobControls, VideoMediaPreview } from "./VideoShotMedia.tsx";
import type { ImageChatPending } from "./image-chat-store.ts";
import { publishVideoProject } from "./useVideoProject.ts";
import "./ChatImageGenerationCard.css";

export type ChatImageGenerationCardProps = {
  remote: JizuoContentRemote;
  workId: string;
  job?: VideoJob | undefined;
  project?: VideoProject | undefined;
  pending?: ImageChatPending | undefined;
  onRetry?: (() => void | Promise<void>) | undefined;
};

function field(value: VideoJsonValue | undefined, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return typeof value[key] === "string" ? value[key] : undefined;
}

function stage(job: VideoJob | undefined, error: string | undefined, hasResults: boolean, media: string): string {
  if (job?.status === "cancelled" && job.state?.endedLocally === true) return "已结束，可重新生成";
  if (hasResults || job?.status === "succeeded") return "生成完成";
  if (job?.status === "running" && job.state?.stage === "recovering") return "正在恢复生成结果";
  if (job?.state?.needsReconciliation || job?.state?.remoteResultUnknown) return "结果待核对";
  if (!job) return error ? `${media}提交未完成` : "正在提交";
  if (job.status === "queued") return "等待生成";
  if (job.status === "running") {
    if (job.state?.stage === "saving" || job.state?.output) return `正在保存${media}`;
    if (job.state?.stage === "generating" || job.remoteId || job.state?.submission === "acknowledged") return `正在生成${media}`;
    return job.state?.stage === "submitting" || job.state?.submission === "started" ? "正在提交" : `正在生成${media}`;
  }
  return { failed: `${media}生成失败`, uncertain: "结果待核对", cancelled: "已停止跟进" }[job.status];
}

/** Image and video conversation results, with inputs read only from the frozen job. */
export function ChatImageGenerationCard({ remote, workId, job, project, pending, onRetry }: ChatImageGenerationCardProps) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const titleId = useId(), promptId = useId(), detailId = useId();
  if (job && job.kind !== "image" && job.kind !== "video") return null;
  const kind = job?.kind ?? pending?.kind ?? "image";
  const media = kind === "video" ? "视频" : "图片";

  const prompt = field(job?.state?.generationSummary, "prompt") ?? field(job?.snapshot.request, "prompt") ?? pending?.prompt ?? "";
  const canCollapsePrompt = prompt.length > 180 || prompt.split("\n").length > 3;
  const model = field(job?.state?.generationSummary, "model") ?? field(job?.snapshot.config, "model") ?? pending?.model;
  const label = typeof job?.state?.label === "string" ? job.state.label : pending?.label;
  const summary = job?.state?.generationSummary;
  const parameters = summary && typeof summary === "object" && !Array.isArray(summary) ? summary : {};
  const ratio = typeof parameters.aspectRatio === "string" && /^[1-9]\d{0,2}:[1-9]\d{0,2}$/.test(parameters.aspectRatio) ? parameters.aspectRatio.replace(":", " / ") : "16 / 9";
  const tags = [typeof parameters.width === "number" && typeof parameters.height === "number" ? `${parameters.width} × ${parameters.height}` : undefined,
    typeof parameters.aspectRatio === "string" ? parameters.aspectRatio : undefined,
    typeof parameters.resolution === "string" ? parameters.resolution : undefined,
    kind === "video" && typeof parameters.durationSeconds === "number" ? (parameters.durationSeconds > 0 ? `${parameters.durationSeconds}秒` : "智能时长") : undefined].filter(Boolean);
  const resultIds = new Set(job?.resultAssetIds ?? []);
  const assets = project?.workId === workId ? project.assets.filter(asset => asset.kind === kind && resultIds.has(asset.id)) : [];
  const hasResults = assets.length > 0;
  const active = !hasResults && (job ? job.status === "queued" || job.status === "running" : !pending?.error);
  const reportedProgress = job?.state?.progress;
  const progress = job?.status === "running" && job.state?.stage !== "saving" && !job.state?.output
    && typeof reportedProgress === "number" && Number.isFinite(reportedProgress) && reportedProgress >= 0 && reportedProgress < 1
    ? Math.floor(reportedProgress * 100) : undefined;
  const status = stage(job, pending?.error, hasResults, media);
  const failed = job ? ["failed", "uncertain", "cancelled"].includes(job.status) : Boolean(pending?.error);
  const canInspect = job ? job.status !== "succeeded" && !hasResults : Boolean(pending?.error);
  const run = async (operation: () => Promise<unknown> | void) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setControlError(null);
    try { await operation(); }
    catch (cause) { setControlError(userErrorMessage(cause, "任务操作未完成，请重试", { operation: "ChatImageGenerationCard" })); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const control = (input: Pick<ControlVideoJobInput, "action" | "remoteId">) => {
    if (!job || !remote.controlVideoJob) return;
    void run(async () => { publishVideoProject(await remote.controlVideoJob!({ workId, jobId: job.id, ...input })); });
  };

  return <article className="jz-chat-image" aria-labelledby={titleId}>
    <header className="jz-chat-image-heading">
      <strong id={titleId}>{label || `${media}生成`}</strong>
      {model && <span className="jz-chat-image-model" title={model}>{model}</span>}
    </header>
    {prompt && <div className="jz-chat-image-prompt-wrap">
      <p id={promptId} className={`jz-chat-image-prompt${promptExpanded || !canCollapsePrompt ? " is-expanded" : ""}`}>{prompt}</p>
      {canCollapsePrompt && <IconButton icon="text" label={(promptExpanded ? "收起提示词" : "展开提示词")} className="jz-chat-image-text-button" type="button" aria-expanded={promptExpanded} aria-controls={promptId}
        onClick={() => setPromptExpanded(value => !value)} />}
    </div>}
    <div className="jz-chat-image-status-row">
      <span role="status" aria-label={`${media}生成状态`} className={failed && !hasResults ? "jz-chat-image-attention" : undefined}>{status}{active && progress !== undefined ? ` · ${progress}%` : ""}</span>
      {canInspect && <IconButton icon="info" label={(detailsExpanded ? "收起详情" : "任务详情")} className="jz-chat-image-text-button" type="button" aria-expanded={detailsExpanded} aria-controls={detailId}
        onClick={() => setDetailsExpanded(value => !value)} />}
    </div>
    {tags.length > 0 && <ul className="jz-chat-image-parameters" aria-label="生成参数">{tags.map(tag => <li key={tag}>{tag}</li>)}</ul>}
    {active && <div className="jz-chat-image-placeholder" aria-label="生成结果占位" aria-busy="true" style={{aspectRatio: ratio}}>
      <span className="jz-chat-image-placeholder-glow" aria-hidden="true" />
      <span className="jz-chat-image-placeholder-status">{status}</span>
      <span className="jz-chat-image-placeholder-hint">生成完成后将在这里展示</span>
    </div>}
    {active && <div className={`jz-chat-image-progress${progress === undefined ? " is-indeterminate" : ""}`} role="progressbar" aria-label={`${media}生成进度`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={progress === undefined ? status : `${status}，${progress}%`}>
      <span style={progress === undefined ? undefined : { width: `${progress}%` }} />
    </div>}
    {hasResults && <div className="jz-chat-image-results">{assets.map(asset => kind === "video"
      ? <VideoMediaPreview key={asset.id} workId={workId} asset={asset} remote={remote} />
      : <VideoAssetPreview key={asset.id} workId={workId} asset={asset} remote={remote} />)}</div>}
    {hasResults && <small className="jz-chat-image-saved">已保存到素材库 · {kind === "video" ? "可在这里直接播放" : "点击图片查看大图"}</small>}
    {job?.status === "succeeded" && !hasResults && <small className="jz-chat-image-saved">{media}预览暂不可用，可在素材库中查看。</small>}
    {detailsExpanded && canInspect && <div id={detailId} className="jz-chat-image-details">
      {job ? <VideoJobControls job={job} busy={busy} control={remote.controlVideoJob ? control : undefined} />
        : <><p>{<ErrorText error={pending?.error} operation="ChatImageGenerationCard" />}</p>{onRetry && !["network", "timeout", "unknown_result"].includes(errorFeedback(pending?.error).category) && <IconButton icon="reset" label={"重试提交"} type="button" disabled={busy} onClick={() => { void run(onRetry); }} />}</>}
      {controlError && <p role="alert">{controlError}</p>}
    </div>}
  </article>;
}
