import { ErrorText } from "../ui/ErrorText.tsx";
import { userErrorMessage } from "@jizuo/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import type { WorkflowRunDetailProjection, WorkflowRunProjection } from "@jizuo/contracts";

import type { JizuoWorkflowRemote } from "../content/remote.ts";
import { useWorkflowRuns, useWorkflowRunsSnapshot } from "./useWorkflowRuns.ts";
import { WorkflowProgressPill } from "./WorkflowProgressPill.tsx";
import { WorkflowRunPopover, type WorkflowRunAction } from "./WorkflowRunPopover.tsx";
import type { WorkflowSessionSource } from "./workflowStore.ts";
import { bindWorkflowComposerStop } from "./composerStop.ts";
import "./workflow.css";

const dockStatuses = new Set<WorkflowRunProjection["status"]>([
  "queued",
  "running",
  "retrying",
  "memory_pending",
]);
const dockActions = new Set([
  "extend_review",
  "resume",
  "reconcile_apply",
]);

function messageOf(error: unknown): string {
  return userErrorMessage(error, "操作暂未完成，请稍后再试。", { operation: "ChapterWorkflowProgressDock" });
}

function currentRun(runs: readonly WorkflowRunProjection[]): WorkflowRunProjection | undefined {
  const ordered = [...runs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const actionable = ordered.find((run) => dockStatuses.has(run.status)
    || (run.availableActions ?? []).some((action) => dockActions.has(action)));
  // Keep the latest failure readable even when there is no safe recovery
  // action. A newer finished run must not resurrect an older failure badge.
  const latest = ordered[0];
  return actionable ?? (latest && ["failed", "blocked"].includes(latest.status) ? latest : undefined);
}

export interface ChapterWorkflowProgressDockProps {
  readonly remote: JizuoWorkflowRemote;
  readonly sessions: WorkflowSessionSource;
}

/** A session-bound, non-invasive workflow progress dock for the conversation composer. */
export function ChapterWorkflowProgressDock({ remote, sessions }: ChapterWorkflowProgressDockProps) {
  const store = useWorkflowRuns({ remote, sessions });
  const snapshot = useWorkflowRunsSnapshot(store);
  useEffect(() => bindWorkflowComposerStop(store), [store]);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<WorkflowRunDetailProjection>();
  const [detailError, setDetailError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const run = useMemo(() => currentRun(snapshot.runs), [snapshot.runs]);

  useEffect(() => {
    setOpen(false);
    setDetail(undefined);
    setDetailError(undefined);
  }, [snapshot.sessionId]);

  useEffect(() => {
    if (!open || run === undefined) return;
    let alive = true;
    setDetail(undefined);
    setDetailError(undefined);
    void store.get(run.runId).then((next) => {
      if (alive) setDetail(next);
    }).catch((error: unknown) => {
      if (alive) setDetailError(messageOf(error));
    });
    return () => { alive = false; };
  }, [open, run?.runId, store]);

  useEffect(() => {
    if (
      !open
      || run === undefined
      || detail === undefined
      || detail.runId !== run.runId
      || detail.updatedAt === run.updatedAt
    ) return;
    let alive = true;
    setDetailError(undefined);
    void store.get(run.runId).then((next) => {
      if (alive) setDetail(next);
    }).catch((error: unknown) => {
      if (alive) setDetailError(messageOf(error));
    });
    return () => { alive = false; };
  }, [detail?.runId, detail?.updatedAt, open, run?.runId, run?.updatedAt, store]);

  useEffect(() => {
    if (run === undefined) setOpen(false);
  }, [run]);

  if (run === undefined) {
    if (snapshot.phase === "error" || snapshot.phase === "unavailable") {
      return <p className="jz-workflow-progress-error" role="alert">{<ErrorText error={snapshot.error} fallback="章节工作流暂不可用" operation="workflowSync" effect="read" />}</p>;
    }
    return null;
  }

  const visibleDetail: WorkflowRunDetailProjection = detail?.runId === run.runId
    && detail.updatedAt >= run.updatedAt ? detail : run;

  const act = async (action: WorkflowRunAction): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setDetailError(undefined);
    try {
      if (action === "extend") await store.extendBudget(visibleDetail.runId);
      else if (action === "resume") await store.resume(visibleDetail.runId);
      else await store.reconcileApply(visibleDetail.runId);
      setOpen(false);
    } catch (error) {
      setDetailError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="jz-workflow-progress-dock" data-plugin="jizuo" data-surface="chapter-workflow-progress">
      {open && (
        <WorkflowRunPopover
          run={visibleDetail}
          busy={busy || snapshot.pendingRunIds.includes(visibleDetail.runId)}
          {...(detailError === undefined ? {} : { error: detailError })}
          onClose={() => { setOpen(false); }}
          onAction={(action) => { void act(action); }}
          anchor={pillRef.current}
        />
      )}
      <WorkflowProgressPill buttonRef={pillRef} run={run} open={open} onToggle={() => { setOpen((value) => !value); }} />
    </div>
  );
}
