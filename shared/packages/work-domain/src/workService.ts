import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, lstat } from "node:fs/promises";
import { basename, join, resolve, relative, isAbsolute, sep } from "node:path";

import {
  ApplyImportInput,
  CreateChapterRequest,
  CreateWorkInput,
  ExportWorkInput,
  SearchWorkInput,
  type SearchWorkResult,
  JizuoError,
  MoveToTrashInput,
  RenameWorkInput,
  RestoreFromTrashInput,
  StableId,
  TrashTarget,
  type WorkSummary,
} from "@jizuo/contracts";
import { stringify } from "yaml";

import { portableTitle, resolveWithin } from "./paths.ts";
import { ProposalService } from "./proposals.ts";
import { createWorkFile, readWorkFile, type WorkFile } from "./yamlStore.ts";
import {
  ChapterStore,
  type WorkflowChapterCreateInput,
  type WorkflowChapterInitializeInput,
  type WorkflowChapterDraftInput,
  type WorkflowChapterLiveDraftInput,
  type WorkflowChapterInspectionInput,
  type WorkflowChapterReplaceInput,
} from "./chapterService.ts";
import { exportMaterializedWork } from "./exporter.ts";
import { previewImport } from "./importer.ts";
import { renameMaterializedDirectory } from "./materializedRename.ts";
import {
  deleteTrashEntry,
  listTrashEntries,
  moveDirectoryToTrash,
  restoreDirectoryFromTrash,
} from "./trash.ts";

export interface WorkDomainOptions {
  worksRoot: string;
  idFactory?: () => string;
  now?: () => Date;
}

function isWorksAccessDenied(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "EACCES" || error.code === "EPERM";
}

export class WorkDomainService {
  readonly worksRoot: string;
  readonly idFactory: () => string;
  readonly now: () => Date;
  readonly chapterStore: ChapterStore;
  readonly proposalService: ProposalService;

  constructor(options: WorkDomainOptions) {
    this.worksRoot = resolve(options.worksRoot);
    this.idFactory = options.idFactory ?? (() => randomUUID().replaceAll("-", "").slice(0, 8));
    this.now = options.now ?? (() => new Date());
    this.chapterStore = new ChapterStore({
      worksRoot: this.worksRoot,
      idFactory: this.idFactory,
      now: this.now,
      findWork: async (workId) => this.requireWork(workId),
      findWorkForInspection: async (workId) => this.findWorkForInspection(workId),
    });
    this.proposalService = new ProposalService({
      worksRoot: this.worksRoot,
      now: this.now,
      reserveChapterId: () => {
        const id = `ch_${this.idFactory()}`;
        StableId.parse(id);
        return id;
      },
      findWork: async (workId) => this.requireWork(workId),
      readChapter: async (target) => this.chapterStore.readChapter(target),
      replaceChapter: async ({ nextContent: _nextContent, ...input }) => this.chapterStore.replaceChapterFromProposal(input),
      chapterListSnapshot: async (target) => this.chapterStore.chapterListSnapshot(target),
      withChapterListLock: async (target, operation) => this.chapterStore.withChapterListLock(target, operation),
      createReservedChapter: async (proposal) => this.chapterStore.createReservedChapter(proposal),
    });
  }

  async initialize(): Promise<void> {
    await mkdir(this.worksRoot, { recursive: true });
  }

  async createWork(rawInput: { title: string; projectKind?: "novel" | "video" | undefined }): Promise<WorkSummary> {
    const input = CreateWorkInput.parse(rawInput);
    const shortId = this.idFactory();
    const workId = `work_${shortId}`;
    StableId.parse(workId);
    const folderName = `${portableTitle(input.title)}--${shortId}`;
    const workRoot = resolveWithin(this.worksRoot, folderName);
    const timestamp = this.now().toISOString();
    const metadata: WorkFile = {
      schema_version: 1,
      id: workId,
      title: input.title,
      project_kind: input.projectKind ?? "novel",
      created_at: timestamp,
      updated_at: timestamp,
    };

    await this.initialize();
    await mkdir(workRoot);
    try {
      await Promise.all([
        ...(input.projectKind === "video" ? [] : [mkdir(join(workRoot, "content", "volumes"), { recursive: true })]),
        mkdir(join(workRoot, "memory"), { recursive: true }),
        mkdir(join(workRoot, "assets"), { recursive: true }),
        ...["revisions", "revision-history", "transactions", "jobs", "trash", "cache"].map((name) => (
          mkdir(join(workRoot, ".jizuo", name), { recursive: true })
        )),
      ]);
      await createWorkFile(join(workRoot, "work.yaml"), metadata);
    } catch (error) {
      await rm(workRoot, { recursive: true, force: true });
      throw error;
    }

    return this.summaryOf(folderName, metadata);
  }

