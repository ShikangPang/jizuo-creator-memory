import { resolve, relative, isAbsolute, sep } from "node:path";

import { JizuoError, ExportWorkInput, type WorkSummary } from "@jizuo/contracts";

import type { FileWorkLocationRegistry, WorkLocations } from "./workLocations.ts";
import { resolveWithin } from "./paths.ts";
import { WorkDomainService, type WorkDomainOptions } from "./workService.ts";

export interface MultiRootWorkDomainOptions extends Omit<WorkDomainOptions, "worksRoot"> {
  readonly workLocations: FileWorkLocationRegistry;
  readonly videoWorkLocations?: FileWorkLocationRegistry;
}

export interface LocatedWork {
  readonly root: string;
  readonly work: WorkSummary;
  readonly service: WorkDomainService;
}

function workIdFrom(input: unknown): string {
  if (typeof input === "string" && input.length > 0) return input;
  if (typeof input !== "object" || input === null) {
    throw new JizuoError("validation_error", "请求缺少作品 ID");
  }
  if ("workId" in input && typeof input.workId === "string") return input.workId;
  if ("target" in input) return workIdFrom(input.target);
  throw new JizuoError("validation_error", "请求缺少作品 ID");
}

function isMissingProposal(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "validation_error"
    && "message" in error
    && error.message === "提案不存在";
}

function conflict(message: string, details: Record<string, unknown>): JizuoError {
  return new JizuoError("revision_conflict", message, details);
}

export class MultiRootWorkDomainService extends WorkDomainService {
  readonly workLocations: FileWorkLocationRegistry;
  readonly videoWorkLocations?: FileWorkLocationRegistry;
  private readonly services = new Map<string, WorkDomainService>();

  constructor(options: MultiRootWorkDomainOptions) {
    super({
      worksRoot: options.workLocations.defaultRoot,
      ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.workLocations = options.workLocations;
    if (options.videoWorkLocations) this.videoWorkLocations = options.videoWorkLocations;
  }

  override async initialize(): Promise<void> {
    const locations = await this.workLocations.read();
    await this.serviceForRoot(locations.createRoot).initialize();
  }

  async getWorkLocations(): Promise<WorkLocations> {
    return this.workLocations.read();
  }

  async locateWork(workId: string): Promise<LocatedWork> {
    const candidates = await this.availableServices();
    const matches = (await Promise.all(candidates.map(async ({ root, service }) => {
      const work = (await service.listWorks()).find((candidate) => candidate.id === workId);
      return work === undefined ? undefined : { root, work, service };
    }))).filter((match): match is LocatedWork => match !== undefined);
    if (matches.length === 0) {
      throw new JizuoError("validation_error", "作品不存在", { workId });
    }
    if (matches.length !== 1) {
      throw conflict("作品 ID 在多个存储位置重复，不能安全修改", {
        workId,
        roots: matches.map(({ root }) => root),
      });
    }
    return matches[0]!;
  }

  async resolveWorkPath(workId: string): Promise<{ path: string }> {
    const located = await this.locateWork(workId);
    return { path: resolveWithin(located.root, located.work.folderName) };
  }

  override async createWork(input: Parameters<WorkDomainService["createWork"]>[0]) {
    return (await this.createService(input.projectKind)).createWork(input);
  }

  override async listWorks(): Promise<WorkSummary[]> {
    const works: WorkSummary[] = [];
    const owners = new Map<string, string>();
    const candidates = await this.availableServices();
    const lists = await Promise.all(candidates.map(({ service }) => service.listWorks()));
    for (const [index, { root }] of candidates.entries()) {
      for (const work of lists[index]!) {
        const existing = owners.get(work.id);
        if (existing !== undefined && existing !== root) {
          throw conflict("作品 ID 在多个存储位置重复，不能安全列出", {
            workId: work.id,
            roots: [existing, root],
          });
        }
        owners.set(work.id, root);
        works.push(work);
      }
    }
    return works.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id));
  }

