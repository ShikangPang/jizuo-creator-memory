import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { DreamChapterStateSchema, DailyTokenBudget, type DreamCommand, type DreamStatus, type DreamWorkReport, type DreamChapterConversations } from "@jizuo/memory-domain";
import { DreamIpcPeer, type DreamIpcTransport } from "./dream-ipc.ts";
import type { DreamModelCatalog } from "./dream-model-catalog.ts";
import type { JizuoService } from "./service.ts";

export interface DreamHostPort {
  start(): void; close(): void; touch(workId: string, chapterId?: string): void;
  invalidate(workId: string): void; settingsChanged(workId: string): void;
  withWorkMutation<T>(workId: string, operation: () => Promise<T>): Promise<T>;
  status(workId: string): Promise<DreamStatus>; report(workId: string): Promise<DreamWorkReport>;
  conversations(target: { workId: string; volumeId: string; chapterId: string }): Promise<DreamChapterConversations>;
  command(command: DreamCommand, workId?: string): Promise<{ saved: true }>;
}
interface Reservation { chapterId: string; workId: string; date: string; id: string }
interface Stream { iterator: AsyncIterator<StreamChunk>; controller: AbortController; reservation: Reservation; pulling: boolean }
export interface DreamProcessOptions {
  worksRoot: string; settingsRoot: string;
  getBusyChapterIds?: (workId: string) => ReadonlySet<string>;
  workerPath?: string;
}