  async listWorks(): Promise<WorkSummary[]> {
    let entries;
    try {
      await this.initialize();
      entries = await readdir(this.worksRoot, { withFileTypes: true });
    } catch (error) {
      if (!isWorksAccessDenied(error)) throw error;
      throw new JizuoError(
        "runtime_unavailable",
        "即作无法读取作品目录。请检查文件夹权限；macOS 请在“隐私与安全性 → 文件与文件夹”中允许即作访问文稿。",
        { reason: "works_access_denied" },
      );
    }
    const folders = entries.filter((entry) => entry.isDirectory());
    const works: WorkSummary[] = [];
    // Windows file scans can be slow under real-time protection. Bound parallel
    // metadata reads so opening one work does not wait for every sibling in turn.
    for (let start = 0; start < folders.length; start += 8) {
      const batch = await Promise.all(folders.slice(start, start + 8).map(async (entry) => {
        try {
          const folderPath = resolveWithin(this.worksRoot, entry.name);
          const metadata = await readWorkFile(join(folderPath, "work.yaml"));
          const summary = this.summaryOf(basename(folderPath), metadata);
          if (summary.projectKind !== "video") {
            const candidates = [join(folderPath, "video", "project.json"), join(folderPath, ".jizuo", "video", "project.json")];
            if ((await Promise.all(candidates.map(path => lstat(path).then(info => info.isFile()).catch(() => false)))).some(Boolean)) summary.hasLegacyVideo = true;
          }
          return summary;
        } catch {
          // Malformed or incomplete folders are not works. Diagnostics will expose them later.
          return undefined;
        }
      }));
      works.push(...batch.filter((work): work is WorkSummary => work !== undefined));
    }
    return works.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async renameWork(rawInput: unknown): Promise<WorkSummary> {
    const input = RenameWorkInput.parse(rawInput);
    const work = await this.requireWork(input.workId);
    // Session cwd is durable. A display rename must not move its directory.
    const folderName = work.folderName;
    const metadata: WorkFile = {
      schema_version: 1,
      id: work.id,
      title: input.title,
      project_kind: work.projectKind ?? "novel",
      created_at: work.createdAt,
      updated_at: this.now().toISOString(),
    };
    await renameMaterializedDirectory({
      currentRoot: resolveWithin(this.worksRoot, work.folderName),
      nextRoot: resolveWithin(this.worksRoot, folderName),
      metadataName: "work.yaml",
      serializedMetadata: stringify(metadata, { lineWidth: 0 }),
    });
    return this.summaryOf(folderName, metadata);
  }

  async createVolume(input: { workId: string; title: string }) {
    await this.requireNovelWork(input.workId);
    return this.chapterStore.createVolume(input);
  }

  async renameVolume(input: Parameters<ChapterStore["renameVolume"]>[0]) {
    return this.chapterStore.renameVolume(input);
  }

  async saveVolumeOutline(input: Parameters<ChapterStore["saveVolumeOutline"]>[0]) {
    return this.chapterStore.saveVolumeOutline(input);
  }

  async createChapter(rawInput: unknown) {
    const input = CreateChapterRequest.parse(rawInput);
    await this.requireNovelWork(input.workId);
    if (input.mode === "create_next") {
      const chapters = await this.listChapters({ workId: input.workId, volumeId: input.volumeId });
      const lastChapter = chapters.at(-1);
      if (lastChapter === undefined || lastChapter.id !== input.afterChapterId) {
        throw new JizuoError("model_repair", "create_next 必须指向当前最后一章", {
          afterChapterId: input.afterChapterId,
          currentLastChapterId: lastChapter?.id,
        });
      }
    }
    return this.chapterStore.createChapter(input);
  }

  private async requireNovelWork(workId: string): Promise<void> {
    if ((await this.requireWork(workId)).projectKind === "video") {
      throw new JizuoError("validation_error", "请在小说项目中创建卷和章节，再在视频项目中选择原著来源");
    }
  }

  reserveWorkflowChapterId(): string {
    const id = `ch_${this.idFactory()}`;
    StableId.parse(id);
    return id;
  }

  async writeWorkflowChapter(input: WorkflowChapterCreateInput | WorkflowChapterReplaceInput, assertActive?: () => void) {
    return this.chapterStore.writeWorkflowChapter(input, assertActive);
  }

  async initializeWorkflowChapter(input: WorkflowChapterInitializeInput, assertActive?: () => void) {
    return this.chapterStore.initializeWorkflowChapter(input, assertActive);
  }

  async saveWorkflowChapterDraft(input: WorkflowChapterDraftInput, assertActive?: () => void) {
    return this.chapterStore.saveWorkflowChapterDraft(input, assertActive);
  }

  async saveWorkflowChapterLiveDraft(input: WorkflowChapterLiveDraftInput, assertActive?: () => void) {
    return this.chapterStore.saveWorkflowChapterLiveDraft(input, assertActive);
  }

  async inspectWorkflowChapterWrite(input: WorkflowChapterInspectionInput) {
    return this.chapterStore.inspectWorkflowChapterWrite(input);
  }

  async saveWorkflowChapterProjection(input: Parameters<ChapterStore["saveWorkflowChapterProjection"]>[0]) {
    return this.chapterStore.saveWorkflowChapterProjection(input);
  }

  async listChapterWorkflowRecords(input: Parameters<ChapterStore["listChapterWorkflowRecords"]>[0]) {
    return this.chapterStore.listChapterWorkflowRecords(input);
  }

  async readChapterWorkflowRecord(input: Parameters<ChapterStore["readChapterWorkflowRecord"]>[0]) {
    return this.chapterStore.readChapterWorkflowRecord(input);
  }

  async renameChapter(input: Parameters<ChapterStore["renameChapter"]>[0]) {
    return this.chapterStore.renameChapter(input);
  }

  async listChapters(input: { workId: string; volumeId: string }) {
    return this.chapterStore.listChapters(input);
  }

  async listVolumes(workId: string) {
    return this.chapterStore.listVolumes(workId);
  }

  async resolveChapterPath(input: { workId: string; volumeId: string; chapterId: string }) {
    return this.chapterStore.resolveChapterPath(input);
  }

  async readChapter(input: { workId: string; volumeId: string; chapterId: string }) {
    return this.chapterStore.readChapter(input);
  }

  async replaceChapter(input: Parameters<ChapterStore["replaceChapter"]>[0]) {
    return this.chapterStore.replaceChapter(input);
  }

  async listChapterRevisions(input: Parameters<ChapterStore["listChapterRevisions"]>[0]) {
    return this.chapterStore.listChapterRevisions(input);
  }

  async readChapterRevision(input: Parameters<ChapterStore["readChapterRevision"]>[0]) {
    return this.chapterStore.readChapterRevision(input);
  }

  async saveChapterPlan(input: Parameters<ChapterStore["saveChapterPlan"]>[0]) {
    return this.chapterStore.saveChapterPlan(input);
  }

  async saveChapterOutline(input: Parameters<ChapterStore["saveChapterOutline"]>[0]) {
    return this.chapterStore.saveChapterOutline(input);
  }

  async appendChapter(input: Parameters<ChapterStore["appendChapter"]>[0]) {
    return this.chapterStore.appendChapter(input);
  }

  async editChapter(input: Parameters<ChapterStore["editChapter"]>[0]) {
    return this.chapterStore.editChapter(input);
  }

  async restoreChapterRevision(input: Parameters<ChapterStore["restoreChapterRevision"]>[0]) {
    return this.chapterStore.restoreChapterRevision(input);
  }

  async inspectTrashTarget(rawInput: unknown) {
    const input = TrashTarget.parse(rawInput);
    if (input.kind !== "work") return this.chapterStore.inspectTrashTarget(input);
    const work = await this.requireWork(input.workId);
    const volumes = await this.listVolumes(work.id);
    const chapters = await Promise.all(volumes.map((volume) => (
      this.listChapters({ workId: work.id, volumeId: volume.id })
    )));
    return {
      kind: "work" as const,
      title: work.title,
      volumeCount: volumes.length,
      chapterCount: chapters.reduce((total, items) => total + items.length, 0),
    };
  }

  async moveToTrash(rawInput: MoveToTrashInput) {
    const input = MoveToTrashInput.parse(rawInput);
    if (input.kind !== "work") return this.chapterStore.moveToTrash(input);
    const work = await this.requireWork(input.workId);
    const impact = await this.inspectTrashTarget(input);
    return moveDirectoryToTrash({
      worksRoot: this.worksRoot,
      itemRoot: resolveWithin(this.worksRoot, work.folderName),
      trashId: `trash_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      kind: "work",
      workId: work.id,
      title: work.title,
      volumeCount: impact.volumeCount,
      chapterCount: impact.chapterCount,
      now: this.now(),
    });
  }

  async listTrash() {
    return listTrashEntries(this.worksRoot);
  }

  async restoreFromTrash(rawInput: RestoreFromTrashInput) {
    const input = RestoreFromTrashInput.parse(rawInput);
    const entry = (await this.listTrash()).find((candidate) => candidate.trashId === input.trashId);
    if (entry === undefined) {
      throw new JizuoError("validation_error", "回收站项目不存在或已损坏", { trashId: input.trashId });
    }
    if (entry.kind !== "work") return this.chapterStore.restoreFromTrash(input);
    return restoreDirectoryFromTrash({ worksRoot: this.worksRoot, ...input });
  }

  async deleteFromTrash(rawInput: RestoreFromTrashInput) {
    const input = RestoreFromTrashInput.parse(rawInput);
    return deleteTrashEntry({ worksRoot: this.worksRoot, ...input });
  }

  async createProposal(input: Parameters<ProposalService["createProposal"]>[0]) {
    return this.proposalService.createProposal(input);
  }

  async createChapterProposal(input: Parameters<ProposalService["createChapterProposal"]>[0]) {
    return this.proposalService.createChapterProposal(input);
  }

  async authorizeProposal(proposalId: string) {
    return this.proposalService.authorizeProposal(proposalId);
  }

  async applyProposal(input: Parameters<ProposalService["applyProposal"]>[0]) {
    return this.proposalService.applyProposal(input);
  }

  async rejectProposal(proposalId: string) {
    return this.proposalService.rejectProposal(proposalId);
  }

  async rejectAnyProposal(proposalId: string) {
    return this.proposalService.rejectAnyProposal(proposalId);
  }

  async isWorkflowOwnedProposal(proposalId: string) {
    return this.proposalService.isWorkflowOwnedProposal(proposalId);
  }

  async inspectProposalApplication(proposalId: string) {
    return this.proposalService.inspectProposalApplication(proposalId);
  }

  async listProposals(target?: Parameters<ProposalService["listProposals"]>[0]) {
    return this.proposalService.listProposals(target);
  }

  async getProposalPreview(proposalId: string) {
    return this.proposalService.getProposalPreview(proposalId);
  }

  async previewImport(input: Parameters<typeof previewImport>[0]) {
    return previewImport(input);
  }

  async applyImport(rawInput: unknown) {
    const input = ApplyImportInput.parse(rawInput);
    const preview = await previewImport(input);
    if (preview.previewHash !== input.previewHash) {
      throw new JizuoError("revision_conflict", "源文件已变化，请重新确认导入预览", {
        expectedPreviewHash: input.previewHash,
        actualPreviewHash: preview.previewHash,
      });
    }
    let work: WorkSummary | undefined;
    try {
      work = await this.createWork({ title: input.workTitle ?? preview.suggestedTitle });
      const volume = await this.createVolume({ workId: work.id, title: "正文" });
      for (const chapter of preview.chapters) {
        await this.createChapter({
          workId: work.id,
          volumeId: volume.id,
          title: chapter.title,
          content: chapter.content,
        });
      }
      return { work, volume, chapterCount: preview.chapters.length, previewHash: preview.previewHash };
    } catch (error) {
      if (work !== undefined) {
        await rm(resolveWithin(this.worksRoot, work.folderName), { recursive: true, force: true });
      }
      throw error;
    }
  }

  async searchWork(rawInput: unknown, signal?: AbortSignal): Promise<SearchWorkResult> {
    const input = SearchWorkInput.parse(rawInput);
    await this.requireWork(input.workId);
    const items: SearchWorkResult["items"] = [];
    const pattern = new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
    for (const volume of await this.listVolumes(input.workId)) {
      for (const summary of await this.listChapters({ workId: input.workId, volumeId: volume.id })) {
        signal?.throwIfAborted();
        const chapter = await this.readChapter({ workId: input.workId, volumeId: volume.id, chapterId: summary.id });
        const titleMatch = pattern.exec(chapter.title);
        const bodyMatch = pattern.exec(chapter.content);
        const match = bodyMatch ?? titleMatch;
        if (!match) continue;
        if (items.length === input.limit) return { items, truncated: true };
        const field = bodyMatch ? "content" : "title";
        const source = bodyMatch ? chapter.content : chapter.title;
        const start = Math.max(0, match.index - 45);
        const end = Math.min(source.length, match.index + match[0].length + 95);
        items.push({ workId: input.workId, volumeId: volume.id, chapterId: chapter.id,
          volumeTitle: volume.title, chapterTitle: chapter.title, chapterNumber: chapter.order,
          field, excerpt: `${start > 0 ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`,
          matchStart: match.index, matchEnd: match.index + match[0].length, revisionToken: chapter.revisionToken });
      }
    }
    return { items, truncated: false };
  }

  async exportWork(rawInput: unknown) {
    const input = ExportWorkInput.parse(rawInput);
    if (!isAbsolute(input.destination)) throw new JizuoError("validation_error", "请选择完整的导出路径");
    const work = await this.requireWork(input.workId);
    const volumes = await this.listVolumes(input.workId);
    const destinationRelative = relative(this.worksRoot, resolve(input.destination));
    if (destinationRelative === "" || (destinationRelative !== ".." && !destinationRelative.startsWith(`..${sep}`) && !isAbsolute(destinationRelative))) {
      throw new JizuoError("validation_error", "请导出到作品存储目录之外，避免覆盖作品文件");
    }
    const selected = input.chapterIds === undefined ? undefined : new Set(input.chapterIds);
    const materialized = await Promise.all(volumes.map(async (volume) => ({
      volume,
      chapters: await Promise.all((await this.listChapters({ workId: input.workId, volumeId: volume.id }))
        .filter((chapter) => selected === undefined || selected.has(chapter.id))
        .map((chapter) => this.readChapter({ workId: input.workId, volumeId: volume.id, chapterId: chapter.id }))),
    })));
    if (selected && materialized.reduce((count, volume) => count + volume.chapters.length, 0) !== selected.size) {
      throw new JizuoError("validation_error", "所选章节已不存在，请刷新后重新选择");
    }
    return exportMaterializedWork({
      work,
      format: input.format,
      destination: input.destination,
      volumes: materialized.filter((volume) => volume.chapters.length > 0),
    });
  }

  private async requireWork(workId: string): Promise<WorkSummary> {
    const work = (await this.listWorks()).find((candidate) => candidate.id === workId);
    if (work === undefined) {
      throw new JizuoError("validation_error", "作品不存在", { workId });
    }
    return work;
  }

  private async findWorkForInspection(workId: string): Promise<WorkSummary | undefined> {
    const parsedWorkId = StableId.parse(workId);
    let directories: string[];
    try {
      directories = (await readdir(this.worksRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => resolveWithin(this.worksRoot, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }

    const shortId = parsedWorkId.replace(/^work_/, "");
    const suffixMatches = directories.filter((root) => basename(root).endsWith(`--${shortId}`));
    const idMatches: Array<{ root: string; metadata: WorkFile }> = [];
    const malformed: string[] = [];
    for (const root of directories) {
      try {
        const metadata = await readWorkFile(join(root, "work.yaml"));
        if (metadata.id === parsedWorkId) idMatches.push({ root, metadata });
      } catch (error) {
        // The shared root also contains .jizuo/trash and unrelated incomplete
        // folders. A missing manifest there says nothing about this target.
        // Keep missing target suffixes and all malformed manifests fail-closed.
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !suffixMatches.includes(root)) continue;
        if ((error as NodeJS.ErrnoException).code !== undefined
          && (error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        malformed.push(root);
      }
    }
    if (malformed.length > 0) {
      throw new JizuoError("revision_conflict", "作品目录存在无法解析的元数据，不能安全对账", {
        workId,
        malformedCount: malformed.length,
      });
    }
    if (suffixMatches.length === 0 && idMatches.length === 0) return undefined;
    if (
      suffixMatches.length !== 1
      || idMatches.length !== 1
      || suffixMatches[0] !== idMatches[0]!.root
    ) {
      throw new JizuoError("revision_conflict", "作品 ID 或路径不唯一，不能安全对账", {
        workId,
        idMatchCount: idMatches.length,
        suffixMatchCount: suffixMatches.length,
      });
    }
    return this.summaryOf(basename(idMatches[0]!.root), idMatches[0]!.metadata);
  }

  private summaryOf(folderName: string, metadata: WorkFile): WorkSummary {
    return {
      projectKind: metadata.project_kind ?? "novel",
      id: metadata.id,
      title: metadata.title,
      folderName,
      createdAt: metadata.created_at,
      updatedAt: metadata.updated_at,
    };
  }
}
