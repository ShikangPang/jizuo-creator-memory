import { MemoryRemoteApi } from "../../memory-plugin/src/remote-api.ts";
import { VideoRemoteApi } from "../../video-plugin/src/remote-api.ts";
import { WritingRemoteApi } from "../../writing-plugin/src/remote-api.ts";
import type { GetVideoProjectViewInput, GetVideoJobUpdatesInput } from "@jizuo/contracts";

import { copyVideoExport } from "./video/save-export.ts";

import type { Context } from "@deepseek-ai/cordis";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { SessionId, type Session, type SessionStore } from "@deepseek-ai/dsh-session";
import type {
  ExportWorkInput, SearchWorkInput,
  ApplyProposalInput,
  ApplyImportInput,
  ChapterChangeProposal,
  ChapterProposal,
  ChapterTarget,
  ReadChapterRevisionInput,
  ReadChapterWorkflowRecordInput,
  MoveToTrashInput,
  PreviewImportInput,
  RenameChapterInput,
  RenameVolumeInput,
  RenameWorkInput,
  ReplaceChapterInput,
  RestoreChapterRevisionInput,
  SaveChapterOutlineInput,
  SaveVolumeOutlineInput,
  RestoreFromTrashInput,
  TrashTarget,
  SaveModelOutputLimit,
} from "@jizuo/contracts";
import type { DreamCommand, DreamSettings, MemoryQueryInput } from "@jizuo/memory-domain";
import type {
  WorkflowRunDetailProjection,
  WorkflowRunProjection,
} from "@jizuo/contracts";
import { JizuoError } from "@jizuo/contracts";

import { REMOTE_NAMESPACE } from "./remote-contract.ts";
import type { JizuoService } from "./service.ts";
import type { ByokSettings } from "./model-settings.ts";
import type { DreamModelCatalog } from "./dream-model-catalog.ts";
import type { ModelOutputSettingsPort } from "./model-output-settings.ts";

/**
 * Deliberately narrow workflow facade exposed to Typert.  In particular this
 * is not a graph, executor, database, or authorization capability.
 */
export interface WorkflowRemotePort {
  list(input: unknown): readonly WorkflowRunProjection[];
  get(input: unknown): WorkflowRunDetailProjection;
  ownsProposal(proposalId: string): boolean;
  decideApproval(input: unknown): Promise<WorkflowRunDetailProjection>;
  extendBudget(input: unknown): WorkflowRunDetailProjection;
  pause(runId: string): WorkflowRunDetailProjection;
  resume(runId: string): WorkflowRunDetailProjection;
  cancel(runId: string): WorkflowRunDetailProjection;
  reconcileIndeterminateApply(runId: string): Promise<WorkflowRunDetailProjection>;
  waitForChange(input: {
    readonly sessionId: string;
    readonly afterSequence: number;
    readonly timeoutMs: number;
  }, signal?: AbortSignal): Promise<{
    readonly sequence: number;
    readonly changed: boolean;
    readonly runs: readonly WorkflowRunProjection[];
  }>;
}

export class JizuoRemoteService extends TypertRemoteService {
  async getChatMedia(request:{sessionId:string},signal:AbortSignal) {
    signal.throwIfAborted();
    const id=SessionId(request.sessionId);
    const live=(this.ctx as unknown as {sessions?:Pick<SessionStore,"get">}).sessions?.get(id);
    const persistence=this.ctx.get("sessionPersistence") as {stat?:(id:Session["id"])=>Promise<{header:Session["header"]}|undefined>}|undefined;
    const header=live?.header??(await persistence?.stat?.(id))?.header;
    if(!header||header.id!==id||header.origin==="subagent")throw new JizuoError("denied","当前聊天不存在或不可访问");
    if(!this.domain.chatMedia)throw new JizuoError("runtime_unavailable","聊天媒体服务尚未连接");
    signal.throwIfAborted();
    return this.domain.chatMedia.list(request.sessionId);
  }

  async getVideoProjectView(request:GetVideoProjectViewInput,signal:AbortSignal) { return this.creationApis.video.getVideoProjectView(request, signal); }
  async getVideoJobUpdates(request:GetVideoJobUpdatesInput,signal:AbortSignal) { return this.creationApis.video.getVideoJobUpdates(request, signal); }
  readonly domain: JizuoService;
  readonly creationApis: { writing: WritingRemoteApi; video: VideoRemoteApi; memory: MemoryRemoteApi };

