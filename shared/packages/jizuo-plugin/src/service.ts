import { ChatMediaRepository, isChatMediaSpace } from "./video/chat-media-repository.ts";
import type { DreamHostPort } from "./dream-process-host.ts";
import { AccountGateway, type AccountSummary } from "@jizuo/account-domain";
import { JizuoError, MoveToTrashInput, RenameWorkInput } from "@jizuo/contracts";
import {
  DreamSettingsRepository,
  MemoryEpisodeCandidate,
  MemoryQuery,
  MemoryQueryService,
  MemoryRepository,
  type DreamSettings,
  type DreamModelSelection,
  type MemorySuggestionDetail,
  type MemoryEpisodeCandidate as MemoryEpisodeCandidateInput,
  type MemoryQueryInput,
} from "@jizuo/memory-domain";
import {
  FileWorkLocationRegistry,
  MultiRootWorkDomainService,
  VideoRepository,
  type WorkDomainService,
  type WorkDomainOptions,
  type WorkLocations,
} from "@jizuo/work-domain";
import { join, resolve } from "node:path";

import { ModelSettingsRepository, type ByokSettings } from "./model-settings.ts";
import { defaultSettingsRoot } from "./config.ts";
import type { HostedModelRuntime } from "./nspox-runtime.ts";
import type { JizuoDomainNodeRegistry } from "./workflow/domainRegistry.ts";

export interface AccountGatewayPort {
  cancelBrowserLogin?(): void;
  beginBrowserLogin(): Promise<{ authorizationUrl: string; expiresAt: number }>;
  getAccountSummary(): Promise<AccountSummary>;
  logout(): Promise<void>;
}

export interface JizuoServiceOptions extends WorkDomainOptions {
  accountEnabled?: boolean;
  settingsRoot?: string;
  protectedWorkRoots?: readonly string[];
  accountGateway?: AccountGatewayPort;
  hostedModels?: HostedModelRuntime;
}

const NOOP_HOSTED_MODELS: HostedModelRuntime = {
  async sync() {},
  async select() {},
  async clear() {},
};

export class JizuoService extends MultiRootWorkDomainService {
  readonly video: VideoRepository;
  readonly chatMediaRepository: ChatMediaRepository;
  chatMedia?: import("./video/chat-media-service.ts").ChatMediaService;
  async resolveMediaPath(id: string): Promise<{path:string}> {
    return isChatMediaSpace(id) ? this.chatMediaRepository.resolveMediaPath(id) : this.resolveWorkPath(id);
  }
  videoProduction?: import("./video/production.ts").VideoProductionService;
  videoEditing?: import("./video/editing-service.ts").VideoEditingService;
  videoSpeech?: import("./video/speech.ts").VideoSpeechService;
  speechSettings?: import("./video/speech-settings.ts").SpeechSettingsRepository;
  videoBatch?: import("./video/batch.ts").VideoBatchGenerationService;
  videoAssets?: import("./video/assets.ts").LocalVideoAssets;
  videoMedia?: import("./video/media-service.ts").VideoMediaService;
  videoGeneration?: import("./video/generation.ts").VideoGenerationService;
  videoAuthoring?: import("./video/authoring.ts").VideoAuthoringService;
  mediaLibrary?: import("./video/media-library.ts").MediaLibraryService;
  mediaSettings?: import("./video/settings.ts").MediaSettingsRepository;
  private readonly memoryQueries = new Map<string, MemoryQueryService>();
  private readonly memoryRepositories = new Map<string, MemoryRepository>();
  dreamHost: DreamHostPort | undefined;
  private readonly dreamSettings = new Map<string, DreamSettingsRepository>();
  private readonly accountGateway: AccountGatewayPort;
  private readonly modelSettings: ModelSettingsRepository;
  private readonly hostedModels: HostedModelRuntime;
  private accountEnabled = true;
  private accountEpoch = 0;
  private accountModelsTail: Promise<unknown> = Promise.resolve();

