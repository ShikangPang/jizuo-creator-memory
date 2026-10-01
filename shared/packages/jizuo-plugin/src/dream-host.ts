import { rm } from "node:fs/promises";
import { DailyTokenBudget, DreamChapterStateSchema, MemoryRepository, type DreamCommand, type DreamStatus, type DreamWorkReport, type DreamChapterState, type DreamChapterProgress, type DreamChapterActivity, type DreamActivityPhase, type DreamChapterConversations } from "@jizuo/memory-domain";
import type { ChapterDocument } from "@jizuo/contracts";
import type { JizuoService } from "./service.ts";
import { DreamEvidenceError, type DreamModelFactory, type DreamExtraction } from "./dream-model.ts";
import { DreamCheckpointError, dreamCheckpointPath, readDreamCheckpoint, writeDreamJson, type DreamCheckpoint } from "./dream-checkpoint.ts";
import { readDreamChapterSnapshot, type DreamChapterSnapshot } from "./dream-report.ts";
import { mapTypedChapterMemoryFacts } from "./workflow/nodeExecutors.ts";
import { describeDreamError, DreamProcessingError, DreamCapacityError } from "./dream-errors.ts";
import { DreamConversationRecorder, readDreamConversations } from "./dream-conversation.ts";


/** One serial worker per application. Chapter/hash checkpoints survive budget pauses and reopening. */
export class DreamMemoryHost {
  private timer: ReturnType<typeof setInterval> | undefined;
  private controller: AbortController | undefined;
  private activeWork: string | undefined;
  private activeManual = false;
  private activeChapter: { id: string; revision: string } | undefined;
  private liveActivity: DreamChapterActivity | undefined;
  private liveConversation: DreamConversationRecorder | undefined;
  private readonly snapshots = new Map<string, { at: number; pending: boolean; promise: Promise<DreamChapterSnapshot[]> }>();
  private flight: Promise<void> | undefined;
  private processing: Promise<boolean> | undefined;
  private readonly mutations = new Set<string>();
  private closed = false;
  private readonly states = new Map<string, Partial<DreamStatus>>();
  private readonly activity = new Map<string, number>();
  private readonly observed = new Map<string, { hash: string; at: number }>();
  private readonly retryAfter = new Map<string, number>();
  private readonly retryRequested = new Set<string>();
  private readonly forced = new Set<string>();
  private readonly now: () => Date;
  constructor(private readonly service: JizuoService, private readonly models: DreamModelFactory, options: { now?: () => Date; quietMs?: number; getBusyChapterIds?: (workId: string) => ReadonlySet<string>; isChapterAvailable?: (workId: string, chapterId: string) => Promise<boolean>; budgetFactory?: (workRoot: string) => Pick<DailyTokenBudget, 'get' | 'reserve' | 'settle'> } = {}) {
    this.budgetFactory = options.budgetFactory ?? ((root) => new DailyTokenBudget(root, this.now));
    this.now = options.now ?? (() => new Date());
    this.quietMs = options.quietMs ?? 30_000;
    this.getBusyChapterIds = options.getBusyChapterIds ?? (() => new Set());
    this.isChapterAvailable = options.isChapterAvailable ?? (async () => true);
  }
  private readonly isChapterAvailable: (workId: string, chapterId: string) => Promise<boolean>;
  private readonly budgetFactory: (workRoot: string) => Pick<DailyTokenBudget, 'get' | 'reserve' | 'settle'>;
  private readonly quietMs: number;
  private readonly getBusyChapterIds: (workId: string) => ReadonlySet<string>;
  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.tick(); }, 15_000);
    this.timer.unref?.();
    void this.tick();
  }
  close(): void {
    this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    this.controller?.abort();
  }
  async drain(): Promise<void> { await Promise.allSettled([this.flight, this.processing]); }
  touch(workId: string, chapterId?: string): void {
    // Legacy work-only activity cannot identify a chapter to defer.
    if (!chapterId) return;
    this.activity.set(`${workId}:${chapterId}`, this.now().getTime());
    if (this.activeWork === workId && this.activeChapter?.id === chapterId && !this.activeManual) this.controller?.abort();
  }
  invalidate(workId: string): void { this.snapshots.delete(workId); }
  chapterAvailabilityChanged(workId: string): void {
    if (this.activeWork === workId && this.activeChapter && this.getBusyChapterIds(workId).has(this.activeChapter.id)) this.controller?.abort();
  }
  settingsChanged(workId: string): void {
    this.invalidate(workId);
    this.states.delete(workId);
    this.forced.delete(workId);
    if (this.activeWork === workId) this.controller?.abort();
    this.retryAfter.delete(workId);
    this.retryRequested.add(workId);
  }
  async withWorkMutation<T>(workId: string, operation: () => Promise<T>): Promise<T> {
    this.mutations.add(workId);
    try {
      if (this.activeWork === workId) {
        this.controller?.abort();
        await this.processing?.catch(() => {});
      }
      return await operation();
    } finally { this.mutations.delete(workId); this.states.delete(workId); this.invalidate(workId); }
  }

  private snapshot(workId: string): Promise<DreamChapterSnapshot[]> {
    const cached = this.snapshots.get(workId);
    if (cached && (cached.pending || Date.now() - cached.at < 30_000)) return cached.promise;
    const promise = readDreamChapterSnapshot(this.service, workId);
    const entry = { at: Date.now(), pending: true, promise };
    this.snapshots.set(workId, entry);
    void promise.then(() => { entry.pending = false; entry.at = Date.now(); }, () => {});
    void promise.catch(() => { if (this.snapshots.get(workId)?.promise === promise) this.snapshots.delete(workId); });
    return promise;
  }
  private chapterRows(workId: string, rows: DreamChapterSnapshot[], manual: boolean): DreamChapterSnapshot[] {
    const busy = this.getBusyChapterIds(workId);
    return rows.map((row) => {
      if (!["pending", "partial", "failed", "empty", "editing"].includes(row.progress.state)) return row;
      if (busy.has(row.document.id)) return { ...row, progress: { ...row.progress, state: "busy" } };
      if (!manual && this.recentChapterActivity(workId, row.document.id)) return { ...row, progress: { ...row.progress, state: "editing" } };
      return row;
    });
  }
  private recentChapterActivity(workId: string, chapterId: string): boolean {
    return (this.activity.get(`${workId}:${chapterId}`) ?? -Infinity) + this.quietMs > this.now().getTime();
  }
  private updateActivity(phase: DreamActivityPhase, update: Partial<Pick<DreamChapterActivity, "part" | "from" | "to" | "receivedChars" | "modelSelection">> = {}): void {
    if (!this.controller || this.controller.signal.aborted) return;
    const at = this.now().toISOString();
    const previous = this.liveActivity;
    const part = update.part ?? previous?.part ?? 1;
    const changed = previous?.phase !== phase || previous.part !== part;
    this.liveActivity = { processingMode: "chapter", startedAt: previous?.startedAt ?? at, from: 0, to: 0, receivedChars: 0, ...previous, ...update, phase, part,
      phaseStartedAt: changed ? at : previous.phaseStartedAt, lastActivityAt: at,
      events: changed ? [...previous?.events ?? [], { phase, part, at }].slice(-12) : previous.events };
  }
  async status(workId: string): Promise<DreamStatus> { return (await this.report(workId)).status; }
  async conversations(target: { workId: string; volumeId: string; chapterId: string }): Promise<DreamChapterConversations> {
    const chapter = await this.service.readChapter(target);
    const { path } = await this.service.resolveWorkPath(target.workId);
    const directory = `${dreamCheckpointPath(path, chapter.id, chapter.revisionToken)}.conversations`;
    const live = this.activeWork === target.workId && this.activeChapter?.id === chapter.id && this.activeChapter.revision === chapter.revisionToken ? this.liveConversation?.value : undefined;
    return { chapterId: chapter.id, conversations: await readDreamConversations(directory, live) };
  }
  async report(workId: string): Promise<DreamWorkReport> {
    const [settings, savedRows, location] = await Promise.all([this.service.getDreamSettings(workId), this.snapshot(workId), this.service.resolveWorkPath(workId)]);
    const rows = this.chapterRows(workId, savedRows, this.forced.has(workId) || (this.activeWork === workId && this.activeManual));
    const budget = await this.budgetFactory(location.path).get();
    const chapters: DreamChapterProgress[] = rows.map(({ document, progress }) => this.controller && !this.controller.signal.aborted && this.activeWork === workId && this.activeChapter?.id === document.id
      && this.activeChapter.revision === document.revisionToken && this.states.get(workId)?.state === "running"
      && ["pending", "partial", "failed", "capacity_exceeded", "capacity_unknown"].includes(progress.state) ? (() => {
        const { lastError: _error, nextRetryAt: _retry, ...saved } = progress;
        return { ...saved, state: "running" as const };
      })() : progress);
    const counts = Object.fromEntries(DreamChapterStateSchema.options.map((state) => [state, 0])) as Record<DreamChapterState, number>;
    chapters.forEach((chapter) => { counts[chapter.state]++; });
    const cached = this.states.get(workId) ?? {};
    const paused = settings.paused || (settings.skipUntil !== undefined && Date.parse(settings.skipUntil) > this.now().getTime());
    const failedChapters = counts.failed + counts.capacity_exceeded + counts.capacity_unknown;
    let state: DreamStatus["state"] = !settings.enabled ? "disabled" : paused ? "paused" : cached.state ?? (failedChapters > 0 ? "error" : "waiting");
    if (state === "waiting" && failedChapters > 0 && counts.pending + counts.partial + counts.running === 0) state = "error";
    let lastError = cached.lastError ?? chapters.find((item) => item.lastError)?.lastError;
    if (settings.enabled && !paused) {
      if (!settings.modelSelection) { state = "needs_model"; lastError = "请为当前作品选择梦境模型"; }
      else {
        try {
          const model = await this.models.prepare(settings.modelSelection);
          const next = rows.find((row) => ["pending", "partial", "failed", "capacity_exceeded", "capacity_unknown"].includes(row.progress.state));
          if (state !== "running" && next && !next.progress.lastError) {
            const body = next.document.content;
            const capacity = model.capacity?.(body);
            if (next.progress.processedChars < body.length && (!capacity || capacity.state === "fits") && model.reservation(body) > settings.dailyTokenLimit - budget.usedTokens - budget.reservedTokens) state = "paused_budget";
          }
        } catch { state = "needs_model"; lastError = "所选梦境模型不可用，请重新选择服务方和模型"; }
      }
    }
    const pendingChapters = counts.pending + counts.partial + counts.running + counts.failed + counts.busy;
    let waitingReason: string | undefined;
    if (state === "waiting") {
      if (pendingChapters === 0) {
        waitingReason = counts.editing > 0 ? "剩余章节正在编辑或有未保存正文，结束编辑后将继续整理。"
          : counts.awaiting_review > 0 ? "可处理章节已整理，待确认候选需要审核，不会重复提取。"
          : "目前没有需要补齐记忆的章节；已入图、已拒绝或无可提取记忆的章节会跳过。";
      } else if (this.mutations.has(workId)) waitingReason = "作品目录正在更新，完成后将继续整理。";
      else if (counts.busy > 0 && counts.pending + counts.partial + counts.failed === 0) waitingReason = "剩余章节正由对话中的创作任务处理，结束后将继续整理。";
      else if (this.activeWork && this.activeWork !== workId) waitingReason = "正在整理其他作品，本作品正在排队。";
      else if (this.forced.has(workId)) waitingReason = "已收到立即整理请求，正在准备待处理章节。";
      else waitingReason = "等待章节保存稳定后自动整理，也可以点击立即整理。";
    }
    const status: DreamStatus = { state, pendingChapters,
      completedChapters: counts.graphed + counts.graph_outdated, usedTokens: budget.usedTokens, reservedTokens: budget.reservedTokens,
      dailyTokenLimit: settings.dailyTokenLimit, ...(cached.currentChapter ? { currentChapter: cached.currentChapter } : {}), ...(lastError ? { lastError } : {}), ...(waitingReason ? { waitingReason } : {}) };
    const active = this.controller && !this.controller.signal.aborted && this.activeWork === workId && state === "running";
    return { workId, generatedAt: this.now().toISOString(), status, totalChapters: chapters.length, counts, chapters: chapters.map((chapter) => {
      if (active && chapter.state === "running" && chapter.chapterId === this.activeChapter?.id && this.liveActivity) {
        return { ...chapter, activity: structuredClone(this.liveActivity) };
      }
      if (chapter.state === "busy") return { ...chapter, waitingReason: "对话正在处理本章，结束后再整理。" };
      if (chapter.state === "editing") return { ...chapter, waitingReason: "等待本章保存稳定后整理。" };
      if (!["pending", "partial"].includes(chapter.state)) return chapter;
      const reason = state === "disabled" ? "此作品的梦境记忆尚未开启。"
        : state === "paused" ? "整理已暂停，继续后处理本章。"
        : state === "paused_budget" ? "今日剩余额度不足，额度恢复后继续。"
        : state === "needs_model" ? "等待选择可用的梦境模型。"
        : active && cached.currentChapter ? `排队中，当前正在整理「${cached.currentChapter}」。`
        : state === "error" ? "作品整理暂时出错，等待重试。"
        : waitingReason;
      return reason ? { ...chapter, waitingReason: reason } : chapter;
    }) };
  }
  async command(command: DreamCommand, workId?: string): Promise<{ saved: true }> {
    if (command === "stop_before_exit") { this.close(); return { saved: true }; }
    const works = workId ? [{ id: workId }] : await this.service.listWorks();
    for (const work of works) {
      const settings = await this.service.getDreamSettings(work.id);
      if (!settings.enabled) continue;
      const { skipUntil: _skip, ...base } = settings;
      if (command === "skip_tonight") {
        const until = this.now(); until.setDate(until.getDate() + 1); until.setHours(6, 0, 0, 0);
        await this.service.saveDreamSettings({ workId: work.id, settings: { ...base, paused: false, skipUntil: until.toISOString() } });
      } else {
        await this.service.saveDreamSettings({ workId: work.id, settings: { ...base, paused: command === "pause" } });
      }
      if (command === "run_now" || command === "resume") {
        this.retryAfter.delete(work.id); this.states.delete(work.id); this.forced.add(work.id); this.retryRequested.add(work.id);
      }
    }
    if (command === "run_now" || command === "resume") {
      // A cancellation may still be settling its usage. Start after that turn finishes.
      void (this.flight ?? Promise.resolve()).then(() => this.tick());
    }
    return { saved: true };
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.flight) return this.flight;
    this.flight = this.scan().catch(() => {
      // Unavailable roots are retried on the next scan; per-work failures are surfaced below.
    }).finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private async scan(): Promise<void> {
    for (const work of await this.service.listWorks()) {
      if (this.closed) return;
      const forced = this.forced.has(work.id);
      try {
        const settings = await this.service.getDreamSettings(work.id);
        if (!settings.enabled || settings.paused || (settings.skipUntil && Date.parse(settings.skipUntil) > this.now().getTime())) continue;
        if ((this.retryAfter.get(work.id) ?? 0) > this.now().getTime()) continue;
        if (this.mutations.has(work.id)) continue;
        const { path } = await this.service.resolveWorkPath(work.id);
        if (!settings.modelSelection) { this.states.set(work.id, { state: "needs_model" }); continue; }
        try { await this.models.prepare(settings.modelSelection); }
        catch { this.states.set(work.id, { state: "needs_model" }); continue; }
        this.invalidate(work.id);
        const rows = this.chapterRows(work.id, await this.snapshot(work.id), forced);
        const retryFailed = this.retryRequested.delete(work.id);
        const chapters = rows.filter((row) => ["pending", "partial", "failed", "capacity_exceeded", "capacity_unknown"].includes(row.progress.state));
        // Provider failures affect the whole work, including after reopening.
        const providerWait = rows.find((row) => row.failureScope === "work" && Date.parse(row.progress.nextRetryAt ?? "") > this.now().getTime());
        if (!retryFailed && providerWait) {
          this.retryAfter.set(work.id, Date.parse(providerWait.progress.nextRetryAt!));
          this.states.set(work.id, { state: "error", ...(providerWait.progress.lastError ? { lastError: providerWait.progress.lastError } : {}) });
          continue;
        }
        let deferred = rows.some((row) => ["busy", "editing"].includes(row.progress.state));
        this.states.set(work.id, { state: "waiting" });
        for (const row of chapters) {
          const chapter = row.document;
          if (!retryFailed && row.failureScope === "chapter") { deferred = true; continue; }
          if (!retryFailed && Date.parse(row.progress.nextRetryAt ?? "") > this.now().getTime()) { deferred = true; continue; }
          const key = `${work.id}:${chapter.id}`;
          const old = this.observed.get(key);
          if (!old || old.hash !== chapter.revisionToken) this.observed.set(key, { hash: chapter.revisionToken, at: this.now().getTime() });
          if (!forced && (this.observed.get(key)?.at ?? 0) + this.quietMs > this.now().getTime()) { deferred = true; continue; }
          if (!await this.workAllowed(work.id)) break;
          if (!await this.allowed(work.id, chapter.id, forced)) { deferred = true; continue; }
          this.processing = this.process(path, chapter, forced);
          let done: boolean;
          try { done = await this.processing; }
          catch (error) {
            const failure = describeDreamError(error);
            if (failure.scope === "work") throw failure;
            deferred = true;
            this.states.set(work.id, { state: "error", lastError: failure.message });
            continue;
          } finally { this.processing = undefined; }
          if (!done) {
            deferred = true;
            if (this.states.get(work.id)?.state === "paused_budget" || !await this.workAllowed(work.id)) break;
            // Only this chapter was changed or taken over. Other chapters can proceed.
            continue;
          }
          this.invalidate(work.id);
          this.states.set(work.id, { state: "waiting" });
        }
        if (!deferred) this.forced.delete(work.id);
      } catch (error) {
        const failure = describeDreamError(error);
        this.states.set(work.id, { ...this.states.get(work.id), state: "error", lastError: failure.message });
        this.retryAfter.set(work.id, this.now().getTime() + failure.retryAfterMs);
      }
    }
  }
  private async workAllowed(workId: string): Promise<boolean> {
    if (this.closed || this.mutations.has(workId)) return false;
    const settings = await this.service.getDreamSettings(workId);
    return settings.enabled && settings.modelSelection !== undefined && !settings.paused && (!settings.skipUntil || Date.parse(settings.skipUntil) <= this.now().getTime());
  }
  private async allowed(workId: string, chapterId: string, manual = false): Promise<boolean> {
    if (!await this.workAllowed(workId)) return false;
    return !this.getBusyChapterIds(workId).has(chapterId) && (manual || !this.recentChapterActivity(workId, chapterId))
      && await this.isChapterAvailable(workId, chapterId);
  }
  private async process(workRoot: string, chapter: ChapterDocument, manual: boolean): Promise<boolean> {
    const controller = new AbortController(); this.controller = controller; this.activeWork = chapter.workId; this.activeChapter = { id: chapter.id, revision: chapter.revisionToken };
    this.activeManual = manual;
    this.liveActivity = undefined;
    this.updateActivity("preparing");
    this.states.set(chapter.workId, { ...this.states.get(chapter.workId), state: "running", currentChapter: chapter.title });
    const budget = this.budgetFactory(workRoot);
    const path = dreamCheckpointPath(workRoot, chapter.id, chapter.revisionToken);
    let checkpoint: DreamCheckpoint = { version: 3, offset: 0, output: { facts: [] }, segments: [] };
    let conversation: DreamConversationRecorder | undefined;
    try {
      const settings = await this.service.getDreamSettings(chapter.workId);
      const selection = settings.modelSelection;
      if (!selection) return false;
      this.updateActivity("preparing", { modelSelection: selection });
      const model = await this.models.prepare(selection);
      controller.signal.throwIfAborted();
      const repository = new MemoryRepository({ workRoot });
      const coverage = (await repository.getChapterMemoryIndex(chapter.workId, true)).get(chapter.id);
      if ((coverage?.formalEpisodeKeys.size ?? 0) > 0 || coverage?.attempts.has(repository.episodeKey(chapter.id, chapter.revisionToken))) return true;
      const saved = await readDreamCheckpoint(path, chapter.content.length);
      if (saved?.version === 3 && saved.offset === chapter.content.length) checkpoint = saved;
      await rm(`${path}.failure`, { force: true });
      if (checkpoint.offset < chapter.content.length) {
        const body = chapter.content;
        let output: DreamExtraction | undefined;
        let correction: DreamEvidenceError | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          controller.signal.throwIfAborted();
          if (!await this.allowed(chapter.workId, chapter.id, manual)) return false;
          const end = body.length;
          const from = 0;
          this.updateActivity("reading", { part: 1, from, to: end, receivedChars: 0 });
          const capacity = model.capacity?.(body, correction);
          if (capacity && capacity.state !== "fits") throw new DreamCapacityError(capacity.state);
          const reserved = model.reservation(body, correction);
          const settings = await this.service.getDreamSettings(chapter.workId);
          const date = (await budget.get()).date;
          if (!await budget.reserve(reserved, settings.dailyTokenLimit, date)) {
            this.states.set(chapter.workId, { ...this.states.get(chapter.workId), state: "paused_budget" }); return false;
          }
          // Reserving can yield to a user action or another writer. No charge if
          // the request is cancelled/skipped before it actually starts.
          let actual = 0;
          try {
            const current = await this.service.readChapter({ workId: chapter.workId, volumeId: chapter.volumeId, chapterId: chapter.id });
            if (current.revisionToken !== chapter.revisionToken || current.liveDraft !== undefined) return false;
            const latest = await this.service.getDreamSettings(chapter.workId);
            if (latest.modelSelection?.provider !== selection.provider || latest.modelSelection.model !== selection.model) return false;
            const coverage = (await repository.getChapterMemoryIndex(chapter.workId, true)).get(chapter.id);
            if ((coverage?.formalEpisodeKeys.size ?? 0) > 0 || coverage?.attempts.has(repository.episodeKey(chapter.id, chapter.revisionToken))) return true;
            await this.models.prepare(selection);
            if (!await this.allowed(chapter.workId, chapter.id, manual)) return false;
            controller.signal.throwIfAborted();
            conversation = new DreamConversationRecorder(`${path}.conversations`, { part: 1, from, to: end, modelSelection: selection, content: body }, this.now, async () => {
              const location = await this.service.resolveWorkPath(chapter.workId).catch(() => null);
              return location ? `${dreamCheckpointPath(location.path, chapter.id, chapter.revisionToken)}.conversations` : null;
            });
            conversation.value.processingMode = "chapter";
            this.liveConversation = conversation;
            await conversation.flush();
            controller.signal.throwIfAborted();
            if (!await this.allowed(chapter.workId, chapter.id, manual)) return false;
            actual = reserved;
            this.updateActivity("waiting_model");
            output = await model.extract(body, controller.signal, (tokens) => { actual = tokens; conversation?.usage(tokens); }, ({ phase, receivedChars }) => {
              if (this.controller === controller) this.updateActivity(phase, { receivedChars });
            }, (detail) => { conversation?.detail(detail); }, correction);
          } catch (error) {
            if (!(error instanceof DreamEvidenceError) || attempt > 0) throw error;
            correction = error;
            await conversation?.finish("failed", error.message);
            conversation = undefined; this.liveConversation = undefined;
          }
          finally {
            // If an external rename moved the ledger, settle at its current location.
            // A removed work keeps its reservation; never recreate a deleted directory.
            const location = await this.service.resolveWorkPath(chapter.workId).catch(() => null);
            if (location) await this.budgetFactory(location.path).settle(reserved, actual, date);
          }
          if (output) break;
        }
        controller.signal.throwIfAborted();
        if (!output) throw new DreamProcessingError("本章证据修正未完成。", "chapter");
        this.updateActivity("saving_segment");
        if ((await this.service.resolveWorkPath(chapter.workId)).path !== workRoot) return false;
        if (output.facts.length + (output.inferences?.length ?? 0) > 256) throw new DreamProcessingError("本章提取的记忆超过容量，请调整模型后重试。", "chapter");
        const updatedAt = this.now().toISOString();
        checkpoint = { version: 3, offset: body.length, output, updatedAt,
          segments: [{ from: 0, to: body.length, modelSelection: selection, completedAt: updatedAt }] };
        await writeDreamJson(path, checkpoint);
        await conversation?.finish("completed"); conversation = undefined; this.liveConversation = undefined;
        this.invalidate(chapter.workId);
      }
      controller.signal.throwIfAborted();
      this.updateActivity("saving_memory", { part: 1 });
      if (!await this.allowed(chapter.workId, chapter.id, manual)) return false;
      const current = await this.service.readChapter({ workId: chapter.workId, volumeId: chapter.volumeId, chapterId: chapter.id });
      if (current.revisionToken !== chapter.revisionToken || current.liveDraft !== undefined) return false;
      const candidate = mapTypedChapterMemoryFacts({ workId: chapter.workId, volumeId: chapter.volumeId, chapterId: chapter.id,
        chapterNumber: chapter.order, appliedRevision: chapter.revisionToken }, { facts: [...checkpoint.output.facts, ...checkpoint.output.inferences ?? []] }, 256);
      // A chapter containing uncertain claims stays entirely in review, so accepting it
      // is one explicit operation with all evidence visible to the author.
      const uncertain = (checkpoint.output.inferences?.length ?? 0) > 0;
      candidate.confirmation = uncertain ? "suggested" : "confirmed";
      if (uncertain) {
        candidate.states = candidate.states.map((state) => ({ ...state, confirmed: false }));
        candidate.edges = candidate.edges.map((edge) => ({ ...edge, confirmed: false }));
      }
      await this.service.saveDreamChapterMemory({ volumeId: chapter.volumeId, candidate }, selection, controller.signal, async () => {
        if (!await this.allowed(chapter.workId, chapter.id, manual)) throw new DOMException("章节正在由对话处理或编辑", "AbortError");
      });
      return true;
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      if (conversation) await conversation.finish(cancelled ? "cancelled" : "failed", cancelled ? "本次请求已取消，已保存的整章结果会保留。" : describeDreamError(error).message).catch(() => {});
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) { this.states.set(chapter.workId, { ...this.states.get(chapter.workId), state: "waiting" }); return false; }
      const failure = error instanceof DreamCheckpointError ? new DreamProcessingError(error.message, "chapter") : describeDreamError(error);
      const location = await this.service.resolveWorkPath(chapter.workId).catch(() => null);
      if (location?.path === workRoot) await writeDreamJson(`${path}.failure`, { message: failure.message, scope: failure.scope, ...(failure instanceof DreamCapacityError ? { capacityState: failure.capacityState } : {}),
        updatedAt: this.now().toISOString(), retryAt: new Date(this.now().getTime() + failure.retryAfterMs).toISOString() }).catch(() => {});
      throw failure;
    } finally {
      // Early returns (for example a moved work) also close the request record.
      if (conversation?.value.state === "running") await conversation.finish("cancelled").catch(() => {});
      this.invalidate(chapter.workId);
      const state = this.states.get(chapter.workId);
      if (state?.state === "running") { const { currentChapter: _current, ...rest } = state; this.states.set(chapter.workId, { ...rest, state: "waiting" }); }
      if (this.controller === controller) { this.controller = undefined; this.activeWork = undefined; this.activeChapter = undefined; this.activeManual = false; this.liveActivity = undefined; this.liveConversation = undefined; }
    }
  }
}
