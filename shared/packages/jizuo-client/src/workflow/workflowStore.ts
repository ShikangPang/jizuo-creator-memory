import {
  WorkflowRunDetailProjection as WorkflowRunDetailProjectionSchema,
  WorkflowRunProjection as WorkflowRunProjectionSchema,
  type WorkflowRunDetailProjection,
  type WorkflowRunProjection,
} from "@jizuo/contracts";

import type { JizuoWorkflowRemote } from "../content/remote.ts";

export interface WorkflowSessionSource {
  getCurrentSessionId(): string | undefined;
  subscribe(listener: () => void): () => void;
}

export type WorkflowProjectionPhase = "idle" | "loading" | "ready" | "unavailable" | "error";

export interface WorkflowRunsSnapshot {
  readonly sessionId: string | undefined;
  readonly phase: WorkflowProjectionPhase;
  readonly runs: readonly WorkflowRunProjection[];
  readonly pendingRunIds: readonly string[];
  readonly cursor: number;
  readonly error: WorkflowStoreError | undefined;
}

export class WorkflowStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowStoreError";
    this.code = code;
  }
}

/** The Harness runtime did not inject the sessions service required for isolation. */
export class WorkflowStoreUnavailableError extends WorkflowStoreError {
  constructor(message = "当前对话会话不可用") {
    super("workflow_unavailable", message);
    this.name = "WorkflowStoreUnavailableError";
  }
}

export interface WorkflowRunsStoreOptions {
  readonly remote: JizuoWorkflowRemote;
  readonly sessions: WorkflowSessionSource;
  readonly watchTimeoutMs?: number;
  /** Bounded transport retry delays. An empty list disables retry. */
  readonly retryDelaysMs?: readonly number[];
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1_000] as const;
const EMPTY_SNAPSHOT: WorkflowRunsSnapshot = Object.freeze({
  sessionId: undefined,
  phase: "idle",
  runs: Object.freeze([]),
  pendingRunIds: Object.freeze([]),
  cursor: 0,
  error: undefined,
});

function delay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = globalThis.setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      globalThis.clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function aborted(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError");
}

function isTransportFailure(error: unknown): boolean {
  if (error instanceof WorkflowStoreError) return false;
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code !== "string") return true;
  return ["transport", "network", "timeout", "connection_lost"].includes(code);
}

function asStoreError(error: unknown): WorkflowStoreError {
  if (error instanceof WorkflowStoreError) return error;
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return new WorkflowStoreError(
      typeof code === "string" ? code : "workflow_transport",
      error.message || "章节工作流状态同步失败",
      { cause: error },
    );
  }
  return new WorkflowStoreError("workflow_transport", "章节工作流状态同步失败");
}

/**
 * A session-bound state machine around the strict workflow remotes.  It keeps
 * only contract-validated public projections and never guesses workflow state
 * from the revision budget or a local action result.
 */
export class WorkflowRunsStore {
  readonly #remote: JizuoWorkflowRemote;
  readonly #sessions: WorkflowSessionSource;
  readonly #watchTimeoutMs: number;
  readonly #retryDelaysMs: readonly number[];
  readonly #wait: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly #listeners = new Set<() => void>();
  readonly #cursors = new Map<string, number>();
  #snapshot: WorkflowRunsSnapshot = EMPTY_SNAPSHOT;
  #mounted = false;
  #epoch = 0;
  #watchController: AbortController | undefined;
  readonly #actionControllers = new Set<AbortController>();
  readonly #readControllers = new Set<AbortController>();
  #unsubscribeSessions: (() => void) | undefined;

  constructor(options: WorkflowRunsStoreOptions) {
    this.#remote = options.remote;
    this.#sessions = options.sessions;
    this.#watchTimeoutMs = Math.min(25_000, Math.max(0, options.watchTimeoutMs ?? 25_000));
    this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.#wait = options.wait ?? delay;
  }