  override async renameWork(input: Parameters<WorkDomainService["renameWork"]>[0]) {
    return (await this.serviceForWork(input)).renameWork(input);
  }

  override async createVolume(input: Parameters<WorkDomainService["createVolume"]>[0]) {
    return (await this.serviceForWork(input)).createVolume(input);
  }

  override async renameVolume(input: Parameters<WorkDomainService["renameVolume"]>[0]) {
    return (await this.serviceForWork(input)).renameVolume(input);
  }

  override async saveVolumeOutline(input: Parameters<WorkDomainService["saveVolumeOutline"]>[0]) {
    return (await this.serviceForWork(input)).saveVolumeOutline(input);
  }

  override async createChapter(input: Parameters<WorkDomainService["createChapter"]>[0]) {
    return (await this.serviceForWork(input)).createChapter(input);
  }

  override async writeWorkflowChapter(
    input: Parameters<WorkDomainService["writeWorkflowChapter"]>[0],
    assertActive?: Parameters<WorkDomainService["writeWorkflowChapter"]>[1],
  ) {
    return (await this.serviceForWork(input)).writeWorkflowChapter(input, assertActive);
  }

  override async initializeWorkflowChapter(
    input: Parameters<WorkDomainService["initializeWorkflowChapter"]>[0],
    assertActive?: Parameters<WorkDomainService["initializeWorkflowChapter"]>[1],
  ) {
    return (await this.serviceForWork(input)).initializeWorkflowChapter(input, assertActive);
  }

  override async saveWorkflowChapterDraft(
    input: Parameters<WorkDomainService["saveWorkflowChapterDraft"]>[0],
    assertActive?: Parameters<WorkDomainService["saveWorkflowChapterDraft"]>[1],
  ) {
    return (await this.serviceForWork(input)).saveWorkflowChapterDraft(input, assertActive);
  }

  override async saveWorkflowChapterLiveDraft(
    input: Parameters<WorkDomainService["saveWorkflowChapterLiveDraft"]>[0],
    assertActive?: Parameters<WorkDomainService["saveWorkflowChapterLiveDraft"]>[1],
  ) {
    return (await this.serviceForWork(input)).saveWorkflowChapterLiveDraft(input, assertActive);
  }

  override async inspectWorkflowChapterWrite(input: Parameters<WorkDomainService["inspectWorkflowChapterWrite"]>[0]) {
    return (await this.serviceForWork(input)).inspectWorkflowChapterWrite(input);
  }

  override async saveWorkflowChapterProjection(input: Parameters<WorkDomainService["saveWorkflowChapterProjection"]>[0]) {
    return (await this.serviceForWork(input)).saveWorkflowChapterProjection(input);
  }

  override async listChapterWorkflowRecords(input: Parameters<WorkDomainService["listChapterWorkflowRecords"]>[0]) {
    return (await this.serviceForWork(input)).listChapterWorkflowRecords(input);
  }

  override async readChapterWorkflowRecord(input: Parameters<WorkDomainService["readChapterWorkflowRecord"]>[0]) {
    return (await this.serviceForWork(input)).readChapterWorkflowRecord(input);
  }

  override async renameChapter(input: Parameters<WorkDomainService["renameChapter"]>[0]) {
    return (await this.serviceForWork(input)).renameChapter(input);
  }

  override async listChapters(input: Parameters<WorkDomainService["listChapters"]>[0]) {
    return (await this.serviceForWork(input)).listChapters(input);
  }

  override async listVolumes(workId: string) {
    return (await this.serviceForWork(workId)).listVolumes(workId);
  }

  override async resolveChapterPath(input: { workId: string; volumeId: string; chapterId: string }) {
    return (await this.serviceForWork(input)).resolveChapterPath(input);
  }

  override async readChapter(input: Parameters<WorkDomainService["readChapter"]>[0]) {
    return (await this.serviceForWork(input)).readChapter(input);
  }

  override async replaceChapter(input: Parameters<WorkDomainService["replaceChapter"]>[0]) {
    return (await this.serviceForWork(input)).replaceChapter(input);
  }