  async renameVideoAsset(request: import("@jizuo/contracts").RenameVideoAssetInput, signal: AbortSignal) { return this.creationApis.video.renameVideoAsset(request, signal); }
  async getVideoTimelineHistory(request: import("@jizuo/contracts").VideoTimelineHistoryInput, signal: AbortSignal) { return this.creationApis.video.getVideoTimelineHistory(request, signal); }
  async restoreVideoTimeline(request: import("@jizuo/contracts").RestoreVideoTimelineInput, signal: AbortSignal) { return this.creationApis.video.restoreVideoTimeline(request, signal); }
  async startVideoProduction(request: import("@jizuo/contracts").StartVideoProductionInput, signal: AbortSignal) { return this.creationApis.video.startVideoProduction(request, signal); }
  async controlVideoProduction(request: import("@jizuo/contracts").ControlVideoProductionInput, signal: AbortSignal) { return this.creationApis.video.controlVideoProduction(request, signal); }
  async copyVideoExport(request: import("@jizuo/contracts").CopyVideoExportInput, signal: AbortSignal) { return this.creationApis.video.copyVideoExport(request, signal); }
  async roughCutVideo(request: import("@jizuo/contracts").RoughCutVideoInput, signal: AbortSignal) { return this.creationApis.video.roughCutVideo(request, signal); }
  async getVideoClipFrames(request: import("@jizuo/contracts").GetVideoClipFramesInput, signal: AbortSignal) { return this.creationApis.video.getVideoClipFrames(request, signal); }
  async editVideoTimeline(request: import("@jizuo/contracts").EditVideoTimelineInput, signal: AbortSignal) { return this.creationApis.video.editVideoTimeline(request, signal); }
  async exportVideo(request: import("@jizuo/contracts").ExportVideoInput, signal: AbortSignal) { return this.creationApis.video.exportVideo(request, signal); }
  async generateVideoSpeech(request: import("@jizuo/contracts").GenerateSpeechInput, signal: AbortSignal) { return this.creationApis.video.generateVideoSpeech(request, signal); }
  async getSpeechSettings(_request: Record<string, never>, signal: AbortSignal) { return this.creationApis.video.getSpeechSettings(_request, signal); }
  async saveSpeechSettings(request: import("@jizuo/contracts").SaveSpeechSettingsInput, signal: AbortSignal) { return this.creationApis.video.saveSpeechSettings(request, signal); }
  async submitVideoBatch(request: import("@jizuo/contracts").SubmitVideoBatchInput, signal: AbortSignal) { return this.creationApis.video.submitVideoBatch(request, signal); }
  async generateVideoMedia(request: import("@jizuo/contracts").GenerateVideoMediaInput, signal: AbortSignal) { return this.creationApis.video.generateVideoMedia(request, signal); }
  async controlVideoJob(request: import("@jizuo/contracts").ControlVideoJobInput, signal: AbortSignal) { return this.creationApis.video.controlVideoJob(request, signal); }
  async saveStyledPrompts(request: import("@jizuo/contracts").SaveStyledPromptsInput, signal: AbortSignal) { return this.creationApis.video.saveStyledPrompts(request, signal); }
  async undoStyledPrompts(request: import("@jizuo/contracts").UndoStyledPromptsInput, signal: AbortSignal) { return this.creationApis.video.undoStyledPrompts(request, signal); }
  async saveWorkVisualStyle(request: import("@jizuo/contracts").SaveWorkVisualStyleInput, signal: AbortSignal) { return this.creationApis.video.saveWorkVisualStyle(request, signal); }
  async saveVideoDesign(request: import("@jizuo/contracts").SaveVideoDesignInput, signal: AbortSignal) { return this.creationApis.video.saveVideoDesign(request, signal); }
  async tagVideoAsset(request: import("@jizuo/contracts").TagVideoAssetInput, signal: AbortSignal) { return this.creationApis.video.tagVideoAsset(request, signal); }
  async extractVideoDesigns(request: import("@jizuo/contracts").ExtractVideoDesignsInput, signal: AbortSignal) { return this.creationApis.video.extractVideoDesigns(request, signal); }
  async importVideoAsset(request: import("@jizuo/contracts").ImportVideoAssetInput, signal: AbortSignal) { return this.creationApis.video.importVideoAsset(request, signal); }
  async selectVideoAsset(request: import("@jizuo/contracts").SelectVideoAssetInput, signal: AbortSignal) { return this.creationApis.video.selectVideoAsset(request, signal); }
  async getVideoAssetUrl(request: { workId: string; assetId: string }, signal: AbortSignal) { return this.creationApis.video.getVideoAssetUrl(request, signal); }

