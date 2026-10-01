import { WorkflowRepository } from "./repository.ts";

export interface PublicWorkflowStepProjection {
  readonly group: string;
  readonly label: string;
  readonly status: "waiting" | "running" | "completed" | "retrying" | "blocked" | "failed" | "skipped" | "cancelled";
  readonly attempt: number;
  readonly warning?: boolean;
  /** A bounded, user-facing stage result or failure explanation. */
  readonly summary?: string;
  /** A bounded, de-identified model result suitable for the conversation UI. */
  readonly output?: { readonly content: string; readonly truncated: boolean };
  readonly durationMs?: number;
}

const publicGroups = Object.freeze([
  { group: "target", label: "锁定目标", nodes: ["lock-target", "initialize-chapter"] },
  { group: "memory", label: "查询记忆", nodes: ["query-memory"] },
  { group: "planning", label: "章节策划", nodes: ["plan"] },
  { group: "writing", label: "小说写作", nodes: ["write", "revise"] },
  { group: "review", label: "质量审查", nodes: ["continuity", "style", "ai-trace", "review-gate"] },
  { group: "proposal", label: "生成提案", nodes: ["proposal"] },
  { group: "approval", label: "人工确认", nodes: ["approval"] },
  { group: "application", label: "应用正文", nodes: ["apply"] },
  { group: "verification", label: "回读校验", nodes: ["verify"] },
  { group: "memory-save", label: "保存记忆", nodes: ["extract-memory", "save-memory"] },
] as const);

interface PublicGroup {
  readonly group: string;
  readonly label: string;
  readonly nodes: readonly string[];
}

const directGroups: readonly PublicGroup[] = Object.freeze(publicGroups
  .filter((group) => !["proposal", "approval", "application"].includes(group.group)));

/** Deliberately omits run, session, target, node, artifact, and proposal identifiers. */
export interface PublicWorkflowProjection {
  readonly status: "queued" | "running" | "waiting_approval" | "waiting_decision" | "paused" | "retrying" | "memory_pending" | "completed" | "blocked" | "failed" | "rejected" | "cancelled";
  readonly currentGroup: number;
  readonly totalGroups: number;
  readonly draftRetained?: boolean;
  readonly revision: { readonly completed: number; readonly budget: number; readonly hardMaximum: 10 };
  readonly steps: readonly PublicWorkflowStepProjection[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowProjectionWithCursor {
  readonly projection: PublicWorkflowProjection;
  readonly sequence: number;
}

/**
 * Step summaries are a public surface. Reject values that look like internal
 * identifiers, artifact references, prompts, or raw candidate payload labels.
 */
export function sanitizeWorkflowStepSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const summary = value.replace(/\s+/g, " ").trim();
  if (summary.length === 0 || summary.length > 240) return undefined;
  if (/(?:run|session|work|vol|chapter|proposal)_[A-Za-z0-9_-]+|artifact|prompt|sha256|candidate payload/i.test(summary)) return undefined;
  return summary;
}

/**
 * Preserve model line breaks for the chat transcript while removing runtime
 * identifiers and capping the durable projection. This is intentionally a
 * presentation boundary: prompts, artifact paths, hashes, and checkpoint
 * envelopes are never copied into the returned value.
 */
export function sanitizeWorkflowStepOutput(value: unknown): { readonly content: string; readonly truncated: boolean } | undefined {
  if (typeof value !== "string") return undefined;
  const redacted = value
    .replace(/runs\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[0-9a-f-]{36}\.json/gi, "[已隐藏内部引用]")
    .replace(/(?:run|session|work|vol|chapter|proposal|artifact)_[A-Za-z0-9_-]+/gi, "[已隐藏标识]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[已隐藏哈希]")
    .trim();
  if (redacted.length === 0) return undefined;
  const truncated = redacted.length > 20_000 || redacted.includes("（输出已截断）");
  return Object.freeze({
    content: redacted.slice(0, 20_000),
    truncated,
  });
}

/** Builds UI-safe, query-only projections from product tables, never checkpoint JSON. */
export class WorkflowProjectionService {
  public constructor(private readonly repository: WorkflowRepository) {}

