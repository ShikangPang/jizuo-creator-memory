import { VideoRuntimeStatus } from "@jizuo/contracts";
import { ChatMediaSessionInput } from "@jizuo/contracts";
import { GetVideoClipFramesInput, VideoClipFrames } from "@jizuo/contracts";
import { GetVideoProjectViewInput, VideoProjectView, GetVideoJobUpdatesInput, VideoJobUpdates } from "@jizuo/contracts";
import { SaveWorkVisualStyleInput, SaveStyledPromptsInput, UndoStyledPromptsInput } from "../../contracts/src/visual-style.ts";
import { DiscussVideoPromptInput, DiscoverMediaModelsInput, DiscoverMediaModelsResult, MediaLibraryView, SaveMediaProviderInput, SetDefaultMediaModelsInput, SaveMediaConnectionInput, ManageMediaConnectionInput } from "@jizuo/contracts";
import type { InvocationDescriptor } from "@deepseek-ai/dsh-typert-protocol";
import { DeleteVideoItemInput, SaveVideoDesignInput, TagVideoAssetInput, ExtractVideoDesignsInput, RenameVideoAssetInput, VideoTimelineHistoryInput, VideoTimelineHistory, RestoreVideoTimelineInput, StartVideoProductionInput, ControlVideoProductionInput, CopyVideoExportInput, RoughCutVideoInput, EditVideoTimelineInput, ExportVideoInput, SpeechSettingsView, SaveSpeechSettingsInput, GenerateSpeechInput, SubmitVideoBatchInput, GenerateVideoMediaInput, ControlVideoJobInput, ImportVideoAssetInput, SelectVideoAssetInput, VideoAssetTarget, AdaptVideoEpisodeInput, MediaSettingsView, SaveMediaSettingsInput, GetVideoProjectInput, DeleteVideoEpisodeInput, CreateVideoEpisodeInput, UpdateVideoEpisodeInput, VideoProject } from "@jizuo/contracts";
import { AccountSummary as AccountSummarySchema } from "@jizuo/account-domain/schemas";
import {
  ExportWorkInput, ExportWorkResult, SearchWorkInput, SearchWorkResult,
  ApplyProposalInput,
  ApplyImportInput,
  ChapterTarget,
  ChapterRevisionDocument,
  ChapterRevisionSummary,
  ChapterWorkflowRecord,
  ChapterWorkflowRecordSummary,
  ChapterProposal,
  CreateChapterInput,
  CreateVolumeInput,
  CreateWorkInput,
  MoveToTrashInput,
  ListChapterRevisionsInput,
  NovelFileFormat,
  PreviewImportInput,
  RenameChapterInput,
  RenameVolumeInput,
  RenameWorkInput,
  ReplaceChapterInput,
  RestoreFromTrashInput,
  RestoreChapterRevisionInput,
  ReadChapterRevisionInput,
  ReadChapterWorkflowRecordInput,
  ListChapterWorkflowRecordsInput,
  SaveChapterOutlineInput,
  SaveVolumeOutlineInput,
  StableId,
  TrashTarget,
  CancelWorkflowRunInput,
  DecideWorkflowApprovalInput,
  ExtendWorkflowBudgetInput,
  GetWorkflowRunInput,
  PauseWorkflowRunInput,
  ResumeWorkflowRunInput,
  WatchWorkflowRunsInput,
  WorkflowRunStatus,
  WorkflowRunDetailProjection,
  WorkflowRunProjection,
  ModelOutputLimit,
  SaveModelOutputLimit,
} from "@jizuo/contracts";
import {
  DreamSettingsSchema, DreamStatusSchema, DreamCommandSchema, DreamWorkReportSchema, DreamChapterConversationsSchema, DreamModelOptionSchema, MemorySuggestionDetailSchema,
  MemorySuggestionSummary,
  MemoryQuery,
  StoredEvidence,
  StoredState,
} from "@jizuo/memory-domain/schemas";
import { z } from "zod";

export const PACKAGE_NAME = "@jizuo/plugin";
export const REMOTE_NAMESPACE = "jizuo";

