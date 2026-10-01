import type { GetVideoProjectViewInput, VideoProjectView, GetVideoJobUpdatesInput, VideoJobUpdates } from "@jizuo/contracts";
import type {
  VideoProject, DeleteVideoEpisodeInput, GetVideoProjectInput, CreateVideoEpisodeInput, UpdateVideoEpisodeInput,
  ExportWorkInput, ExportWorkResult, SearchWorkInput, SearchWorkResult,
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
} from "@jizuo/contracts";
import type { AdaptVideoEpisodeInput } from "../../../contracts/src/video-authoring.ts";
import type { VideoProductionRemote } from "../video/production-remote.ts";

export interface JizuoContentRemote extends VideoProductionRemote {
  getVideoProject?(input: GetVideoProjectInput, signal?: AbortSignal): Promise<VideoProject>;
  getVideoProjectView?(input: GetVideoProjectViewInput, signal?: AbortSignal): Promise<VideoProjectView>;
  getChatMedia?(input:{sessionId:string},signal?:AbortSignal):Promise<import("@jizuo/contracts").VideoProject[]>;
  getVideoJobUpdates?(input: GetVideoJobUpdatesInput, signal?: AbortSignal): Promise<VideoJobUpdates>;
  createVideoEpisode?(input: CreateVideoEpisodeInput): Promise<VideoProject>;
  deleteVideoEpisode?(input: DeleteVideoEpisodeInput): Promise<VideoProject>;
  updateVideoEpisode?(input: UpdateVideoEpisodeInput): Promise<VideoProject>;
  discussVideoPrompt?(input: import("@jizuo/contracts").DiscussVideoPromptInput): Promise<VideoProject>;
  adaptVideoEpisode?(input: AdaptVideoEpisodeInput): Promise<VideoProject>;
  exportWork?(input: ExportWorkInput): Promise<ExportWorkResult>;
  searchWork?(input: SearchWorkInput): Promise<SearchWorkResult>;
  touchDreamActivity?(workId: string, chapterId?: string): Promise<unknown>;
  listWorks(): Promise<WorkSummary[]>;
  resolveChapterPath?(target: ChapterTarget): Promise<{ path: string }>;
  resolveWorkPath?(workId: string): Promise<{ path: string }>;
  createWork(input: { title: string; projectKind?: "novel" | "video" }): Promise<WorkSummary>;
  previewImport?(input: PreviewImportInput): Promise<ImportPreview>;
  applyImport?(input: ApplyImportInput): Promise<AppliedImport>;
  renameWork(input: RenameWorkInput): Promise<WorkSummary>;
  listVolumes(input: { workId: string }): Promise<VolumeSummary[]>;
  createVolume(input: { workId: string; title: string }): Promise<VolumeSummary>;
  renameVolume(input: RenameVolumeInput): Promise<VolumeSummary>;
  saveVolumeOutline(input: SaveVolumeOutlineInput): Promise<VolumeSummary>;
  listChapters(input: { workId: string; volumeId: string }): Promise<ChapterSummary[]>;
  createChapter(input: {
    workId: string;
    volumeId: string;
    title: string;
    content?: string;
    plan?: string;
    detailedOutline?: string;
  }): Promise<ChapterDocument>;
  renameChapter(input: RenameChapterInput): Promise<ChapterSummary>;
  inspectTrashTarget(input: TrashTarget): Promise<TrashImpact>;
  moveToTrash(input: MoveToTrashInput): Promise<TrashEntry>;
  listTrash(): Promise<TrashEntry[]>;
  restoreFromTrash(input: RestoreFromTrashInput): Promise<TrashEntry>;
  deleteFromTrash(input: RestoreFromTrashInput): Promise<{ deleted: true }>;
  readChapter(target: ChapterTarget): Promise<ChapterDocument>;
  replaceChapter(input: ReplaceChapterInput): Promise<ChapterDocument>;
  saveChapterOutline(input: SaveChapterOutlineInput): Promise<ChapterDocument>;
  listProposals?(target: ChapterTarget): Promise<ChapterChangeProposal[]>;
  /** Candidate content is available only to the dedicated proposal preview surface. */
  getProposalPreview?(proposalId: string): Promise<ChapterProposal>;
  rejectProposal?(proposalId: string): Promise<ChapterChangeProposal>;
  authorizeProposal?(proposalId: string): Promise<string>;
  applyProposal?(input: ApplyProposalInput): Promise<ChapterDocument>;
  restoreChapterRevision(input: RestoreChapterRevisionInput): Promise<ChapterDocument>;
  listChapterRevisions(target: ChapterTarget, signal?: AbortSignal): Promise<ChapterRevisionSummary[]>;
  readChapterRevision(input: ReadChapterRevisionInput): Promise<ChapterRevisionDocument>;
  listChapterWorkflowRecords(target: ChapterTarget): Promise<ChapterWorkflowRecordSummary[]>;
  readChapterWorkflowRecord(input: ReadChapterWorkflowRecordInput): Promise<ChapterWorkflowRecord>;
}

/**
 * The deliberately small public workflow surface consumed by the conversation
 * progress UI. It contains projections only: bounded, de-identified model
 * output may be shown in the conversation, while artifact paths, checkpoint
 * data, prompts, and approval capabilities never cross this boundary.
 */
export interface JizuoWorkflowRemote {
  listWorkflowRuns(input: {
    sessionId: string;
    statuses?: WorkflowRunProjection["status"][];
  }, signal?: AbortSignal): Promise<WorkflowRunProjection[]>;
  getWorkflowRun(input: { runId: string }, signal?: AbortSignal): Promise<WorkflowRunDetailProjection>;
  decideWorkflowApproval(input: {
    runId: string;
    proposalId: string;
    decision: "approved" | "rejected";
  }, signal?: AbortSignal): Promise<WorkflowRunDetailProjection>;
  extendWorkflowBudget(input: { runId: string; additionalRounds: 2 }, signal?: AbortSignal): Promise<WorkflowRunDetailProjection>;
  pauseWorkflowRun(input: { runId: string }, signal?: AbortSignal): Promise<WorkflowRunDetailProjection>;
  resumeWorkflowRun(input: { runId: string }, signal?: AbortSignal): Promise<WorkflowRunDetailProjection>;
  cancelWorkflowRun(input: { runId: string }, signal?: AbortSignal): Promise<WorkflowRunDetailProjection>;
  reconcileWorkflowApply(input: { runId: string }, signal?: AbortSignal): Promise<WorkflowRunDetailProjection>;
  watchWorkflowRuns(input: {
    sessionId: string;
    afterSequence: number;
    timeoutMs: number;
  }, signal?: AbortSignal): Promise<{
    sequence: number;
    changed: boolean;
    runs: WorkflowRunProjection[];
  }>;
}

/** A Jizuo content remote with the opt-in, strict workflow lifecycle surface. */
export type JizuoWorkflowContentRemote = JizuoContentRemote & JizuoWorkflowRemote;