  isAccountEnabled(): boolean { return this.accountEnabled; }
  async setAccountEnabled(enabled: boolean): Promise<void> {
    this.accountEnabled = enabled;
    this.accountEpoch++;
    if (!enabled) {
      this.accountGateway.cancelBrowserLogin?.();
      await this.updateAccountModels(() => this.hostedModels.clear());
    }
  }
  private requireAccount(epoch = this.accountEpoch): void {
    if (!this.accountEnabled || epoch !== this.accountEpoch) throw new JizuoError("denied", "请先启用即作账号插件");
  }
  private updateAccountModels<T>(action: () => Promise<T>): Promise<T> {
    const result = this.accountModelsTail.then(action);
    this.accountModelsTail = result.catch(() => {});
    return result;
  }
  private workflowDomainRegistry: JizuoDomainNodeRegistry | undefined;

  constructor(options: JizuoServiceOptions) {
    const {
      accountGateway,
      hostedModels,
      settingsRoot = defaultSettingsRoot(),
      protectedWorkRoots = [],
      worksRoot,
      idFactory,
      now,
    } = options;
    const resolvedSettingsRoot = resolve(settingsRoot);
    super({
      workLocations: new FileWorkLocationRegistry({
        configPath: join(resolvedSettingsRoot, "work-locations.json"),
        defaultRoot: worksRoot,
        protectedRoots: [resolvedSettingsRoot, ...protectedWorkRoots],
      }),
      videoWorkLocations: new FileWorkLocationRegistry({
        configPath: join(resolvedSettingsRoot, "video-work-locations.json"),
        defaultRoot: `${resolve(worksRoot)}-videos`,
        protectedRoots: [resolvedSettingsRoot, ...protectedWorkRoots],
      }),
      ...(idFactory === undefined ? {} : { idFactory }),
      ...(now === undefined ? {} : { now }),
    });
    this.accountGateway = accountGateway ?? new AccountGateway();
    this.hostedModels = hostedModels ?? NOOP_HOSTED_MODELS;
    this.accountEnabled = options.accountEnabled ?? true;
    this.modelSettings = new ModelSettingsRepository(resolvedSettingsRoot);
    this.chatMediaRepository = new ChatMediaRepository(resolvedSettingsRoot);
    this.video = new VideoRepository((workId) => this.resolveMediaPath(workId));
  }

  override async renameWork(input: Parameters<WorkDomainService["renameWork"]>[0]) {
    const parsed = RenameWorkInput.parse(input);
    const rename = async () => {
      const work = await super.renameWork(parsed);
      this.clearMemoryServices(work.id);
      return work;
    };
    return this.dreamHost ? this.dreamHost.withWorkMutation(parsed.workId, rename) : rename();
  }

  override async moveToTrash(input: Parameters<WorkDomainService["moveToTrash"]>[0]) {
    const parsed = MoveToTrashInput.parse(input);
    const remove = async () => {
      const entry = await super.moveToTrash(parsed);
      if (entry.kind === "work") this.clearMemoryServices(entry.workId);
      return entry;
    };
    return this.dreamHost ? this.dreamHost.withWorkMutation(parsed.workId, remove) : remove();
  }

  override async restoreFromTrash(input: Parameters<WorkDomainService["restoreFromTrash"]>[0]) {
    const entry = await super.restoreFromTrash(input);
    if (entry.kind === "work") this.clearMemoryServices(entry.workId);
    return entry;
  }

  async getAccountState() {
    this.requireAccount();
    const epoch = this.accountEpoch;
    try {
      const summary = await this.accountGateway.getAccountSummary();
      this.requireAccount(epoch);
      await this.updateAccountModels(() => { this.requireAccount(epoch); return this.hostedModels.sync(summary.modelEntitlements); });
      return { kind: "signed-in" as const, summary };
    } catch (error) {
      this.requireAccount(epoch);
      if (error instanceof JizuoError && error.code === "credential_required") {
        await this.updateAccountModels(() => this.hostedModels.clear());
        return { kind: "signed-out" as const };
      }
      if (error instanceof JizuoError && error.code === "runtime_unavailable") {
        return { kind: "offline" as const };
      }
      throw error;
    }
  }

  async beginBrowserLogin() {
    this.requireAccount();
    const epoch = this.accountEpoch;
    const login = await this.accountGateway.beginBrowserLogin();
    if (epoch !== this.accountEpoch || !this.accountEnabled) {
      this.accountGateway.cancelBrowserLogin?.();
      this.requireAccount(epoch);
    }
    return { authorizationUrl: login.authorizationUrl, expiresAt: login.expiresAt };
  }