/** Main process owns credentials, formal writes and request budgets. The child owns expensive reads/validation. */
export class DreamProcessHost implements DreamHostPort {
  private child: ChildProcess | undefined;
  private peer: DreamIpcPeer | undefined;
  private ready: Promise<DreamIpcPeer> | undefined;
  private stopped = false;
  private failures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private busyTimer: ReturnType<typeof setInterval> | undefined;
  private error: string | undefined;
  private readonly workErrors = new Map<string, string>();
  private readonly reports = new Map<string, DreamWorkReport>();
  private readonly reportFlights = new Map<string, Promise<DreamWorkReport>>();
  private readonly streams = new Map<string, Stream>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly recovered = new Map<string, Promise<void>>();
  private readonly workIds = new Set<string>();
  private readonly mutating = new Set<string>();
  private readonly mutationFlights = new Map<string, Promise<unknown>>();
  private readonly currentChapters = new Map<string, string>();
  private readonly writes = new Set<Promise<unknown>>();
  private recovery: Promise<void> = Promise.resolve();
  constructor(private readonly service: JizuoService, private readonly models: Pick<DreamModelCatalog, "describe" | "stream">, private readonly options: DreamProcessOptions) {}
  get processId(): number | undefined { return this.child?.pid; }
  start(): void {
    if (this.stopped) return;
    if (!this.busyTimer) { this.busyTimer = setInterval(() => this.publishBusy(), 250); this.busyTimer.unref(); }
    void this.connect().catch(() => {});
  }
  close(): void {
    if (this.stopped) return; this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.busyTimer) clearInterval(this.busyTimer);
    for (const stream of this.streams.values()) stream.controller.abort();
    this.peer?.event("shutdown");
    const child = this.child;
    if (child) { const kill = setTimeout(() => child.kill("SIGKILL"), 2000); kill.unref(); child.once("exit", () => clearTimeout(kill)); }
  }
  touch(workId: string, chapterId?: string): void { this.peer?.event("touch", { workId, chapterId }); }
  invalidate(workId: string): void { this.peer?.event("invalidate", { workId }); }
  settingsChanged(workId: string): void {
    this.abortWork(workId); this.peer?.event("settingsChanged", { workId });
  }
  async withWorkMutation<T>(workId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationFlights.get(workId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() => this.performMutation(workId, operation));
    this.mutationFlights.set(workId, result);
    try { return await result; } finally { if (this.mutationFlights.get(workId) === result) this.mutationFlights.delete(workId); }
  }
  private async performMutation<T>(workId: string, operation: () => Promise<T>): Promise<T> {
    this.mutating.add(workId); this.abortWork(workId);
    let peer: DreamIpcPeer | undefined;
    try {
      if (!this.stopped) { peer = await this.connect(); await peer.call("mutation.begin", { workId }); }
      return await operation();
    } finally { this.mutating.delete(workId); peer?.event("mutation.end", { workId }); this.invalidate(workId); }
  }
  async status(workId: string): Promise<DreamStatus> { return (await this.report(workId)).status; }
  async report(workId: string): Promise<DreamWorkReport> {
    this.workIds.add(workId); this.publishBusy();
    const cached = this.reports.get(workId);
    if (cached) {
      const error = this.error ?? this.workErrors.get(workId);
      if (!error) return cached;
      const chapters = cached.chapters.map((chapter) => {
        if (chapter.state !== "running") return chapter;
        const { activity: _activity, ...saved } = chapter;
        return { ...saved, state: "failed" as const, lastError: error };
      });
      return { ...cached, chapters, counts: { ...cached.counts, failed: cached.counts.failed + cached.counts.running, running: 0 },
        status: { ...cached.status, state: "error", lastError: error } };
    }
    let flight = this.reportFlights.get(workId);
    if (!flight) {
      flight = this.connect().then((peer) => peer.call<DreamWorkReport>("report", { workId })).then((report) => { this.reports.set(workId, report); return report; })
        .catch(async (error: unknown) => this.unavailableReport(workId, error));
      this.reportFlights.set(workId, flight);
      void flight.finally(() => this.reportFlights.delete(workId)).catch(() => {});
    }
    return flight;
  }
  async conversations(target: { workId: string; volumeId: string; chapterId: string }): Promise<DreamChapterConversations> {
    return (await this.connect()).call("conversations", target);
  }
  async command(command: DreamCommand, workId?: string): Promise<{ saved: true }> {
    if (command === "stop_before_exit") { this.close(); return { saved: true }; }
    if (command === "pause" || command === "skip_tonight") {
      if (workId) this.abortWork(workId); else for (const stream of this.streams.values()) stream.controller.abort();
    }
    this.failures = 0;
    const peer = await this.connect(); this.publishBusy();
    return peer.call("command", { command, workId });
  }
  private connect(): Promise<DreamIpcPeer> {
    if (this.stopped) return Promise.reject(new Error("梦境后台已关闭"));
    if (this.ready) return this.ready;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
    const run = async () => {
      await this.recovery;
      if (this.stopped) throw new Error("梦境后台已关闭");
      const child = fork(this.options.workerPath ?? fileURLToPath(import.meta.resolve("@jizuo/plugin/dream-worker")), [], {
        execPath: process.execPath, execArgv: dreamWorkerExecArgv(process.execArgv), stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced",
        env: { ...Object.fromEntries(["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "NODE_NO_WARNINGS"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])), JIZUO_DREAM_WORKER: "1" },
      });
      this.child = child;
      let diagnostic = "";
      child.stderr?.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString("utf8")).slice(-4000); });
      const peer = new DreamIpcPeer(child as DreamIpcTransport, (method, input, signal) => {
        const result = this.handle(method, input, signal);
        if (method.startsWith("budget.") || method === "commit") {
          this.writes.add(result); void result.finally(() => this.writes.delete(result)).catch(() => {});
        }
        return result;
      }, (method, value) => {
        if (child !== this.child) return;
        if (method === "report") { this.reports.set(value.workId, value); this.workErrors.delete(value.workId); this.error = undefined; }
        if (method === "reportError") this.workErrors.set(value.workId, value.message);
        if (method === "stream.close") this.closeStream(value.streamId);
      });
      this.peer = peer;
      let exited = false;
      const lost = () => { if (exited) return; exited = true; this.disconnected(child, peer, diagnostic); };
      child.once("exit", lost); child.once("error", lost);
      try {
        await peer.call("init", { worksRoot: this.options.worksRoot, settingsRoot: this.options.settingsRoot });
        this.error = undefined; this.publishBusy();
        for (const workId of this.workIds) void peer.call<DreamWorkReport>("report", { workId }).then((report) => this.reports.set(workId, report)).catch(() => {});
        return peer;
      } catch (error) { child.kill(); throw error; }
    };
    this.ready = run();
    return this.ready;
  }
  private disconnected(child: ChildProcess, peer: DreamIpcPeer, diagnostic: string): void {
    const cause = diagnostic.split("\n").find((line) => /Error(?:\s|:|\[)/.test(line));
    peer.close(new Error(cause ? `梦境后台加载失败：${cause}` : "梦境后台进程已断开")); if (this.child !== child) return;
    this.child = undefined; this.peer = undefined; this.ready = undefined;
    this.error = "梦境后台进程已中断，正在恢复；已保存的章节记忆会保留。";
    for (const stream of this.streams.values()) stream.controller.abort(); this.streams.clear();
    this.recovery = Promise.allSettled([...this.writes]).then(async () => {
      await Promise.allSettled([...this.reservations.values()].map(async (request) => {
        const budget = await this.budgetForWork(request.workId); await budget.settleRequest(request.id, undefined, request.date);
      }));
      this.reservations.clear();
    });
    if (!this.stopped && this.failures++ < 3) {
      this.restartTimer = setTimeout(() => { this.restartTimer = undefined; if (!this.ready) this.start(); }, 1000 * 2 ** (this.failures - 1)); this.restartTimer.unref();
    } else if (!this.stopped) this.error = "梦境后台多次启动失败，请点击立即整理重试或重新打开应用。";
  }
  private publishBusy(): void {
    if (!this.peer) return;
    const value = Object.fromEntries([...this.workIds].map((id) => [id, [...this.options.getBusyChapterIds?.(id) ?? []]]));
    this.peer.event("busy", value);
  }
  private abortWork(workId: string): void {
    for (const stream of this.streams.values()) if (stream.reservation.workId === workId) stream.controller.abort();
  }
  private closeStream(id: string): void {
    const stream = this.streams.get(id); if (!stream) return;
    this.streams.delete(id); stream.controller.abort(); void stream.iterator.return?.().catch(() => {});
  }
  private async budgetForWork(workId: string): Promise<DailyTokenBudget> {
    const location = await this.service.resolveWorkPath(workId);
    return new DailyTokenBudget(location.path, () => new Date());
  }
  private trackWrite<T>(write: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(write);
    this.writes.add(pending); void pending.finally(() => this.writes.delete(pending)).catch(() => {});
    return pending;
  }
  private async workForRoot(root: string): Promise<string> {
    for (const work of await this.service.listWorks()) {
      if (resolve((await this.service.resolveWorkPath(work.id)).path) === resolve(root)) { this.workIds.add(work.id); this.publishBusy(); return work.id; }
    }
    throw new Error("梦境作品目录已不存在");
  }
  private async handle(method: string, input: any, signal: AbortSignal): Promise<unknown> {
    if (method === "chapter.available") {
      this.currentChapters.set(input.workId, input.chapterId);
      return !this.mutating.has(input.workId) && !this.options.getBusyChapterIds?.(input.workId).has(input.chapterId);
    }
    if (method === "model.describe") return this.models.describe(input);
    if (method === "settings") return this.service.saveDreamSettings(input);
    if (method === "budget.get" || method === "budget.reserve") {
      const workId = await this.workForRoot(input.workRoot); const budget = await this.budgetForWork(workId);
      const key = workId;
      let recovery = this.recovered.get(key);
      if (!recovery) { recovery = budget.recoverRequests(); this.recovered.set(key, recovery); }
      await recovery;
      if (method === "budget.get") { const { requests: _requests, ...snapshot } = await budget.get(input.date); return snapshot; }
      const settings = await this.service.getDreamSettings(workId);
      if (!settings.enabled || settings.paused || this.mutating.has(workId)) return false;
      const chapterId = this.currentChapters.get(workId);
      if (!chapterId) throw new Error("梦境章节尚未检查占用状态");
      signal.throwIfAborted();
      const reserved = await budget.reserveRequest(input.id, input.tokens, Math.min(input.limit, settings.dailyTokenLimit), input.date);
      if (reserved) this.reservations.set(input.id, { id: input.id, workId, chapterId, date: input.date ?? new Date().toISOString().slice(0, 10) });
      return reserved;
    }
    if (method === "budget.settle") {
      const request = this.reservations.get(input.id); if (!request) throw new Error("梦境额度请求已失效");
      const result = await (await this.budgetForWork(request.workId)).settleRequest(request.id, input.actual, request.date);
      this.reservations.delete(request.id); return result;
    }
    if (method === "stream.open") {
      const reservation = this.reservations.get(input.reservationId); if (!reservation) throw new Error("模型请求尚未预留额度");
      const settings = await this.service.getDreamSettings(reservation.workId);
      if (!settings.enabled || settings.paused || this.mutating.has(reservation.workId) || this.options.getBusyChapterIds?.(reservation.workId).has(reservation.chapterId)
        || settings.modelSelection?.provider !== input.request.provider || settings.modelSelection?.model !== input.request.model) throw new DOMException("梦境设置已变化", "AbortError");
      await this.trackWrite(async () => (await this.budgetForWork(reservation.workId)).observeRequest(reservation.id, undefined, reservation.date));
      signal.throwIfAborted();
      const controller = new AbortController(); const id = randomUUID();
      const iterator = this.models.stream({ ...input.request, signal: controller.signal } as GenerateOptions)[Symbol.asyncIterator]();
      this.streams.set(id, { iterator, controller, reservation, pulling: false }); return id;
    }
    if (method === "stream.next") {
      const stream = this.streams.get(input.streamId); if (!stream) throw new Error("模型流已关闭");
      if (stream.pulling) throw new Error("模型流已有读取请求"); stream.pulling = true;
      const abort = () => stream.controller.abort(); signal.addEventListener("abort", abort, { once: true });
      try {
        const result = await stream.iterator.next();
        if (!result.done && result.value.type === "usage") {
          const usage = result.value.usage;
          await this.trackWrite(async () => (await this.budgetForWork(stream.reservation.workId)).observeRequest(stream.reservation.id,
            Math.ceil(usage.totalTokens ?? usage.inputTokens + usage.outputTokens), stream.reservation.date));
        }
        if (result.done) this.closeStream(input.streamId); return result;
      } finally { stream.pulling = false; signal.removeEventListener("abort", abort); }
    }
    if (method === "commit") {
      const { selection, ...value } = input;
      return this.service.saveDreamChapterMemory(value, selection, signal, async () => {
        if (this.mutating.has(value.candidate.workId) || this.options.getBusyChapterIds?.(value.candidate.workId).has(value.candidate.chapterId)) {
          throw new DOMException("章节正在由对话处理或目录正在更新", "AbortError");
        }
        signal.throwIfAborted();
      });
    }
    throw new Error(`Unknown dream parent method: ${method}`);
  }
  private async unavailableReport(workId: string, error: unknown): Promise<DreamWorkReport> {
    const settings = await this.service.getDreamSettings(workId); const budget = await (await this.budgetForWork(workId)).get();
    return { workId, generatedAt: new Date().toISOString(), totalChapters: 0, chapters: [],
      counts: Object.fromEntries(DreamChapterStateSchema.options.map((state) => [state, 0])) as DreamWorkReport["counts"],
      status: { state: "error", pendingChapters: 0, completedChapters: 0, usedTokens: budget.usedTokens, reservedTokens: budget.reservedTokens,
        dailyTokenLimit: settings.dailyTokenLimit, lastError: error instanceof Error ? error.message : "梦境后台进程暂不可用" } };
  }
}

/** Preserve the packaged resolver after prebundling, without inheriting eval/debug/test flags. */
export function dreamWorkerExecArgv(args: readonly string[]): string[] {
  const flags: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--import" && args[index + 1]?.endsWith("/resolve-jizuo.mjs")) { flags.push(value, args[++index]!); }
    else if (value?.startsWith("--import=") && value.endsWith("/resolve-jizuo.mjs")) flags.push(value);
  }
  return flags;
}
