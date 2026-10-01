import { StorageLocation } from "../../jizuo-client/src/settings/WorkStorageSettings.tsx";
import { NativeWorkspaces } from "./native-workspaces.tsx";
import { WORKSPACE_PLUGINS, type WorkspacePluginId } from "../../jizuo-client/src/plugins/registry.ts";
import { subscribeWorkspacePlugins, isBuiltinPluginEnabled } from "../../jizuo-client/src/plugins/preferences.ts";
import type { NativeShellHost, NativeShellSlots } from "./shell-host.ts";
import { BuiltinPluginsSettings } from "../../jizuo-client/src/plugins/BuiltinPluginsSettings.tsx";
import { creationPanels, subscribeCreationPanels, creationClientApi } from "./creation-client.ts";
export { creationClientApi } from "./creation-client.ts";
import { pluginForOverlay } from "../../jizuo-client/src/plugins/registry.ts";
import { isWorkspacePluginEnabled } from "../../jizuo-client/src/plugins/preferences.ts";
import { installClientErrors, observeClientRemote } from "./client-errors.ts";
import { userErrorMessage } from "@jizuo/contracts";
import { sendToSessionConversation } from "./session-conversation.ts";
import { JizuoHeroBrand } from "./hero-brand.tsx";
import { storyboardChatMessage, type StoryboardChatRequest } from "../../jizuo-client/src/video/storyboard-chat.ts";
import { IconButton } from "../../jizuo-client/src/ui/IconButton.tsx";
import { registerLocalDirectoryQuery } from "./local-directory.ts";
import { bridgeComposerTextModelBlock } from "./composer-model-block.ts";
import { composerDetectSpan } from "./composer-input-span.ts";
import { ComposerWorkImageDrop, createWorkImageIntake } from "./composer-work-image-drop.tsx";
import { bindImageChatActivity } from "./image-chat-runtime.ts";
import { createImageChatStore } from "../../jizuo-client/src/video/image-chat-store.ts";
import { ChatImageConversation } from "../../jizuo-client/src/video/ChatImageConversation.tsx";
import { ComposerModelTypeControl, type ComposerInputPhaseStore } from "../../jizuo-client/src/video/ComposerModelTypeControl.tsx";
import {ComposerWorkspaceAccess} from "../../jizuo-client/src/video/ComposerWorkspaceAccess.tsx";
import {MainVideoComposerFooter} from "../../jizuo-client/src/video/MainVideoComposerDock.tsx";
import { ComposerPromptPreview } from "./composer-prompt-preview.tsx";
import {createMainVideoComposer, type MainVideoComposer} from "../../jizuo-client/src/video/main-video-composer.ts";
import "../../jizuo-client/src/settings/model-categories.css";
import "./settings-layout.css";
import type { DreamStatus, DreamCommand, DreamWorkReport, DreamChapterConversations, DreamModelOption, MemorySuggestionDetail } from "@jizuo/memory-domain";
import type { ExportWorkInput, ExportWorkResult, SearchWorkInput, SearchWorkResult, NovelFileFormat } from "@jizuo/contracts";
import { createSessionNavigation } from "./session-navigation.ts";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { SessionId } from "@deepseek-ai/dsh-session";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import type { WorkspaceId } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { ConversationController } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";

declare module "@deepseek-ai/cordis" {
  interface Events {
    /** Resolved synchronously by the native composer before any text send. */
    "jizuo/input-submit-route"(): ReturnType<MainVideoComposer["submissionRoute"]>;
  }
}
import {
  ChapterWorkflowProgressDock,
  type VideoEpisodeQuote,
  AboutJizuo,
  type AboutJizuoRemote,
  UpdateNoticeDialog,
  type UpdateNotice,
  type UpdateNoticeStore,
  JizuoSettingsCard,
  ProviderModelsSettings,
  MediaModelsSettings,
  type MediaSettingsRemote,
  type MediaLibraryRemote,
  type SpeechSettingsRemote,
  DreamMemorySettings,
  type ModelOutputSettingsRemote,
  WorkStorageSettings,
  type WorkLocations,
  type WorkLocationsRemote,
  JizuoSidebarRoot,
  createChapterExcerptReference,
  getSelection,
  registerChapterTriggers,
  setSelection,
  subscribeSelection,
  type AccountRemote,
  type ChapterExcerptQuote,
  type ChapterTriggerService,
  type JizuoContentRemote,
  WorkflowStoreUnavailableError,
  type JizuoWorkflowRemote as ClientJizuoWorkflowRemote,
  type MemoryPalaceOverlayRemote,
  type SubscribeWorksChanges,
  type WorkflowSessionSource,
} from "../../jizuo-client/src/shell.tsx";
import type {
  ApplyProposalInput,
  AppliedImport,
  ApplyImportInput,
  ChapterChangeProposal,
  ChapterProposal,
  ChapterDocument,
  ChapterSummary,
  ChapterTarget,
  ChapterRevisionDocument,
  ChapterRevisionSummary,
  ChapterWorkflowRecord,
  ChapterWorkflowRecordSummary,
  MoveToTrashInput,
  ImportPreview,
  PreviewImportInput,
  RenameChapterInput,
  RenameVolumeInput,
  RenameWorkInput,
  ReplaceChapterInput,
  RestoreChapterRevisionInput,
  ReadChapterRevisionInput,
  ReadChapterWorkflowRecordInput,
  SaveChapterOutlineInput,
  SaveVolumeOutlineInput,
  RestoreFromTrashInput,
  TrashEntry,
  TrashImpact,
  TrashTarget,
  VolumeSummary,
  WorkflowRunDetailProjection,
  WorkflowRunProjection,
  WorkSummary,
  ModelOutputLimit,
  SaveModelOutputLimit,
} from "@jizuo/contracts";
import type {
  DreamSettings,
  MemoryGraph,
  MemoryQueryInput,
  MemorySuggestionSummary,
} from "@jizuo/memory-domain";

import {
  createAccountRemote,
  desktopControlToken,
  type AccountHostRemote,
} from "./account-client.ts";
import { TYPERT_REMOTE } from "./remote.ts";
import "./chapter-excerpt-reference.css";
import "./message-actions.css";
import "./composer-chrome.css";

interface RemoteAnswer<T> {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string };
}