  getSnapshot = (): WorkflowRunsSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  start(): void {
    if (this.#mounted) return;
    this.#mounted = true;
    try {
      this.#unsubscribeSessions = this.#sessions.subscribe(() => { this.#synchronizeSession(); });
      this.#synchronizeSession();
    } catch (error) {
      this.#replace({ ...EMPTY_SNAPSHOT, phase: "unavailable", error: asStoreError(error) });
    }
  }

  dispose(): void {
    if (!this.#mounted) return;
    this.#mounted = false;
    this.#epoch += 1;
    this.#watchController?.abort();
    for (const controller of this.#actionControllers) controller.abort();
    for (const controller of this.#readControllers) controller.abort();
    this.#watchController = undefined;
    this.#unsubscribeSessions?.();
    this.#unsubscribeSessions = undefined;
  }

  /** Refetch the selected session now; control actions call this after completion. */
  async refresh(): Promise<void> {
    const sessionId = this.#currentSessionId();
    if (sessionId === undefined) return;
    const epoch = this.#epoch;
    await this.#fetch(sessionId, epoch);
  }

  async get(runId: string): Promise<WorkflowRunDetailProjection> {
    const sessionId = this.#currentSessionId();
    if (sessionId === undefined) throw new WorkflowStoreUnavailableError();
    const epoch = this.#epoch;
    const controller = new AbortController();
    this.#readControllers.add(controller);
    try {
      const detail = this.#validateDetail(await this.#remote.getWorkflowRun({ runId }, controller.signal));
      if (detail.sessionId !== sessionId || !this.#isCurrent(epoch, sessionId)) {
        throw new WorkflowStoreError("workflow_session_changed", "当前对话已切换，未采用过期工作流结果");
      }
      return detail;
    } finally {
      this.#readControllers.delete(controller);
    }
  }

  async decideApproval(input: {
    runId: string;
    proposalId: string;
    decision: "approved" | "rejected";
  }): Promise<WorkflowRunDetailProjection> {
    return this.#control(input.runId, (signal) => this.#remote.decideWorkflowApproval(input, signal));
  }

  async extendBudget(runId: string): Promise<WorkflowRunDetailProjection> {
    return this.#control(runId, (signal) => this.#remote.extendWorkflowBudget({ runId, additionalRounds: 2 }, signal));
  }

  async pause(runId: string): Promise<WorkflowRunDetailProjection> {
    return this.#control(runId, (signal) => this.#remote.pauseWorkflowRun({ runId }, signal));
  }

  async resume(runId: string): Promise<WorkflowRunDetailProjection> {
    return this.#control(runId, (signal) => this.#remote.resumeWorkflowRun({ runId }, signal));
  }

  async cancel(runId: string): Promise<WorkflowRunDetailProjection> {
    return this.#control(runId, (signal) => this.#remote.cancelWorkflowRun({ runId }, signal));
  }

  async reconcileApply(runId: string): Promise<WorkflowRunDetailProjection> {
    return this.#control(runId, (signal) => this.#remote.reconcileWorkflowApply({ runId }, signal));
  }

  #synchronizeSession(): void {
    if (!this.#mounted) return;
    let nextSessionId: string | undefined;
    try {
      nextSessionId = this.#sessions.getCurrentSessionId();
    } catch (error) {
      this.#epoch += 1;
      this.#watchController?.abort();
      for (const controller of this.#actionControllers) controller.abort();
      for (const controller of this.#readControllers) controller.abort();
      this.#replace({ ...EMPTY_SNAPSHOT, phase: "unavailable", error: asStoreError(error) });
      return;
    }
    if (nextSessionId === this.#snapshot.sessionId) return;

    this.#epoch += 1;
    this.#watchController?.abort();
    for (const controller of this.#actionControllers) controller.abort();
    for (const controller of this.#readControllers) controller.abort();
    this.#watchController = undefined;
    if (nextSessionId === undefined) {
      this.#replace(EMPTY_SNAPSHOT);
      return;
    }

    const epoch = this.#epoch;
    const cursor = this.#cursors.get(nextSessionId) ?? 0;
    this.#replace({
      sessionId: nextSessionId,
      phase: "loading",
      runs: Object.freeze([]),
      pendingRunIds: Object.freeze([]),
      cursor,
      error: undefined,
    });
    void this.#activate(nextSessionId, epoch);
  }

  async #activate(sessionId: string, epoch: number): Promise<void> {
    await this.#fetch(sessionId, epoch);
    if (!this.#isCurrent(epoch, sessionId)) return;
    this.#watchController = new AbortController();
    await this.#watch(sessionId, epoch, this.#watchController.signal);
  }

  async #fetch(sessionId: string, epoch: number): Promise<void> {
    const controller = new AbortController();
    this.#readControllers.add(controller);
    try {
      const runs = this.#validateRuns(await this.#remote.listWorkflowRuns({ sessionId }, controller.signal));
      if (!this.#isCurrent(epoch, sessionId)) return;
      this.#replace({
        ...this.#snapshot,
        phase: "ready",
        runs: this.#forSession(runs, sessionId),
        error: undefined,
      });
    } catch (error) {
      if (!this.#isCurrent(epoch, sessionId) || aborted(error)) return;
      this.#replace({ ...this.#snapshot, phase: "error", error: asStoreError(error) });
    } finally {
      this.#readControllers.delete(controller);
    }
  }

  async #watch(sessionId: string, epoch: number, signal: AbortSignal): Promise<void> {
    let retries = 0;
    while (this.#isCurrent(epoch, sessionId) && !signal.aborted) {
      const cursor = this.#cursors.get(sessionId) ?? 0;
      try {
        const result = await this.#remote.watchWorkflowRuns({
          sessionId,
          afterSequence: cursor,
          timeoutMs: this.#watchTimeoutMs,
        }, signal);
        if (!this.#isCurrent(epoch, sessionId) || signal.aborted) return;
        const nextCursor = Math.max(cursor, result.sequence);
        this.#cursors.set(sessionId, nextCursor);
        // A lower server cursor is stale relative to this session's reconnect cursor;
        // retain the last authority rather than moving either cursor or projections back.
        if (result.sequence < cursor) continue;
        const runs = this.#validateRuns(result.runs);
        this.#replace({
          ...this.#snapshot,
          phase: "ready",
          cursor: nextCursor,
          runs: this.#forSession(runs, sessionId),
          error: undefined,
        });
        retries = 0;
      } catch (error) {
        if (!this.#isCurrent(epoch, sessionId) || aborted(error, signal)) return;
        if (!isTransportFailure(error) || retries >= this.#retryDelaysMs.length) {
          this.#replace({ ...this.#snapshot, phase: "error", error: asStoreError(error) });
          return;
        }
        const retryDelay = this.#retryDelaysMs[retries] ?? 0;
        retries += 1;
        try {
          await this.#wait(retryDelay, signal);
        } catch (waitError) {
          if (!aborted(waitError, signal)) {
            this.#replace({ ...this.#snapshot, phase: "error", error: asStoreError(waitError) });
          }
          return;
        }
      }
    }
  }

  async #control(
    runId: string,
    action: (signal: AbortSignal) => Promise<WorkflowRunDetailProjection>,
  ): Promise<WorkflowRunDetailProjection> {
    const sessionId = this.#currentSessionId();
    if (sessionId === undefined) throw new WorkflowStoreUnavailableError();
    const epoch = this.#epoch;
    const controller = new AbortController();
    this.#actionControllers.add(controller);
    this.#setPending(runId, true);
    try {
      const detail = this.#validateDetail(await action(controller.signal));
      if (!this.#isCurrent(epoch, sessionId) || detail.sessionId !== sessionId) {
        throw new WorkflowStoreError("workflow_session_changed", "当前对话已切换，未采用过期工作流结果");
      }
      // The action result is intentionally not installed as status truth. Fetch the
      // durable session projection immediately; this also handles concurrent changes.
      await this.#fetch(sessionId, epoch);
      return detail;
    } finally {
      this.#actionControllers.delete(controller);
      if (this.#isCurrent(epoch, sessionId)) this.#setPending(runId, false);
    }
  }

  #currentSessionId(): string | undefined {
    try {
      return this.#sessions.getCurrentSessionId();
    } catch (error) {
      throw error instanceof WorkflowStoreError
        ? error
        : new WorkflowStoreUnavailableError(error instanceof Error ? error.message : undefined);
    }
  }

  #isCurrent(epoch: number, sessionId: string): boolean {
    return this.#mounted && this.#epoch === epoch && this.#snapshot.sessionId === sessionId;
  }

  #setPending(runId: string, pending: boolean): void {
    const current = new Set(this.#snapshot.pendingRunIds);
    if (pending) current.add(runId);
    else current.delete(runId);
    this.#replace({ ...this.#snapshot, pendingRunIds: Object.freeze([...current]) });
  }

  #validateRuns(value: unknown): WorkflowRunProjection[] {
    const parsed = WorkflowRunProjectionSchema.array().safeParse(value);
    if (!parsed.success) {
      throw new WorkflowStoreError("invalid_projection", "服务返回了无效的章节工作流投影", { cause: parsed.error });
    }
    return parsed.data;
  }

  #validateDetail(value: unknown): WorkflowRunDetailProjection {
    const parsed = WorkflowRunDetailProjectionSchema.safeParse(value);
    if (!parsed.success) {
      throw new WorkflowStoreError("invalid_projection", "服务返回了无效的章节工作流详情", { cause: parsed.error });
    }
    return parsed.data;
  }

  #forSession(runs: readonly WorkflowRunProjection[], sessionId: string): readonly WorkflowRunProjection[] {
    return Object.freeze(runs.filter((run) => run.sessionId === sessionId));
  }

  #replace(next: WorkflowRunsSnapshot): void {
    this.#snapshot = Object.freeze(next);
    for (const listener of this.#listeners) listener();
  }
}