  override async listChapterRevisions(input: Parameters<WorkDomainService["listChapterRevisions"]>[0]) {
    return (await this.serviceForWork(input)).listChapterRevisions(input);
  }

  override async readChapterRevision(input: Parameters<WorkDomainService["readChapterRevision"]>[0]) {
    return (await this.serviceForWork(input)).readChapterRevision(input);
  }

  override async saveChapterPlan(input: Parameters<WorkDomainService["saveChapterPlan"]>[0]) {
    return (await this.serviceForWork(input)).saveChapterPlan(input);
  }

  override async saveChapterOutline(input: Parameters<WorkDomainService["saveChapterOutline"]>[0]) {
    return (await this.serviceForWork(input)).saveChapterOutline(input);
  }

  override async appendChapter(input: Parameters<WorkDomainService["appendChapter"]>[0]) {
    return (await this.serviceForWork(input)).appendChapter(input);
  }

  override async editChapter(input: Parameters<WorkDomainService["editChapter"]>[0]) {
    return (await this.serviceForWork(input)).editChapter(input);
  }

  override async restoreChapterRevision(input: Parameters<WorkDomainService["restoreChapterRevision"]>[0]) {
    return (await this.serviceForWork(input)).restoreChapterRevision(input);
  }

  override async inspectTrashTarget(input: Parameters<WorkDomainService["inspectTrashTarget"]>[0]) {
    return (await this.serviceForWork(input)).inspectTrashTarget(input);
  }

  override async moveToTrash(input: Parameters<WorkDomainService["moveToTrash"]>[0]) {
    return (await this.serviceForWork(input)).moveToTrash(input);
  }

  override async listTrash() {
    const entries = [];
    const owners = new Map<string, string>();
    for (const { root, service } of await this.availableServices()) {
      for (const entry of await service.listTrash()) {
        const existing = owners.get(entry.trashId);
        if (existing !== undefined && existing !== root) {
          throw conflict("回收站 ID 在多个存储位置重复，不能安全操作", {
            trashId: entry.trashId,
            roots: [existing, root],
          });
        }
        owners.set(entry.trashId, root);
        entries.push(entry);
      }
    }
    return entries.sort((left, right) => right.trashedAt.localeCompare(left.trashedAt));
  }

  override async restoreFromTrash(input: Parameters<WorkDomainService["restoreFromTrash"]>[0]) {
    return (await this.serviceForTrash(input.trashId)).restoreFromTrash(input);
  }

  override async deleteFromTrash(input: Parameters<WorkDomainService["deleteFromTrash"]>[0]) {
    return (await this.serviceForTrash(input.trashId)).deleteFromTrash(input);
  }

  override async createProposal(input: Parameters<WorkDomainService["createProposal"]>[0]) {
    return (await this.serviceForWork(input)).createProposal(input);
  }

  override async createChapterProposal(input: Parameters<WorkDomainService["createChapterProposal"]>[0]) {
    return (await this.serviceForWork(input)).createChapterProposal(input);
  }

  override async authorizeProposal(proposalId: string) {
    return (await this.serviceForProposal(proposalId)).authorizeProposal(proposalId);
  }

  override async applyProposal(input: Parameters<WorkDomainService["applyProposal"]>[0]) {
    return (await this.serviceForProposal(input.proposalId)).applyProposal(input);
  }

  override async rejectProposal(proposalId: string) {
    return (await this.serviceForProposal(proposalId)).rejectProposal(proposalId);
  }

  override async rejectAnyProposal(proposalId: string) {
    return (await this.serviceForProposal(proposalId)).rejectAnyProposal(proposalId);
  }

  override async isWorkflowOwnedProposal(proposalId: string) {
    return (await this.serviceForProposal(proposalId)).isWorkflowOwnedProposal(proposalId);
  }

  override async inspectProposalApplication(proposalId: string) {
    return (await this.serviceForProposal(proposalId)).inspectProposalApplication(proposalId);
  }