  async getMediaLibrary(request: Record<string, never>, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.mediaLibrary) throw new JizuoError("runtime_unavailable", "模型目录尚未连接");
    return this.domain.mediaLibrary.get();
  }
  async saveMediaProvider(request: import("@jizuo/contracts").SaveMediaProviderInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.mediaLibrary) throw new JizuoError("runtime_unavailable", "模型目录尚未连接");
    return this.domain.mediaLibrary.saveProvider(request);
  }
  async setDefaultMediaModels(request: import("@jizuo/contracts").SetDefaultMediaModelsInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.mediaLibrary) throw new JizuoError("runtime_unavailable", "模型目录尚未连接");
    return this.domain.mediaLibrary.setDefaults(request);
  }
  async discoverMediaModels(request: import("@jizuo/contracts").DiscoverMediaModelsInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.mediaLibrary) throw new JizuoError("runtime_unavailable", "模型目录尚未连接");
    return this.domain.mediaLibrary.discover(request);
  }
  async getMediaSettings(_request: Record<string, never>, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.mediaSettings) throw new JizuoError("runtime_unavailable", "媒体模型设置尚未连接");
    return this.domain.mediaSettings.get();
  }

  async saveMediaConnection(request: import("@jizuo/contracts").SaveMediaConnectionInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.mediaSettings) throw new JizuoError("runtime_unavailable", "媒体模型设置尚未连接");
    return this.domain.mediaSettings.saveConnection(request);
  }

  async saveMediaSettings(request: import("@jizuo/contracts").SaveMediaSettingsInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.mediaSettings) throw new JizuoError("runtime_unavailable", "媒体模型设置尚未连接");
    return this.domain.mediaSettings.save(request);
  }

  async manageMediaConnection(request: import("@jizuo/contracts").ManageMediaConnectionInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.mediaSettings) throw new JizuoError("runtime_unavailable", "媒体模型设置尚未连接");
    return this.domain.mediaSettings.manageConnection(request);
  }

  async discussVideoPrompt(request: import("@jizuo/contracts").DiscussVideoPromptInput, signal: AbortSignal) { return this.creationApis.video.discussVideoPrompt(request, signal); }

  async adaptVideoEpisode(request: import("@jizuo/contracts").AdaptVideoEpisodeInput, signal: AbortSignal) { return this.creationApis.video.adaptVideoEpisode(request, signal); }

  async getVideoProject(request: { workId: string }, signal: AbortSignal) { return this.creationApis.video.getVideoProject(request, signal); }

  async createVideoEpisode(request: import("@jizuo/contracts").CreateVideoEpisodeInput, signal: AbortSignal) { return this.creationApis.video.createVideoEpisode(request, signal); }

  async deleteVideoItem(request: import("@jizuo/contracts").DeleteVideoItemInput, signal: AbortSignal) { return this.creationApis.video.deleteVideoItem(request, signal); }

  async deleteVideoEpisode(request: import("@jizuo/contracts").DeleteVideoEpisodeInput, signal: AbortSignal) { return this.creationApis.video.deleteVideoEpisode(request, signal); }

  async updateVideoEpisode(request: import("@jizuo/contracts").UpdateVideoEpisodeInput, signal: AbortSignal) { return this.creationApis.video.updateVideoEpisode(request, signal); }

  constructor(ctx: Context, domain: JizuoService, private readonly workflowRuns?: WorkflowRemotePort, private readonly modelOutputs?: ModelOutputSettingsPort, private readonly dreamModels?: Pick<DreamModelCatalog, "list">) {
    super(ctx, REMOTE_NAMESPACE);
    this.domain = domain;
    this.creationApis = {
      writing: new WritingRemoteApi(domain, workflowRuns),
      video: new VideoRemoteApi(ctx, domain),
      memory: new MemoryRemoteApi(domain, dreamModels),
    };
  }

  async getVideoWorkLocations(_request: Record<string, never>, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.getVideoWorkLocations();
  }

  async setCreateVideoWorkLocation(request: { path: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.setCreateVideoWorkLocation(request.path);
  }

  async resetCreateVideoWorkLocation(_request: Record<string, never>, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.resetCreateVideoWorkLocation();
  }

  async getWorkLocations(_request: Record<string, never>, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.getWorkLocations();
  }

  async setCreateWorkLocation(request: { path: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.setCreateWorkLocation(request.path);
  }

  async resetCreateWorkLocation(_request: Record<string, never>, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.resetCreateWorkLocation();
  }

  async listWorks(_request: Record<string, never>, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.listWorks();
  }

  async createWork(request: { title: string; projectKind?: "novel" | "video" | undefined }, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.createWork(request);
  }

  async exportWork(request: ExportWorkInput, signal: AbortSignal) { return this.creationApis.writing.exportWork(request, signal); }

  async searchWork(request: SearchWorkInput, signal: AbortSignal) { return this.creationApis.writing.searchWork(request, signal); }

  async previewImport(request: PreviewImportInput, signal: AbortSignal) { return this.creationApis.writing.previewImport(request, signal); }

  async applyImport(request: ApplyImportInput, signal: AbortSignal) { return this.creationApis.writing.applyImport(request, signal); }

  async renameWork(request: RenameWorkInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.renameWork(request);
  }

  async listVolumes(request: { workId: string }, signal: AbortSignal) { return this.creationApis.writing.listVolumes(request, signal); }

  async createVolume(request: { workId: string; title: string }, signal: AbortSignal) { return this.creationApis.writing.createVolume(request, signal); }

  async renameVolume(request: RenameVolumeInput, signal: AbortSignal) { return this.creationApis.writing.renameVolume(request, signal); }

  async saveVolumeOutline(request: SaveVolumeOutlineInput, signal: AbortSignal) { return this.creationApis.writing.saveVolumeOutline(request, signal); }

  async listChapters(request: { workId: string; volumeId: string }, signal: AbortSignal) { return this.creationApis.writing.listChapters(request, signal); }

  async createChapter(request: {
    workId: string;
    volumeId: string;
    title: string;
    content?: string;
    plan?: string;
    detailedOutline?: string;
  }, signal: AbortSignal) { return this.creationApis.writing.createChapter(request, signal); }

  async renameChapter(request: RenameChapterInput, signal: AbortSignal) { return this.creationApis.writing.renameChapter(request, signal); }

  async inspectTrashTarget(request: TrashTarget, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.inspectTrashTarget(request);
  }

  async moveToTrash(request: MoveToTrashInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.moveToTrash(request);
  }

  async listTrash(_request: Record<string, never>, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.listTrash();
  }

  async restoreFromTrash(request: RestoreFromTrashInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.restoreFromTrash(request);
  }

  async deleteFromTrash(request: RestoreFromTrashInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.deleteFromTrash(request);
  }

  async readChapter(request: ChapterTarget, signal: AbortSignal) { return this.creationApis.writing.readChapter(request, signal); }

  async replaceChapter(request: ReplaceChapterInput, signal: AbortSignal) { return this.creationApis.writing.replaceChapter(request, signal); }

  async saveChapterOutline(request: SaveChapterOutlineInput, signal: AbortSignal) { return this.creationApis.writing.saveChapterOutline(request, signal); }

  async listProposals(request: ChapterTarget, signal: AbortSignal) { return this.creationApis.writing.listProposals(request, signal); }

  async getProposalPreview(request: { proposalId: string }, signal: AbortSignal): Promise<ChapterProposal> { return this.creationApis.writing.getProposalPreview(request, signal); }

  async rejectProposal(request: { proposalId: string }, signal: AbortSignal): Promise<ChapterChangeProposal> { return this.creationApis.writing.rejectProposal(request, signal); }

  async authorizeProposal(request: { proposalId: string }, signal: AbortSignal) { return this.creationApis.writing.authorizeProposal(request, signal); }

  async applyProposal(request: ApplyProposalInput, signal: AbortSignal) { return this.creationApis.writing.applyProposal(request, signal); }

  async restoreChapterRevision(request: RestoreChapterRevisionInput, signal: AbortSignal) { return this.creationApis.writing.restoreChapterRevision(request, signal); }

  async listChapterRevisions(request: ChapterTarget, signal: AbortSignal) { return this.creationApis.writing.listChapterRevisions(request, signal); }

  async readChapterRevision(request: ReadChapterRevisionInput, signal: AbortSignal) { return this.creationApis.writing.readChapterRevision(request, signal); }

  async listChapterWorkflowRecords(request: ChapterTarget, signal: AbortSignal) { return this.creationApis.writing.listChapterWorkflowRecords(request, signal); }

  async readChapterWorkflowRecord(request: ReadChapterWorkflowRecordInput, signal: AbortSignal) { return this.creationApis.writing.readChapterWorkflowRecord(request, signal); }

  async queryMemory(request: MemoryQueryInput, signal: AbortSignal) { return this.creationApis.memory.queryMemory(request, signal); }

  async listWorkflowRuns(request: { sessionId: string; statuses?: readonly string[] }, signal: AbortSignal): Promise<readonly WorkflowRunProjection[]> { return this.creationApis.writing.listWorkflowRuns(request, signal); }

  async getWorkflowRun(request: { runId: string }, signal: AbortSignal): Promise<WorkflowRunDetailProjection> { return this.creationApis.writing.getWorkflowRun(request, signal); }

  async decideWorkflowApproval(request: {
    runId: string;
    proposalId: string;
    decision: "approved" | "rejected";
  }, signal: AbortSignal): Promise<WorkflowRunDetailProjection> { return this.creationApis.writing.decideWorkflowApproval(request, signal); }

  async extendWorkflowBudget(request: { runId: string; additionalRounds: 2 }, signal: AbortSignal): Promise<WorkflowRunDetailProjection> { return this.creationApis.writing.extendWorkflowBudget(request, signal); }

  async pauseWorkflowRun(request: { runId: string }, signal: AbortSignal): Promise<WorkflowRunDetailProjection> { return this.creationApis.writing.pauseWorkflowRun(request, signal); }

  async resumeWorkflowRun(request: { runId: string }, signal: AbortSignal): Promise<WorkflowRunDetailProjection> { return this.creationApis.writing.resumeWorkflowRun(request, signal); }

  async cancelWorkflowRun(request: { runId: string }, signal: AbortSignal): Promise<WorkflowRunDetailProjection> { return this.creationApis.writing.cancelWorkflowRun(request, signal); }

  async reconcileWorkflowApply(request: { runId: string }, signal: AbortSignal): Promise<WorkflowRunDetailProjection> { return this.creationApis.writing.reconcileWorkflowApply(request, signal); }

  async watchWorkflowRuns(request: {
    sessionId: string;
    afterSequence: number;
    timeoutMs: number;
  }, signal: AbortSignal) { return this.creationApis.writing.watchWorkflowRuns(request, signal); }

  async getDreamStatus(request: { workId: string }, signal: AbortSignal) { return this.creationApis.memory.getDreamStatus(request, signal); }

  async getDreamReport(request: { workId: string }, signal: AbortSignal) { return this.creationApis.memory.getDreamReport(request, signal); }

  async getDreamConversations(request: { workId: string; volumeId: string; chapterId: string }, signal: AbortSignal) { return this.creationApis.memory.getDreamConversations(request, signal); }

  async listDreamModels(_request: Record<string, never>, signal: AbortSignal) { return this.creationApis.memory.listDreamModels(_request, signal); }

  async getMemorySuggestion(request: { workId: string; episodeKey: string }, signal: AbortSignal) { return this.creationApis.memory.getMemorySuggestion(request, signal); }

  async controlDream(request: { workId?: string; command: DreamCommand }, signal: AbortSignal) { return this.creationApis.memory.controlDream(request, signal); }

  async touchDreamActivity(request: { workId: string; chapterId?: string }, signal: AbortSignal): Promise<{ saved: true }> { return this.creationApis.memory.touchDreamActivity(request, signal); }

  async getDreamSettings(request: { workId: string }, signal: AbortSignal) { return this.creationApis.memory.getDreamSettings(request, signal); }

  async saveDreamSettings(request: { workId: string } & DreamSettings, signal: AbortSignal) { return this.creationApis.memory.saveDreamSettings(request, signal); }

  async listMemorySuggestions(request: { workId: string }, signal: AbortSignal) { return this.creationApis.memory.listMemorySuggestions(request, signal); }

  async acceptMemorySuggestion(request: { workId: string; episodeKey: string }, signal: AbortSignal) { return this.creationApis.memory.acceptMemorySuggestion(request, signal); }

  async rejectMemorySuggestion(request: { workId: string; episodeKey: string }, signal: AbortSignal) { return this.creationApis.memory.rejectMemorySuggestion(request, signal); }

  async resolveChapterPath(request: ChapterTarget, signal: AbortSignal) { return this.creationApis.writing.resolveChapterPath(request, signal); }

  async resolveWorkPath(request: { workId: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.resolveWorkPath(request.workId);
  }

  async accountGetState(_request: Record<string, never>, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.getAccountState();
  }

  async accountBeginBrowserLogin(_request: Record<string, never>, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.beginBrowserLogin();
  }

  async accountLogout(_request: Record<string, never>, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.logoutAccount();
  }

  async getModelSettings(_request: Record<string, never>, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.getModelSettings();
  }

  async listModelOutputLimits(request: { provider?: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.modelOutputs) throw new JizuoError("runtime_unavailable", "模型输出设置尚未就绪");
    return this.modelOutputs.list(request.provider);
  }

  async saveModelOutputLimit(request: SaveModelOutputLimit, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.modelOutputs) throw new JizuoError("runtime_unavailable", "模型输出设置尚未就绪");
    await this.modelOutputs.save(request);
    return { saved: true as const };
  }

  async selectHostedModel(request: { modelId: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.selectHostedModel(request.modelId);
  }

  async saveByok(request: ByokSettings, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.saveByok(request);
  }

}
