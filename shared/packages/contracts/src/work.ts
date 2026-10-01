import { z } from "zod";

const normalizedTitle = z.string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).refine(
    (value) => [...value].length <= 120,
    "标题不能超过 120 个字符",
  ).refine(
    (value) => !value.includes("/") && !value.includes("\\") && value !== "." && value !== ".." && !value.includes(".."),
    "标题不能包含路径语法",
  ));

export const StableId = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/,
  "ID 必须是稳定的字母数字标识",
);

export const CreateWorkInput = z.object({
  title: normalizedTitle,
  projectKind: z.enum(["novel", "video"]).optional(),
});

export const CreateVolumeInput = z.object({
  workId: StableId,
  title: normalizedTitle,
});

export const CreateChapterInput = z.object({
  workId: StableId,
  volumeId: StableId,
  title: normalizedTitle,
  content: z.string().default(""),
  plan: z.string().default(""),
  detailedOutline: z.string().default(""),
});

export const RenameWorkInput = z.object({
  workId: StableId,
  title: normalizedTitle,
});

export const RenameVolumeInput = z.object({
  workId: StableId,
  volumeId: StableId,
  title: normalizedTitle,
});

export const RenameChapterInput = z.object({
  workId: StableId,
  volumeId: StableId,
  chapterId: StableId,
  title: normalizedTitle,
});

export const CreateChapterRequest = CreateChapterInput.extend({
  mode: z.enum(["create_explicit", "create_next"]).default("create_explicit"),
  afterChapterId: StableId.optional(),
}).superRefine((value, context) => {
  if (value.mode === "create_next" && value.afterChapterId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["afterChapterId"],
      message: "create_next 必须提供明确的前一章节 ID",
    });
  }
});

export type CreateChapterRequest = z.input<typeof CreateChapterRequest>;

export const VolumeTarget = z.object({
  workId: StableId,
  volumeId: StableId,
});

export type VolumeTarget = z.infer<typeof VolumeTarget>;

export const ChapterTarget = z.object({
  workId: StableId,
  volumeId: StableId,
  chapterId: StableId,
});

export type ChapterTarget = z.infer<typeof ChapterTarget>;

export const RevisionToken = z.string().regex(/^[a-f0-9]{64}$/);

export const ReplaceChapterInput = ChapterTarget.extend({
  content: z.string(),
  expectedRevision: RevisionToken,
  editSessionId: z.string().regex(/^edit_[A-Za-z0-9_-]{8,75}$/).optional(),
});

export type ReplaceChapterInput = z.infer<typeof ReplaceChapterInput>;

export const ChapterRevisionSource = z.enum(["manual", "workflow", "proposal", "restore"]);

export const ChapterRevisionSummary = z.object({
  revision: RevisionToken,
  createdAt: z.string().datetime(),
  source: ChapterRevisionSource,
  label: z.string().trim().min(1).max(120),
}).strict();

export const ChapterRevisionDocument = ChapterRevisionSummary.extend({
  content: z.string(),
}).strict();

export const ListChapterRevisionsInput = ChapterTarget.strict();

export const ReadChapterRevisionInput = ChapterTarget.extend({
  revision: RevisionToken,
}).strict();

export const SaveChapterPlanInput = ChapterTarget.extend({
  plan: z.string(),
  expectedRevision: RevisionToken,
});

export const SaveChapterOutlineInput = ChapterTarget.extend({
  outline: z.string(),
  detailedOutline: z.string(),
  expectedRevision: RevisionToken,
});

export const SaveVolumeOutlineInput = VolumeTarget.extend({
  outline: z.string(),
  detailedOutline: z.string(),
});

export const AppendChapterInput = ChapterTarget.extend({
  text: z.string(),
  expectedRevision: RevisionToken,
});

export const TextEditOperation = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string(),
});

export const EditChapterInput = ChapterTarget.extend({
  baseContentHash: RevisionToken,
  operations: z.array(TextEditOperation).min(1),
});

