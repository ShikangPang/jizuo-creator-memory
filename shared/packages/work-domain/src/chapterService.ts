import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import {
  AppendChapterInput,
  CreateChapterInput,
  CreateVolumeInput,
  ChapterTarget,
  ChapterProposal,
  EditChapterInput,
  JizuoError,
  MoveToTrashInput,
  RenameChapterInput,
  RenameVolumeInput,
  ReplaceChapterInput,
  RestoreChapterRevisionInput,
  ReadChapterRevisionInput,
  RestoreFromTrashInput,
  SaveChapterOutlineInput,
  SaveChapterPlanInput,
  SaveVolumeOutlineInput,
  WorkflowChapterProjectionInput,
  ListChapterWorkflowRecordsInput,
  ReadChapterWorkflowRecordInput,
  StableId,
  TrashTarget,
  VolumeTarget,
  type ChapterDocument,
  type ChapterRevisionDocument,
  type ChapterRevisionSummary,
  type ChapterCreationProposal,
  type ChapterSummary,
  type VolumeSummary,
  type WorkSummary,
} from "@jizuo/contracts";
import { parse, stringify } from "yaml";
import { z } from "zod";

import { portableTitle, resolveWithin } from "./paths.ts";
import { sha256Text } from "./revisions.ts";
import { ChapterHistoryStore, type ChapterHistoryCheckpoint } from "./chapterHistory.ts";
import { FileTransaction, type FileTransactionInstallContext } from "./transaction.ts";
import { renameMaterializedDirectory } from "./materializedRename.ts";
import { listTrashEntries, moveDirectoryToTrash, restoreDirectoryFromTrash } from "./trash.ts";
import { WorkflowChapterProjectionStore } from "./workflowProjection.ts";
import { WatchedReadCache } from "./readCache.ts";

const VolumeFile = z.object({
  schema_version: z.literal(1),
  id: StableId,
  work_id: StableId,
  title: z.string().min(1),
  order: z.number().int().positive(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  outline: z.string().default(""),
  detailed_outline: z.string().default(""),
});

const ChapterFile = z.object({
  schema_version: z.literal(1),
  id: StableId,
  work_id: StableId,
  volume_id: StableId,
  title: z.string().min(1),
  order: z.number().int().positive(),
  revision_token: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  workflow_origin_run: StableId.optional(),
  workflow_target_fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  workflow_draft_status: z.enum(["pending", "draft"]).optional(),
});

const WorkflowChapterCreateTarget = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("create_explicit"),
    workId: StableId,
    volumeId: StableId,
    title: z.string().trim().min(1).max(120),
  }).strict(),
  z.object({
    mode: z.literal("create_next"),
    workId: StableId,
    volumeId: StableId,
    afterChapterId: StableId,
    title: z.string().trim().min(1).max(120),
  }).strict(),
]);

const RevisionHash = z.string().regex(/^[a-f0-9]{64}$/);

const WorkflowChapterCreateInputSchema = z.object({
  operation: z.literal("create"),
  runId: StableId,
  target: WorkflowChapterCreateTarget,
  reservedChapterId: StableId,
  chapterListHash: RevisionHash,
  insertAfterChapterId: StableId.nullable(),
  content: z.string().min(1),
  plan: z.string().default(""),
  detailedOutline: z.string().default(""),
  requireInitialized: z.boolean().optional(),
}).strict();

const WorkflowChapterInitializeInputSchema = WorkflowChapterCreateInputSchema.omit({
  operation: true, content: true, plan: true, detailedOutline: true, requireInitialized: true,
});

const WorkflowChapterEffectId = z.enum(["write", "revise", "continuity-revise", "style-revise", "ai-trace-revise"]);

const WorkflowChapterDraftInputSchema = z.object({
  runId: StableId,
  target: ChapterTarget.strict(),
  nodeId: WorkflowChapterEffectId,
  revisionRound: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  workflowTargetKind: z.enum(["created", "existing"]).default("created"),
  content: z.string().min(1),
}).strict();

const WorkflowChapterReplaceInputSchema = z.object({
  operation: z.literal("replace"),
  runId: StableId,
  target: ChapterTarget,
  expectedRevision: RevisionHash,
  revisionRound: z.number().int().min(0).max(10).optional(),
  workflowEffectId: WorkflowChapterEffectId.optional(),
  previousWorkflowEffectId: WorkflowChapterEffectId.optional(),
  previousWorkflowRevisionRound: z.number().int().min(0).max(10).optional(),
  workflowTargetKind: z.enum(["created", "existing"]).default("created"),
  /** Internal prior-artifact proof; never supplied by model tool arguments. */
  expectedPlan: z.string().optional(),
  expectedDetailedOutline: z.string().optional(),
  content: z.string().min(1),
  plan: z.string().optional(),
  detailedOutline: z.string().optional(),
}).strict();

const WorkflowChapterInspectionInputSchema = z.object({
  runId: StableId,
  target: ChapterTarget,
  workflowTargetKind: z.enum(["created", "existing"]).default("created"),
}).strict();

const VolumeCreationLock = z.object({
  schemaVersion: z.literal(1),
  owner: z.string().min(1),
  pid: z.number().int().positive(),
  expiresAt: z.number().finite(),
});

const VOLUME_CREATION_LOCK_TTL_MS = 30_000;
const VOLUME_CREATION_LOCK_WAIT_MS = 2_000;
const VOLUME_CREATION_LOCK_RETRY_MS = 10;

type VolumeFile = z.infer<typeof VolumeFile>;
type ChapterFile = z.infer<typeof ChapterFile>;
export type WorkflowChapterCreateInput = z.input<typeof WorkflowChapterCreateInputSchema>;
export type WorkflowChapterInitializeInput = Omit<WorkflowChapterCreateInput,
  "operation" | "content" | "plan" | "detailedOutline" | "requireInitialized">;
export type WorkflowChapterDraftInput = z.input<typeof WorkflowChapterDraftInputSchema>;
export type WorkflowChapterLiveDraftInput = WorkflowChapterDraftInput;
export type WorkflowChapterReplaceInput = z.input<typeof WorkflowChapterReplaceInputSchema>;
export type WorkflowChapterInspectionInput = z.input<typeof WorkflowChapterInspectionInputSchema>;

export interface ChapterStoreOptions {
  worksRoot: string;
  idFactory: () => string;
  now: () => Date;
  findWork: (workId: string) => Promise<WorkSummary>;
  findWorkForInspection: (workId: string) => Promise<WorkSummary | undefined>;
}

export interface ChapterListSnapshot {
  expectedChapterListHash: string;
  insertAfterChapterId: string | null;
}

interface CurrentChapterEntry {
  root: string;
  metadata: ChapterFile;
  revisionToken: string;
}

interface WorkflowChapterEntry extends CurrentChapterEntry {
  content: string;
  plan: string;
  detailedOutline: string;
}

function numberedFolder(order: number, title: string, shortId: string): string {
  return `${String(order).padStart(4, "0")}-${portableTitle(title)}--${shortId}`;
}

export class ChapterStore {
  private readonly options: ChapterStoreOptions;
  private readonly history: ChapterHistoryStore;
  private readonly readIndex = new WatchedReadCache<Array<{ root: string; metadata: ChapterFile }>>(
    (file) => !file.includes("/") || file.endsWith("/chapter.yaml"),
  );

  constructor(options: ChapterStoreOptions) {
    this.options = options;
    this.history = new ChapterHistoryStore({
      now: options.now,
      assertSafePath: (path) => this.requireSafeWorkflowPath(path),
    });
  }

  async createVolume(rawInput: { workId: string; title: string }): Promise<VolumeSummary> {
    const input = CreateVolumeInput.parse(rawInput);
    const work = await this.options.findWork(input.workId);
    const volumesRoot = resolveWithin(this.options.worksRoot, work.folderName, "content", "volumes");
    const existing = await this.volumeEntries(volumesRoot);
    const order = Math.max(0, ...existing.map((entry) => entry.metadata.order)) + 1;
    const shortId = this.options.idFactory();
    const id = `vol_${shortId}`;
    StableId.parse(id);
    const folderName = numberedFolder(order, input.title, shortId);
    const volumeRoot = resolveWithin(volumesRoot, folderName);
    const timestamp = this.options.now().toISOString();
    const metadata: VolumeFile = {
      schema_version: 1,
      id,
      work_id: input.workId,
      title: input.title,
      order,
      created_at: timestamp,
      updated_at: timestamp,
      outline: "",
      detailed_outline: "",
    };
    await mkdir(join(volumeRoot, "chapters"), { recursive: true });
    await writeFile(join(volumeRoot, "volume.yaml"), stringify(metadata, { lineWidth: 0 }), { encoding: "utf8", flag: "wx" });
    return this.volumeSummaryOf(volumeRoot, metadata);
  }

  async renameVolume(rawInput: unknown): Promise<VolumeSummary> {
    const input = RenameVolumeInput.parse(rawInput);
    const { volumeRoot, volume } = await this.findVolume(input.workId, input.volumeId);
    const shortId = volume.id.replace(/^vol_/, "");
    const folderName = numberedFolder(volume.order, input.title, shortId);
    const metadata: VolumeFile = {
      ...volume,
      title: input.title,
      updated_at: this.options.now().toISOString(),
    };
    await renameMaterializedDirectory({
      currentRoot: volumeRoot,
      nextRoot: resolveWithin(dirname(volumeRoot), folderName),
      metadataName: "volume.yaml",
      serializedMetadata: stringify(metadata, { lineWidth: 0 }),
    });
    return this.volumeSummaryOf(resolveWithin(dirname(volumeRoot), folderName), metadata);
  }