  async logoutAccount(): Promise<{ signedOut: true }> {
    this.requireAccount();
    this.accountEpoch++;
    try {
      await this.accountGateway.logout();
    } finally {
      await this.updateAccountModels(() => this.hostedModels.clear());
    }
    return { signedOut: true };
  }

  getModelSettings() {
    return this.modelSettings.read();
  }

  async selectHostedModel(modelId: string): Promise<{ saved: true }> {
    this.requireAccount();
    const epoch = this.accountEpoch;
    const summary = await this.accountGateway.getAccountSummary();
    this.requireAccount(epoch);
    const allowed = summary.modelEntitlements.some((model) => model.id === modelId && model.enabled);
    if (!allowed) throw new JizuoError("denied", "当前账号无权使用该托管模型");
    await this.updateAccountModels(async () => {
      this.requireAccount(epoch);
      await this.hostedModels.sync(summary.modelEntitlements);
      this.requireAccount(epoch);
      await this.hostedModels.select(modelId);
    });
    const current = await this.modelSettings.read();
    await this.modelSettings.write({ ...current, selectedHostedModelId: modelId });
    return { saved: true };
  }

  async saveByok(byok: ByokSettings): Promise<{ saved: true }> {
    const current = await this.modelSettings.read();
    await this.modelSettings.write({ ...current, byok });
    return { saved: true };
  }

  async queryMemory(rawInput: MemoryQueryInput) {
    const input = MemoryQuery.parse(rawInput);
    let service = this.memoryQueries.get(input.workId);
    if (service === undefined) {
      service = new MemoryQueryService(await this.memoryRepository(input.workId));
      this.memoryQueries.set(input.workId, service);
    }
    return service.queryMemory(input);
  }

  /** Workflow-only bounded read boundary; every mode projects no future chapter data. */
  async queryMemoryBounded(input: { query: MemoryQueryInput; maximumChapter: number }) {
    if (!Number.isInteger(input.maximumChapter) || input.maximumChapter < 1) {
      throw new JizuoError("validation_error", "记忆查询上界必须是正整数", { maximumChapter: input.maximumChapter });
    }
    const query = MemoryQuery.parse(input.query);
    let service = this.memoryQueries.get(query.workId);
    if (service === undefined) {
      service = new MemoryQueryService(await this.memoryRepository(query.workId));
      this.memoryQueries.set(query.workId, service);
    }
    return service.queryMemory(query, { maximumChapter: input.maximumChapter });
  }

  /** Public workflow read boundary for locking an append-only chapter target. */
  async getChapterListSnapshot(input: { workId: string; volumeId: string }) {
    return (await this.locateWork(input.workId)).service.chapterStore.chapterListSnapshot(input);
  }

  setWorkflowDomainRegistry(registry: JizuoDomainNodeRegistry): void {
    this.workflowDomainRegistry = registry;
  }

  getWorkflowDomainRegistry(): JizuoDomainNodeRegistry {
    if (this.workflowDomainRegistry === undefined) {
      throw new JizuoError("runtime_unavailable", "章节工作流领域适配器尚未连接");
    }
    return this.workflowDomainRegistry;
  }

  async saveChapterMemory(input: {
    volumeId: string;
    candidate: MemoryEpisodeCandidateInput;
  }) {
    const candidate = await this.validateChapterMemory(input);
    const result = await (await this.memoryRepository(candidate.workId)).commitEpisode(candidate);
    this.dreamHost?.invalidate(candidate.workId);
    return result;
  }

  async saveDreamChapterMemory(input: { volumeId: string; candidate: MemoryEpisodeCandidateInput }, selection: DreamModelSelection, signal: AbortSignal, beforeCommit: () => Promise<void>) {
    const repository = await this.memoryRepository(input.candidate.workId);
    return repository.commitDreamEpisodeIfUncovered(input.candidate, async () => {
      await this.validateChapterMemory(input, true);
      const settings = await this.getDreamSettings(input.candidate.workId);
      signal.throwIfAborted();
      if (!settings.enabled || settings.paused || (settings.skipUntil && Date.parse(settings.skipUntil) > Date.now())
        || settings.modelSelection?.provider !== selection.provider || settings.modelSelection.model !== selection.model) {
        throw new DOMException("梦境设置已变化", "AbortError");
      }
      await beforeCommit();
      signal.throwIfAborted();
    });
  }

