import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useRef, useState, type KeyboardEvent, type ClipboardEvent } from "react";
import type { VideoEpisode, VideoJob, VideoProject } from "@jizuo/contracts";
import type { StartVideoProductionInput, ControlVideoProductionInput } from "../../../contracts/src/video-production.ts";
import type { VideoProductionRemote } from "./production-remote.ts";
import { publishVideoProject } from "./useVideoProject.ts";
import { VideoErrorNotice } from "./VideoErrorNotice.tsx";
import "./video-production.css";

const integerOnly = {
  inputMode: "numeric" as const,
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
    if (!event.ctrlKey && !event.metaKey && [".", ",", "e", "E", "+", "-"].includes(event.key)) event.preventDefault();
  },
  onPaste: (event: ClipboardEvent<HTMLInputElement>) => {
    if (!/^\d+$/.test(event.clipboardData.getData("text").trim())) event.preventDefault();
  },
};

const pendingStarts = new Map<string, StartVideoProductionInput>();
type PendingAddition = { request: ControlVideoProductionInput; expectedLimit: number };
const pendingAdditions = new Map<string, PendingAddition>();
const stages: Record<string, string> = { storyboard: "整理制作稿", adapting: "改编原著", images: "生成图片", videos: "生成镜头视频", editing: "整理剪辑", export: "导出成片", done: "制作完成" };
const isProduction = (job: VideoJob) => job.kind === "pipeline" && (job.state?.service === "production" || typeof job.state?.stage === "string" && Object.hasOwn(stages, job.state.stage));
const active = (job: VideoJob) => job.status === "running" || job.status === "queued";
const definiteRejection = (cause: unknown) => cause && typeof cause === "object" && "code" in cause && ["revision_conflict", "validation_error", "credential_required"].includes(String(cause.code));