  async saveVolumeOutline(rawInput: SaveVolumeOutlineInput): Promise<VolumeSummary> {
    const input = SaveVolumeOutlineInput.parse(rawInput);
    const { workRoot, volumeRoot, volume } = await this.findVolume(input.workId, input.volumeId);
    const metadata: VolumeFile = {
      ...volume,
      outline: input.outline,
      detailed_outline: input.detailedOutline,
      updated_at: this.options.now().toISOString(),
    };
    const transaction = await FileTransaction.begin({
      workRoot,
      id: `volume_${randomUUID().replaceAll("-", "")}`,
    });
    await transaction.stage(
      relative(workRoot, join(volumeRoot, "volume.yaml")),
      stringify(metadata, { lineWidth: 0 }),
    );
    await transaction.commit();
    return this.volumeSummaryOf(volumeRoot, metadata);
  }

  async createChapter(rawInput: {
    workId: string;
    volumeId: string;
    title: string;
    content?: string;
    plan?: string;
    detailedOutline?: string;
  }): Promise<ChapterDocument> {
    const input = CreateChapterInput.parse(rawInput);
    return this.withChapterListLock(input, async (assertLockOwner) => {
      const { volumeRoot, volume } = await this.findVolume(input.workId, input.volumeId);
      const chaptersRoot = resolveWithin(volumeRoot, "chapters");
      const existing = await this.chapterEntries(chaptersRoot);
      const order = Math.max(0, ...existing.map((entry) => entry.metadata.order)) + 1;
      const shortId = this.options.idFactory();
      const id = `ch_${shortId}`;
      StableId.parse(id);
      const chapterRoot = resolveWithin(chaptersRoot, numberedFolder(order, input.title, shortId));
      const timestamp = this.options.now().toISOString();
      const revisionToken = sha256Text(input.content);
      const metadata: ChapterFile = {
        schema_version: 1,
        id,
        work_id: input.workId,
        volume_id: volume.id,
        title: input.title,
        order,
        revision_token: revisionToken,
        created_at: timestamp,
        updated_at: timestamp,
      };
      await mkdir(chapterRoot, { recursive: true });
      await assertLockOwner();
      await Promise.all([
        writeFile(join(chapterRoot, "chapter.yaml"), stringify(metadata, { lineWidth: 0 }), { encoding: "utf8", flag: "wx" }),
        writeFile(join(chapterRoot, "content.md"), input.content, { encoding: "utf8", flag: "wx" }),
        writeFile(join(chapterRoot, "plan.md"), input.plan, { encoding: "utf8", flag: "wx" }),
        writeFile(join(chapterRoot, "detailed-outline.md"), input.detailedOutline, { encoding: "utf8", flag: "wx" }),
      ]);
      return this.documentOf(metadata, input.content, input.plan, input.detailedOutline);
    });
  }

  async chapterListSnapshot(rawTarget: VolumeTarget): Promise<ChapterListSnapshot> {
    const target = VolumeTarget.parse(rawTarget);
    const { volumeRoot } = await this.findVolume(target.workId, target.volumeId);
    const chapters = await this.currentChapterEntries(resolveWithin(volumeRoot, "chapters"));
    return {
      expectedChapterListHash: this.hashChapterList(chapters),
      insertAfterChapterId: chapters.at(-1)?.metadata.id ?? null,
    };
  }

  async withChapterListLock<T>(rawTarget: VolumeTarget, operation: (assertLockOwner: () => Promise<void>) => Promise<T>): Promise<T> {
    const target = VolumeTarget.parse(rawTarget);
    return this.withChapterListLockById(target, operation);
  }

  async withChapterListLockById<T>(target: { workId: string; volumeId: string }, operation: (assertLockOwner: () => Promise<void>) => Promise<T>): Promise<T> {
    const work = await this.options.findWork(StableId.parse(target.workId));
    return this.withVolumeCreationLock(
      resolveWithin(this.options.worksRoot, work.folderName),
      StableId.parse(target.volumeId),
      operation,
    );
  }