  private async validateChapterMemory(input: { volumeId: string; candidate: MemoryEpisodeCandidateInput }, rejectLiveDraft = false) {
    const candidate = MemoryEpisodeCandidate.parse(input.candidate);
    if (candidate.source !== "chapter") {
      throw new JizuoError("validation_error", "章节记忆只能引用章节来源", { source: candidate.source });
    }
    const chapter = await this.readChapter({
      workId: candidate.workId,
      volumeId: input.volumeId,
      chapterId: candidate.chapterId,
    });
    if (rejectLiveDraft && chapter.liveDraft !== undefined) throw new JizuoError("revision_conflict", "章节仍有未保存的创作正文，稍后再整理");
    if (chapter.order !== candidate.chapterNumber || chapter.revisionToken !== candidate.contentHash) {
      throw new JizuoError("revision_conflict", "章节正文已变化，请重新读取后再保存记忆", {
        chapterId: candidate.chapterId,
        expectedChapterNumber: candidate.chapterNumber,
        actualChapterNumber: chapter.order,
        expectedRevision: candidate.contentHash,
        actualRevision: chapter.revisionToken,
      });
    }
    const containsMemory = candidate.identities.length + candidate.states.length + candidate.edges.length > 0;
    if (containsMemory && candidate.evidence.length === 0) {
      throw new JizuoError("validation_error", "记忆必须携带可核验的章节证据");
    }
    for (const evidence of candidate.evidence) {
      if (!chapter.content.includes(evidence.excerpt)) {
        throw new JizuoError("validation_error", "记忆证据不是当前章节的原文片段", {
          evidenceId: evidence.id,
          chapterId: candidate.chapterId,
        });
      }
    }
    if (candidate.confirmation === "confirmed" && (
      candidate.states.some(({ confirmed }) => !confirmed)
      || candidate.edges.some(({ confirmed }) => !confirmed)
    )) {
      throw new JizuoError("validation_error", "正式记忆中的状态和关系必须明确确认");
    }
    if (candidate.confirmation === "confirmed") {
      const identitiesWithoutEvidence = candidate.identities
        .filter(({ evidenceIds }) => evidenceIds.length === 0)
        .map(({ id }) => id);
      const statesWithoutEvidence = candidate.states
        .filter(({ evidenceIds }) => evidenceIds.length === 0)
        .map(({ id }) => id);
      if (identitiesWithoutEvidence.length > 0 || statesWithoutEvidence.length > 0) {
        throw new JizuoError("validation_error", "正式人物和状态必须关联至少一条当前章节原文证据", {
          identitiesWithoutEvidence,
          statesWithoutEvidence,
        });
      }
    }
    return candidate;
  }

  async getDreamSettings(workId: string) {
    return (await this.dreamSettingsRepository(workId)).get();
  }

  async saveDreamSettings(input: { workId: string; settings: DreamSettings }) {
    const saved = await (await this.dreamSettingsRepository(input.workId)).set(input.settings);
    this.dreamHost?.settingsChanged(input.workId);
    return saved;
  }

  async listMemorySuggestions(workId: string) {
    const suggestions = await (await this.memoryRepository(workId)).listSuggestions();
    if (suggestions.length === 0) return suggestions;
    const titles = new Map<string, { chapterTitle: string; volumeTitle: string }>();
    if (this.dreamHost) {
      for (const chapter of (await this.dreamHost.report(workId)).chapters) titles.set(chapter.chapterId, { chapterTitle: chapter.chapterTitle, volumeTitle: chapter.volumeTitle });
    } else for (const volume of await this.listVolumes(workId)) {
      for (const chapter of await this.listChapters({ workId, volumeId: volume.id })) titles.set(chapter.id, { chapterTitle: chapter.title, volumeTitle: volume.title });
    }
    return suggestions.map((item) => ({ ...item, ...(item.chapterId ? titles.get(item.chapterId) : {}) }));
  }