  getRun(runId: string): PublicWorkflowProjection | undefined {
    const run = this.repository.getRun(runId);
    if (!run) return undefined;
    const direct = run.chapterWriteMode === "direct";
    const groups = direct ? directGroups : publicGroups;
    const draftRetained = direct && this.repository.getChapterWrite(runId, "write", 0)?.status === "completed";
    const storedSteps = this.repository.listSteps(runId);
    const currentIndex = currentGroupIndex(groups, run.status, run.currentNode, storedSteps);
    const steps = groups.map((group, index) => {
      const attempts = storedSteps.filter((step) => step.uiGroup === group.group);
      const durationMs = attempts.reduce((total, step) => total + (step.durationMs ?? 0), 0);
      const warningSummary = [...attempts].reverse().map((step) => sanitizeWorkflowStepSummary(step.summary)).find((value) => value !== undefined && (
        value.includes("仍有未解决的审查意见")
        || value.includes("达到本类上限") && value.includes("继续")
        || value.includes("已达上限") && value.includes("继续")
      ));
      const terminalProblem = index === currentIndex && ["failed", "blocked"].includes(run.status);
      const latestSummary = sanitizeWorkflowStepSummary(attempts.at(-1)?.summary);
      const summary = terminalProblem
        ? latestSummary ?? "该任务未记录可显示的失败详情，请先核对章节状态，并提供失败步骤和应用版本以便排查。"
        : warningSummary ?? latestSummary;
      const output = sanitizeWorkflowStepOutput(attempts.at(-1)?.output);
      const warning = group.group === "review" && warningSummary !== undefined;
      return {
        group: group.group,
        label: group.label,
        status: publicGroupStatus(run.status, currentIndex, index),
        attempt: Math.max(1, ...attempts.map((step) => step.attempt)),
        ...(warning ? { warning: true } : {}),
        ...(summary === undefined ? {} : { summary }),
        ...(output === undefined ? {} : { output }),
        ...(durationMs > 0 ? { durationMs } : {}),
      };
    });
    return {
      status: run.status,
      currentGroup: currentIndex + 1,
      // The denominator is fixed for this persisted execution mode, not for
      // the number of physical attempts that have completed so far.
      totalGroups: groups.length,
      ...(draftRetained ? { draftRetained: true } : {}),
      revision: {
        // v2 budgets are per review class. Summing three serial loops can
        // exceed the public hard maximum even though no class exceeded it.
        completed: Math.max(run.revisionCompleted, ...["revise", "continuity-revise", "style-revise", "ai-trace-revise"]
          .map((nodeKey) => storedSteps.filter((step) => step.nodeKey === nodeKey && step.status === "completed").length)),
        budget: run.revisionBudget,
        hardMaximum: 10,
      },
      steps,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  getRunWithCursor(runId: string): WorkflowProjectionWithCursor | undefined {
    const projection = this.getRun(runId);
    return projection ? { projection, sequence: this.repository.getChangeSequence() } : undefined;
  }
}

function currentGroupIndex(groups: readonly PublicGroup[], status: PublicWorkflowProjection["status"], currentNode: string | undefined, steps: readonly ReturnType<WorkflowRepository["listSteps"]>[number][]): number {
  const nodeGroup = new Map(groups.flatMap((group, index) => group.nodes.map((node) => [node, index] as const)));
  const groupForNode = (node: string): number | undefined => {
    const exact = nodeGroup.get(node);
    if (exact !== undefined) return exact;
    if (/^(?:continuity|style|ai-trace)-(?:review|gate|revise)$/.test(node)) return groups.findIndex((group) => group.group === "review");
    return undefined;
  };
  if (status === "completed") return groups.length - 1;
  if (status === "waiting_approval" || status === "rejected") return nodeGroup.get("approval") ?? 0;
  if (status === "waiting_decision") return nodeGroup.get("review-gate") ?? 0;
  if (status === "memory_pending") return nodeGroup.get("save-memory") ?? 0;
  const fromNode = currentNode === undefined ? undefined : groupForNode(currentNode);
  if (fromNode !== undefined) return fromNode;
  const active = steps.find((step) => step.status === "running" || step.status === "retrying" || step.status === "blocked" || step.status === "failed");
  if (active) return groupForNode(active.nodeKey) ?? Math.max(0, groups.findIndex((group) => group.group === active.uiGroup));
  if (status === "blocked" || status === "failed" || status === "cancelled" || status === "paused") {
    // Older/crash-boundary rows may have lost current_node after the physical
    // attempt committed. Fold the latest durable attempt, including a
    // completed review gate, back into its frozen public group. An empty run
    // safely remains at Target 1/N. Persisted groupOrder still uses the old
    // ten-group layout, so map durable nodes into this run's visible groups.
    const latest = steps.reduce<number | undefined>((groupIndex, step) => (
      Math.max(groupIndex ?? 0, groupForNode(step.nodeKey) ?? groups.findIndex((group) => group.group === step.uiGroup))
    ), undefined);
    if (latest !== undefined) return latest;
  }
  return 0;
}

function publicGroupStatus(status: PublicWorkflowProjection["status"], currentIndex: number, index: number): PublicWorkflowStepProjection["status"] {
  if (status === "completed") return "completed";
  if (index < currentIndex) return "completed";
  if (index > currentIndex) return "waiting";
  if (status === "retrying" || status === "memory_pending") return "retrying";
  if (status === "blocked" || status === "waiting_decision") return "blocked";
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "rejected") return "cancelled";
  if (status === "running") return "running";
  return "waiting";
}