  async createReservedChapter(rawProposal: ChapterCreationProposal): Promise<ChapterDocument> {
    const parsed = ChapterProposal.parse(rawProposal);
    if (parsed.kind !== "chapter_create") {
      throw new JizuoError("validation_error", "章节创建提案类型无效", { kind: parsed.kind });
    }
    const proposal = parsed;
    if (!proposal.reservedChapterId.startsWith("ch_")) {
      throw new JizuoError("validation_error", "保留章节 ID 格式无效", {
        reservedChapterId: proposal.reservedChapterId,
      });
    }
    const { workRoot, volume } = await this.findVolume(proposal.target.workId, proposal.target.volumeId);
    return this.withVolumeCreationLock(workRoot, volume.id, async (assertLockOwner) => {
      const locked = await this.findVolume(proposal.target.workId, proposal.target.volumeId);
      const chaptersRoot = resolveWithin(locked.volumeRoot, "chapters");
      const chapters = await this.currentChapterEntries(chaptersRoot);
      const reserved = chapters.filter((entry) => entry.metadata.id === proposal.reservedChapterId);
      if (reserved.length > 1) {
        throw new JizuoError("revision_conflict", "保留章节 ID 不唯一，无法安全恢复", {
          reservedChapterId: proposal.reservedChapterId,
        });
      }
      if (reserved.length === 1) {
        const existing = reserved[0]!;
        const prior = chapters.filter((entry) => entry.metadata.id !== proposal.reservedChapterId);
        const priorAnchor = prior.at(-1)?.metadata.id ?? null;
        if (
          this.hashChapterList(prior) !== proposal.expectedChapterListHash
          || chapters.at(-1)?.metadata.id !== proposal.reservedChapterId
          || priorAnchor !== proposal.insertAfterChapterId
          || existing.metadata.work_id !== proposal.target.workId
          || existing.metadata.volume_id !== proposal.target.volumeId
          || existing.metadata.title !== proposal.title
          || existing.revisionToken !== proposal.nextHash
        ) {
          throw new JizuoError("revision_conflict", "章节创建提案的现有结果不完整或存在歧义", {
            proposalId: proposal.id,
            reservedChapterId: proposal.reservedChapterId,
          });
        }
        return this.readChapter({ ...proposal.target, chapterId: proposal.reservedChapterId });
      }

      const actualHash = this.hashChapterList(chapters);
      const actualAnchor = chapters.at(-1)?.metadata.id ?? null;
      if (actualHash !== proposal.expectedChapterListHash || actualAnchor !== proposal.insertAfterChapterId) {
        throw new JizuoError("revision_conflict", "章节列表已变化，不能安全应用创建提案", {
          proposalId: proposal.id,
          expectedChapterListHash: proposal.expectedChapterListHash,
          actualChapterListHash: actualHash,
          insertAfterChapterId: proposal.insertAfterChapterId,
          actualInsertAfterChapterId: actualAnchor,
        });
      }

      const order = Math.max(0, ...chapters.map((entry) => entry.metadata.order)) + 1;
      const shortId = proposal.reservedChapterId.replace(/^ch_/, "");
      const chapterRoot = resolveWithin(chaptersRoot, numberedFolder(order, proposal.title, shortId));
      try {
        await access(chapterRoot);
        throw new JizuoError("transaction_recovery_required", "保留章节路径已存在，无法安全创建", {
          proposalId: proposal.id,
          reservedChapterId: proposal.reservedChapterId,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      const timestamp = this.options.now().toISOString();
      const metadata: ChapterFile = {
        schema_version: 1,
        id: proposal.reservedChapterId,
        work_id: proposal.target.workId,
        volume_id: locked.volume.id,
        title: proposal.title,
        order,
        revision_token: proposal.nextHash,
        created_at: timestamp,
        updated_at: timestamp,
      };
      const transaction = await FileTransaction.begin({
        workRoot: locked.workRoot,
        id: `chapter_create_${randomUUID().replaceAll("-", "")}`,
        beforeInstall: async () => assertLockOwner(),
      });
      await Promise.all([
        transaction.stage(relative(locked.workRoot, join(chapterRoot, "chapter.yaml")), stringify(metadata, { lineWidth: 0 })),
        transaction.stage(relative(locked.workRoot, join(chapterRoot, "content.md")), proposal.nextContent),
        transaction.stage(relative(locked.workRoot, join(chapterRoot, "plan.md")), ""),
        transaction.stage(relative(locked.workRoot, join(chapterRoot, "detailed-outline.md")), ""),
      ]);
      await assertLockOwner();
      await transaction.commit();
      return this.documentOf(metadata, proposal.nextContent, "", "");
    });
  }

  async writeWorkflowChapter(
    rawInput: WorkflowChapterCreateInput | WorkflowChapterReplaceInput,
    assertActive?: () => void,
  ): Promise<ChapterDocument> {
    assertActive?.();
    if (rawInput.operation === "create") {
      return this.createWorkflowChapter(WorkflowChapterCreateInputSchema.parse(rawInput), assertActive);
    }
    return this.replaceWorkflowChapter(WorkflowChapterReplaceInputSchema.parse(rawInput), assertActive);
  }

  async initializeWorkflowChapter(
    rawInput: WorkflowChapterInitializeInput,
    assertActive?: () => void,
  ): Promise<ChapterDocument> {
    assertActive?.();
    const input = WorkflowChapterInitializeInputSchema.parse(rawInput);
    return this.createWorkflowChapter({ ...input, operation: "create", content: "", plan: "", detailedOutline: "" }, assertActive, true);
  }

  async saveWorkflowChapterDraft(
    rawInput: WorkflowChapterDraftInput,
    assertActive?: () => void,
  ): Promise<{ relativePath: string; contentHash: string }> {
    assertActive?.();
    const input = WorkflowChapterDraftInputSchema.parse(rawInput);
    const volume = await this.requireWorkflowVolume(input.target.workId, input.target.volumeId);
    assertActive?.();
    return this.withVolumeCreationLock(volume.workRoot, volume.volume.id, async (assertLockOwner) => {
      const locked = await this.requireWorkflowVolume(input.target.workId, input.target.volumeId, volume);
      const entry = await this.inspectWorkflowChapterEntry(resolveWithin(locked.volumeRoot, "chapters"), input.target.chapterId);
      if (!entry) throw new JizuoError("revision_conflict", "归档章节不存在");
      const { root: chapterRoot, metadata } = entry;
      this.requireWorkflowWriteIdentity(metadata, input.runId, input.target, input.workflowTargetKind);
      await assertLockOwner();
      const contentHash = sha256Text(input.content);
      const relativePath = `drafts/${input.runId}/${String(input.revisionRound).padStart(3, "0")}-${contentHash}.md`;
      const destination = resolveWithin(chapterRoot, relativePath);
      const guard = () => {
        assertActive?.();
        this.requireSafeWorkflowPath(destination);
        this.requireSafeWorkflowPath(join(chapterRoot, "chapter.yaml"));
        const current = ChapterFile.parse(parse(readFileSync(join(chapterRoot, "chapter.yaml"), "utf8")));
        this.requireWorkflowWriteIdentity(current, input.runId, input.target, input.workflowTargetKind);
      };
      guard();
      // No await between the last identity/path checks and the exclusive installation.
      // A complete staged inode is linked into place; an existing pathname is never replaced.
      if (this.readExistingWorkflowDraft(destination, input.content)) return { relativePath, contentHash };
      for (const directory of [join(chapterRoot, "drafts"), dirname(destination)]) {
        guard();
        this.requireSafeWorkflowPath(directory);
        try { mkdirSync(directory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        this.requireSafeWorkflowPath(directory);
      }
      const temporary = join(dirname(destination), `.candidate-${randomUUID()}.tmp`);
      let descriptor: number | undefined;
      let temporaryCreated = false;
      try {
        guard();
        this.requireSafeWorkflowPath(temporary);
        descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        temporaryCreated = true;
        writeFileSync(descriptor, input.content, "utf8");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        guard();
        try { linkSync(temporary, destination); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!this.readExistingWorkflowDraft(destination, input.content)) {
            throw new JizuoError("revision_conflict", "候选稿目标在安装时发生变化");
          }
        }
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        if (temporaryCreated) {
          this.requireSafeWorkflowPath(temporary);
          try { unlinkSync(temporary); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
      }
      return { relativePath, contentHash };
    });
  }

  async saveWorkflowChapterLiveDraft(
    rawInput: WorkflowChapterLiveDraftInput,
    assertActive?: () => void,
  ): Promise<{ relativePath: string; contentHash: string }> {
    assertActive?.();
    const input = WorkflowChapterDraftInputSchema.parse(rawInput);
    const volume = await this.requireWorkflowVolume(input.target.workId, input.target.volumeId);
    assertActive?.();
    return this.withVolumeCreationLock(volume.workRoot, volume.volume.id, async (assertLockOwner) => {
      const locked = await this.requireWorkflowVolume(input.target.workId, input.target.volumeId, volume);
      const entry = await this.inspectWorkflowChapterEntry(resolveWithin(locked.volumeRoot, "chapters"), input.target.chapterId);
      if (!entry) throw new JizuoError("revision_conflict", "实时草稿章节不存在");
      const { root: chapterRoot, metadata } = entry;
      this.requireWorkflowChapterIdentity(metadata, input.runId, input.target);
      if (metadata.workflow_draft_status !== "pending" || entry.content !== "") {
        throw new JizuoError("revision_conflict", "正式正文已经存在，不能写入实时草稿");
      }
      await assertLockOwner();
      const relativePath = `drafts/${input.runId}/live.md`;
      const destination = resolveWithin(chapterRoot, relativePath);
      const guard = () => {
        assertActive?.();
        this.requireSafeWorkflowPath(destination);
        this.requireSafeWorkflowPath(join(chapterRoot, "chapter.yaml"));
        const current = ChapterFile.parse(parse(readFileSync(join(chapterRoot, "chapter.yaml"), "utf8")));
        this.requireWorkflowChapterIdentity(current, input.runId, input.target);
        if (current.workflow_draft_status !== "pending") {
          throw new JizuoError("revision_conflict", "正式正文已经提交，不能继续写入实时草稿");
        }
      };
      guard();
      for (const directory of [join(chapterRoot, "drafts"), dirname(destination)]) {
        guard();
        try { mkdirSync(directory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        this.requireSafeWorkflowPath(directory);
      }
      const temporary = join(dirname(destination), `.live-${randomUUID()}.tmp`);
      let descriptor: number | undefined;
      try {
        guard();
        descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        writeFileSync(descriptor, input.content, "utf8");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        guard();
        renameSync(temporary, destination);
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        try { unlinkSync(temporary); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      return { relativePath, contentHash: sha256Text(input.content) };
    });
  }

  async inspectWorkflowChapterWrite(
    rawInput: WorkflowChapterInspectionInput,
  ): Promise<ChapterDocument | undefined> {
    const input = WorkflowChapterInspectionInputSchema.parse(rawInput);
    const volume = await this.findVolumeForInspection(input.target.workId, input.target.volumeId);
    if (volume === undefined) return undefined;
    const { volumeRoot } = volume;
    const chaptersRoot = resolveWithin(volumeRoot, "chapters");
    const match = await this.inspectWorkflowChapterEntry(chaptersRoot, input.target.chapterId);
    if (match === undefined) return undefined;
    this.requireWorkflowWriteIdentity(match.metadata, input.runId, input.target, input.workflowTargetKind);
    return this.documentOf(match.metadata, match.content, match.plan, match.detailedOutline);
  }

  async saveWorkflowChapterProjection(rawInput: unknown) {
    const input = WorkflowChapterProjectionInput.parse(rawInput);
    const volume = await this.requireWorkflowVolume(input.target.workId, input.target.volumeId);
    return this.withVolumeCreationLock(volume.workRoot, volume.volume.id, async (assertLockOwner) => {
      const locked = await this.requireWorkflowVolume(input.target.workId, input.target.volumeId, volume);
      const entry = await this.inspectWorkflowChapterEntry(resolveWithin(locked.volumeRoot, "chapters"), input.target.chapterId);
      if (!entry) throw new JizuoError("validation_error", "章节不存在", input.target);
      const assertIdentity = () => {
        this.requireSafeWorkflowPath(join(entry.root, "chapter.yaml"));
        const current = ChapterFile.parse(parse(readFileSync(join(entry.root, "chapter.yaml"), "utf8")));
        this.requireWorkflowProjectionIdentity(current, input.runId, input.target);
      };
      await assertLockOwner();
      assertIdentity();
      return new WorkflowChapterProjectionStore({
        chapterRoot: entry.root,
        now: this.options.now,
        assertSafePath: (path) => this.requireSafeWorkflowPath(path),
        assertChapterIdentity: assertIdentity,
      }).save(input);
    });
  }

  async listChapterWorkflowRecords(rawInput: unknown) {
    const target = ListChapterWorkflowRecordsInput.parse(rawInput);
    const { chapterRoot } = await this.findWorkflowChapter(target);
    return new WorkflowChapterProjectionStore({
      chapterRoot,
      now: this.options.now,
      assertSafePath: (path) => this.requireSafeWorkflowPath(path),
    }).list();
  }

  async readChapterWorkflowRecord(rawInput: unknown) {
    const input = ReadChapterWorkflowRecordInput.parse(rawInput);
    const { chapterRoot } = await this.findWorkflowChapter(input);
    return new WorkflowChapterProjectionStore({
      chapterRoot,
      now: this.options.now,
      assertSafePath: (path) => this.requireSafeWorkflowPath(path),
    }).read(input);
  }

  async renameChapter(rawInput: unknown): Promise<ChapterSummary> {
    const input = RenameChapterInput.parse(rawInput);
    const { chapterRoot, metadata } = await this.findChapter(input);
    const shortId = metadata.id.replace(/^ch_/, "");
    const nextMetadata: ChapterFile = {
      ...metadata,
      title: input.title,
      updated_at: this.options.now().toISOString(),
    };
    await renameMaterializedDirectory({
      currentRoot: chapterRoot,
      nextRoot: resolveWithin(dirname(chapterRoot), numberedFolder(metadata.order, input.title, shortId)),
      metadataName: "chapter.yaml",
      serializedMetadata: stringify(nextMetadata, { lineWidth: 0 }),
    });
    return this.summaryOf(nextMetadata);
  }

  async listChapters(target: { workId: string; volumeId: string }): Promise<ChapterSummary[]> {
    const { volumeRoot } = await this.findVolume(target.workId, target.volumeId);
    const entries = await this.chapterEntries(resolveWithin(volumeRoot, "chapters"));
    const summaries = await Promise.all(entries.map(async ({ root, metadata }) => {
      if (metadata.workflow_draft_status !== "pending") return this.summaryOf(metadata);
      const content = await readFile(join(root, "content.md"), "utf8");
      return this.summaryOf(content.length > 0 ? { ...metadata, workflow_draft_status: "draft" } : metadata);
    }));
    return summaries.sort((left, right) => left.order - right.order);
  }

  async listVolumes(workId: string): Promise<VolumeSummary[]> {
    const work = await this.options.findWork(StableId.parse(workId));
    const volumesRoot = resolveWithin(this.options.worksRoot, work.folderName, "content", "volumes");
    return (await this.volumeEntries(volumesRoot))
      .map(({ root, metadata }) => this.volumeSummaryOf(root, metadata))
      .sort((left, right) => left.order - right.order);
  }

  async readChapter(rawTarget: ChapterTarget): Promise<ChapterDocument> {
    const target = ChapterTarget.parse(rawTarget);
    const { chapterRoot, metadata } = await this.findChapterForRead(target);
    const [content, plan, detailedOutline] = await Promise.all([
      readFile(join(chapterRoot, "content.md"), "utf8"),
      readFile(join(chapterRoot, "plan.md"), "utf8"),
      readOptionalText(join(chapterRoot, "detailed-outline.md")),
    ]);
    const actualRevision = sha256Text(content);
    const document = this.documentOf({ ...metadata, revision_token: actualRevision }, content, plan, detailedOutline);
    const liveDraft = await this.readWorkflowChapterLiveDraft(chapterRoot, metadata, content);
    return liveDraft === undefined ? document : { ...document, liveDraft };
  }

  async replaceChapter(rawInput: ChapterTarget & {
    content: string;
    expectedRevision: string;
    editSessionId?: string | undefined;
  }): Promise<ChapterDocument> {
    return this.replaceChapterWithCheckpoint(rawInput, rawInput.editSessionId === undefined ? undefined : {
      source: "manual",
      label: "编辑前版本",
      editSessionId: rawInput.editSessionId,
    });
  }

  async replaceChapterFromProposal(rawInput: ChapterTarget & {
    content: string;
    expectedRevision: string;
  }): Promise<ChapterDocument> {
    return this.replaceChapterWithCheckpoint(rawInput, { source: "proposal", label: "应用提案前" });
  }

  private async replaceChapterWithCheckpoint(
    rawInput: ChapterTarget & { content: string; expectedRevision: string; editSessionId?: string | undefined },
    checkpoint?: ChapterHistoryCheckpoint,
  ): Promise<ChapterDocument> {
    const input = ReplaceChapterInput.parse(rawInput);
    return this.withChapterListLock(input, async (assertLockOwner) => {
      const { workRoot, chapterRoot, metadata } = await this.findChapter(input);
      const currentContent = await readFile(join(chapterRoot, "content.md"), "utf8");
      const currentRevision = sha256Text(currentContent);
      if (currentRevision !== input.expectedRevision) {
        throw new JizuoError("revision_conflict", "章节已在其他位置更新", {
          chapterId: input.chapterId,
          expectedRevision: input.expectedRevision,
          actualRevision: currentRevision,
        });
      }
      const revisionToken = sha256Text(input.content);
      const nextMetadata: ChapterFile = {
        ...metadata,
        revision_token: revisionToken,
        updated_at: this.options.now().toISOString(),
        ...(metadata.workflow_draft_status !== undefined && input.content.length > 0 ? { workflow_draft_status: "draft" as const } : {}),
      };
      await assertLockOwner();
      if (checkpoint !== undefined && input.content !== currentContent) {
        await this.history.record({
          workRoot,
          chapterId: input.chapterId,
          contentRelativePath: relative(workRoot, join(chapterRoot, "content.md")),
          content: currentContent,
          checkpoint,
        });
      }
      await this.commitChapterFiles(workRoot, chapterRoot, nextMetadata, { content: input.content });
      const [plan, detailedOutline] = await Promise.all([
        readFile(join(chapterRoot, "plan.md"), "utf8"),
        readOptionalText(join(chapterRoot, "detailed-outline.md")),
      ]);
      return this.documentOf(nextMetadata, input.content, plan, detailedOutline);
    });
  }

  async listChapterRevisions(rawTarget: ChapterTarget): Promise<ChapterRevisionSummary[]> {
    const target = ChapterTarget.parse(rawTarget);
    const { workRoot, chapterRoot } = await this.findChapter(target);
    const currentContent = await readFile(join(chapterRoot, "content.md"), "utf8");
    return this.history.list({
      workRoot,
      chapterId: target.chapterId,
      contentRelativePath: relative(workRoot, join(chapterRoot, "content.md")),
      currentRevision: sha256Text(currentContent),
    });
  }

  async readChapterRevision(rawInput: unknown): Promise<ChapterRevisionDocument> {
    const input = ReadChapterRevisionInput.parse(rawInput);
    const { workRoot, chapterRoot } = await this.findChapter(input);
    return this.history.read({
      workRoot,
      chapterId: input.chapterId,
      contentRelativePath: relative(workRoot, join(chapterRoot, "content.md")),
      revision: input.revision,
    });
  }

  async saveChapterPlan(rawInput: SaveChapterPlanInput): Promise<ChapterDocument> {
    const input = SaveChapterPlanInput.parse(rawInput);
    const { workRoot, chapterRoot, metadata } = await this.findChapter(input);
    const content = await readFile(join(chapterRoot, "content.md"), "utf8");
    this.requireRevision(input.chapterId, input.expectedRevision, sha256Text(content));
    const nextMetadata = { ...metadata, updated_at: this.options.now().toISOString() };
    await this.commitChapterFiles(workRoot, chapterRoot, nextMetadata, { plan: input.plan });
    const detailedOutline = await readOptionalText(join(chapterRoot, "detailed-outline.md"));
    return this.documentOf(nextMetadata, content, input.plan, detailedOutline);
  }

  async saveChapterOutline(rawInput: SaveChapterOutlineInput): Promise<ChapterDocument> {
    const input = SaveChapterOutlineInput.parse(rawInput);
    const { workRoot, chapterRoot, metadata } = await this.findChapter(input);
    const content = await readFile(join(chapterRoot, "content.md"), "utf8");
    this.requireRevision(input.chapterId, input.expectedRevision, sha256Text(content));
    const nextMetadata = { ...metadata, updated_at: this.options.now().toISOString() };
    await this.commitChapterFiles(workRoot, chapterRoot, nextMetadata, {
      plan: input.outline,
      detailedOutline: input.detailedOutline,
    });
    return this.documentOf(nextMetadata, content, input.outline, input.detailedOutline);
  }

  async appendChapter(rawInput: AppendChapterInput): Promise<ChapterDocument> {
    const input = AppendChapterInput.parse(rawInput);
    const current = await this.readChapter(input);
    return this.replaceChapter({ ...input, content: `${current.content}${input.text}` });
  }

  async editChapter(rawInput: EditChapterInput): Promise<ChapterDocument> {
    const input = EditChapterInput.parse(rawInput);
    const current = await this.readChapter(input);
    this.requireRevision(input.chapterId, input.baseContentHash, current.revisionToken);
    const operations = [...input.operations].sort((left, right) => left.start - right.start || left.end - right.end);
    let cursor = 0;
    let nextContent = "";
    for (const operation of operations) {
      if (operation.start < cursor || operation.end < operation.start || operation.end > current.content.length) {
        throw new JizuoError("validation_error", "章节编辑范围无效或互相重叠", {
          chapterId: input.chapterId,
          operation,
          contentLength: current.content.length,
        });
      }
      nextContent += current.content.slice(cursor, operation.start) + operation.text;
      cursor = operation.end;
    }
    nextContent += current.content.slice(cursor);
    return this.replaceChapter({ ...input, content: nextContent, expectedRevision: input.baseContentHash });
  }

  async restoreChapterRevision(rawInput: RestoreChapterRevisionInput): Promise<ChapterDocument> {
    const input = RestoreChapterRevisionInput.parse(rawInput);
    const { workRoot, chapterRoot } = await this.findChapter(input);
    const currentContent = await readFile(join(chapterRoot, "content.md"), "utf8");
    this.requireRevision(input.chapterId, input.expectedRevision, sha256Text(currentContent));
    const contentRelativePath = relative(workRoot, join(chapterRoot, "content.md"));
    let restoredContent: string;
    try {
      restoredContent = (await this.history.read({
        workRoot,
        chapterId: input.chapterId,
        contentRelativePath,
        revision: input.revision,
      })).content;
    } catch (historyError) {
      if (!(historyError instanceof JizuoError) || historyError.code !== "validation_error") throw historyError;
      try {
        restoredContent = await readFile(
          resolveWithin(workRoot, ".jizuo", "revisions", input.revision, contentRelativePath),
          "utf8",
        );
      } catch {
        throw new JizuoError("validation_error", "指定章节版本不存在", {
          chapterId: input.chapterId,
          revision: input.revision,
        });
      }
    }
    if (sha256Text(restoredContent) !== input.revision) {
      throw new JizuoError("transaction_recovery_required", "章节版本校验失败", {
        chapterId: input.chapterId,
        revision: input.revision,
      });
    }
    return this.replaceChapterWithCheckpoint(
      { ...input, content: restoredContent },
      { source: "restore", label: "恢复前版本" },
    );
  }

  async inspectTrashTarget(rawInput: unknown) {
    const input = TrashTarget.parse(rawInput);
    if (input.kind === "work") {
      throw new JizuoError("validation_error", "作品删除必须由作品服务处理", input);
    }
    if (input.kind === "volume") {
      const { volumeRoot, volume } = await this.findVolume(input.workId, input.volumeId);
      const chapters = await this.chapterEntries(resolveWithin(volumeRoot, "chapters"));
      return {
        kind: "volume" as const,
        title: volume.title,
        volumeCount: 0,
        chapterCount: chapters.length,
      };
    }
    const { metadata } = await this.findChapter(input);
    return {
      kind: "chapter" as const,
      title: metadata.title,
      volumeCount: 0,
      chapterCount: 0,
    };
  }

  async moveToTrash(rawInput: MoveToTrashInput) {
    const input = MoveToTrashInput.parse(rawInput);
    if (input.kind === "work") {
      throw new JizuoError("validation_error", "作品删除必须由作品服务处理", input);
    }
    if (input.kind === "volume") {
      return this.withChapterListLock(input, async (assertLockOwner) => {
        const impact = await this.inspectTrashTarget(input);
        const { volumeRoot } = await this.findVolume(input.workId, input.volumeId);
        await assertLockOwner();
        return moveDirectoryToTrash({
          worksRoot: this.options.worksRoot,
          itemRoot: volumeRoot,
          trashId: `trash_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
          kind: "volume",
          workId: input.workId,
          volumeId: input.volumeId,
          title: impact.title,
          volumeCount: impact.volumeCount,
          chapterCount: impact.chapterCount,
          now: this.options.now(),
        });
      });
    }
    return this.withChapterListLock(input, async (assertLockOwner) => {
      const impact = await this.inspectTrashTarget(input);
      const { chapterRoot } = await this.findChapter(input);
      await assertLockOwner();
      return moveDirectoryToTrash({
        worksRoot: this.options.worksRoot,
        itemRoot: chapterRoot,
        trashId: `trash_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        kind: "chapter",
        workId: input.workId,
        volumeId: input.volumeId,
        chapterId: input.chapterId,
        title: impact.title,
        volumeCount: 0,
        chapterCount: 0,
        now: this.options.now(),
      });
    });
  }

  async restoreFromTrash(rawInput: RestoreFromTrashInput) {
    const input = RestoreFromTrashInput.parse(rawInput);
    const entry = (await listTrashEntries(this.options.worksRoot))
      .find((candidate) => candidate.trashId === input.trashId);
    if (entry === undefined || entry.kind === "work") {
      throw new JizuoError("validation_error", "回收站项目不存在或类型无效", { trashId: input.trashId });
    }
    if (entry.volumeId === undefined) {
      throw new JizuoError("validation_error", "回收项缺少分卷 ID", { trashId: input.trashId });
    }
    return this.withChapterListLockById({ workId: input.workId, volumeId: entry.volumeId }, async (assertLockOwner) => {
      const folderName = basename(entry.originalRelativePath);
      let targetRoot: string;
      if (entry.kind === "volume") {
        const work = await this.options.findWork(input.workId);
        targetRoot = resolveWithin(this.options.worksRoot, work.folderName, "content", "volumes", folderName);
      } else {
        const { volumeRoot } = await this.findVolume(input.workId, entry.volumeId!);
        targetRoot = resolveWithin(volumeRoot, "chapters", folderName);
      }
      await assertLockOwner();
      return restoreDirectoryFromTrash({ worksRoot: this.options.worksRoot, ...input, targetRoot });
    });
  }

  private requireRevision(chapterId: string, expectedRevision: string, actualRevision: string): void {
    if (actualRevision !== expectedRevision) {
      throw new JizuoError("revision_conflict", "章节已在其他位置更新", {
        chapterId,
        expectedRevision,
        actualRevision,
      });
    }
  }

  private async createWorkflowChapter(
    input: z.output<typeof WorkflowChapterCreateInputSchema>,
    assertActive?: () => void,
    initializeOnly = false,
  ): Promise<ChapterDocument> {
    if (!input.reservedChapterId.startsWith("ch_")) {
      throw new JizuoError("validation_error", "工作流保留章节 ID 格式无效", {
        reservedChapterId: input.reservedChapterId,
      });
    }
    if (input.target.mode === "create_next" && input.target.afterChapterId !== input.insertAfterChapterId) {
      throw new JizuoError("revision_conflict", "工作流章节插入锚点不一致", {
        targetAfterChapterId: input.target.afterChapterId,
        insertAfterChapterId: input.insertAfterChapterId,
      });
    }

    const initialVolume = initializeOnly
      ? await this.requireWorkflowVolume(input.target.workId, input.target.volumeId)
      : await this.findVolume(input.target.workId, input.target.volumeId);
    const { workRoot, volume } = initialVolume;
    assertActive?.();
    return this.withVolumeCreationLock(workRoot, volume.id, async (assertLockOwner) => {
      const locked = initializeOnly
        ? await this.requireWorkflowVolume(input.target.workId, input.target.volumeId, initialVolume)
        : await this.findVolume(input.target.workId, input.target.volumeId);
      const chaptersRoot = resolveWithin(locked.volumeRoot, "chapters");
      const reserved = await this.inspectWorkflowChapterEntry(chaptersRoot, input.reservedChapterId);
      const chapters = await this.currentChapterEntries(chaptersRoot);
      const targetFingerprint = this.workflowCreateTargetFingerprint(input);
      if (reserved !== undefined) {
        const existing = reserved;
        this.requireWorkflowCreateProof(input, existing, chapters);
        assertActive?.();
        if (initializeOnly) return this.documentOf(existing.metadata, existing.content, existing.plan, existing.detailedOutline);
        if (existing.metadata.workflow_draft_status === "pending") {
          this.requireEmptyWorkflowShell(existing);
          const target = { workId: input.target.workId, volumeId: input.target.volumeId, chapterId: input.reservedChapterId };
          return this.replaceWorkflowChapterLocked({
            operation: "replace", runId: input.runId, target,
            workflowTargetKind: "created",
            expectedRevision: sha256Text(""), expectedPlan: "", expectedDetailedOutline: "",
            content: input.content, plan: input.plan, detailedOutline: input.detailedOutline,
          }, assertLockOwner, assertActive, async () => {
            const current = await this.findWorkflowChapter(target);
            this.requireWorkflowCreateProof(input, current, await this.currentChapterEntries(chaptersRoot));
            this.requireEmptyWorkflowShell(current);
          });
        }
        this.requireRevision(input.reservedChapterId, sha256Text(input.content), existing.revisionToken);
        return this.documentOf(existing.metadata, existing.content, existing.plan, existing.detailedOutline);
      }

      if (input.requireInitialized) {
        throw new JizuoError("revision_conflict", "工作流章节尚未初始化，不能写入正文", { reservedChapterId: input.reservedChapterId });
      }

      const actualHash = this.hashChapterList(chapters);
      const actualAnchor = chapters.at(-1)?.metadata.id ?? null;
      if (actualHash !== input.chapterListHash || actualAnchor !== input.insertAfterChapterId) {
        throw new JizuoError("revision_conflict", "章节列表已变化，不能安全执行工作流写入", {
          expectedChapterListHash: input.chapterListHash,
          actualChapterListHash: actualHash,
          insertAfterChapterId: input.insertAfterChapterId,
          actualInsertAfterChapterId: actualAnchor,
        });
      }

      const order = Math.max(0, ...chapters.map((entry) => entry.metadata.order)) + 1;
      const shortId = input.reservedChapterId.replace(/^ch_/, "");
      const chapterRoot = resolveWithin(chaptersRoot, numberedFolder(order, input.target.title, shortId));
      const timestamp = this.options.now().toISOString();
      const revisionToken = sha256Text(input.content);
      const metadata: ChapterFile = {
        schema_version: 1,
        id: input.reservedChapterId,
        work_id: input.target.workId,
        volume_id: locked.volume.id,
        title: input.target.title,
        order,
        revision_token: revisionToken,
        created_at: timestamp,
        updated_at: timestamp,
        workflow_origin_run: input.runId,
        workflow_target_fingerprint: targetFingerprint,
        workflow_draft_status: initializeOnly ? "pending" : "draft",
      };
      const guard = () => {
        assertActive?.();
        this.requireSafeWorkflowPath(chapterRoot);
        this.requireSafeWorkflowPath(join(locked.workRoot, ".jizuo", "transactions"));
        for (const name of ["chapter.yaml", "content.md", "plan.md", "detailed-outline.md"]) this.requireSafeWorkflowPath(join(chapterRoot, name));
      };
      guard();
      const transaction = await FileTransaction.begin({
        workRoot: locked.workRoot,
        id: `workflow_chapter_create_${randomUUID().replaceAll("-", "")}`,
        beforePreserveRevision: (destination) => this.requireSafeWorkflowPath(destination),
        beforeInstall: async (_relativePath, _index, context) => {
          await assertLockOwner();
          guard();
          if (await context.readOriginal() !== undefined || await context.targetExists()) {
            throw new JizuoError("revision_conflict", "初始化章节路径已被其他写入占用");
          }
          guard();
        },
        assertActive: guard,
      });
      await Promise.all([
        transaction.stage(relative(locked.workRoot, join(chapterRoot, "content.md")), input.content),
        transaction.stage(relative(locked.workRoot, join(chapterRoot, "plan.md")), input.plan),
        transaction.stage(relative(locked.workRoot, join(chapterRoot, "detailed-outline.md")), input.detailedOutline),
      ]);
      // Metadata makes the chapter discoverable; install it only after its files.
      await transaction.stage(relative(locked.workRoot, join(chapterRoot, "chapter.yaml")), stringify(metadata, { lineWidth: 0 }));
      try {
        await assertLockOwner();
        guard();
        await transaction.commit();
      } catch (error) {
        await transaction.rollback();
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new JizuoError("revision_conflict", "初始化章节目录已被其他写入占用");
        throw error;
      }
      return this.documentOf(metadata, input.content, input.plan, input.detailedOutline);
    });
  }

  private async replaceWorkflowChapter(
    input: z.output<typeof WorkflowChapterReplaceInputSchema>,
    assertActive?: () => void,
  ): Promise<ChapterDocument> {
    return this.withChapterListLock(input.target, (assertLockOwner) => this.replaceWorkflowChapterLocked(input, assertLockOwner, assertActive));
  }

  private async replaceWorkflowChapterLocked(
    input: z.output<typeof WorkflowChapterReplaceInputSchema>,
    assertLockOwner: () => Promise<void>,
    assertActive?: () => void,
    requireInitializationProof?: () => Promise<void>,
  ): Promise<ChapterDocument> {
      const { workRoot, chapterRoot, metadata, content, plan, detailedOutline } = await this.findWorkflowChapter(input.target);
      this.requireWorkflowWriteIdentity(metadata, input.runId, input.target, input.workflowTargetKind);
      this.requireRevision(input.target.chapterId, input.expectedRevision, sha256Text(content));
      const requirePriorDocuments = (currentPlan: string, currentDetailedOutline: string) => {
        if ((input.expectedPlan !== undefined && currentPlan !== input.expectedPlan)
          || (input.expectedDetailedOutline !== undefined && currentDetailedOutline !== input.expectedDetailedOutline)) {
          throw new JizuoError("revision_conflict", "章节计划或细纲已被修改，不能安全覆盖");
        }
      };
      requirePriorDocuments(plan, detailedOutline);
      const nextMetadata: ChapterFile = {
        ...metadata,
        revision_token: sha256Text(input.content),
        updated_at: this.options.now().toISOString(),
        workflow_draft_status: "draft",
      };
      const contentRelativePath = relative(workRoot, join(chapterRoot, "content.md"));
      await assertLockOwner();
      assertActive?.();
      if (input.revisionRound !== undefined && input.content !== content) {
        await this.history.record({
          workRoot,
          chapterId: input.target.chapterId,
          contentRelativePath,
          content,
          checkpoint: {
            source: "workflow",
            label: this.workflowRevisionLabel({
              targetKind: input.workflowTargetKind,
              effectId: input.workflowEffectId,
              round: input.revisionRound,
              previousEffectId: input.previousWorkflowEffectId,
              previousRound: input.previousWorkflowRevisionRound,
            }),
            workflowRunId: input.runId,
            ...(input.previousWorkflowEffectId !== undefined
              ? { workflowEffectId: input.previousWorkflowEffectId }
              : input.workflowEffectId !== undefined ? { workflowEffectId: input.workflowEffectId } : {}),
            workflowRevisionRound: input.previousWorkflowRevisionRound ?? input.revisionRound,
          },
        });
      }
      await this.commitChapterFiles(
        workRoot,
        chapterRoot,
        nextMetadata,
        {
          content: input.content,
          ...(input.plan === undefined ? {} : { plan: input.plan }),
          ...(input.detailedOutline === undefined ? {} : { detailedOutline: input.detailedOutline }),
        },
        {
          ...(assertActive === undefined ? {} : { assertActive }),
          beforeCommit: async () => {
            await assertLockOwner();
            await requireInitializationProof?.();
            const current = await this.findWorkflowChapter(input.target);
            this.requireWorkflowWriteIdentity(current.metadata, input.runId, input.target, input.workflowTargetKind);
            this.requireRevision(input.target.chapterId, input.expectedRevision, current.revisionToken);
            requirePriorDocuments(current.plan, current.detailedOutline);
          },
          beforeInstall: async (relativePath, index, context) => {
            await assertLockOwner();
            const isMetadata = relativePath === relative(workRoot, join(chapterRoot, "chapter.yaml"));
            const expectedDocument = relativePath === relative(workRoot, join(chapterRoot, "plan.md")) ? input.expectedPlan
              : relativePath === relative(workRoot, join(chapterRoot, "detailed-outline.md")) ? input.expectedDetailedOutline : undefined;
            if (index !== 0 && expectedDocument === undefined && !isMetadata) return;
            const [originalContent, targetExists] = await Promise.all([
              context.readOriginal(),
              context.targetExists(),
            ]);
            if ((index === 0 && relativePath !== contentRelativePath) || originalContent === undefined || targetExists) {
              throw new JizuoError("revision_conflict", "章节在事务安装前发生变化，不能安全覆盖", {
                chapterId: input.target.chapterId,
                relativePath,
                targetExists,
              });
            }
            if (isMetadata) {
              const current = ChapterFile.safeParse(parse(originalContent));
              if (!current.success) throw new JizuoError("revision_conflict", "章节元数据在事务安装前发生变化");
              const { revision_token: _currentRevision, ...currentIdentity } = current.data;
              const { revision_token: _priorRevision, ...priorIdentity } = metadata;
              if (JSON.stringify(currentIdentity) !== JSON.stringify(priorIdentity)) {
                throw new JizuoError("revision_conflict", "章节身份或元数据在事务安装前发生变化");
              }
            }
            else if (index === 0) this.requireRevision(input.target.chapterId, input.expectedRevision, sha256Text(originalContent));
            else if (originalContent !== expectedDocument) throw new JizuoError("revision_conflict", "章节计划或细纲在事务安装前发生变化，不能安全覆盖");
          },
        },
      );
      this.removeWorkflowChapterLiveDraft(chapterRoot, input.runId);
      return this.documentOf(
        nextMetadata,
        input.content,
        input.plan ?? plan,
        input.detailedOutline ?? detailedOutline,
      );
  }

  private requireEmptyWorkflowShell(entry: WorkflowChapterEntry): void {
    if (entry.metadata.workflow_draft_status !== "pending" || entry.content !== "" || entry.plan !== "" || entry.detailedOutline !== "") {
      throw new JizuoError("revision_conflict", "待生成章节已被编辑，不能安全填充", { chapterId: entry.metadata.id });
    }
  }

  private async readWorkflowChapterLiveDraft(chapterRoot: string, metadata: ChapterFile, formalContent: string): Promise<string | undefined> {
    if (formalContent !== "" || metadata.workflow_draft_status !== "pending" || metadata.workflow_origin_run === undefined) return undefined;
    const path = resolveWithin(chapterRoot, "drafts", metadata.workflow_origin_run, "live.md");
    this.requireSafeWorkflowPath(path);
    try {
      const content = await readFile(path, "utf8");
      return content === "" ? undefined : content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private removeWorkflowChapterLiveDraft(chapterRoot: string, runId: string): void {
    const path = resolveWithin(chapterRoot, "drafts", StableId.parse(runId), "live.md");
    try {
      this.requireSafeWorkflowPath(path);
      unlinkSync(path);
    } catch (error) {
      // Formal content is already committed. A missing or externally replaced
      // preview must not turn a successful chapter write into an uncertain one.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
  }

  private requireSafeWorkflowPath(path: string): void {
    const target = resolveWithin(this.options.worksRoot, path);
    let current = this.options.worksRoot;
    const parts = relative(current, target).split(sep).filter(Boolean);
    for (let index = -1; index < parts.length; index++) {
      if (index >= 0) current = join(current, parts[index]!);
      let entry;
      try { entry = lstatSync(current); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (entry.isSymbolicLink() || (!entry.isDirectory() && (!entry.isFile() || index < parts.length - 1))) {
        throw new JizuoError("revision_conflict", "工作流路径包含符号链接或非标准文件，不能安全写入", { path: current });
      }
    }
  }

  private readExistingWorkflowDraft(path: string, content: string): boolean {
    this.requireSafeWorkflowPath(path);
    let descriptor: number;
    try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    try {
      if (readFileSync(descriptor, "utf8") !== content) {
        throw new JizuoError("revision_conflict", "候选稿历史文件已存在且内容不匹配，不能覆盖", { path });
      }
      return true;
    } finally { closeSync(descriptor); }
  }

  private requireWorkflowCreateProof(
    input: WorkflowChapterInitializeInput,
    existing: WorkflowChapterEntry,
    chapters: CurrentChapterEntry[],
  ): void {
    const prior = chapters.filter((entry) => entry.metadata.id !== input.reservedChapterId);
    this.requireWorkflowChapterIdentity(existing.metadata, input.runId, { ...input.target, chapterId: input.reservedChapterId });
    if (existing.metadata.workflow_target_fingerprint !== this.workflowCreateTargetFingerprint(input)
      || existing.metadata.title !== input.target.title
      || this.hashChapterList(prior) !== input.chapterListHash
      || (prior.at(-1)?.metadata.id ?? null) !== input.insertAfterChapterId
      || chapters.at(-1)?.metadata.id !== input.reservedChapterId) {
      throw new JizuoError("revision_conflict", "工作流章节的现有结果不完整或与重试输入冲突", { runId: input.runId, reservedChapterId: input.reservedChapterId });
    }
  }

  private requireWorkflowChapterIdentity(
    metadata: ChapterFile,
    runId: string,
    target: { workId: string; volumeId: string; chapterId: string },
  ): void {
    if (
      metadata.workflow_origin_run !== runId
      || metadata.id !== target.chapterId
      || metadata.work_id !== target.workId
      || metadata.volume_id !== target.volumeId
    ) {
      throw new JizuoError("revision_conflict", "章节不属于本次工作流，不能安全写入或对账", {
        runId,
        ...target,
      });
    }
  }

  private requireWorkflowWriteIdentity(
    metadata: ChapterFile,
    runId: string,
    target: { workId: string; volumeId: string; chapterId: string },
    workflowTargetKind: "created" | "existing",
  ): void {
    if (workflowTargetKind === "created") {
      this.requireWorkflowChapterIdentity(metadata, runId, target);
      return;
    }
    if (metadata.id !== target.chapterId || metadata.work_id !== target.workId || metadata.volume_id !== target.volumeId) {
      throw new JizuoError("revision_conflict", "锁定的既有章节身份已经变化，不能安全写入或对账", {
        runId,
        ...target,
      });
    }
  }

  private requireWorkflowProjectionIdentity(
    metadata: ChapterFile,
    runId: string,
    target: { workId: string; volumeId: string; chapterId: string },
  ): void {
    if (
      metadata.id !== target.chapterId
      || metadata.work_id !== target.workId
      || metadata.volume_id !== target.volumeId
      || metadata.workflow_origin_run !== undefined && metadata.workflow_origin_run !== runId
    ) {
      throw new JizuoError("revision_conflict", "章节与本次工作流投影目标不匹配", { runId, ...target });
    }
  }

  private workflowRevisionLabel(input: Readonly<{
    targetKind: "created" | "existing";
    effectId: z.infer<typeof WorkflowChapterEffectId> | undefined;
    round: number;
    previousEffectId: z.infer<typeof WorkflowChapterEffectId> | undefined;
    previousRound: number | undefined;
  }>): string {
    if (input.targetKind === "existing" && input.effectId === "write" && input.round === 0
      && input.previousEffectId === undefined) return "工作流修改前";
    const effectId = input.previousEffectId ?? (input.round > 1 ? input.effectId : "write");
    const round = input.previousRound ?? Math.max(0, input.round - 1);
    if (effectId === "write") return "工作流初稿";
    const stage = effectId?.replace(/-revise$/, "");
    if (stage === "continuity") return `连续性修订第 ${round} 轮`;
    if (stage === "style") return `文风修订第 ${round} 轮`;
    if (stage === "ai-trace") return `AI 痕迹修订第 ${round} 轮`;
    return round > 0 ? `工作流修订第 ${round} 轮` : "工作流初稿";
  }

  private workflowCreateTargetFingerprint(input: WorkflowChapterInitializeInput): string {
    return sha256Text(JSON.stringify({
      mode: input.target.mode,
      workId: input.target.workId,
      volumeId: input.target.volumeId,
      afterChapterId: input.target.mode === "create_next" ? input.target.afterChapterId : null,
      insertAfterChapterId: input.insertAfterChapterId,
      title: input.target.title,
      chapterListHash: input.chapterListHash,
    }));
  }

  private async inspectWorkflowChapterEntry(
    chaptersRoot: string,
    chapterId: string,
  ): Promise<WorkflowChapterEntry | undefined> {
    this.requireSafeWorkflowPath(chaptersRoot);
    let directories: string[];
    try {
      const entries = await readdir(chaptersRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new JizuoError("revision_conflict", "章节目录包含符号链接，不能安全写入", { chapterId });
      }
      directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => resolveWithin(chaptersRoot, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }

    const shortId = chapterId.replace(/^ch_/, "");
    const suffixMatches = directories.filter((root) => basename(root).endsWith(`--${shortId}`));
    const idMatches: Array<{ root: string; metadata: ChapterFile }> = [];
    const malformed: string[] = [];
    for (const root of directories) {
      this.requireSafeWorkflowPath(join(root, "chapter.yaml"));
      let rawMetadata: string;
      try {
        rawMetadata = await readFile(join(root, "chapter.yaml"), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        malformed.push(root);
        continue;
      }
      try {
        const metadata = ChapterFile.parse(parse(rawMetadata));
        if (metadata.id === chapterId) idMatches.push({ root, metadata });
      } catch {
        malformed.push(root);
      }
    }

    if (malformed.length > 0) {
      throw new JizuoError("revision_conflict", "章节目录存在无法解析的元数据，无法安全写入或对账", {
        chapterId,
        malformedCount: malformed.length,
      });
    }
    if (suffixMatches.length === 0 && idMatches.length === 0) return undefined;
    if (
      suffixMatches.length !== 1
      || idMatches.length !== 1
      || suffixMatches[0] !== idMatches[0]!.root
    ) {
      throw new JizuoError("revision_conflict", "工作流章节 ID 或路径不唯一，无法安全写入或对账", {
        chapterId,
        idMatchCount: idMatches.length,
        suffixMatchCount: suffixMatches.length,
      });
    }

    const match = idMatches[0]!;
    try {
      for (const name of ["content.md", "plan.md", "detailed-outline.md"]) this.requireSafeWorkflowPath(join(match.root, name));
      const [content, plan, detailedOutline] = await Promise.all([
        readFile(join(match.root, "content.md"), "utf8"),
        readFile(join(match.root, "plan.md"), "utf8"),
        readFile(join(match.root, "detailed-outline.md"), "utf8"),
      ]);
      return {
        ...match,
        metadata: { ...match.metadata, revision_token: sha256Text(content) },
        content,
        plan,
        detailedOutline,
        revisionToken: sha256Text(content),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new JizuoError("revision_conflict", "工作流章节缺少可读的标准文件，无法安全写入或对账", { chapterId });
    }
  }

  async resolveChapterPath(target: ChapterTarget): Promise<{ path: string }> {
    const { chapterRoot } = await this.findChapterForRead(target);
    return { path: chapterRoot };
  }

  private async findWorkflowChapter(
    target: ChapterTarget,
  ): Promise<{ workRoot: string; chapterRoot: string } & WorkflowChapterEntry> {
    const { workRoot, volumeRoot } = await this.findVolume(target.workId, target.volumeId);
    const entry = await this.inspectWorkflowChapterEntry(resolveWithin(volumeRoot, "chapters"), target.chapterId);
    if (entry === undefined) throw new JizuoError("validation_error", "章节不存在", target);
    return { workRoot, chapterRoot: entry.root, ...entry };
  }

  private async commitChapterFiles(
    workRoot: string,
    chapterRoot: string,
    metadata: ChapterFile,
    update: { content?: string; plan?: string; detailedOutline?: string },
    hooks?: {
      assertActive?: () => void;
      beforeCommit?: () => Promise<void>;
      beforeInstall?: (
        relativePath: string,
        index: number,
        context: FileTransactionInstallContext,
      ) => Promise<void>;
    },
  ): Promise<void> {
    const guard = () => {
      hooks?.assertActive?.();
      this.requireSafeWorkflowPath(join(workRoot, ".jizuo", "transactions"));
      for (const name of ["chapter.yaml", "content.md", "plan.md", "detailed-outline.md"]) this.requireSafeWorkflowPath(join(chapterRoot, name));
    };
    guard();
    const transaction = await FileTransaction.begin({
      workRoot,
      id: `chapter_${randomUUID().replaceAll("-", "")}`,
      beforePreserveRevision: (destination) => this.requireSafeWorkflowPath(destination),
      ...(hooks?.beforeInstall === undefined ? {} : { beforeInstall: hooks.beforeInstall }),
      assertActive: guard,
    });
    if (update.content !== undefined) {
      await transaction.stage(relative(workRoot, join(chapterRoot, "content.md")), update.content);
    }
    if (update.plan !== undefined) {
      await transaction.stage(relative(workRoot, join(chapterRoot, "plan.md")), update.plan);
    }
    if (update.detailedOutline !== undefined) {
      await transaction.stage(
        relative(workRoot, join(chapterRoot, "detailed-outline.md")),
        update.detailedOutline,
      );
    }
    await transaction.stage(
      relative(workRoot, join(chapterRoot, "chapter.yaml")),
      stringify(metadata, { lineWidth: 0 }),
    );
    try {
      await hooks?.beforeCommit?.();
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new JizuoError("revision_conflict", "事务安装目标已被外部写入，不能安全覆盖", {
          chapterId: metadata.id,
        });
      }
      throw error;
    }
  }

  private async findVolume(
    workId: string,
    volumeId: string,
  ): Promise<{ workRoot: string; volumeRoot: string; volume: VolumeFile }> {
    const work = await this.options.findWork(StableId.parse(workId));
    const workRoot = resolveWithin(this.options.worksRoot, work.folderName);
    const volumesRoot = resolveWithin(workRoot, "content", "volumes");
    this.requireSafeWorkflowPath(volumesRoot);
    const parsedVolumeId = StableId.parse(volumeId);
    const entries = await this.volumeEntries(volumesRoot);
    const exact = entries.find((entry) => entry.metadata.id === parsedVolumeId);
    if (exact !== undefined) return { workRoot, volumeRoot: exact.root, volume: exact.metadata };
    const aliases = entries.filter((entry) => (
      entry.metadata.id === `vol_${parsedVolumeId}`
      || basename(entry.root).endsWith(`--${parsedVolumeId}`)
    ));
    if (aliases.length > 1) {
      throw new JizuoError("validation_error", "分卷短 ID 不唯一，请使用完整分卷 ID", {
        workId,
        volumeId,
      });
    }
    const found = aliases[0];
    if (found === undefined) throw new JizuoError("validation_error", "卷不存在", { workId, volumeId });
    return { workRoot, volumeRoot: found.root, volume: found.metadata };
  }

  private async requireWorkflowVolume(
    workId: string,
    volumeId: string,
    expected?: { workRoot: string; volumeRoot: string },
  ): Promise<{ workRoot: string; volumeRoot: string; volume: VolumeFile }> {
    const volume = await this.findVolumeForInspection(workId, volumeId);
    if (!volume || volume.volume.id !== volumeId
      || (expected && (volume.workRoot !== expected.workRoot || volume.volumeRoot !== expected.volumeRoot))) {
      throw new JizuoError("revision_conflict", "工作流作品或分卷身份已变化");
    }
    this.requireSafeWorkflowPath(volume.volumeRoot);
    return volume;
  }

  private async findVolumeForInspection(
    workId: string,
    volumeId: string,
  ): Promise<{ workRoot: string; volumeRoot: string; volume: VolumeFile } | undefined> {
    const work = await this.options.findWorkForInspection(StableId.parse(workId));
    if (work === undefined) return undefined;
    const workRoot = resolveWithin(this.options.worksRoot, work.folderName);
    const volumesRoot = resolveWithin(workRoot, "content", "volumes");
    let directories: string[];
    try {
      directories = (await readdir(volumesRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => resolveWithin(volumesRoot, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }

    const parsedVolumeId = StableId.parse(volumeId);
    const candidateIds = new Set([parsedVolumeId, `vol_${parsedVolumeId}`]);
    const shortId = parsedVolumeId.replace(/^vol_/, "");
    const suffixMatches = directories.filter((root) => basename(root).endsWith(`--${shortId}`));
    const idMatches: Array<{ root: string; metadata: VolumeFile }> = [];
    const malformed: string[] = [];
    for (const root of directories) {
      let rawMetadata: string;
      try {
        rawMetadata = await readFile(join(root, "volume.yaml"), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        malformed.push(root);
        continue;
      }
      try {
        const metadata = VolumeFile.parse(parse(rawMetadata));
        if (candidateIds.has(metadata.id)) idMatches.push({ root, metadata });
      } catch {
        malformed.push(root);
      }
    }
    if (malformed.length > 0) {
      throw new JizuoError("revision_conflict", "分卷目录存在无法解析的元数据，不能安全对账", {
        workId,
        volumeId,
        malformedCount: malformed.length,
      });
    }
    if (suffixMatches.length === 0 && idMatches.length === 0) return undefined;
    if (
      suffixMatches.length !== 1
      || idMatches.length !== 1
      || suffixMatches[0] !== idMatches[0]!.root
      || idMatches[0]!.metadata.work_id !== workId
    ) {
      throw new JizuoError("revision_conflict", "分卷 ID 或路径不唯一，不能安全对账", {
        workId,
        volumeId,
        idMatchCount: idMatches.length,
        suffixMatchCount: suffixMatches.length,
      });
    }
    return { workRoot, volumeRoot: idMatches[0]!.root, volume: idMatches[0]!.metadata };
  }

  private async findChapter(
    target: ChapterTarget,
  ): Promise<{ workRoot: string; chapterRoot: string; metadata: ChapterFile }> {
    const { workRoot, volumeRoot } = await this.findVolume(target.workId, target.volumeId);
    const found = (await this.chapterEntries(resolveWithin(volumeRoot, "chapters")))
      .find((entry) => entry.metadata.id === target.chapterId);
    if (found === undefined) throw new JizuoError("validation_error", "章节不存在", target);
    return { workRoot, chapterRoot: found.root, metadata: found.metadata };
  }

  private async findChapterForRead(target: ChapterTarget): Promise<{ chapterRoot: string; metadata: ChapterFile }> {
    const { volumeRoot, volume } = await this.findVolume(target.workId, target.volumeId);
    const root = resolveWithin(volumeRoot, "chapters");
    // Cache the ID-to-path lookup, but always read the selected metadata and body afresh.
    for (let attempt = 0; attempt < 2; attempt++) {
      const entries = await this.readIndex.get(root, () => this.chapterEntries(root));
      const found = entries.find((entry) => entry.metadata.id === target.chapterId);
      if (found) {
        try {
          const metadata = ChapterFile.parse(parse(await readFile(join(found.root, "chapter.yaml"), "utf8")));
          if (metadata.id === target.chapterId && metadata.work_id === target.workId && metadata.volume_id === volume.id) {
            return { chapterRoot: found.root, metadata };
          }
        } catch { /* Renames/deletes invalidate the path even before a watcher event arrives. */ }
      }
      this.readIndex.invalidate(root);
    }
    throw new JizuoError("validation_error", "章节不存在", target);
  }

  private async volumeEntries(root: string): Promise<Array<{ root: string; metadata: VolumeFile }>> {
    await mkdir(root, { recursive: true });
    const entries = await readdir(root, { withFileTypes: true });
    const values: Array<{ root: string; metadata: VolumeFile }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const entryRoot = resolveWithin(root, entry.name);
        values.push({ root: entryRoot, metadata: VolumeFile.parse(parse(await readFile(join(entryRoot, "volume.yaml"), "utf8"))) });
      } catch {
        // Incomplete folders are excluded from the materialized volume list.
      }
    }
    return values;
  }

  private async chapterEntries(root: string): Promise<Array<{ root: string; metadata: ChapterFile }>> {
    await mkdir(root, { recursive: true });
    const entries = await readdir(root, { withFileTypes: true });
    const values: Array<{ root: string; metadata: ChapterFile }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const entryRoot = resolveWithin(root, entry.name);
        values.push({ root: entryRoot, metadata: ChapterFile.parse(parse(await readFile(join(entryRoot, "chapter.yaml"), "utf8"))) });
      } catch {
        // Incomplete folders are excluded from the materialized chapter list.
      }
    }
    return values;
  }

  private async currentChapterEntries(root: string): Promise<CurrentChapterEntry[]> {
    const entries = await this.chapterEntries(root);
    const current = await Promise.all(entries.map(async (entry) => ({
      ...entry,
      revisionToken: sha256Text(await readFile(join(entry.root, "content.md"), "utf8")),
    })));
    current.sort((left, right) => left.metadata.order - right.metadata.order || left.metadata.id.localeCompare(right.metadata.id));
    for (const [index, entry] of current.entries()) {
      if (
        current.findIndex((candidate) => candidate.metadata.id === entry.metadata.id) !== index
        || current.findIndex((candidate) => candidate.metadata.order === entry.metadata.order) !== index
      ) {
        throw new JizuoError("revision_conflict", "章节列表顺序不唯一，无法安全应用提案", {
          chapterId: entry.metadata.id,
          order: entry.metadata.order,
        });
      }
    }
    return current;
  }

  private hashChapterList(entries: CurrentChapterEntry[]): string {
    return sha256Text(JSON.stringify(entries.map((entry) => ({
      id: entry.metadata.id,
      order: entry.metadata.order,
      revisionToken: entry.revisionToken,
    }))));
  }

  private async withVolumeCreationLock<T>(
    workRoot: string,
    volumeId: string,
    operation: (assertLockOwner: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const locksRoot = resolveWithin(workRoot, ".jizuo", "locks");
    const lockRoot = resolveWithin(locksRoot, `volume-create-${volumeId}`);
    this.requireSafeWorkflowPath(lockRoot);
    const owner = randomUUID();
    const pid = process.pid;
    await mkdir(locksRoot, { recursive: true });
    await this.acquireVolumeCreationLock(lockRoot, owner, pid);
    const renewal = setInterval(() => {
      void this.renewVolumeCreationLock(lockRoot, owner, pid);
    }, VOLUME_CREATION_LOCK_TTL_MS / 3);
    try {
      return await operation(() => this.requireVolumeCreationLockOwner(lockRoot, owner, pid));
    } finally {
      clearInterval(renewal);
      await this.releaseVolumeCreationLock(lockRoot, owner, pid);
    }
  }

  private async acquireVolumeCreationLock(lockRoot: string, owner: string, pid: number): Promise<void> {
    const deadline = Date.now() + VOLUME_CREATION_LOCK_WAIT_MS;
    while (true) {
      try {
        await mkdir(lockRoot);
        await writeFile(
          resolveWithin(lockRoot, "lock.json"),
          `${JSON.stringify({ schemaVersion: 1, owner, pid, expiresAt: Date.now() + VOLUME_CREATION_LOCK_TTL_MS })}\n`,
          { encoding: "utf8", flag: "wx" },
        );
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await this.reclaimStaleVolumeCreationLock(lockRoot);
      if (Date.now() >= deadline) {
        throw new JizuoError("revision_conflict", "章节创建正在进行，不能安全并发应用提案", { lockRoot });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, VOLUME_CREATION_LOCK_RETRY_MS));
    }
  }

  private async reclaimStaleVolumeCreationLock(lockRoot: string): Promise<void> {
    let expiresAt: number;
    let ownerPid: number | undefined;
    try {
      const lock = VolumeCreationLock.parse(JSON.parse(await readFile(resolveWithin(lockRoot, "lock.json"), "utf8")));
      expiresAt = lock.expiresAt;
      ownerPid = lock.pid;
    } catch {
      try {
        expiresAt = (await stat(lockRoot)).mtimeMs + VOLUME_CREATION_LOCK_TTL_MS;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
    if (expiresAt >= Date.now()) return;
    if (ownerPid !== undefined && this.isProcessAlive(ownerPid)) {
      throw new JizuoError("revision_conflict", "章节创建锁仍由存活进程持有", { ownerPid });
    }
    const staleRoot = `${lockRoot}.stale-${randomUUID()}`;
    try {
      await rename(lockRoot, staleRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await rm(staleRoot, { recursive: true, force: true });
  }

  private async renewVolumeCreationLock(lockRoot: string, owner: string, pid: number): Promise<void> {
    try {
      const marker = resolveWithin(lockRoot, "lock.json");
      const current = VolumeCreationLock.parse(JSON.parse(await readFile(marker, "utf8")));
      if (current.owner !== owner || current.pid !== pid) return;
      const temporary = resolveWithin(lockRoot, `lock-${owner}-${randomUUID()}.next`);
      await writeFile(
        temporary,
        `${JSON.stringify({ schemaVersion: 1, owner, pid, expiresAt: Date.now() + VOLUME_CREATION_LOCK_TTL_MS })}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      const beforeRename = VolumeCreationLock.parse(JSON.parse(await readFile(marker, "utf8")));
      if (beforeRename.owner !== owner || beforeRename.pid !== pid) {
        await rm(temporary, { force: true });
        return;
      }
      await rename(temporary, marker);
    } catch {
      // The lock was released, reclaimed, or the owner crashed; do not disturb a replacement owner.
    }
  }

  private async requireVolumeCreationLockOwner(lockRoot: string, owner: string, pid: number): Promise<void> {
    try {
      const lock = VolumeCreationLock.parse(JSON.parse(await readFile(resolveWithin(lockRoot, "lock.json"), "utf8")));
      if (lock.owner === owner && lock.pid === pid) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // A malformed or replaced lock is not safe to own.
      }
    }
    throw new JizuoError("revision_conflict", "章节创建锁已失去所有权，已中止应用", {});
  }

  private async releaseVolumeCreationLock(lockRoot: string, owner: string, pid: number): Promise<void> {
    try {
      const lock = VolumeCreationLock.parse(JSON.parse(await readFile(resolveWithin(lockRoot, "lock.json"), "utf8")));
      if (lock.owner === owner && lock.pid === pid) await rm(lockRoot, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // A crashed or reclaimed owner must not remove another owner's lock.
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private summaryOf(metadata: ChapterFile): ChapterSummary {
    return {
      id: metadata.id,
      workId: metadata.work_id,
      volumeId: metadata.volume_id,
      title: metadata.title,
      order: metadata.order,
      revisionToken: metadata.revision_token,
      ...(metadata.workflow_draft_status === undefined ? {} : { draftStatus: metadata.workflow_draft_status }),
    };
  }

  private volumeSummaryOf(root: string, metadata: VolumeFile): VolumeSummary {
    return {
      id: metadata.id,
      workId: metadata.work_id,
      title: metadata.title,
      order: metadata.order,
      folderName: basename(root),
      outline: metadata.outline,
      detailedOutline: metadata.detailed_outline,
    };
  }

  private documentOf(
    metadata: ChapterFile,
    content: string,
    outline: string,
    detailedOutline: string,
  ): ChapterDocument {
    const currentMetadata = metadata.workflow_draft_status === "pending" && content.length > 0
      ? { ...metadata, workflow_draft_status: "draft" as const } : metadata;
    return { ...this.summaryOf(currentMetadata), content, plan: outline, outline, detailedOutline };
  }
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