export interface JizuoHostRemote extends AccountHostRemote {
  getChatMedia?(request:{sessionId:string},signal?:AbortSignal):Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject[]>>;
  getMediaLibrary(request: Record<string, never>): Promise<RemoteAnswer<import("@jizuo/contracts").MediaLibraryView>>;
  saveMediaProvider(request: import("@jizuo/contracts").SaveMediaProviderInput): Promise<RemoteAnswer<import("@jizuo/contracts").MediaLibraryView>>;
  setDefaultMediaModels(request: import("@jizuo/contracts").SetDefaultMediaModelsInput): Promise<RemoteAnswer<import("@jizuo/contracts").MediaLibraryView>>;
  discoverMediaModels(request: import("@jizuo/contracts").DiscoverMediaModelsInput): Promise<RemoteAnswer<import("@jizuo/contracts").DiscoverMediaModelsResult>>;
  getMediaSettings(request: Record<string, never>): Promise<RemoteAnswer<import("@jizuo/contracts").MediaSettingsView>>;
  saveMediaSettings(request: import("@jizuo/contracts").SaveMediaSettingsInput): Promise<RemoteAnswer<import("@jizuo/contracts").MediaSettingsView>>;
  saveMediaConnection(request: import("@jizuo/contracts").SaveMediaConnectionInput): Promise<RemoteAnswer<import("@jizuo/contracts").MediaSettingsView>>;
  manageMediaConnection(request: import("@jizuo/contracts").ManageMediaConnectionInput): Promise<RemoteAnswer<import("@jizuo/contracts").MediaSettingsView>>;
  deleteVideoItem(request: import("@jizuo/contracts").DeleteVideoItemInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  renameVideoAsset(request: import("@jizuo/contracts").RenameVideoAssetInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  getVideoTimelineHistory(request: import("@jizuo/contracts").VideoTimelineHistoryInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoTimelineHistory>>;
  restoreVideoTimeline(request: import("@jizuo/contracts").RestoreVideoTimelineInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  startVideoProduction(request: import("@jizuo/contracts").StartVideoProductionInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  controlVideoProduction(request: import("@jizuo/contracts").ControlVideoProductionInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  copyVideoExport(request: import("@jizuo/contracts").CopyVideoExportInput): Promise<RemoteAnswer<{path:string}>>;
  roughCutVideo(request: import("@jizuo/contracts").RoughCutVideoInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  getVideoClipFrames(request: import("@jizuo/contracts").GetVideoClipFramesInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoClipFrames>>;
  editVideoTimeline(request: import("@jizuo/contracts").EditVideoTimelineInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  exportVideo(request: import("@jizuo/contracts").ExportVideoInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  generateVideoSpeech(request: import("@jizuo/contracts").GenerateSpeechInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  getSpeechSettings(request: Record<string, never>): Promise<RemoteAnswer<import("@jizuo/contracts").SpeechSettingsView>>;
  saveSpeechSettings(request: import("@jizuo/contracts").SaveSpeechSettingsInput): Promise<RemoteAnswer<import("@jizuo/contracts").SpeechSettingsView>>;
  submitVideoBatch(request: import("@jizuo/contracts").SubmitVideoBatchInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  generateVideoMedia(request: import("@jizuo/contracts").GenerateVideoMediaInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  controlVideoJob(request: import("@jizuo/contracts").ControlVideoJobInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  saveVideoDesign(request: import("@jizuo/contracts").SaveVideoDesignInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  saveWorkVisualStyle(request: import("@jizuo/contracts").SaveWorkVisualStyleInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  undoStyledPrompts(request: import("@jizuo/contracts").UndoStyledPromptsInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  tagVideoAsset(request: import("@jizuo/contracts").TagVideoAssetInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  extractVideoDesigns(request: import("@jizuo/contracts").ExtractVideoDesignsInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  importVideoAsset(request: import("@jizuo/contracts").ImportVideoAssetInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  selectVideoAsset(request: import("@jizuo/contracts").SelectVideoAssetInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  getVideoAssetUrl(request: { workId: string; assetId: string }): Promise<RemoteAnswer<{url: string}>>;
  discussVideoPrompt(request: import("@jizuo/contracts").DiscussVideoPromptInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  adaptVideoEpisode(request: import("@jizuo/contracts").AdaptVideoEpisodeInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  getVideoProject(request: { workId: string }, signal?: AbortSignal): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  getVideoProjectView?(request: import("@jizuo/contracts").GetVideoProjectViewInput, signal?: AbortSignal): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProjectView>>;
  getVideoJobUpdates?(request: import("@jizuo/contracts").GetVideoJobUpdatesInput, signal?: AbortSignal): Promise<RemoteAnswer<import("@jizuo/contracts").VideoJobUpdates>>;
  createVideoEpisode(request: import("@jizuo/contracts").CreateVideoEpisodeInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  deleteVideoEpisode(request: import("@jizuo/contracts").DeleteVideoEpisodeInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  updateVideoEpisode(request: import("@jizuo/contracts").UpdateVideoEpisodeInput): Promise<RemoteAnswer<import("@jizuo/contracts").VideoProject>>;
  getVideoWorkLocations?(request: Record<string, never>): Promise<RemoteAnswer<WorkLocations>>;
  setCreateVideoWorkLocation?(request: { path: string }): Promise<RemoteAnswer<WorkLocations>>;
  resetCreateVideoWorkLocation?(request: Record<string, never>): Promise<RemoteAnswer<WorkLocations>>;
  getWorkLocations(request: Record<string, never>): Promise<RemoteAnswer<WorkLocations>>;
  setCreateWorkLocation(request: { path: string }): Promise<RemoteAnswer<WorkLocations>>;
  resetCreateWorkLocation(request: Record<string, never>): Promise<RemoteAnswer<WorkLocations>>;
  listModelOutputLimits(request: { provider?: string }): Promise<RemoteAnswer<ModelOutputLimit[]>>;
  saveModelOutputLimit(request: SaveModelOutputLimit): Promise<RemoteAnswer<{ saved: true }>>;
  listWorks(request: Record<string, never>): Promise<RemoteAnswer<WorkSummary[]>>;
  resolveChapterPath(request: ChapterTarget): Promise<RemoteAnswer<{ path: string }>>;
  resolveWorkPath(request: { workId: string }): Promise<RemoteAnswer<{ path: string }>>;
  createWork(request: { title: string }): Promise<RemoteAnswer<WorkSummary>>;
  exportWork(request: ExportWorkInput): Promise<RemoteAnswer<ExportWorkResult>>;
  searchWork(request: SearchWorkInput): Promise<RemoteAnswer<SearchWorkResult>>;
  previewImport(request: PreviewImportInput): Promise<RemoteAnswer<ImportPreview>>;
  applyImport(request: ApplyImportInput): Promise<RemoteAnswer<AppliedImport>>;
  renameWork(request: RenameWorkInput): Promise<RemoteAnswer<WorkSummary>>;
  listVolumes(request: { workId: string }): Promise<RemoteAnswer<VolumeSummary[]>>;
  createVolume(request: { workId: string; title: string }): Promise<RemoteAnswer<VolumeSummary>>;
  renameVolume(request: RenameVolumeInput): Promise<RemoteAnswer<VolumeSummary>>;
  saveVolumeOutline(request: SaveVolumeOutlineInput): Promise<RemoteAnswer<VolumeSummary>>;
  listChapters(request: { workId: string; volumeId: string }): Promise<RemoteAnswer<ChapterSummary[]>>;
  createChapter(request: {
    workId: string;
    volumeId: string;
    title: string;
    content?: string;
    plan?: string;
    detailedOutline?: string;
  }): Promise<RemoteAnswer<ChapterDocument>>;
  renameChapter(request: RenameChapterInput): Promise<RemoteAnswer<ChapterSummary>>;
  inspectTrashTarget(request: TrashTarget): Promise<RemoteAnswer<TrashImpact>>;
  moveToTrash(request: MoveToTrashInput): Promise<RemoteAnswer<TrashEntry>>;
  listTrash(request: Record<string, never>): Promise<RemoteAnswer<TrashEntry[]>>;
  restoreFromTrash(request: RestoreFromTrashInput): Promise<RemoteAnswer<TrashEntry>>;
  deleteFromTrash(request: RestoreFromTrashInput): Promise<RemoteAnswer<{ deleted: true }>>;
  readChapter(request: ChapterTarget): Promise<RemoteAnswer<ChapterDocument>>;
  replaceChapter(request: ReplaceChapterInput): Promise<RemoteAnswer<ChapterDocument>>;
  saveChapterOutline(request: SaveChapterOutlineInput): Promise<RemoteAnswer<ChapterDocument>>;
  listProposals(request: ChapterTarget): Promise<RemoteAnswer<ChapterChangeProposal[]>>;
  getProposalPreview(request: { proposalId: string }): Promise<RemoteAnswer<ChapterProposal>>;
  rejectProposal(request: { proposalId: string }): Promise<RemoteAnswer<ChapterChangeProposal>>;
  authorizeProposal(request: { proposalId: string }): Promise<RemoteAnswer<string>>;
  applyProposal(request: ApplyProposalInput): Promise<RemoteAnswer<ChapterDocument>>;
  restoreChapterRevision(request: RestoreChapterRevisionInput): Promise<RemoteAnswer<ChapterDocument>>;
  listChapterRevisions(request: ChapterTarget, signal?: AbortSignal): Promise<RemoteAnswer<ChapterRevisionSummary[]>>;
  readChapterRevision(request: ReadChapterRevisionInput): Promise<RemoteAnswer<ChapterRevisionDocument>>;
  listChapterWorkflowRecords(request: ChapterTarget): Promise<RemoteAnswer<ChapterWorkflowRecordSummary[]>>;
  readChapterWorkflowRecord(request: ReadChapterWorkflowRecordInput): Promise<RemoteAnswer<ChapterWorkflowRecord>>;
  queryMemory(request: MemoryQueryInput): Promise<RemoteAnswer<MemoryGraph>>;
  getDreamReport(request: { workId: string }): Promise<RemoteAnswer<DreamWorkReport>>;
  getDreamConversations(request: ChapterTarget): Promise<RemoteAnswer<DreamChapterConversations>>;
  listDreamModels(request: Record<string, never>): Promise<RemoteAnswer<DreamModelOption[]>>;
  getMemorySuggestion(request: { workId: string; episodeKey: string }): Promise<RemoteAnswer<MemorySuggestionDetail>>;
  getDreamStatus(request: { workId: string }): Promise<RemoteAnswer<DreamStatus>>;
  controlDream(request: { workId?: string; command: DreamCommand }): Promise<RemoteAnswer<{ saved: true }>>;
  touchDreamActivity(request: { workId: string; chapterId?: string }): Promise<RemoteAnswer<{ saved: true }>>;
  getDreamSettings(request: { workId: string }): Promise<RemoteAnswer<DreamSettings>>;
  saveDreamSettings(request: { workId: string } & DreamSettings): Promise<RemoteAnswer<DreamSettings>>;
  listMemorySuggestions(request: { workId: string }): Promise<RemoteAnswer<MemorySuggestionSummary[]>>;
  acceptMemorySuggestion(request: { workId: string; episodeKey: string }): Promise<RemoteAnswer<unknown>>;
  rejectMemorySuggestion(request: { workId: string; episodeKey: string }): Promise<RemoteAnswer<{ rejected: true }>>;
  listWorkflowRuns(request: { sessionId: string; statuses?: WorkflowRunProjection["status"][] }, signal?: AbortSignal): Promise<RemoteAnswer<WorkflowRunProjection[]>>;
  getWorkflowRun(request: { runId: string }, signal?: AbortSignal): Promise<RemoteAnswer<WorkflowRunDetailProjection>>;
  decideWorkflowApproval(request: {
    runId: string;
    proposalId: string;
    decision: "approved" | "rejected";
  }, signal?: AbortSignal): Promise<RemoteAnswer<WorkflowRunDetailProjection>>;
  extendWorkflowBudget(request: { runId: string; additionalRounds: 2 }, signal?: AbortSignal): Promise<RemoteAnswer<WorkflowRunDetailProjection>>;
  pauseWorkflowRun(request: { runId: string }, signal?: AbortSignal): Promise<RemoteAnswer<WorkflowRunDetailProjection>>;
  resumeWorkflowRun(request: { runId: string }, signal?: AbortSignal): Promise<RemoteAnswer<WorkflowRunDetailProjection>>;
  cancelWorkflowRun(request: { runId: string }, signal?: AbortSignal): Promise<RemoteAnswer<WorkflowRunDetailProjection>>;
  reconcileWorkflowApply(request: { runId: string }, signal?: AbortSignal): Promise<RemoteAnswer<WorkflowRunDetailProjection>>;
  watchWorkflowRuns(request: {
    sessionId: string;
    afterSequence: number;
    timeoutMs: number;
  }, signal?: AbortSignal): Promise<RemoteAnswer<{
    sequence: number;
    changed: boolean;
    runs: WorkflowRunProjection[];
  }>>;
}

export type JizuoWorkflowRemote = ClientJizuoWorkflowRemote;

export type { NativeShellHost, NativeShellSlots } from "./shell-host.ts";

export interface ClientOptions { hostUi?: "jizuo" | "native" }

interface NativeShellDependencies extends ClientOptions {
  remote: JizuoContentRemote & MemoryPalaceOverlayRemote & WorkLocationsRemote & Partial<ClientJizuoWorkflowRemote>;
  account?: AccountRemote;
  about?: { version: string; remote: AboutJizuoRemote };
  updates?: UpdateNoticeStore;
  modelOutputs?: ModelOutputSettingsRemote;
  mediaModels?: MediaSettingsRemote;
  pickImportFile?: () => Promise<ImportFileSelection | null>;
  pickExportFile?: (input: { title: string; format: NovelFileFormat }) => Promise<string | null>;
  pickWorkDirectory?: () => Promise<string | null>;
  replaceWorksWatchRoots?: (roots: string[]) => Promise<void>;
  subscribeWorksChanges?: SubscribeWorksChanges;
  workflowSessions?: WorkflowSessionSource;
  videoComposer?: MainVideoComposer;
  draftImagesFor?: Parameters<typeof MainVideoComposerFooter>[0]["draftImagesFor"];
}

export interface ImportFileSelection {
  sourcePath: string;
  format: "text" | "docx";
}

type DesktopInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export async function pickImportFileFromDesktop(
  currentUrl: string,
  invokeCommand: DesktopInvoke = invoke,
): Promise<ImportFileSelection | null> {
  const value = await invokeCommand("pick_import_file", {
    controlToken: desktopControlToken(currentUrl),
  });
  if (value === null) return null;
  if (typeof value !== "object") throw new Error("文件选择器返回了无效结果");
  const candidate = value as Partial<ImportFileSelection>;
  if (typeof candidate.sourcePath !== "string"
    || (candidate.format !== "text" && candidate.format !== "docx")) {
    throw new Error("文件选择器返回了无效结果");
  }
  return { sourcePath: candidate.sourcePath, format: candidate.format };
}

export async function pickExportFileFromDesktop(
  currentUrl: string,
  input: { title: string; format: NovelFileFormat | "video" },
  invokeCommand: DesktopInvoke = invoke,
): Promise<string | null> {
  const result = await invokeCommand("pick_export_file", { controlToken: desktopControlToken(currentUrl), ...input });
  if (result === null) return null;
  if (typeof result !== "string" || result.trim() === "") throw new Error("导出位置无效");
  return result;
}

export async function pickWorkDirectoryFromDesktop(
  currentUrl: string,
  invokeCommand: DesktopInvoke = invoke,
): Promise<string | null> {
  const value = await invokeCommand("pick_work_directory", {
    controlToken: desktopControlToken(currentUrl),
  });
  if (value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("文件夹选择器返回了无效结果");
  }
  return value;
}

export async function replaceWorksWatchRootsFromDesktop(
  currentUrl: string,
  roots: string[],
  invokeCommand: DesktopInvoke = invoke,
): Promise<void> {
  await invokeCommand("replace_works_watch_roots", {
    roots,
    controlToken: desktopControlToken(currentUrl),
  });
}

export async function checkForUpdatesFromDesktop(
  currentUrl: string,
  invokeCommand: DesktopInvoke = invoke,
): Promise<void> {
  await invokeCommand("check_for_updates", {
    controlToken: desktopControlToken(currentUrl),
  });
}

function unwrap<T>(answer: RemoteAnswer<T>, fallback: string): T {
  if (!answer.ok || answer.value === undefined) {
    const error = new Error(answer.error?.message ?? fallback) as Error & { code?: string };
    if (answer.error?.code !== undefined) error.code = answer.error.code;
    throw error;
  }
  return answer.value;
}

function invokeWithSignal<TRequest, TResult>(
  invokeRemote: (request: TRequest, signal?: AbortSignal) => Promise<TResult>,
  request: TRequest,
  signal: AbortSignal | undefined,
): Promise<TResult> {
  return signal === undefined ? invokeRemote(request) : invokeRemote(request, signal);
}

export function jizuoRemote(remote: JizuoHostRemote): JizuoContentRemote & MemoryPalaceOverlayRemote & JizuoWorkflowRemote & WorkLocationsRemote & MediaSettingsRemote & MediaLibraryRemote & SpeechSettingsRemote {
  return {
    ...(remote.getChatMedia ? {getChatMedia: async (input:{sessionId:string},signal?:AbortSignal) => unwrap(await remote.getChatMedia!(input,signal),"聊天媒体记录读取失败")} : {}),
    getMediaLibrary: async () => unwrap(await remote.getMediaLibrary({}), "模型目录加载失败"),
    saveMediaProvider: async (input) => unwrap(await remote.saveMediaProvider(input), "服务商保存失败"),
    setDefaultMediaModels: async (input) => unwrap(await remote.setDefaultMediaModels(input), "默认模型保存失败"),
    discoverMediaModels: async (input) => unwrap(await remote.discoverMediaModels(input), "模型列表获取失败"),
    getMediaSettings: async () => unwrap(await remote.getMediaSettings({}), "媒体模型加载失败"),
    saveMediaSettings: async (input) => unwrap(await remote.saveMediaSettings(input), "媒体模型保存失败"),
    saveMediaConnection: async (input) => unwrap(await remote.saveMediaConnection(input), "媒体模型保存失败"),
    manageMediaConnection: async (input) => unwrap(await remote.manageMediaConnection(input), "媒体模型更新失败"),
    deleteVideoItem: async (input) => unwrap(await remote.deleteVideoItem(input), "删除失败"),
    renameVideoAsset: async (input) => unwrap(await remote.renameVideoAsset(input), "素材重命名失败"),
    getVideoTimelineHistory: async (input) => unwrap(await remote.getVideoTimelineHistory(input), "剪辑历史失败"),
    restoreVideoTimeline: async (input) => unwrap(await remote.restoreVideoTimeline(input), "剪辑恢复失败"),
    startVideoProduction: async (input) => unwrap(await remote.startVideoProduction(input), "自动制作启动失败"),
    controlVideoProduction: async (input) => unwrap(await remote.controlVideoProduction(input), "自动制作操作失败"),
    saveVideoExport: async (input) => {
      const destination = await pickExportFileFromDesktop(window.location.href, { title: input.title, format: "video" });
      return destination === null ? null : unwrap(await remote.copyVideoExport({ workId: input.workId, assetId: input.assetId, destination }), "成片保存失败");
    },
    roughCutVideo: async (input) => unwrap(await remote.roughCutVideo(input), "剪辑配音操作失败"),
    getVideoClipFrames: async (input) => unwrap(await remote.getVideoClipFrames(input), "提取首末帧失败"),
    editVideoTimeline: async (input) => unwrap(await remote.editVideoTimeline(input), "剪辑配音操作失败"),
    exportVideo: async (input) => unwrap(await remote.exportVideo(input), "剪辑配音操作失败"),
    generateVideoSpeech: async (input) => unwrap(await remote.generateVideoSpeech(input), "剪辑配音操作失败"),
    getSpeechSettings: async () => unwrap(await remote.getSpeechSettings({}), "配音设置加载失败"),
    saveSpeechSettings: async (input) => unwrap(await remote.saveSpeechSettings(input), "配音设置保存失败"),
    submitVideoBatch: async (input) => unwrap(await remote.submitVideoBatch(input), "批量生成失败"),
    generateVideoMedia: async (input) => unwrap(await remote.generateVideoMedia(input), "生成任务提交失败"),
    controlVideoJob: async (input) => unwrap(await remote.controlVideoJob(input), "任务操作失败"),
    saveVideoDesign: async (input) => unwrap(await remote.saveVideoDesign(input), "设定操作失败"),
    saveWorkVisualStyle: async (input) => unwrap(await remote.saveWorkVisualStyle(input), "画风保存失败"),
    undoStyledPrompts: async (input) => unwrap(await remote.undoStyledPrompts(input), "提示词撤销失败"),
    tagVideoAsset: async (input) => unwrap(await remote.tagVideoAsset(input), "设定操作失败"),
    extractVideoDesigns: async (input) => unwrap(await remote.extractVideoDesigns(input), "设定操作失败"),
    importVideoAsset: async (input) => unwrap(await remote.importVideoAsset(input), "素材导入失败"),
    selectVideoAsset: async (input) => unwrap(await remote.selectVideoAsset(input), "素材选择失败"),
    getVideoAssetUrl: async (input) => unwrap(await remote.getVideoAssetUrl(input), "素材预览失败"),
    discussVideoPrompt: async (input) => unwrap(await remote.discussVideoPrompt(input), "提示词讨论失败"),
    adaptVideoEpisode: async (input) => unwrap(await remote.adaptVideoEpisode(input), "制作稿生成失败"),
    getVideoProject: async (input, signal) => unwrap(await remote.getVideoProject(input, ...(signal ? [signal] as const : [])), "视频项目加载失败"),
    ...(remote.getVideoProjectView ? {getVideoProjectView: async (input: import("@jizuo/contracts").GetVideoProjectViewInput, signal?: AbortSignal) => unwrap(await remote.getVideoProjectView!(input, ...(signal ? [signal] as const : [])), "视频章节加载失败")} : {}),
    ...(remote.getVideoJobUpdates ? {getVideoJobUpdates: async (input: import("@jizuo/contracts").GetVideoJobUpdatesInput, signal?: AbortSignal) => unwrap(await remote.getVideoJobUpdates!(input, ...(signal ? [signal] as const : [])), "生成进度刷新失败")} : {}),
    createVideoEpisode: async (input) => unwrap(await remote.createVideoEpisode(input), "视频集创建失败"),
    deleteVideoEpisode: async (input) => unwrap(await remote.deleteVideoEpisode(input), "视频集删除失败"),
    updateVideoEpisode: async (input) => unwrap(await remote.updateVideoEpisode(input), "视频制作稿保存失败"),
    ...(remote.getVideoWorkLocations && remote.setCreateVideoWorkLocation && remote.resetCreateVideoWorkLocation ? { video: {
      get: async () => unwrap(await remote.getVideoWorkLocations!({}), "视频存储位置加载失败"),
      setCreateRoot: async (path: string) => unwrap(await remote.setCreateVideoWorkLocation!({ path }), "视频存储位置保存失败"),
      resetCreateRoot: async () => unwrap(await remote.resetCreateVideoWorkLocation!({}), "视频存储位置恢复失败"),
    } } : {}),
    get: async () => unwrap(await remote.getWorkLocations({}), "作品存储位置加载失败"),
    setCreateRoot: async (path) => unwrap(
      await remote.setCreateWorkLocation({ path }),
      "作品存储位置保存失败",
    ),
    resetCreateRoot: async () => unwrap(
      await remote.resetCreateWorkLocation({}),
      "作品存储位置恢复失败",
    ),
    listWorks: async () => unwrap(await remote.listWorks({}), "作品列表加载失败"),
    resolveChapterPath: async (target) => unwrap(await remote.resolveChapterPath(target), "章节目录读取失败"),
    resolveWorkPath: async (workId) => unwrap(
      await remote.resolveWorkPath({ workId }),
      "作品目录读取失败",
    ),
    createWork: async (request) => unwrap(await remote.createWork(request), "作品创建失败"),
    exportWork: async (request) => unwrap(await remote.exportWork(request), "导出失败"),
    searchWork: async (request) => unwrap(await remote.searchWork(request), "搜索失败"),
    previewImport: async (request) => unwrap(await remote.previewImport(request), "导入预览失败"),
    applyImport: async (request) => unwrap(await remote.applyImport(request), "作品导入失败"),
    renameWork: async (request) => unwrap(await remote.renameWork(request), "作品重命名失败"),
    listVolumes: async (request) => unwrap(await remote.listVolumes(request), "分卷列表加载失败"),
    createVolume: async (request) => unwrap(await remote.createVolume(request), "分卷创建失败"),
    renameVolume: async (request) => unwrap(await remote.renameVolume(request), "分卷重命名失败"),
    saveVolumeOutline: async (request) => unwrap(
      await remote.saveVolumeOutline(request),
      "分卷大纲保存失败",
    ),
    listChapters: async (request) => unwrap(await remote.listChapters(request), "章节列表加载失败"),
    createChapter: async (request) => unwrap(await remote.createChapter(request), "章节创建失败"),
    renameChapter: async (request) => unwrap(await remote.renameChapter(request), "章节重命名失败"),
    inspectTrashTarget: async (request) => unwrap(
      await remote.inspectTrashTarget(request),
      "删除影响检查失败",
    ),
    moveToTrash: async (request) => unwrap(await remote.moveToTrash(request), "移入回收站失败"),
    listTrash: async () => unwrap(await remote.listTrash({}), "回收站加载失败"),
    restoreFromTrash: async (request) => unwrap(await remote.restoreFromTrash(request), "恢复失败"),
    deleteFromTrash: async (request) => unwrap(await remote.deleteFromTrash(request), "永久删除失败"),
    readChapter: async (request) => unwrap(await remote.readChapter(request), "章节读取失败"),
    replaceChapter: async (request) => unwrap(await remote.replaceChapter(request), "章节保存失败"),
    saveChapterOutline: async (request) => unwrap(
      await remote.saveChapterOutline(request),
      "章节大纲保存失败",
    ),
    listProposals: async (request) => unwrap(await remote.listProposals(request), "提案列表加载失败"),
    getProposalPreview: async (proposalId) => unwrap(
      await remote.getProposalPreview({ proposalId }),
      "提案预览加载失败",
    ),
    rejectProposal: async (proposalId) => unwrap(
      await remote.rejectProposal({ proposalId }),
      "提案拒绝失败",
    ),
    authorizeProposal: async (proposalId) => unwrap(
      await remote.authorizeProposal({ proposalId }),
      "提案授权失败",
    ),
    applyProposal: async (request) => unwrap(await remote.applyProposal(request), "提案应用失败"),
    restoreChapterRevision: async (request) => unwrap(
      await remote.restoreChapterRevision(request),
      "章节版本恢复失败",
    ),
    listChapterRevisions: async (request, signal) => unwrap(
      await invokeWithSignal(remote.listChapterRevisions.bind(remote), request, signal),
      "章节历史加载失败",
    ),
    readChapterRevision: async (request) => unwrap(
      await remote.readChapterRevision(request),
      "章节历史正文加载失败",
    ),
    listChapterWorkflowRecords: async (request) => unwrap(
      await remote.listChapterWorkflowRecords(request),
      "章节流程记录加载失败",
    ),
    readChapterWorkflowRecord: async (request) => unwrap(
      await remote.readChapterWorkflowRecord(request),
      "章节流程记录正文加载失败",
    ),
    queryMemory: async (request) => unwrap(await remote.queryMemory(request), "记忆查询失败"),
    getDreamReport: async (workId) => unwrap(await remote.getDreamReport({ workId }), "梦境进度加载失败"),
    getDreamConversations: async (target) => unwrap(await remote.getDreamConversations(target), "模型对话详情加载失败"),
    listDreamModels: async () => unwrap(await remote.listDreamModels({}), "梦境模型加载失败"),
    getMemorySuggestion: async (workId, episodeKey) => unwrap(await remote.getMemorySuggestion({ workId, episodeKey }), "候选详情加载失败"),
    getDreamStatus: async (workId) => unwrap(await remote.getDreamStatus({ workId }), "梦境状态加载失败"),
    controlDream: async (workId, command) => unwrap(await remote.controlDream({ workId, command }), "梦境操作失败"),
    touchDreamActivity: async (workId, chapterId) => unwrap(await remote.touchDreamActivity({ workId, ...(chapterId ? { chapterId } : {}) }), "梦境状态更新失败"),
    getDreamSettings: async (workId) => unwrap(
      await remote.getDreamSettings({ workId }),
      "梦境设置加载失败",
    ),
    saveDreamSettings: async (workId, settings) => unwrap(
      await remote.saveDreamSettings({ workId, ...settings }),
      "梦境设置保存失败",
    ),
    listMemorySuggestions: async (workId) => unwrap(
      await remote.listMemorySuggestions({ workId }),
      "梦境建议加载失败",
    ),
    acceptMemorySuggestion: async (workId, episodeKey) => unwrap(
      await remote.acceptMemorySuggestion({ workId, episodeKey }),
      "梦境建议接受失败",
    ),
    rejectMemorySuggestion: async (workId, episodeKey) => unwrap(
      await remote.rejectMemorySuggestion({ workId, episodeKey }),
      "梦境建议拒绝失败",
    ),
    listWorkflowRuns: async (request, signal) => unwrap(
      await invokeWithSignal(remote.listWorkflowRuns.bind(remote), request, signal),
      "章节工作流列表加载失败",
    ),
    getWorkflowRun: async (request, signal) => unwrap(
      await invokeWithSignal(remote.getWorkflowRun.bind(remote), request, signal),
      "章节工作流详情加载失败",
    ),
    decideWorkflowApproval: async (request, signal) => unwrap(
      await invokeWithSignal(remote.decideWorkflowApproval.bind(remote), request, signal),
      "章节工作流审批失败",
    ),
    extendWorkflowBudget: async (request, signal) => unwrap(
      await invokeWithSignal(remote.extendWorkflowBudget.bind(remote), request, signal),
      "章节工作流预算扩展失败",
    ),
    pauseWorkflowRun: async (request, signal) => unwrap(
      await invokeWithSignal(remote.pauseWorkflowRun.bind(remote), request, signal),
      "章节工作流暂停失败",
    ),
    resumeWorkflowRun: async (request, signal) => unwrap(
      await invokeWithSignal(remote.resumeWorkflowRun.bind(remote), request, signal),
      "章节工作流恢复失败",
    ),
    cancelWorkflowRun: async (request, signal) => unwrap(
      await invokeWithSignal(remote.cancelWorkflowRun.bind(remote), request, signal),
      "章节工作流取消失败",
    ),
    reconcileWorkflowApply: async (request, signal) => unwrap(
      await invokeWithSignal(remote.reconcileWorkflowApply.bind(remote), request, signal),
      "章节工作流应用对账失败",
    ),
    watchWorkflowRuns: async (request, signal) => unwrap(
      await invokeWithSignal(remote.watchWorkflowRuns.bind(remote), request, signal),
      "章节工作流状态订阅失败",
    ),
  };
}

type NativeChapterRead = (target: ChapterTarget) => Promise<ChapterDocument>;

/**
 * Keep chapter inspection responsive while the conversation transport is busy.
 * The native boundary is read-only; every mutation continues through the
 * canonical Host domain service. Browser and diagnostic surfaces retain the
 * existing Remote path as a compatibility fallback.
 */
export function preferDesktopChapterReads<T extends JizuoContentRemote>(
  remote: T,
  nativeRead: NativeChapterRead,
): T {
  return {
    ...remote,
    readChapter: async (target) => {
      try {
        return await nativeRead(target);
      } catch {
        return remote.readChapter(target);
      }
    },
  };
}

interface WorkflowSessionsPort {
  readonly list: {
    getSnapshot(): { current: string | undefined };
    subscribe(listener: () => void): () => void;
  };
}

/** Harness 0.1.7 exposes the active main view through session retention. */
export function nativeCurrentSessionId(sessions: { list: { getSnapshot(): { current?: string | undefined; byId?: Readonly<Record<string, { id: string; retainedBy?: Readonly<{ mainView?: number }> }>> } } }): SessionId | undefined {
  const snapshot = sessions.list.getSnapshot();
  return (Object.values(snapshot.byId ?? {}).find(item => (item.retainedBy?.mainView ?? 0) > 0)?.id ?? snapshot.current) as SessionId | undefined;
}

/**
 * The host session id is the exact `exec.agent.session.id` captured when a
 * workflow starts.  Read it only from the injected sessions service; the
 * conversation service is not an identity source and can be absent in docks.
 */
export function workflowSessionSource(ctx: Context): WorkflowSessionSource {
  let sessions: WorkflowSessionsPort | undefined;
  try {
    sessions = ctx.sessions as unknown as WorkflowSessionsPort | undefined;
  } catch {
    // Cordis throws when an undeclared service is read. Convert that bootstrap
    // configuration failure into a displayable, typed unavailable state.
    throw new WorkflowStoreUnavailableError("章节工作流不可用：会话服务未注入");
  }
  if (sessions?.list === undefined) {
    throw new WorkflowStoreUnavailableError("章节工作流不可用：会话服务未注入");
  }
  return {
    getCurrentSessionId: () => nativeCurrentSessionId(sessions),
    subscribe: (listener) => sessions.list.subscribe(listener),
  };
}

function hasWorkflowRemote(
  remote: NativeShellDependencies["remote"],
): remote is NativeShellDependencies["remote"] & ClientJizuoWorkflowRemote {
  return [
    remote.listWorkflowRuns,
    remote.getWorkflowRun,
    remote.decideWorkflowApproval,
    remote.extendWorkflowBudget,
    remote.pauseWorkflowRun,
    remote.resumeWorkflowRun,
    remote.cancelWorkflowRun,
    remote.reconcileWorkflowApply,
    remote.watchWorkflowRuns,
  ].every((method) => typeof method === "function");
}

function overlayKey(): string {
  const selection = getSelection();
  return [selection.overlay, selection.workId, selection.volumeId, selection.chapterId, selection.episodeId].join(":");
}

export function appendChapterExcerptToCurrentConversation(
  ctx: Context,
  quote: ChapterExcerptQuote,
): boolean {
  const current = nativeCurrentSessionId(ctx.sessions);
  if (current === undefined) return false;
  const binding = ctx.sessions.binding(current);
  if (binding === undefined) return false;
  const input = ctx.conversation.input.for(binding.ctx);
  const draft = input.state.getSnapshot().draft;
  const separator = draft === "" ? "" : draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n";
  if (separator !== "") input.setDraft(`${draft}${separator}`);
  const snapshot = input.state.getSnapshot();
  const reference = createChapterExcerptReference(quote);
  const focusComposer = (): void => {
    queueMicrotask(() => {
      document.querySelector<HTMLTextAreaElement>("textarea[data-phase]:not([disabled])")?.focus();
    });
  };
  const insertPlainTextFallback = (): true => {
    input.setDraft(`${snapshot.draft}${reference.clipboardText}`);
    input.notify("info", "已将章节内容加入当前对话");
    focusComposer();
    return true;
  };
  let inserted = false;
  try {
    inserted = input.insertReference(reference, {
      start: snapshot.draft.length,
      end: snapshot.draft.length,
      draftRev: snapshot.draftRev,
    });
  } catch {
    return insertPlainTextFallback();
  }
  if (!inserted) return insertPlainTextFallback();
  focusComposer();
  return true;
}

export function subscribeToDesktopWorksChanges(listener: () => void): Promise<() => void> {
  return listen("jizuo://works-changed", () => { listener(); });
}

export function registerComposerModelTypeControl(
  slots: NativeShellSlots,
  dependencies: {
    remote: JizuoContentRemote;
    composer: MainVideoComposer;
    availableFor(sessionId: string): boolean;
    inputFor(sessionId: string): ComposerInputPhaseStore | undefined;
  },
): () => void {
  return slots.inject("conversation.input.right", () => slots.register({
    name: "conversation.input.right", id: "jizuo-composer-model-type", order: 100,
    inject: (sessionId: string) => ({
      remote: dependencies.remote, composer: dependencies.composer,
      available: dependencies.availableFor(sessionId),
      inputStore: dependencies.inputFor(sessionId),
    }),
  }, ComposerModelTypeControl));
}

/** Match optional UI lifetimes to the separately loaded feature clients. */
function registerForCreationFeature(id: WorkspacePluginId, install: () => () => void): () => void {
  let stop: (() => void) | undefined;
  const sync = () => {
    const enabled = !!creationPanels(id) && isBuiltinPluginEnabled(id);
    if (enabled && !stop) stop = install();
    else if (!enabled && stop) { stop(); stop = undefined; }
  };
  const stopPanels = subscribeCreationPanels(sync);
  const stopPreferences = subscribeWorkspacePlugins(sync);
  sync();
  return () => { stopPanels(); stopPreferences(); stop?.(); };
}

export function registerNativeShellContributions(
  host: NativeShellHost,
  {
    remote,
    account,
    about,
    updates,
    modelOutputs,
    mediaModels,
    pickImportFile,
    pickExportFile,
    pickWorkDirectory,
    replaceWorksWatchRoots,
    subscribeWorksChanges,
    workflowSessions,
    videoComposer,
    draftImagesFor,
    hostUi = "jizuo",
  }: NativeShellDependencies,
): () => void {
  const feature = (id: WorkspacePluginId, install: () => () => void) => hostUi === "native"
    ? registerForCreationFeature(id, install) : install();
  const stopLocalDirectory = registerLocalDirectoryQuery(remote);
  const stopVideoComposer = videoComposer ? feature("video", () => host.slots.inject("conversation.input.left", () => host.slots.register({
    name: "conversation.input.left", id: "jizuo-main-video-composer", order: -21,
    inject: () => ({ remote, composer: videoComposer, draftImagesFor }),
  }, MainVideoComposerFooter))) : () => {};
  const stopWorkspaceAccess = ["conversation.hero.actions", "conversation.session.header.actions"].map(name =>
    host.slots.inject(name, () => host.slots.register({name, id: "jizuo-workspace-access", order: -20}, ComposerWorkspaceAccess)));
  const stopWorkflowProgress = hostUi !== "native" && workflowSessions !== undefined && hasWorkflowRemote(remote)
    ? host.slots.inject(
      "conversation.input.dock",
      () => host.slots.register(
        {
          name: "conversation.input.dock",
          id: "jizuo-chapter-workflow-progress",
          order: -19,
          inject: () => ({
            remote,
            sessions: workflowSessions,
          }),
        },
        ChapterWorkflowProgressDock,
      ),
    )
    : () => undefined;

  const stopHeroBrand = hostUi === "native" ? () => {} : host.slots.inject(
    "conversation.hero.brand.mark",
    () => host.slots.register(
      { name: "conversation.hero.brand.mark", id: "jizuo-brand-mark", priority: -1 },
      JizuoHeroBrand,
    ),
  );

  const navigation = createSessionNavigation(host, remote);
  const stopSidebar = hostUi === "native" ? registerNativeCreationNavigation() : host.slots.inject("sidebar", () => host.slots.register({
    name: "sidebar",
    priority: -1,
    children: {
      "sidebar.workspaces": { kind: "single", scope: "root" },
      "sidebar.settings": { kind: "single", scope: "root" },
      "sidebar.footer.action": { kind: "list", scope: "root" },
    },
    inject: () => ({
      remote,
      pickImportFile,
      ...(pickExportFile ? { pickExportFile } : {}),
      subscribeWorksChanges,
      startSession: (workspaceId?: WorkspaceId) => { host.uiWorkspace.startSession(workspaceId); },
      startWorkSession: navigation.openWork,
      sessionNavigation: navigation,
      toggleSidebar: () => { host.layout.toggleSidebar(); },
    }),
  }, JizuoSidebarRoot));

  function registerNativeCreationNavigation(): () => void {
    let stops: Array<() => void> = [];
    const configs = new Map<string, () => void>();
    const sync = () => {
      for (const { id } of WORKSPACE_PLUGINS) {
        if (!creationPanels(id)) { configs.get(id)?.(); configs.delete(id); continue; }
        if (configs.has(id)) continue;
        configs.set(id, host.slots.inject("plugins.bundle.config", () => host.slots.register({
          name: "plugins.bundle.config", key: `@jizuo/${id}-plugin`,
          inject: () => id === "memory" ? { remote, subscribeWorksChanges } : {
            remote: id === "video" ? remote.video : remote,
            title: id === "video" ? "视频项目存储" : "小说存储",
            ...(pickWorkDirectory ? { pickDirectory: pickWorkDirectory } : {}),
          },
        }, id === "memory" ? DreamMemorySettings : id === "video" && !remote.video
          ? () => <p role="status">视频项目存储暂不可用，请更新即作创作插件后重试。</p>
          : StorageLocation)));
      }
      const enabled = WORKSPACE_PLUGINS.some(({ id }) => creationPanels(id) && isBuiltinPluginEnabled(id));
      if (enabled === (stops.length > 0)) return;
      if (!enabled) { stops.splice(0).reverse().forEach(stop => stop()); return; }
      stops.push(host.slots.inject("sidebar.workspaces", () => host.slots.register({
        name: "sidebar.workspaces", id: "jizuo-workspaces", priority: -10,
        inject: () => ({ host, remote, pickImportFile, pickExportFile, subscribeWorksChanges,
          sessionNavigation: navigation, openWorkSession: navigation.openWork }),
      }, NativeWorkspaces)));
    };
    const stopPanels = subscribeCreationPanels(sync);
    const stopPreferences = subscribeWorkspacePlugins(sync);
    sync();
    return () => { stopPanels(); stopPreferences(); stops.reverse().forEach(stop => stop()); configs.forEach(stop => stop()); };
  }

  const stopOverlay = host.slots.inject("shell.overlay", () => {
    let disposeOccupant: (() => void) | undefined;
    let mountedKey = "";
    const release = (): void => {
      disposeOccupant?.();
      disposeOccupant = undefined;
      mountedKey = "";
    };
    const sync = (): void => {
      const selection = getSelection();
      const nextKey = overlayKey();
      if (selection.overlay === null) {
        release();
        return;
      }
      if (disposeOccupant !== undefined && mountedKey === nextKey && creationPanels(pluginForOverlay(selection.overlay)!.id) && isWorkspacePluginEnabled(selection.workId, pluginForOverlay(selection.overlay)!.id)) return;
      release();
      mountedKey = nextKey;
      const owner = pluginForOverlay(selection.overlay);
      if (!owner || !isWorkspacePluginEnabled(selection.workId, owner.id)) return;
      const panels = creationPanels(owner.id)?.(host, remote, subscribeWorksChanges, navigation);
      disposeOccupant = panels?.[selection.overlay]?.();
    };
    const stopPlugins = subscribeCreationPanels(sync);
    const stopSelection = subscribeSelection(sync);
    const stopPreferences = subscribeWorkspacePlugins(sync);
    sync();
    return () => {
      stopPlugins();
      stopSelection();
      stopPreferences();
      release();
    };
  });

  const stopBuiltinPlugins = hostUi === "native" ? () => {} : host.slots.inject("settings.plugins.tab", () => host.slots.register({
    name: "settings.plugins.tab", id: "jizuo-creation-plugins", order: -10,
    label: () => "创作插件",
  }, BuiltinPluginsSettings));
  const stopSettings = account && host.slots.inject("settings.section", () => host.slots.register({
    name: "settings.section",
    id: "account",
    order: 5,
    label: () => "账号",
    inject: () => ({ account }),
  }, JizuoSettingsCard));
  const stopModelOutputs = modelOutputs ? ["llm-pi-ai", "llm-deepseek"].map((key) => host.slots.inject("settings.models.provider-card", () => host.slots.register({
    name: "settings.models.provider-card", key, inject: () => ({ remote: modelOutputs }),
  }, ProviderModelsSettings))) : [];
  const stopMediaModels = mediaModels && feature("video", () => host.slots.inject("settings.models.footer", () => host.slots.register({
    name: "settings.models.footer", id: "jizuo-media-models", order: 15,
    inject: () => ({ remote: mediaModels }),
  }, MediaModelsSettings)));
  const stopDreamSettings = hostUi === "native" ? () => {} : host.slots.inject("settings.section", () => host.slots.register({
    name: "settings.section", id: "jizuo-dream-memory", order: 30, label: () => "梦境记忆",
    inject: () => ({ remote, subscribeWorksChanges }),
  }, DreamMemorySettings));
  const stopWorkStorage = hostUi === "native" ? () => {} : host.slots.inject("settings.section", () => host.slots.register({
    name: "settings.section",
    id: "jizuo-work-storage",
    order: 20,
    label: () => "作品存储",
    inject: () => ({
      remote,
      ...(pickWorkDirectory ? { pickDirectory: pickWorkDirectory } : {}),
      ...(replaceWorksWatchRoots === undefined ? {} : {
        syncLocations: async () => {
          const [novels, videos] = await Promise.all([remote.get(), remote.video?.get()]);
          await replaceWorksWatchRoots([...new Set([...novels.roots, ...(videos?.roots ?? [])])]);
        },
      }),
    }),
  }, WorkStorageSettings));
  const stopAbout = about && host.slots.inject("settings.section", () => host.slots.register({
    name: "settings.section",
    id: "jizuo-about",
    order: 90,
    label: () => "关于即作",
    inject: () => about,
  }, AboutJizuo));
  const stopUpdates = updates && host.slots.inject("shell.overlay", () => host.slots.register({
    name: "shell.overlay", id: "jizuo-update-notice", order: 100,
    inject: () => ({ store: updates }),
  }, UpdateNoticeDialog));

  return () => {
    stopUpdates?.();
    stopAbout?.();
    stopWorkStorage?.();
    stopModelOutputs.forEach((stop) => stop());
    stopDreamSettings();
    stopMediaModels?.();
    stopBuiltinPlugins();
    stopSettings?.();
    stopOverlay();
    stopLocalDirectory();
    navigation.dispose();
    stopSidebar();
    stopHeroBrand();
    stopWorkflowProgress();
    stopVideoComposer();
    stopWorkspaceAccess.forEach(stop => stop());
  };
}

export const inject = ["slots", "remote", "layout", "workspaces", "uiWorkspace", "sessions", "conversation"];

export async function apply(ctx: Context, options: ClientOptions = {}): Promise<() => Promise<void>> {
  // Runtime capability, never token absence, determines the browser adapter.
  const desktop = isTauri() || "__TAURI_INTERNALS__" in window;
  if (desktop) desktopControlToken(window.location.href);
  // Feature clients contribute panel factories without invoking remote methods.
  // Publish this synchronous capability before remote mounting can yield: the
  // native shell audits feature activation before starting its transport loop.
  creationClientApi.preferences.trackWorkspacePluginAvailability();
  ctx.provide("jizuoCreationClient", creationClientApi);
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
  const rawHostRemote = ctx.get("remote.jizuo") as JizuoHostRemote | undefined;
  if (rawHostRemote === undefined) {
    await disposeRemote();
    throw new Error("jizuo: Host remote unavailable after mount");
  }

  const stopClientErrors = desktop ? installClientErrors(entry => invoke("record_client_error", {
    entry,
    controlToken: desktopControlToken(window.location.href),
  }), window) : () => {};
  const hostRemote = observeClientRemote(rawHostRemote);

  const remote = desktop ? preferDesktopChapterReads(
    jizuoRemote(hostRemote),
    (target) => invoke<ChapterDocument>("read_chapter_local", {
      target,
      controlToken: desktopControlToken(window.location.href),
    }),
  ) : jizuoRemote(hostRemote);
  const account = desktop ? createAccountRemote(hostRemote, {
    currentUrl: () => window.location.href,
    openExternal: async (url) => { await openUrl(url); },
    describeCredential: (credentialRef, controlToken) => invoke("credential_describe", {
      credentialRef,
      controlToken,
    }),
    setCredential: (credentialRef, value, controlToken) => invoke("credential_set", {
      credentialRef,
      value,
      controlToken,
    }),
    deleteCredential: (credentialRef, controlToken) => invoke("credential_delete", {
      credentialRef,
      controlToken,
    }),
  }) : undefined;
  let workflowSessions: WorkflowSessionSource | undefined;
  try {
    if (options.hostUi !== "native") workflowSessions = workflowSessionSource(ctx);
  } catch (reason) {
    // A partially embedded Harness surface may not expose sessions.  Keep the
    // rest of the writing UI usable; the dock is deliberately optional there.
    console.warn("jizuo: workflow progress dock unavailable", reason);
  }
  const installedVersion = desktop ? await getVersion().catch((reason: unknown) => {
    console.warn("jizuo: installed version unavailable", reason);
    return "无法读取";
  }) : "";

  const updateListeners = new Set<() => void>();
  let updateNotice: UpdateNotice | null = null;
  const setUpdateNotice = (notice: UpdateNotice | null) => {
    updateNotice = notice;
    updateListeners.forEach(listener => listener());
  };
  const updateStore: UpdateNoticeStore = {
    getSnapshot: () => updateNotice,
    subscribe: listener => { updateListeners.add(listener); return () => { updateListeners.delete(listener); }; },
    respond: (id, accept) => invoke("respond_to_update_notice", {
      id, accept, controlToken: desktopControlToken(window.location.href),
    }),
  };
  const stopUpdateEvents = desktop ? await listen<UpdateNotice | null>("jizuo://update-notice", event => {
    setUpdateNotice(event.payload);
  }).catch(() => () => {}) : () => {};
  const initialUpdateNotice = desktop ? await invoke<UpdateNotice | null>("get_update_notice", {
    controlToken: desktopControlToken(window.location.href),
  }).catch(() => null) : null;
  if (updateNotice === null) setUpdateNotice(initialUpdateNotice);

  const stopDreamEvents = desktop ? await listen<string>("jizuo://dream-command", (event) => {
    const commands: readonly string[] = ["run_now", "pause", "resume", "skip_tonight", "stop_before_exit"];
    if (commands.includes(event.payload)) void hostRemote.controlDream({ command: event.payload as DreamCommand })
      .catch(() => { console.warn("jizuo: dream tray command failed"); });
  }).catch(() => () => {}) : () => {};

  const imageChatListeners = new Set<(sessionId: string) => void>();
  const imageChat = createImageChatStore(remote, {
    storage: { getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value) },
    changed: sessionId => imageChatListeners.forEach(listener => listener(sessionId)),
  });
  const stopImageChatActivity = bindImageChatActivity({
    isActive: sessionId => imageChat.getSnapshot(sessionId).length > 0 || imageChat.getError(sessionId) !== undefined,
    ensure: sessionId => imageChat.ensure(sessionId),
    subscribe: listener => { imageChatListeners.add(listener); return () => { imageChatListeners.delete(listener); }; },
  });
  const videoSlots: NativeShellSlots = options.hostUi === "native" ? {
    inject: (name, install) => registerForCreationFeature("video", () => (ctx.slots as unknown as NativeShellSlots).inject(name, install)),
    register: (registration, component) => (ctx.slots as unknown as NativeShellSlots).register(registration, component),
  } : ctx.slots as unknown as NativeShellSlots;
  const stopImageChat = videoSlots.inject("conversation.chat.media", () =>
    (ctx.slots as unknown as NativeShellSlots).register({ name: "conversation.chat.media", id: "jizuo-image-generation-history", order: 0,
      inject: () => ({ remote, store: imageChat }),
    }, ChatImageConversation));
  const videoComposer = createMainVideoComposer(remote, sessionId => {
    const binding = ctx.sessions.binding(sessionId as Parameters<typeof ctx.sessions.binding>[0]);
    if (!binding) return undefined;
    const input = ctx.conversation.input.for(binding.ctx);
    return {
      state: input.state,
      setDraft: (text) => input.setDraft(text),
      insertReference: (reference, span) => {
        const nativeSpan = composerDetectSpan(input.state.getSnapshot(), span);
        return nativeSpan !== undefined && input.insertReference(reference, nativeSpan);
      },
      insertText: (text, span) => {
        const nativeSpan = composerDetectSpan(input.state.getSnapshot(), span);
        return nativeSpan !== undefined && binding.ctx.bail(binding.ctx, "slash/input-insert-text", { text, span: nativeSpan }) === true;
      },
      consumeSpan: (span) => {
        const snapshot = input.state.getSnapshot();
        if (snapshot.phase === "submitting" || snapshot.phase === "adjudicating") return false;
        const nativeSpan = composerDetectSpan(snapshot, span);
        return nativeSpan !== undefined && binding.ctx.bail(binding.ctx, "slash/input-consume-token", { guard: { kind: "span", span: nativeSpan } }) === true;
      },
    };
  }, imageChat);
  // The dispatch subject is the submitting session, including background
  // sessions; do not route from whichever conversation happens to be visible.
  const stopMediaSubmit = ctx.on("jizuo/input-submit-route", function (this: Context) {
    const sessionId = ctx.sessions.scopeOf(this);
    return sessionId === undefined ? undefined : videoComposer.submissionRoute(sessionId);
  });
  const attachWorkImage = createWorkImageIntake({ remote, composer: videoComposer, inputFor: sessionId => {
    const id = sessionId as Parameters<typeof ctx.sessions.binding>[0];
    const binding = ctx.sessions.binding(id);
    if (!binding) return undefined;
    const input = ctx.conversation.input.for(binding.ctx);
    const isBusy = () => ctx.sessions.binding(id) !== binding
      || binding.session.getSnapshot().removed === true
      || ["submitting", "adjudicating"].includes(input.state.getSnapshot().phase)
      || ctx.conversation.blocks.storeFor(id).getSnapshot() !== undefined;
    return { isBusy, addFile: file => {
      if (isBusy()) throw new Error("输入框正在提交，请稍后添加图片");
      // These concrete attachment methods are provided by the pinned native controller.
      const images = ctx.conversation as typeof ctx.conversation & Pick<ConversationController, "resolveDraftAttachments" | "createDrafts" | "releaseDraftAttachments">;
      if (!images.createDrafts || !images.resolveDraftAttachments || !images.releaseDraftAttachments) throw new Error("当前运行时无法添加图片附件");
      const limits = binding.session.projections.faceOf("imageLimits").getSnapshot() as { maxImagesPerMessage?: number; maxImageBytes?: number; maxMessageImageBytes?: number } | undefined;
      const current = images.resolveDraftAttachments(input.state.getSnapshot().attachmentIds);
      if (file.size > (limits?.maxImageBytes ?? 20 * 1024 * 1024) || current.length >= (limits?.maxImagesPerMessage ?? 20)
        || current.reduce((sum, item) => sum + item.file.size, file.size) > (limits?.maxMessageImageBytes ?? 200 * 1024 * 1024)) throw new Error("附件数量或总大小超出限制，请先移除部分图片");
      const attachments = images.createDrafts(id, [file]);
      if (!input.addAttachments(attachments.map(item => item.id))) {
        images.releaseDraftAttachments(attachments);
        throw new Error("图片添加失败，请重试");
      }
    } };
  } });
  const notifyImageDrop = (sessionId: string, message: string) => {
    const binding = ctx.sessions.binding(sessionId as Parameters<typeof ctx.sessions.binding>[0]);
    if (binding) ctx.conversation.input.for(binding.ctx).notify("error", userErrorMessage(message, "图片添加失败", { operation: "imageDrop" }));
  };
  const stopWorkImageDrop = videoSlots.inject("conversation.input.overlay", () =>
    (ctx.slots as unknown as NativeShellSlots).register({ name: "conversation.input.overlay", id: "jizuo-work-image-drop", order: 10,
      inject: () => ({ attach: attachWorkImage, notify: notifyImageDrop }),
    }, ComposerWorkImageDrop));
  const stopPromptReferencePreview = videoSlots.inject("conversation.input.overlay", () =>
    (ctx.slots as unknown as NativeShellSlots).register({ name: "conversation.input.overlay", id: "jizuo-prompt-reference-preview", order: 20,
      inject: (sessionId: string) => {
        const binding = ctx.sessions.binding(sessionId as Parameters<typeof ctx.sessions.binding>[0]);
        return { remote, inputStore: binding ? ctx.conversation.input.for(binding.ctx).state : undefined };
      },
    }, ComposerPromptPreview));
  // Keep the entry independent from the native text-model catalog and its load order.
  const stopModelType = registerComposerModelTypeControl(videoSlots, {
    remote, composer: videoComposer,
    availableFor: sessionId => ctx.sessions.subagentAddress(sessionId as Parameters<typeof ctx.sessions.subagentAddress>[0]) === undefined,
    inputFor: sessionId => {
      const binding = ctx.sessions.binding(sessionId as Parameters<typeof ctx.sessions.binding>[0]);
      return binding ? ctx.conversation.input.for(binding.ctx).state : undefined;
    },
  });
  const textModelBridgeScope = ctx.inject(["modelDirectories", "locale"], scope => {
    const directories = scope.get("modelDirectories") as {
      directoryFor(sessionId: string): { store: { getSnapshot(): { routable: boolean | null }; subscribe(listener: () => void): () => void } };
    };
    const modelText = (scope.get("locale") as { bind(namespace: string): (key: string) => string }).bind("model");
    const bridges = new Map<string, () => void>();
    const syncCurrentSession = () => {
      const sessionId = nativeCurrentSessionId(scope.sessions);
      if (sessionId === undefined || bridges.has(sessionId)) return;
      const binding = scope.sessions.binding(sessionId);
      if (!binding) return;
      const directory = directories.directoryFor(sessionId);
      const stop = bridgeComposerTextModelBlock({
        mode: { getSnapshot: () => videoComposer.getSnapshot(sessionId), subscribe: listener => videoComposer.subscribe(sessionId, listener) },
        directory: directory.store, block: scope.conversation.blocks.storeFor(sessionId),
        setBlock: value => scope.conversation.blocks.set(sessionId, value),
        textModelBlockReason: () => modelText("blocked.composer"),
      });
      bridges.set(sessionId, stop);
      binding.ctx.effect(() => () => { bridges.get(sessionId)?.(); bridges.delete(sessionId); });
    };
    scope.effect(() => scope.sessions.list.subscribe(syncCurrentSession));
    scope.effect(() => () => { bridges.forEach(stop => stop()); bridges.clear(); });
    syncCurrentSession();
  });
  const mediaTriggerScope = ctx.inject(["inputTriggers"], scope => {
    const triggers = scope.get("inputTriggers") as { registerSource(source: import("@deepseek-ai/dsh-client-ui-input-trigger/client").InputTriggerSource): () => void };
    for (const source of [videoComposer.episodeSource, videoComposer.imageSource, videoComposer.videoSource, videoComposer.audioSource, videoComposer.shotSource, videoComposer.designSource, videoComposer.editingSource, videoComposer.styleSource]) scope.effect(() => triggers.registerSource(source));
  });
  const stopShell = ctx.effect(() => registerNativeShellContributions({
    slots: ctx.slots as unknown as NativeShellSlots,
    workspaces: ctx.workspaces,
    sessions: {
      list: {
        getSnapshot: () => ({ ...ctx.sessions.list.getSnapshot(), current: nativeCurrentSessionId(ctx.sessions) }),
        subscribe: (listener) => ctx.sessions.list.subscribe(listener),
      },
      create: (input) => ctx.sessions.create(input),
      binding: (id) => ctx.sessions.binding(id as SessionId),
      open: (id) => ctx.uiWorkspace.openSession(id as SessionId),
    },
    uiWorkspace: ctx.uiWorkspace,
    layout: ctx.layout,
    conversation: {
      appendChapterExcerpt: (quote) => appendChapterExcerptToCurrentConversation(ctx, quote),
      generateStoryboard: async (request) => {
        const current = nativeCurrentSessionId(ctx.sessions);
        const binding = current === undefined ? undefined : ctx.sessions.binding(current);
        if (!binding) throw new Error("作品对话尚未就绪，请重试");
        const project = await remote.getVideoProject!({workId:request.workId});
        await sendToSessionConversation(binding.ctx, storyboardChatMessage(project, request));
      },
      appendVideoEpisode: (quote) => {
        const current = nativeCurrentSessionId(ctx.sessions);
        const binding = current === undefined ? undefined : ctx.sessions.binding(current);
        if (!binding) return false;
        const input = ctx.conversation.input.for(binding.ctx);
        if (!videoComposer.insertEpisode(current!, quote, quote.title)) return false;
        input.notify("info", "已将当前视频集加入对话");
        return true;
      },
    },
  }, {
    ...options,
    remote,
    ...(account ? { account } : {}),
    ...(desktop ? {
      about: {
        version: installedVersion,
        remote: { checkForUpdates: () => checkForUpdatesFromDesktop(window.location.href) },
      },
      updates: updateStore,
    } : {}),
    mediaModels: remote,
    modelOutputs: {
      subscribe: (listener) => {
        const stop = [
          ctx.remote.$on("settings/document-updated", listener),
          ctx.remote.$on("credentials/reference-updated", listener),
          ctx.remote.$on("llm/adapters-updated", listener),
          ctx.on("connection/reset", listener),
        ];
        return () => { stop.forEach((dispose) => dispose()); };
      },
      list: async (provider) => {
        const answer = await hostRemote.listModelOutputLimits(provider ? { provider } : {});
        if (!answer.ok || answer.value === undefined) throw new Error(answer.error?.message ?? "模型列表加载失败");
        return answer.value;
      },
      save: async (input) => {
        const answer = await hostRemote.saveModelOutputLimit(input);
        if (!answer.ok) throw new Error(answer.error?.message ?? "输出上限保存失败");
      },
    },
    ...(desktop ? {
      pickImportFile: () => pickImportFileFromDesktop(window.location.href),
      pickExportFile: (input) => pickExportFileFromDesktop(window.location.href, input),
      pickWorkDirectory: () => pickWorkDirectoryFromDesktop(window.location.href),
      replaceWorksWatchRoots: (roots) => replaceWorksWatchRootsFromDesktop(window.location.href, roots),
      subscribeWorksChanges: subscribeToDesktopWorksChanges,
    } : {}),
    videoComposer,
    draftImagesFor: sessionId => ({
      read: ids => {
        const images = ctx.conversation as typeof ctx.conversation & Pick<ConversationController, "resolveDraftAttachments">;
        return images.resolveDraftAttachments(ids as Parameters<ConversationController["resolveDraftAttachments"]>[0]).filter(item => item.kind === "image");
      },
      remove: imageId => {
        const binding = ctx.sessions.binding(sessionId as Parameters<typeof ctx.sessions.binding>[0]);
        if (!binding || binding.session.getSnapshot().removed) return;
        const input = ctx.conversation.input.for(binding.ctx);
        if (["submitting", "adjudicating"].includes(input.state.getSnapshot().phase)) return;
        input.removeAttachment(imageId as Parameters<typeof input.removeAttachment>[0]);
      },
    }),
    ...(workflowSessions === undefined ? {} : { workflowSessions }),
  }));
  const stopTriggers = registerChapterTriggers(
    ctx.get("inputTriggers") as ChapterTriggerService | undefined,
    remote,
  );
  const revealRuntime = () => {
    (window as Window & { __JIZUO_STARTUP_REVEAL__?: () => void })
      .__JIZUO_STARTUP_REVEAL__?.();
  };
  if (window.requestAnimationFrame) {
    window.requestAnimationFrame(() => window.requestAnimationFrame(revealRuntime));
  } else {
    revealRuntime();
  }

  return async () => {
    stopClientErrors();
    stopTriggers();
    stopModelType();
    stopMediaSubmit();
    stopWorkImageDrop();
    stopPromptReferencePreview();
    stopImageChat();
    stopImageChatActivity();
    imageChat.dispose();
    await textModelBridgeScope.dispose();
    await mediaTriggerScope.dispose();
    stopDreamEvents();
    stopUpdateEvents();
    stopShell();
    await disposeRemote();
  };
}