  async getMemorySuggestion(input: { workId: string; episodeKey: string }): Promise<MemorySuggestionDetail> {
    const candidate = await (await this.memoryRepository(input.workId)).getSuggestion(input.episodeKey);
    if (candidate.workId !== input.workId) throw new JizuoError("validation_error", "建议不属于当前作品");
    for (const volume of await this.listVolumes(input.workId)) {
      const chapter = (await this.listChapters({ workId: input.workId, volumeId: volume.id })).find((item) => item.id === candidate.chapterId);
      if (chapter) return { episodeKey: input.episodeKey, candidate, volumeTitle: volume.title, chapterTitle: chapter.title,
        sourceState: chapter.revisionToken === candidate.contentHash && chapter.order === candidate.chapterNumber ? "current" : "changed" };
    }
    return { episodeKey: input.episodeKey, candidate, sourceState: "missing" };
  }

  async acceptMemorySuggestion(input: { workId: string; episodeKey: string }) {
    const repository = await this.memoryRepository(input.workId);
    const result = await repository.acceptSuggestion(input.episodeKey, async (candidate) => {
      if (candidate.workId !== input.workId) throw new JizuoError("validation_error", "建议不属于当前作品");
      if (candidate.source !== "chapter") throw new JizuoError("validation_error", "该建议未关联可核验的章节，请通过对应创作流程确认");
      for (const volume of await this.listVolumes(input.workId)) {
        const chapter = (await this.listChapters({ workId: input.workId, volumeId: volume.id })).find((item) => item.id === candidate.chapterId);
        if (!chapter) continue;
        if (chapter.revisionToken !== candidate.contentHash || chapter.order !== candidate.chapterNumber) {
          throw new JizuoError("revision_conflict", "建议引用的章节已改写，请拒绝旧建议并重新整理");
        }
        await this.validateChapterMemory({ volumeId: volume.id, candidate: { ...candidate, confirmation: "confirmed",
          states: candidate.states.map((state) => ({ ...state, confirmed: true })),
          edges: candidate.edges.map((edge) => ({ ...edge, confirmed: true })) } });
        return;
      }
      throw new JizuoError("validation_error", "建议引用的章节已不存在");
    });
    this.dreamHost?.invalidate(input.workId);
    return result;
  }

  async rejectMemorySuggestion(input: { workId: string; episodeKey: string }): Promise<{ rejected: true }> {
    await (await this.memoryRepository(input.workId)).rejectSuggestion(input.episodeKey);
    this.dreamHost?.invalidate(input.workId);
    return { rejected: true };
  }

  async getVideoWorkLocations(): Promise<WorkLocations> {
    return this.videoWorkLocations!.read();
  }

  async setCreateVideoWorkLocation(path: string): Promise<WorkLocations> {
    return this.videoWorkLocations!.setCreateRoot(path);
  }

  async resetCreateVideoWorkLocation(): Promise<WorkLocations> {
    return this.videoWorkLocations!.resetCreateRoot();
  }

  async setCreateWorkLocation(path: string): Promise<WorkLocations> {
    const locations = await this.workLocations.setCreateRoot(path);
    this.clearAllMemoryServices();
    return locations;
  }

  async resetCreateWorkLocation(): Promise<WorkLocations> {
    const locations = await this.workLocations.resetCreateRoot();
    this.clearAllMemoryServices();
    return locations;
  }

  private clearMemoryServices(workId: string): void {
    this.memoryQueries.delete(workId);
    this.memoryRepositories.delete(workId);
    this.dreamSettings.delete(workId);
  }

  private clearAllMemoryServices(): void {
    this.memoryQueries.clear();
    this.memoryRepositories.clear();
    this.dreamSettings.clear();
  }

  private async memoryRepository(workId: string): Promise<MemoryRepository> {
    const { path: workRoot } = await this.resolveWorkPath(workId);
    let repository = this.memoryRepositories.get(workId);
    if (repository?.workRoot === workRoot) return repository;
    if (repository) this.clearMemoryServices(workId);
    repository = new MemoryRepository({ workRoot });
    this.memoryRepositories.set(workId, repository);
    return repository;
  }

  private async dreamSettingsRepository(workId: string): Promise<DreamSettingsRepository> {
    const memory = await this.memoryRepository(workId);
    let repository = this.dreamSettings.get(workId);
    if (repository !== undefined) return repository;
    repository = new DreamSettingsRepository(memory.workRoot);
    this.dreamSettings.set(workId, repository);
    return repository;
  }
}
