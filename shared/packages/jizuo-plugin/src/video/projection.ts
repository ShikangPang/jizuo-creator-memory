import { isDiscardedMediaJob } from "../../../contracts/src/media-job-policy.ts";
import { mediaJobBlocksDuplicate, mediaJobRecoveryState } from "./generation.ts";
import type { VideoJsonValue, VideoProject } from "@jizuo/contracts";

/** Project files retain complete execution inputs; remotes and tools only return this view. */
export function projectVideoForClient(project: VideoProject, selection?: Partial<Pick<VideoProject,"episodes"|"jobs"|"assets">>): VideoProject {
  // Recovery checks use the full authoritative context, even for a scoped response.
  const view = structuredClone({...project,...selection});
  view.assets = view.assets.filter(item => !item.deletedAt);
  view.designs = (view.designs ?? []).filter(item => !item.deletedAt);
  const designIds = new Set(view.designs.map(item => item.id));
  for (const asset of view.assets) if (asset.designId && !designIds.has(asset.designId)) delete asset.designId;
  view.episodes = view.episodes.filter(episode => !episode.deletedAt);
  for (const job of view.jobs) {
    const generationBlocked=(job.kind==="image"||job.kind==="video")?mediaJobBlocksDuplicate(job):undefined;
    const recovery=generationBlocked!==undefined?mediaJobRecoveryState(job,project)
      :job.kind==="audio"&&job.state?.service==="speech"?{hasReceipt:Boolean(job.state.output),needsReconciliation:job.status!=="succeeded"&&!job.state.output&&(job.status==="uncertain"||Boolean(job.state.submissionStarted))}
      :job.kind==="export"?{hasReceipt:false,needsReconciliation:false}:undefined;
    const discarded = isDiscardedMediaJob(job);
    if(!discarded && recovery?.needsReconciliation && job.status === "failed") job.status = "uncertain";
    const frozen = job.snapshot;
    job.snapshot = {};
    const state: Record<string, VideoJsonValue> = {};
    for (const field of ["label", "subtitleMode", "stage", "reason", "childJobId", "designId", "view"] as const) {
      const value = job.state?.[field];
      if (typeof value === "string") state[field] = value;
    }
    for (const field of ["progress", "usedRequests", "maxRequests"] as const) {
      const value = job.state?.[field];
      if(field==="progress"&&generationBlocked!==undefined&&(typeof value!=="number"||value<0||value>=1||job.status!=="running"))continue;
      if (typeof value === "number" && Number.isFinite(value)) state[field] = value;
    }
    for (const field of ["stale", "paused", "remoteResultUnknown", "endedLocally"] as const) {
      const value = job.state?.[field];
      if (typeof value === "boolean") state[field] = value;
    }
    if(generationBlocked!==undefined)state.generationBlocked=generationBlocked;
    if(recovery)Object.assign(state,recovery);
    if(recovery?.needsReconciliation && job.kind === "image" && frozen.config && typeof frozen.config === "object" && !Array.isArray(frozen.config) && frozen.config.protocol === "openai") state.reconciliationUnsupported = true;
    if(generationBlocked!==undefined){
      const sourceSessionId=job.state?.sourceSessionId;
      if(typeof sourceSessionId==="string"&&sourceSessionId.length>0&&sourceSessionId.length<=128)state.sourceSessionId=sourceSessionId;
      if(job.status==="queued"||job.status==="running"){
        state.stage=recovery?.canRecoverSubmission && (job.state?.submission==="unknown" || Number(job.state?.receiptRecoveryAttempts)>0)?"recovering":job.state?.output?"saving":job.remoteId?"generating":job.status==="queued"?"queued":"submitting";
        if(state.stage==="saving")delete state.progress;
      }
    }
    // Expose a deliberate author-facing subset, never credentials, URLs or embedded image bytes.
    const request = frozen.request;
    const config = frozen.config;
    if ((job.kind === "video" || job.kind === "image") && request && typeof request === "object" && !Array.isArray(request) && typeof request.prompt === "string" && config && typeof config === "object" && !Array.isArray(config)) {
      const summary: Record<string, VideoJsonValue> = {};
      if (typeof request.prompt === "string") summary.prompt = request.prompt;
      if (typeof config.model === "string") summary.model = config.model;
      for (const field of ["durationSeconds", "aspectRatio", "width", "height"]) {
        const value = request[field]; if (typeof value === "string" || typeof value === "number") summary[field] = value;
      }
      const options = config.options;
      if(options && typeof options === "object" && !Array.isArray(options)) for(const field of ["resolution", "generateAudio"]) {
        const value = options[field]; if(typeof value === "string" || typeof value === "boolean") summary[field] = value;
      }
      state.generationSummary = summary;
    }
    job.state = state;
  }
  return view;
}