const Empty = z.object({}).strict();
const AccountState = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("signed-out") }).strict(),
  z.object({ kind: z.literal("signed-in"), summary: AccountSummarySchema }).strict(),
  z.object({ kind: z.literal("offline"), summary: AccountSummarySchema.optional() }).strict(),
]);
const BrowserLoginStart = z.object({
  authorizationUrl: z.string().url(),
  expiresAt: z.number().int().positive(),
}).strict();
const ByokSettings = z.object({
  endpoint: z.string().url(),
  model: z.string().trim().min(1).max(240),
  credentialRef: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
}).strict();
const ModelSettings = z.object({
  selectedHostedModelId: z.string().trim().min(1).max(160).nullable(),
  byok: ByokSettings.nullable(),
}).strict();
const Saved = z.object({ saved: z.literal(true) }).strict();
const SignedOut = z.object({ signedOut: z.literal(true) }).strict();
const WorkPath = z.object({ path: z.string().min(1) }).strict();
const WorkLocations = z.object({
  schemaVersion: z.literal(1),
  createRoot: z.string().min(1),
  roots: z.array(z.string().min(1)).min(1),
  statuses: z.array(z.object({
    path: z.string().min(1),
    available: z.boolean(),
    reason: z.string().optional(),
  }).strict()),
  warning: z.string().optional(),
}).strict();
const WorkTarget = z.object({ workId: StableId }).strict();
const DreamSettingsRequest = DreamSettingsSchema.extend({ workId: StableId });
const SuggestionTarget = WorkTarget.extend({
  episodeKey: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const EpisodeCommitResult = z.object({
  status: z.enum(["committed", "suggested"]),
  episodeKey: z.string().regex(/^[a-f0-9]{64}$/),
  workId: StableId,
  chapterId: StableId,
  chapterNumber: z.number().int().positive(),
  identityCount: z.number().int().nonnegative(),
  stateCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  evidenceCount: z.number().int().nonnegative(),
}).strict();
const Rejected = z.object({ rejected: z.literal(true) }).strict();
const WorkSummary = z.object({
  projectKind: z.enum(["novel", "video"]).optional(),
  hasLegacyVideo: z.boolean().optional(),
  id: StableId,
  title: z.string(),
  folderName: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
const VolumeSummary = z.object({
  id: StableId,
  workId: StableId,
  title: z.string(),
  order: z.number().int().positive(),
  folderName: z.string(),
  outline: z.string(),
  detailedOutline: z.string(),
}).strict();
const ChapterSummary = z.object({
  id: StableId,
  workId: StableId,
  volumeId: StableId,
  title: z.string(),
  order: z.number().int().positive(),
  revisionToken: z.string().regex(/^[a-f0-9]{64}$/),
  draftStatus: z.enum(["pending", "draft"]).optional(),
}).strict();
const ChapterDocument = ChapterSummary.extend({
  content: z.string(),
  plan: z.string(),
  outline: z.string(),
  detailedOutline: z.string(),
  liveDraft: z.string().min(1).optional(),
}).strict();
const ImportChapterPreview = z.object({
  title: z.string(),
  content: z.string(),
}).strict();
const ImportPreview = z.object({
  sourcePath: z.string().min(1),
  format: NovelFileFormat,
  suggestedTitle: z.string(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  chapters: z.array(ImportChapterPreview).min(1),
  warnings: z.array(z.string()),
}).strict();
const AppliedImport = z.object({
  work: WorkSummary,
  volume: VolumeSummary,
  chapterCount: z.number().int().positive(),
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const TrashImpact = z.object({
  kind: z.enum(["work", "volume", "chapter"]),
  title: z.string(),
  volumeCount: z.number().int().nonnegative(),
  chapterCount: z.number().int().nonnegative(),
}).strict();
const TrashEntry = TrashImpact.extend({
  trashId: StableId,
  workId: StableId,
  volumeId: StableId.optional(),
  chapterId: StableId.optional(),
  originalRelativePath: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  trashedAt: z.string().datetime(),
}).strict();
const Deleted = z.object({ deleted: z.literal(true) }).strict();
const Proposal = z.object({
  id: StableId,
  target: ChapterTarget,
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  baseHash: z.string().regex(/^[a-f0-9]{64}$/),
  nextHash: z.string().regex(/^[a-f0-9]{64}$/),
  nextContent: z.string(),
  unifiedDiff: z.string(),
  status: z.enum(["pending", "applied", "rejected"]),
  createdAt: z.string().datetime(),
  appliedAt: z.string().datetime().optional(),
}).strict();
const MemoryGraph = z.object({
  query: MemoryQuery,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  bounds: z.object({ from: z.number().int().positive(), to: z.number().int().positive() }).strict(),
  nodes: z.array(z.object({
    id: StableId,
    identityId: StableId,
    name: z.string(),
    kind: z.enum(["character", "rule", "organization", "worldbuilding", "clue", "location", "object", "event", "style"]),
    room: z.enum(["characters", "world", "clues", "plot", "style"]),
    chapterNumber: z.number().int().positive(),
    evidenceIds: z.array(StableId),
  }).strict()),
  states: z.array(StoredState),
  edges: z.array(z.object({
    id: StableId,
    source: StableId,
    target: StableId,
    type: z.string(),
    chapterNumber: z.number().int().positive(),
    evidenceId: StableId,
    evidenceChapter: z.number().int().positive(),
  }).strict()),
  evidence: z.array(StoredEvidence),
}).strict();
const WorkflowWatchResult = z.object({
  sequence: z.number().int().nonnegative(),
  changed: z.boolean(),
  runs: z.array(WorkflowRunProjection),
}).strict();
/** UI projection reads are always constrained to the initiating session. */
const ListWorkflowRunsRequest = z.object({
  sessionId: StableId,
  statuses: z.array(WorkflowRunStatus).min(1).optional(),
}).strict();

function codec(typeSymbol: string, schema: z.ZodType<unknown>) {
  return { mode: "strict" as const, typeSymbol, create: () => schema };
}

function invocation(method: string, request: z.ZodType<unknown>, result: z.ZodType<unknown>): InvocationDescriptor {
  return {
    id: `${PACKAGE_NAME}#${REMOTE_NAMESPACE}/${method}`,
    service: REMOTE_NAMESPACE,
    namespace: REMOTE_NAMESPACE,
    method,
    invocation: { kind: "direct" },
    parameters: [{
      name: "request",
      wire: "request",
      source: "json",
      codec: codec(`${PACKAGE_NAME}#${method}Request`, request),
    }],
    cancellation: { parameter: "signal" },
    result: codec(`${PACKAGE_NAME}#${method}Result`, result),
    sourceLocation: { file: "src/remote-service.ts", line: 1, column: 1 },
  };
}

export const JIZUO_INVOCATIONS: readonly InvocationDescriptor[] = [
  invocation("getMediaLibrary", Empty, MediaLibraryView),
  invocation("saveMediaProvider", SaveMediaProviderInput, MediaLibraryView),
  invocation("setDefaultMediaModels", SetDefaultMediaModelsInput, MediaLibraryView),
  invocation("discoverMediaModels", DiscoverMediaModelsInput, DiscoverMediaModelsResult),
  invocation("getMediaSettings", z.object({}).strict(), MediaSettingsView),
  invocation("saveMediaSettings", SaveMediaSettingsInput, MediaSettingsView),
  invocation("saveMediaConnection", SaveMediaConnectionInput, MediaSettingsView),
  invocation("manageMediaConnection", ManageMediaConnectionInput, MediaSettingsView),
  invocation("deleteVideoItem", DeleteVideoItemInput, VideoProject),
  invocation("renameVideoAsset", RenameVideoAssetInput, VideoProject),
  invocation("getVideoTimelineHistory", VideoTimelineHistoryInput, VideoTimelineHistory),
  invocation("restoreVideoTimeline", RestoreVideoTimelineInput, VideoProject),
  invocation("startVideoProduction", StartVideoProductionInput, VideoProject),
  invocation("controlVideoProduction", ControlVideoProductionInput, VideoProject),
  invocation("copyVideoExport", CopyVideoExportInput, z.object({ path: z.string() }).strict()),
  invocation("roughCutVideo", RoughCutVideoInput, VideoProject),
  invocation("getVideoClipFrames", GetVideoClipFramesInput, VideoClipFrames),
  invocation("editVideoTimeline", EditVideoTimelineInput, VideoProject),
  invocation("checkVideoRuntime", Empty, VideoRuntimeStatus),
  invocation("exportVideo", ExportVideoInput, VideoProject),
  invocation("generateVideoSpeech", GenerateSpeechInput, VideoProject),
  invocation("getSpeechSettings", z.object({}).strict(), SpeechSettingsView),
  invocation("saveSpeechSettings", SaveSpeechSettingsInput, SpeechSettingsView),
  invocation("submitVideoBatch", SubmitVideoBatchInput, VideoProject),
  invocation("generateVideoMedia", GenerateVideoMediaInput, VideoProject),
  invocation("controlVideoJob", ControlVideoJobInput, VideoProject),
  invocation("saveStyledPrompts", SaveStyledPromptsInput, VideoProject),
  invocation("undoStyledPrompts", UndoStyledPromptsInput, VideoProject),
  invocation("saveWorkVisualStyle", SaveWorkVisualStyleInput, VideoProject),
  invocation("saveVideoDesign", SaveVideoDesignInput, VideoProject),
  invocation("tagVideoAsset", TagVideoAssetInput, VideoProject),
  invocation("extractVideoDesigns", ExtractVideoDesignsInput, VideoProject),
  invocation("importVideoAsset", ImportVideoAssetInput, VideoProject),
  invocation("selectVideoAsset", SelectVideoAssetInput, VideoProject),
  invocation("getVideoAssetUrl", VideoAssetTarget, z.object({ url: z.string().url() }).strict()),
  invocation("discussVideoPrompt", DiscussVideoPromptInput, VideoProject),
  invocation("adaptVideoEpisode", AdaptVideoEpisodeInput, VideoProject),
  invocation("getVideoProject", GetVideoProjectInput, VideoProject),
  invocation("getVideoProjectView", GetVideoProjectViewInput, VideoProjectView),
  invocation("getChatMedia", ChatMediaSessionInput, z.array(VideoProject)),
  invocation("getVideoJobUpdates", GetVideoJobUpdatesInput, VideoJobUpdates),
  invocation("createVideoEpisode", CreateVideoEpisodeInput, VideoProject),
  invocation("deleteVideoEpisode", DeleteVideoEpisodeInput, VideoProject),
  invocation("updateVideoEpisode", UpdateVideoEpisodeInput, VideoProject),
  invocation("getVideoWorkLocations", Empty, WorkLocations),
  invocation("setCreateVideoWorkLocation", z.object({ path: z.string().min(1) }).strict(), WorkLocations),
  invocation("resetCreateVideoWorkLocation", Empty, WorkLocations),
  invocation("getWorkLocations", Empty, WorkLocations),
  invocation("setCreateWorkLocation", z.object({ path: z.string().min(1) }).strict(), WorkLocations),
  invocation("resetCreateWorkLocation", Empty, WorkLocations),
  invocation("exportWork", ExportWorkInput, ExportWorkResult),
  invocation("searchWork", SearchWorkInput, SearchWorkResult),
  invocation("listWorks", Empty, z.array(WorkSummary)),
  invocation("createWork", CreateWorkInput, WorkSummary),
  invocation("previewImport", PreviewImportInput, ImportPreview),
  invocation("applyImport", ApplyImportInput, AppliedImport),
  invocation("renameWork", RenameWorkInput, WorkSummary),
  invocation("listVolumes", z.object({ workId: StableId }).strict(), z.array(VolumeSummary)),
  invocation("createVolume", CreateVolumeInput, VolumeSummary),
  invocation("renameVolume", RenameVolumeInput, VolumeSummary),
  invocation("saveVolumeOutline", SaveVolumeOutlineInput, VolumeSummary),
  invocation("listChapters", z.object({ workId: StableId, volumeId: StableId }).strict(), z.array(ChapterSummary)),
  invocation("createChapter", CreateChapterInput, ChapterDocument),
  invocation("renameChapter", RenameChapterInput, ChapterSummary),
  invocation("inspectTrashTarget", TrashTarget, TrashImpact),
  invocation("moveToTrash", MoveToTrashInput, TrashEntry),
  invocation("listTrash", Empty, z.array(TrashEntry)),
  invocation("restoreFromTrash", RestoreFromTrashInput, TrashEntry),
  invocation("deleteFromTrash", RestoreFromTrashInput, Deleted),
  invocation("resolveChapterPath", ChapterTarget, WorkPath),
  invocation("readChapter", ChapterTarget, ChapterDocument),
  invocation("replaceChapter", ReplaceChapterInput, ChapterDocument),
  invocation("saveChapterOutline", SaveChapterOutlineInput, ChapterDocument),
  invocation("listProposals", ChapterTarget, z.array(Proposal)),
  invocation("getProposalPreview", z.object({ proposalId: StableId }).strict(), ChapterProposal),
  invocation("rejectProposal", z.object({ proposalId: StableId }).strict(), Proposal),
  invocation("authorizeProposal", z.object({ proposalId: StableId }).strict(), z.string().min(1)),
  invocation("applyProposal", ApplyProposalInput, ChapterDocument),
  invocation("restoreChapterRevision", RestoreChapterRevisionInput, ChapterDocument),
  invocation("listChapterRevisions", ListChapterRevisionsInput, z.array(ChapterRevisionSummary)),
  invocation("readChapterRevision", ReadChapterRevisionInput, ChapterRevisionDocument),
  invocation("listChapterWorkflowRecords", ListChapterWorkflowRecordsInput, z.array(ChapterWorkflowRecordSummary)),
  invocation("readChapterWorkflowRecord", ReadChapterWorkflowRecordInput, ChapterWorkflowRecord),
  invocation("queryMemory", MemoryQuery, MemoryGraph),
  invocation("listWorkflowRuns", ListWorkflowRunsRequest, z.array(WorkflowRunProjection)),
  invocation("getWorkflowRun", GetWorkflowRunInput, WorkflowRunDetailProjection),
  invocation("decideWorkflowApproval", DecideWorkflowApprovalInput, WorkflowRunDetailProjection),
  invocation("extendWorkflowBudget", ExtendWorkflowBudgetInput, WorkflowRunDetailProjection),
  invocation("pauseWorkflowRun", PauseWorkflowRunInput, WorkflowRunDetailProjection),
  invocation("resumeWorkflowRun", ResumeWorkflowRunInput, WorkflowRunDetailProjection),
  invocation("cancelWorkflowRun", CancelWorkflowRunInput, WorkflowRunDetailProjection),
  invocation("reconcileWorkflowApply", GetWorkflowRunInput, WorkflowRunDetailProjection),
  invocation("watchWorkflowRuns", WatchWorkflowRunsInput, WorkflowWatchResult),
  invocation("getDreamStatus", WorkTarget, DreamStatusSchema),
  invocation("getDreamReport", WorkTarget, DreamWorkReportSchema),
  invocation("getDreamConversations", ChapterTarget, DreamChapterConversationsSchema),
  invocation("listDreamModels", Empty, z.array(DreamModelOptionSchema)),
  invocation("getMemorySuggestion", SuggestionTarget, MemorySuggestionDetailSchema),
  invocation("controlDream", z.object({ workId: StableId.optional(), command: DreamCommandSchema }).strict(), Saved),
  invocation("touchDreamActivity", WorkTarget.extend({ chapterId: StableId.optional() }), Saved),
  invocation("getDreamSettings", WorkTarget, DreamSettingsSchema),
  invocation("saveDreamSettings", DreamSettingsRequest, DreamSettingsSchema),
  invocation("listMemorySuggestions", WorkTarget, z.array(MemorySuggestionSummary)),
  invocation("acceptMemorySuggestion", SuggestionTarget, EpisodeCommitResult),
  invocation("rejectMemorySuggestion", SuggestionTarget, Rejected),
  invocation("resolveWorkPath", z.object({ workId: StableId }).strict(), WorkPath),
  invocation("accountGetState", Empty, AccountState),
  invocation("accountBeginBrowserLogin", Empty, BrowserLoginStart),
  invocation("accountLogout", Empty, SignedOut),
  invocation("getModelSettings", Empty, ModelSettings),
  invocation("listModelOutputLimits", z.object({ provider: z.string().trim().min(1).optional() }).strict(), z.array(ModelOutputLimit)),
  invocation("saveModelOutputLimit", SaveModelOutputLimit, Saved),
  invocation("selectHostedModel", z.object({ modelId: z.string().trim().min(1).max(160) }).strict(), Saved),
  invocation("saveByok", ByokSettings, Saved),
];