  override async listProposals(target?: Parameters<WorkDomainService["listProposals"]>[0]) {
    if (target !== undefined) return (await this.serviceForWork(target)).listProposals(target);
    const proposals = await Promise.all(
      (await this.availableServices()).map(({ service }) => service.listProposals()),
    );
    return proposals.flat().sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  override async getProposalPreview(proposalId: string) {
    return (await this.serviceForProposal(proposalId)).getProposalPreview(proposalId);
  }

  override async previewImport(input: Parameters<WorkDomainService["previewImport"]>[0]) {
    return super.previewImport(input);
  }

  override async applyImport(input: Parameters<WorkDomainService["applyImport"]>[0]) {
    return (await this.createService()).applyImport(input);
  }

  override async exportWork(input: Parameters<WorkDomainService["exportWork"]>[0]) {
    const parsed = ExportWorkInput.parse(input);
    for (const root of (await this.workLocations.read()).roots) {
      const path = relative(root, resolve(parsed.destination));
      if (path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))) {
        throw new JizuoError("validation_error", "请导出到作品存储目录之外，避免覆盖作品文件");
      }
    }
    return (await this.serviceForWork(parsed)).exportWork(parsed);
  }

  override async searchWork(input: Parameters<WorkDomainService["searchWork"]>[0], signal?: AbortSignal) {
    return (await this.serviceForWork(input)).searchWork(input, signal);
  }

  private serviceForRoot(root: string): WorkDomainService {
    const normalized = resolve(root);
    const existing = this.services.get(normalized);
    if (existing !== undefined) return existing;
    const service = new WorkDomainService({
      worksRoot: normalized,
      idFactory: this.idFactory,
      now: this.now,
    });
    this.services.set(normalized, service);
    return service;
  }

  private async createService(projectKind?: "novel" | "video"): Promise<WorkDomainService> {
    const locations = await (projectKind === "video" && this.videoWorkLocations ? this.videoWorkLocations : this.workLocations).read();
    return this.serviceForRoot(locations.createRoot);
  }

  private async availableServices(): Promise<Array<{ root: string; service: WorkDomainService }>> {
    const locations = await Promise.all([this.workLocations.read(), ...(this.videoWorkLocations ? [this.videoWorkLocations.read()] : [])]);
    return [...new Map(locations.flatMap(location => location.statuses).map(status => [status.path, status])).values()]
      .filter((status) => status.available)
      .map(({ path }) => ({ root: path, service: this.serviceForRoot(path) }));
  }

  private async serviceForWork(input: unknown): Promise<WorkDomainService> {
    return (await this.locateWork(workIdFrom(input))).service;
  }

  private async serviceForProposal(proposalId: string): Promise<WorkDomainService> {
    const matches: Array<{ root: string; service: WorkDomainService }> = [];
    for (const candidate of await this.availableServices()) {
      try {
        await candidate.service.getProposalPreview(proposalId);
        matches.push(candidate);
      } catch (error) {
        if (!isMissingProposal(error)) throw error;
      }
    }
    if (matches.length === 0) throw new JizuoError("validation_error", "提案不存在", { proposalId });
    if (matches.length !== 1) {
      throw conflict("提案 ID 在多个存储位置重复，不能安全操作", {
        proposalId,
        roots: matches.map(({ root }) => root),
      });
    }
    return matches[0]!.service;
  }

  private async serviceForTrash(trashId: string): Promise<WorkDomainService> {
    const matches: Array<{ root: string; service: WorkDomainService }> = [];
    for (const candidate of await this.availableServices()) {
      if ((await candidate.service.listTrash()).some((entry) => entry.trashId === trashId)) matches.push(candidate);
    }
    if (matches.length === 0) {
      throw new JizuoError("validation_error", "回收站项目不存在或已损坏", { trashId });
    }
    if (matches.length !== 1) {
      throw conflict("回收站 ID 在多个存储位置重复，不能安全操作", {
        trashId,
        roots: matches.map(({ root }) => root),
      });
    }
    return matches[0]!.service;
  }
}