export const RestoreChapterRevisionInput = ChapterTarget.extend({
  revision: RevisionToken,
  expectedRevision: RevisionToken,
});

export const TrashTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("work"), workId: StableId }),
  VolumeTarget.extend({ kind: z.literal("volume") }),
  ChapterTarget.extend({ kind: z.literal("chapter") }),
]);

export const MoveToTrashInput = TrashTarget;

export const RestoreFromTrashInput = z.object({
  workId: StableId,
  trashId: StableId,
});

export type SaveChapterPlanInput = z.infer<typeof SaveChapterPlanInput>;
export type SaveChapterOutlineInput = z.infer<typeof SaveChapterOutlineInput>;
export type SaveVolumeOutlineInput = z.infer<typeof SaveVolumeOutlineInput>;
export type AppendChapterInput = z.infer<typeof AppendChapterInput>;
export type EditChapterInput = z.infer<typeof EditChapterInput>;
export type RestoreChapterRevisionInput = z.infer<typeof RestoreChapterRevisionInput>;
export type ChapterRevisionSource = z.infer<typeof ChapterRevisionSource>;
export type ChapterRevisionSummary = z.infer<typeof ChapterRevisionSummary>;
export type ChapterRevisionDocument = z.infer<typeof ChapterRevisionDocument>;
export type ListChapterRevisionsInput = z.infer<typeof ListChapterRevisionsInput>;
export type ReadChapterRevisionInput = z.infer<typeof ReadChapterRevisionInput>;
export type RenameWorkInput = z.infer<typeof RenameWorkInput>;
export type RenameVolumeInput = z.infer<typeof RenameVolumeInput>;
export type RenameChapterInput = z.infer<typeof RenameChapterInput>;
export type TrashTarget = z.infer<typeof TrashTarget>;
export type MoveToTrashInput = z.infer<typeof MoveToTrashInput>;
export type RestoreFromTrashInput = z.infer<typeof RestoreFromTrashInput>;

export const ChapterWorkflowRecordKind = z.enum([
  "memory-context",
  "plan",
  "review",
  "summary",
  "memory-extraction",
]);

export const ChapterWorkflowReviewStage = z.enum(["continuity", "style", "ai-trace"]);

const ChapterWorkflowProjectionCommon = z.object({
  label: z.string().trim().min(1).max(120),
  content: z.string().max(1_000_000),
});

export const ChapterWorkflowProjectionRecord = z.discriminatedUnion("kind", [
  ChapterWorkflowProjectionCommon.extend({ kind: z.literal("memory-context") }).strict(),
  ChapterWorkflowProjectionCommon.extend({ kind: z.literal("plan") }).strict(),
  ChapterWorkflowProjectionCommon.extend({
    kind: z.literal("review"),
    stage: ChapterWorkflowReviewStage,
    // Ten allowed revisions produce eleven review observations: the initial
    // review plus one after each committed revision.
    round: z.number().int().positive().max(11),
  }).strict(),
  ChapterWorkflowProjectionCommon.extend({ kind: z.literal("summary") }).strict(),
  ChapterWorkflowProjectionCommon.extend({ kind: z.literal("memory-extraction") }).strict(),
]);

export const WorkflowChapterProjectionInput = z.object({
  target: ChapterTarget.strict(),
  runId: StableId,
  record: ChapterWorkflowProjectionRecord,
}).strict();

export const ChapterWorkflowRecordSummary = z.object({
  runId: StableId,
  recordId: z.string().regex(/^[a-z0-9-]{1,80}$/),
  relativePath: z.string().regex(/^workflow\/[A-Za-z0-9][A-Za-z0-9_-]{1,63}\/[a-z0-9/-]+\.md$/),
  kind: ChapterWorkflowRecordKind,
  label: z.string().trim().min(1).max(120),
  stage: ChapterWorkflowReviewStage.optional(),
  round: z.number().int().positive().max(11).optional(),
  updatedAt: z.string().datetime(),
}).strict();

