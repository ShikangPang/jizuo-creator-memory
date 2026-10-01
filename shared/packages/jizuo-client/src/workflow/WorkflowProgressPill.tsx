import { IconButton } from "../ui/IconButton.tsx";
import type { Ref } from "react";

import type { WorkflowRunProjection } from "@jizuo/contracts";

export const workflowStatusLabel: Record<WorkflowRunProjection["status"], string> = {
  queued: "等待开始",
  running: "进行中",
  waiting_approval: "等待确认",
  waiting_decision: "等待决定",
  paused: "已停止",
  retrying: "正在重试",
  memory_pending: "等待保存记忆",
  completed: "已完成",
  blocked: "已阻塞",
  failed: "执行失败",
  rejected: "提案已拒绝",
  cancelled: "已取消",
};

const activeStatuses = new Set<WorkflowRunProjection["status"]>([
  "queued",
  "running",
  "retrying",
  "memory_pending",
]);

export interface WorkflowProgressPillProps {
  readonly run: WorkflowRunProjection;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly buttonRef?: Ref<HTMLButtonElement>;
}

/** A deliberately small status entry point above the conversation composer. */
export function WorkflowProgressPill({ run, open, onToggle, buttonRef }: WorkflowProgressPillProps) {
  const status = workflowStatusLabel[run.status];
  const active = activeStatuses.has(run.status);
  const position = Math.min(run.totalGroups, Math.max(1, run.currentGroup));
  return (
    <IconButton icon="history" label={`章节工作流：第 ${position} / ${run.totalGroups} 步，${status}${run.revision.completed > 0 ? `，修订第 ${run.revision.completed} 轮` : ""}`}
      type="button"
      ref={buttonRef}
      className="jz-workflow-progress-pill"
      aria-expanded={open}
      aria-busy={active}
      aria-haspopup="dialog"
      aria-label={`章节工作流：第 ${position} / ${run.totalGroups} 步，${status}`}
      onClick={onToggle}
     />
  );
}
