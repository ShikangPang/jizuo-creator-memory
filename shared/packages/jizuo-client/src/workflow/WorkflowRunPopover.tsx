import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import type { WorkflowRunDetailProjection, WorkflowRunProjection, WorkflowStepProjection } from "@jizuo/contracts";

import { workflowStatusLabel } from "./WorkflowProgressPill.tsx";

type Action = "extend" | "resume" | "reconcile";

const stepStatusLabels: Record<WorkflowStepProjection["status"], string> = {
  waiting: "等待中",
  running: "进行中",
  completed: "已完成",
  retrying: "正在重试",
  blocked: "已阻塞",
  failed: "执行失败",
  skipped: "已跳过",
  cancelled: "已取消",
};

function hasCurrentOrProblem(step: WorkflowStepProjection, index: number, currentGroup: number): boolean {
  return step.warning === true || index + 1 === currentGroup || ["running", "retrying", "blocked", "failed"].includes(step.status);
}

function ActionButton({ label, action, busy, onAction }: {
  label: string;
  action: Action;
  busy: boolean;
  onAction(action: Action): void;
}) {
  return <IconButton icon={action === "extend" ? "add" : action === "resume" ? "play" : "search"} label={(label)} type="button" disabled={busy} onClick={() => { onAction(action); }} />;
}

export interface WorkflowRunPopoverProps {
  readonly run: WorkflowRunDetailProjection;
  readonly busy?: boolean;
  readonly error?: string;
  readonly onClose: () => void;
  readonly onAction: (action: Action) => void;
  readonly onDismissCompleted?: () => void;
  /** The compact pill used to calculate an upward, viewport-safe placement. */
  readonly anchor?: HTMLElement | null;
}

/** The popover renders only contract-sanitized projection data. */
export function WorkflowRunPopover({
  run,
  busy = false,
  error,
  onClose,
  onAction,
  onDismissCompleted,
  anchor,
}: WorkflowRunPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (anchor === null || anchor === undefined) {
      setPlacement(undefined);
      return;
    }
    const measure = (): void => {
      const rect = anchor.getBoundingClientRect();
      const margin = 12;
      const gap = 8;
      const width = Math.max(0, Math.min(520, window.innerWidth - margin * 2));
      const availableAbove = Math.max(0, rect.top - gap - margin);
      const left = Math.max(margin, Math.min(
        rect.left + rect.width / 2 - width / 2,
        Math.max(margin, window.innerWidth - margin - width),
      ));
      setPlacement({
        position: "fixed",
        width,
        maxHeight: availableAbove,
        left,
        bottom: Math.max(margin, window.innerHeight - rect.top + gap),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(anchor);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      observer?.disconnect();
    };
  }, [anchor]);
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const outside = (event: MouseEvent): void => {
      if (event.target instanceof Element && event.target.closest(".jz-workflow-progress-pill") !== null) return;
      if (ref.current !== null && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("mousedown", outside);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("mousedown", outside);
    };
  }, [onClose]);

  const status = workflowStatusLabel[run.status];
  const available = new Set(run.availableActions ?? []);
  const canExtend = available.has("extend_review");
  const canResume = available.has("resume");
  const canReconcile = available.has("reconcile_apply");

  return (
    <div ref={ref} style={placement} className="jz-workflow-run-popover" role="dialog" aria-label="章节工作流进度">
      <header className="jz-workflow-run-popover-header">
        <div>
          <strong>{status}</strong>
          <span>第 {Math.min(run.totalGroups, Math.max(1, run.currentGroup))} / {run.totalGroups} 步</span>
        </div>
        <IconButton icon="close" label={"关闭工作流进度"} type="button" className="jz-workflow-run-popover-close" aria-label="关闭工作流进度" onClick={onClose} />
      </header>

      <p className="jz-workflow-run-revision">修订第 {run.revision.completed} 轮</p>
      {(run.status === "failed" || run.status === "blocked") && <p role="alert" className="jz-workflow-run-error">
        请查看下方失败步骤和处理建议。
        {!run.draftRetained && "当前提示不能确认正文是否已写入，请先打开章节核对。"}
        {canReconcile ? "请先对账已写入内容。" : canResume
          ? "处理原因后可继续工作流。"
          : "当前没有可用的恢复按钮；处理原因后，可回到原对话请求继续并核对恢复条件。"}
      </p>}
      {run.status === "paused" && <p className="jz-workflow-run-notice">
        {canResume
          ? "已停止。可继续未完成步骤，运行时会先核对当前章节和检查点。"
          : "已停止。当前运行暂无可用的恢复操作。"}
      </p>}
      {run.draftRetained && run.status !== "completed" && (
        <>
          <p className="jz-workflow-run-notice">章节草稿已保留</p>
          {run.status === "waiting_decision" && (
            <p className="jz-workflow-run-notice">连续两轮审查没有改善，可再增加 2 轮修订。</p>
          )}
        </>
      )}
      {run.status === "waiting_decision" && !run.draftRetained && (
        <p className="jz-workflow-run-notice">
          连续两轮审查没有改善，可再增加 2 轮修订，或保留当前已写入的正文。
        </p>
      )}
      {error !== undefined && <p role="alert" className="jz-workflow-run-error">{error}</p>}

      <ol className="jz-workflow-run-steps" aria-label="工作流节点">
        {run.steps.map((step, index) => {
          const open = hasCurrentOrProblem(step, index, run.currentGroup);
          return (
            <li key={step.key} className={`jz-workflow-run-step jz-workflow-run-step--${step.warning === true ? "warning" : step.status}`}>
              <details open={open}>
                <summary>
                  <span aria-hidden="true" className="jz-workflow-step-dot" />
                  <strong>{step.label}</strong>
                  <span>{stepStatusLabels[step.status]}</span>
                </summary>
                {step.summary !== undefined ? <p>{step.summary}</p>
                  : ["failed", "blocked"].includes(step.status) && <p>该任务未记录失败详情，请核对章节状态，并提供失败步骤和应用版本以便排查。</p>}
              </details>
            </li>
          );
        })}
      </ol>

      <footer className="jz-workflow-run-actions">
        {canExtend && <ActionButton label="增加 2 轮修订" action="extend" busy={busy} onAction={onAction} />}
        {canResume && <ActionButton label="继续工作流" action="resume" busy={busy} onAction={onAction} />}
        {canReconcile && <ActionButton label="对账已写入内容" action="reconcile" busy={busy} onAction={onAction} />}
        {run.status === "completed" && onDismissCompleted !== undefined && (
          <IconButton icon="close" label={"关闭已完成工作流提示"} type="button" disabled={busy} aria-label="关闭已完成工作流提示" onClick={onDismissCompleted} />
        )}
      </footer>
    </div>
  );
}

export type { Action as WorkflowRunAction };