export const ChapterWorkflowRecord = ChapterWorkflowRecordSummary.extend({
  content: z.string().max(1_000_000),
}).strict();

export const ListChapterWorkflowRecordsInput = ChapterTarget.strict();

export const ReadChapterWorkflowRecordInput = ChapterTarget.extend({
  runId: StableId,
  recordId: z.string().regex(/^[a-z0-9-]{1,80}$/),
}).strict();

export type ChapterWorkflowRecordKind = z.infer<typeof ChapterWorkflowRecordKind>;
export type ChapterWorkflowReviewStage = z.infer<typeof ChapterWorkflowReviewStage>;
export type ChapterWorkflowProjectionRecord = z.infer<typeof ChapterWorkflowProjectionRecord>;
export type WorkflowChapterProjectionInput = z.infer<typeof WorkflowChapterProjectionInput>;
export type ChapterWorkflowRecordSummary = z.infer<typeof ChapterWorkflowRecordSummary>;
export type ChapterWorkflowRecord = z.infer<typeof ChapterWorkflowRecord>;
export type ListChapterWorkflowRecordsInput = z.infer<typeof ListChapterWorkflowRecordsInput>;
export type ReadChapterWorkflowRecordInput = z.infer<typeof ReadChapterWorkflowRecordInput>;

export const CreateProposalInput = ChapterTarget.extend({
  nextContent: z.string(),
  expectedRevision: RevisionToken,
  workflowRunId: StableId.optional(),
});

export const ApplyProposalInput = z.object({
  proposalId: StableId,
  token: z.string().min(1),
});

export const CreateChapterProposalInput = z.object({
  target: VolumeTarget,
  title: normalizedTitle,
  nextContent: z.string(),
  expectedChapterListHash: RevisionToken,
  insertAfterChapterId: StableId.nullable().optional(),
  workflowRunId: StableId.optional(),
});

export type CreateProposalInput = z.infer<typeof CreateProposalInput>;
export type ApplyProposalInput = z.infer<typeof ApplyProposalInput>;
export type CreateChapterProposalInput = z.infer<typeof CreateChapterProposalInput>;

export interface ChapterChangeProposal {
  id: string;
  target: ChapterTarget;
  expectedRevision: string;
  baseHash: string;
  nextHash: string;
  nextContent: string;
  unifiedDiff: string;
  status: "pending" | "applied" | "rejected";
  createdAt: string;
  appliedAt?: string;
}

export interface ChapterCreationProposal {
  kind: "chapter_create";
  id: string;
  target: VolumeTarget;
  reservedChapterId: string;
  insertAfterChapterId: string | null;
  expectedChapterListHash: string;
  nextHash: string;
  title: string;
  nextContent: string;
  status: "pending" | "applied" | "rejected";
  createdAt: string;
  appliedAt?: string;
}

const ChapterProposalStatus = z.enum(["pending", "applied", "rejected"]);
const ChapterChangeProposalRecord = z.object({
  kind: z.literal("chapter_change").optional(),
  id: StableId,
  target: ChapterTarget,
  expectedRevision: RevisionToken,
  baseHash: RevisionToken,
  nextHash: RevisionToken,
  nextContent: z.string(),
  unifiedDiff: z.string(),
  status: ChapterProposalStatus,
  createdAt: z.string().datetime(),
  appliedAt: z.string().datetime().optional(),
}).strict().transform((proposal) => ({ ...proposal, kind: "chapter_change" as const }));

const ChapterCreationProposalRecord = z.object({
  kind: z.literal("chapter_create"),
  id: StableId,
  target: VolumeTarget,
  reservedChapterId: StableId,
  insertAfterChapterId: StableId.nullable(),
  expectedChapterListHash: RevisionToken,
  nextHash: RevisionToken,
  title: normalizedTitle,
  nextContent: z.string(),
  status: ChapterProposalStatus,
  createdAt: z.string().datetime(),
  appliedAt: z.string().datetime().optional(),
}).strict();

