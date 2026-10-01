import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { isDiscardedMediaJob } from "../../../contracts/src/media-job-policy.ts";
import { useEffect, useRef, useState } from "react";
import type { VideoEpisode, VideoJob, VideoProject } from "@jizuo/contracts";
import type { VideoAssetsRemote } from "./assets-remote.ts";
import type { ControlVideoJobInput } from "../../../contracts/src/media-operations.ts";
import { VideoJobControls } from "./VideoShotMedia.tsx";
import { VideoErrorNotice } from "./VideoErrorNotice.tsx";
import { publishVideoProject } from "./useVideoProject.ts";
import "./video-task-history.css";

const kinds: Record<VideoJob["kind"], string> = { image: "图片", video: "视频", audio: "配音", export: "导出", pipeline: "自动制作" };
const states: Record<VideoJob["status"], string> = { queued: "等待生成", running: "进行中", succeeded: "已完成", failed: "失败", uncertain: "待核对", cancelled: "已停止" };
const active = (job: VideoJob) => job.status === "queued" || job.status === "running";
const needsAttention = (job: VideoJob) => !isDiscardedMediaJob(job) && !active(job) && job.status !== "succeeded"
  && (job.status === "uncertain" || job.state?.needsReconciliation === true);

export function VideoTaskHistory({ project, episode, remote }: { project: VideoProject; episode: VideoEpisode; remote: VideoAssetsRemote }) {
  const [open, setOpen] = useState(false);
  const jobs = project.jobs.filter((job) => job.kind !== "pipeline" && (!job.episodeId || job.episodeId === episode.id));
  const activeCount = jobs.filter(active).length;
  const attentionCount = jobs.filter(needsAttention).length;
  return <>
    <IconButton icon="history" label={`任务记录${activeCount > 0 ? ` · ${activeCount} 进行中` : attentionCount > 0 ? ` · ${attentionCount}` : ""}`} type="button" className="jz-video-history-trigger" aria-haspopup="dialog" onClick={() => setOpen(true)} />
    {open && <TaskHistoryDialog key={`${project.workId}/${episode.id}`} project={project} episode={episode} jobs={jobs} remote={remote} close={() => setOpen(false)} />}
  </>;
}

function TaskHistoryDialog({ project, episode, jobs, remote, close }: { project: VideoProject; episode: VideoEpisode; jobs: VideoJob[]; remote: VideoAssetsRemote; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [filter, setFilter] = useState<"all" | "active" | "attention">("all");
  const [limit, setLimit] = useState(30);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const visible = [...jobs].reverse().sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))
    .filter((job) => filter === "all" || (filter === "active" ? active(job) : needsAttention(job)));
  const control = async (job: VideoJob, input: Pick<ControlVideoJobInput, "action" | "remoteId">) => {
    if (!remote.controlVideoJob || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { publishVideoProject(await remote.controlVideoJob({ workId: project.workId, jobId: job.id, ...input })); }
    catch (cause) { setError(userErrorMessage(cause, "任务操作未完成，请重试", { operation: "VideoTaskHistory" })); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className="jz-video-task-history jz-video-editor" aria-label="任务记录" onCancel={(event) => { event.preventDefault(); close(); }}>
    <header><div><h3>任务记录</h3><p>{episode.title} · 含作品共用图片</p></div><IconButton icon="close" label={"关闭任务记录"} type="button" aria-label="关闭任务记录" onClick={close} /></header>
    <div className="jz-video-history-filters" role="group" aria-label="筛选任务">{([["all", "全部"], ["active", "进行中"], ["attention", "需处理"]] as const).map(([value, label]) =>
      <button type="button" key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setLimit(30); }}>{label}</button>)}</div>
    {error && <VideoErrorNotice title="任务操作未完成" message={error} />}
    <div className="jz-video-history-list">{visible.slice(0, limit).map((job) => {
      const shot = episode.shots.find((item) => item.id === job.shotId);
      const label = typeof job.state?.label === "string" ? job.state.label : shot?.title ?? `${kinds[job.kind]}任务`;
      const time = job.createdAt ? new Date(job.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : null;
      return <article key={job.id}>
        <button type="button" className="jz-video-history-row" aria-expanded={expanded === job.id} aria-controls={`video-job-${job.id}`} onClick={() => setExpanded(expanded === job.id ? null : job.id)}>
          <span className="jz-video-history-label">{label}<small>{kinds[job.kind]}{time ? ` · ${time}` : ""}</small></span>
          <span className="jz-video-history-status">{isDiscardedMediaJob(job) ? "已结束" : needsAttention(job) ? "待核对" : states[job.status]}{typeof job.state?.progress === "number" && active(job) ? ` ${Math.round(job.state.progress * 100)}%` : ""}<span aria-hidden="true"> {expanded === job.id ? "−" : "+"}</span></span>
        </button>
        {expanded === job.id && <div id={`video-job-${job.id}`} className="jz-video-history-detail">
          <VideoJobControls job={job} busy={busy} control={remote.controlVideoJob ? (input) => { void control(job, input); } : undefined} />
          {job.status === "succeeded" && <p>结果已保存到作品素材中。</p>}
        </div>}
      </article>;
    })}{!visible.length && <p>暂无{filter === "active" ? "进行中的" : filter === "attention" ? "需要处理的" : ""}任务。</p>}</div>
    {visible.length > limit && <IconButton icon="down" label={"显示更多记录"} type="button" onClick={() => setLimit((count) => count + 30)} />}
  </dialog>;
}