export function VideoProductionPanel({ project, episode, remote, onInspectStage }: {
  project: VideoProject; episode: VideoEpisode; remote: VideoProductionRemote;
  onInspectStage?: ((stage: "storyboard" | "shots" | "assets" | "editing") => void) | undefined;
}) {
  const key = `${project.workId}/${episode.id}`;
  const runs = project.jobs.filter((job) => job.episodeId === episode.id && isProduction(job));
  const run = [...runs].reverse().find(active) ?? runs.at(-1);
  const isActive = Boolean(run && active(run));
  const [pending, setPending] = useState(() => pendingStarts.get(key));
  const [pendingAddition, setPendingAddition] = useState(() => run ? pendingAdditions.get(run.id) : undefined);
  const [maxRequests, setMaxRequests] = useState(10);
  const [pauseAfterStoryboard, setPauseAfterStoryboard] = useState(true);
  const [instructions, setInstructions] = useState("");
  const [aspectRatio, setAspectRatio] = useState<StartVideoProductionInput["aspectRatio"]>(episode.aspectRatio ?? "9:16");
  const [targetOnly, setTargetOnly] = useState(false);
  const [shotIds, setShotIds] = useState<string[]>([]);
  const [additional, setAdditional] = useState(0);
  const [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const incomplete = episode.shots.filter((shot) => !shot.archived && !shot.locked && (!shot.imageAssetId || !shot.videoAssetId));
  const targetShots = shotIds.filter((id) => incomplete.some((shot) => shot.id === id));
  const used = typeof run?.state?.usedRequests === "number" ? run.state.usedRequests : 0;
  const limit = typeof run?.state?.maxRequests === "number" ? run.state.maxRequests : 0;
  const paused = run?.state?.paused === true;
  const stage = typeof run?.state?.stage === "string" ? run.state.stage : "storyboard";
  useEffect(() => {
    if (pending && project.jobs.some((job) => job.id === pending.requestId && isProduction(job))) { pendingStarts.delete(key); setPending(undefined); }
  }, [project.jobs, key, pending]);
  useEffect(() => {
    if (run && pendingAddition !== undefined && limit >= pendingAddition.expectedLimit) { pendingAdditions.delete(run.id); setPendingAddition(undefined); setAdditional(0); }
  }, [run?.id, limit, pendingAddition]);
  const operate = async (operation: () => Promise<VideoProject>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { publishVideoProject(await operation()); }
    catch (cause) { setError(userErrorMessage(cause, "操作结果尚未确认，请核对任务状态", { operation: "VideoProductionPanel" })); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const start = () => {
    if (!remote.startVideoProduction || busyRef.current || isActive) return;
    const request = pending ?? { workId: project.workId, episodeId: episode.id, expectedRevision: project.revision, requestId: crypto.randomUUID(),
      maxRequests, pauseAfterStoryboard, aspectRatio, ...(instructions.trim() ? { instructions: instructions.trim() } : {}), ...(targetOnly ? { shotIds: targetShots } : {}) };
    pendingStarts.set(key, request); setPending(request);
    void operate(async () => {
      try { const next = await remote.startVideoProduction!(request); pendingStarts.delete(key); setPending(undefined); return next; }
      catch (cause) { if (definiteRejection(cause)) { pendingStarts.delete(key); setPending(undefined); } throw cause; }
    });
  };
  const control = (action: ControlVideoProductionInput["action"], includeBudget = false) => {
    if (!run || !remote.controlVideoProduction || busyRef.current) return;
    const additionalRequests = action === "resume" && includeBudget ? additional : 0;
    const request: ControlVideoProductionInput = action === "resume" && pendingAddition ? pendingAddition.request : {
      workId: project.workId, jobId: run.id, action, ...(additionalRequests ? { additionalRequests, requestId: crypto.randomUUID() } : {}),
    };
    if (additionalRequests > 0 && !pendingAddition) { const pendingValue = { request, expectedLimit: limit + additionalRequests }; pendingAdditions.set(run.id, pendingValue); setPendingAddition(pendingValue); }
    void operate(async () => {
      try {
        const next = await remote.controlVideoProduction!(request);
        if (request.additionalRequests || action === "cancel") { pendingAdditions.delete(run.id); setPendingAddition(undefined); setAdditional(0); }
        return next;
      } catch (cause) { if (request.additionalRequests && definiteRejection(cause)) { pendingAdditions.delete(run.id); setPendingAddition(undefined); } throw cause; }
    });
  };
  if (!remote.startVideoProduction && !run) return null;
  const stageTab = paused && stage === "images" && !run?.state?.childJobId ? "storyboard" : stage === "images" ? "assets" : stage === "videos" ? "shots" : stage === "editing" || stage === "export" || stage === "done" ? "editing" : "storyboard";
  return <section className="jz-video-production jz-video-editor" aria-label="AI 自动制作">
    <div className="jz-video-editor-heading"><strong>AI 制作</strong><div className="jz-video-tools">
      {isActive && run ? <><span>{paused ? "已暂停" : Object.hasOwn(stages, stage) ? stages[stage] : "制作中"} · {used}/{limit} 次请求</span>
        {remote.controlVideoProduction && <><IconButton icon={paused ? "play" : "pause"} label={(paused ? "继续制作" : "暂停制作")} type="button" disabled={busy} onClick={() => control(paused ? "resume" : "pause")} /><IconButton icon="close" label={"取消制作"} type="button" disabled={busy} onClick={() => control("cancel")} /></>}
      </> : remote.startVideoProduction && <IconButton icon="sparkles" label={(pending ? "核对本次制作请求" : "AI 制作这一集")} type="button" disabled={busy || !pending && (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 200 || targetOnly && !targetShots.length)} onClick={start} />}
    </div></div>
    {error && <VideoErrorNotice title="制作操作未完成" message={error} />}
    {pending && <small>请求结果尚未确认。再次核对会使用同一请求，不会新建重复制作任务。</small>}
    {run && <div className="jz-production-status">
      {!isActive && <span>{run.status === "succeeded" ? "上一轮制作已完成" : run.status === "cancelled" ? "上一轮制作已取消" : "上一轮制作需要处理"} · {used}/{limit} 次请求</span>}
      {typeof run.state?.reason === "string" && run.state.reason && <p>{run.state.reason}</p>}
      {run.error && <VideoErrorNotice title="制作任务需要处理" message={run.error} />}
      {onInspectStage && <IconButton icon="eye" label={"查看" + (stageTab === "storyboard" ? "制作稿" : stageTab === "shots" ? "镜头任务" : stageTab === "assets" ? "图片任务" : "剪辑与导出")} type="button" onClick={() => onInspectStage(stageTab)} />}
      {isActive && paused && <details><summary>调整请求数量上限</summary><p>需要更多生成时再增加；恢复制作不会自动增加额度。</p>
        <label>额外允许的请求数<input {...integerOnly} type="number" min={0} max={Math.min(100, 200 - limit)} step={1} value={additional} disabled={busy || pendingAddition !== undefined} onChange={(event) => { if (Number.isInteger(event.target.valueAsNumber)) setAdditional(event.target.valueAsNumber); }} /></label>
        {pendingAddition !== undefined && <p>上次追加数量的结果尚未确认；再次核对会使用同一请求，不会重复追加。</p>}
        <IconButton icon="add" label={(pendingAddition ? "核对本次追加并继续" : additional > 0 ? `增加 ${additional} 次并继续` : "保持上限并继续")} type="button" disabled={busy || !pendingAddition && (!Number.isInteger(additional) || additional < 0 || additional > Math.min(100, 200 - limit))} onClick={() => control("resume", true)} />
      </details>}
    </div>}
    {!isActive && <details><summary>制作设置 · 请求数量上限 {pending?.maxRequests ?? maxRequests} 次{(pending?.pauseAfterStoryboard ?? pauseAfterStoryboard) ? " · 先检查制作稿" : ""}</summary>
      <fieldset disabled={busy || Boolean(pending)}><legend>本次制作</legend>
        <label>请求数量上限<input {...integerOnly} type="number" min={1} max={200} step={1} value={maxRequests} onChange={(event) => { if (Number.isInteger(event.target.valueAsNumber)) setMaxRequests(event.target.valueAsNumber); }} /></label>
        <label>成片画幅<select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as StartVideoProductionInput["aspectRatio"])}><option value="9:16">竖屏 9:16</option><option value="16:9">横屏 16:9</option><option value="1:1">方形 1:1</option><option value="4:3">4:3</option><option value="3:4">3:4</option><option value="21:9">宽屏 21:9</option></select></label>
        <small>这是生成请求次数上限，费用由所配置服务商决定。</small>
        <label><input type="checkbox" checked={pauseAfterStoryboard} onChange={(event) => setPauseAfterStoryboard(event.target.checked)} />制作稿完成后暂停，让我先检查</label>
        <label>制作要求<textarea rows={2} maxLength={10000} value={instructions} placeholder="例如：保持人物形象一致，竖屏短剧，节奏紧凑" onChange={(event) => setInstructions(event.target.value)} /></label>
        {incomplete.length > 0 && <><label><input type="checkbox" checked={targetOnly} onChange={(event) => setTargetOnly(event.target.checked)} />仅补齐指定镜头</label>
          {targetOnly && incomplete.map((shot) => <label key={shot.id}><input type="checkbox" checked={shotIds.includes(shot.id)} onChange={() => setShotIds((current) => current.includes(shot.id) ? current.filter((id) => id !== shot.id) : [...current, shot.id])} />{shot.title}</label>)}
        </>}
      </fieldset>
    </details>}
  </section>;
}