export const ChapterProposal = z.union([
  ChapterChangeProposalRecord,
  ChapterCreationProposalRecord,
]);

export type ChapterProposal = z.output<typeof ChapterProposal>;

export interface TrashEntry {
  trashId: string;
  kind: "work" | "volume" | "chapter";
  workId: string;
  volumeId?: string | undefined;
  chapterId?: string | undefined;
  title: string;
  volumeCount: number;
  chapterCount: number;
  originalRelativePath: string;
  contentHash: string;
  trashedAt: string;
}

export interface TrashImpact {
  kind: "work" | "volume" | "chapter";
  title: string;
  volumeCount: number;
  chapterCount: number;
}

export const NovelFileFormat = z.enum(["markdown", "text", "docx"]);

export const PreviewImportInput = z.object({
  sourcePath: z.string().min(1),
  format: NovelFileFormat,
});

export const ApplyImportInput = PreviewImportInput.extend({
  previewHash: RevisionToken,
  workTitle: normalizedTitle.optional(),
});

export const ExportWorkInput = z.object({
  workId: StableId,
  format: NovelFileFormat,
  destination: z.string().min(1),
  chapterIds: z.array(StableId).min(1).optional(),
});

export const ExportWorkResult = z.object({
  workId: StableId,
  format: NovelFileFormat,
  destination: z.string().min(1),
  chapterCount: z.number().int().nonnegative(),
  byteLength: z.number().int().nonnegative(),
}).strict();
export type ExportWorkResult = z.infer<typeof ExportWorkResult>;

export const SearchWorkInput = z.object({
  workId: StableId,
  query: z.string().trim().min(1).max(120),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
export type SearchWorkInput = z.input<typeof SearchWorkInput>;
export const WorkSearchHit = z.object({
  workId: StableId,
  volumeId: StableId,
  chapterId: StableId,
  volumeTitle: z.string(),
  chapterTitle: z.string(),
  chapterNumber: z.number().int().positive(),
  field: z.enum(["title", "content"]),
  excerpt: z.string(),
  matchStart: z.number().int().nonnegative(),
  matchEnd: z.number().int().nonnegative(),
  revisionToken: RevisionToken,
}).strict();
export type WorkSearchHit = z.infer<typeof WorkSearchHit>;
export const SearchWorkResult = z.object({ items: z.array(WorkSearchHit), truncated: z.boolean() }).strict();
export type SearchWorkResult = z.infer<typeof SearchWorkResult>;

export type NovelFileFormat = z.infer<typeof NovelFileFormat>;
export type PreviewImportInput = z.infer<typeof PreviewImportInput>;
export type ApplyImportInput = z.infer<typeof ApplyImportInput>;
export type ExportWorkInput = z.infer<typeof ExportWorkInput>;

export interface ImportChapterPreview {
  title: string;
  content: string;
}

export interface ImportPreview {
  sourcePath: string;
  format: NovelFileFormat;
  suggestedTitle: string;
  sourceHash: string;
  previewHash: string;
  chapters: ImportChapterPreview[];
  warnings: string[];
}

export interface WorkSummary {
  projectKind?: "novel" | "video";
  hasLegacyVideo?: boolean;
  id: string;
  title: string;
  folderName: string;
  createdAt: string;
  updatedAt: string;
}

export interface VolumeSummary {
  id: string;
  workId: string;
  title: string;
  order: number;
  folderName: string;
  outline: string;
  detailedOutline: string;
}

export interface AppliedImport {
  work: WorkSummary;
  volume: VolumeSummary;
  chapterCount: number;
  previewHash: string;
}

export interface ChapterSummary {
  id: string;
  workId: string;
  volumeId: string;
  title: string;
  order: number;
  revisionToken: string;
  draftStatus?: "pending" | "draft";
}

export interface ChapterDocument extends ChapterSummary {
  content: string;
  plan: string;
  outline: string;
  detailedOutline: string;
  /** Runtime-owned preview for a pending workflow chapter; never formal content. */
  liveDraft?: string;
}
