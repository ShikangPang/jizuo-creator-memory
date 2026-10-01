import type { VideoJob } from "./video.ts";
/** A local failure is not proof that the provider rejected or finished the paid request. */
export function isDiscardedMediaJob(job: VideoJob): boolean {
  if (job.kind !== "image" && job.kind !== "video") return false;
  if (job.status === "cancelled" && job.state?.endedLocally === true) return true;
  const ended = job.status === "failed" || job.state?.discarded === true;
  if (job.state?.remoteTerminal === true || job.state?.submission === "rejected" || job.state?.submission === "not-submitted") return ended;
  // Ignore legacy discarded flags when a receipt or ambiguous submission survives.
  if (job.remoteId || job.state?.output || job.state?.hasReceipt === true || job.state?.needsReconciliation === true
    || job.status === "uncertain" || (job.attempt ?? 0) > 0
    || ["started", "unknown", "acknowledged"].includes(String(job.state?.submission))) return false;
  return ended;
}
