import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";

import {
  ApplyProposalInput,
  ChapterTarget,
  CreateChapterProposalInput,
  CreateProposalInput,
  JizuoError,
  StableId,
  VolumeTarget,
  type ChapterChangeProposal,
  type ChapterCreationProposal,
  type ChapterDocument,
  type ChapterProposal,
  type WorkSummary,
} from "@jizuo/contracts";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";

import type { ChapterListSnapshot } from "./chapterService.ts";
import { resolveWithin } from "./paths.ts";
import { sha256Text } from "./revisions.ts";

const ProposalStatus = z.enum(["pending", "applied", "rejected"]);
const LegacyChangeProposalFile = z.object({
  schemaVersion: z.literal(1),
  id: StableId,
  target: ChapterTarget,
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  baseHash: z.string().regex(/^[a-f0-9]{64}$/),
  nextHash: z.string().regex(/^[a-f0-9]{64}$/),
  nextContent: z.string(),
  unifiedDiff: z.string(),
  status: ProposalStatus,
  createdAt: z.string().datetime(),
  appliedAt: z.string().datetime().optional(),
});

const ChangeProposalFile = LegacyChangeProposalFile.omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal(2),
  kind: z.literal("chapter_change"),
  workflowRunId: StableId.optional(),
});

const CreationProposalFile = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal("chapter_create"),
  id: StableId,
  target: VolumeTarget,
  reservedChapterId: StableId,
  insertAfterChapterId: StableId.nullable(),
  expectedChapterListHash: z.string().regex(/^[a-f0-9]{64}$/),
  nextHash: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().min(1),
  nextContent: z.string(),
  status: ProposalStatus,
  createdAt: z.string().datetime(),
  appliedAt: z.string().datetime().optional(),
  workflowRunId: StableId.optional(),
});

const ProposalFile = z.union([
  LegacyChangeProposalFile.transform((proposal) => ({ ...proposal, kind: "chapter_change" as const, workflowRunId: undefined as string | undefined })),
  ChangeProposalFile,
  CreationProposalFile,
]);

type ProposalFile = z.output<typeof ProposalFile>;
type ChangeProposalFile = z.output<typeof ChangeProposalFile>;
type CreationProposalFile = z.output<typeof CreationProposalFile>;

interface ProposalServiceOptions {
  worksRoot: string;
  now: () => Date;
  reserveChapterId: () => string;
  findWork: (workId: string) => Promise<WorkSummary>;
  readChapter: (target: z.infer<typeof ChapterTarget>) => Promise<ChapterDocument>;
  replaceChapter: (input: z.infer<typeof CreateProposalInput> & { content: string }) => Promise<ChapterDocument>;
  chapterListSnapshot: (target: z.infer<typeof VolumeTarget>) => Promise<ChapterListSnapshot>;
  withChapterListLock: <T>(target: z.infer<typeof VolumeTarget>, operation: (assertLockOwner: () => Promise<void>) => Promise<T>) => Promise<T>;
  createReservedChapter: (proposal: ChapterCreationProposal) => Promise<ChapterDocument>;
}

export type ProposalApplicationSnapshot =
  | Readonly<{
    kind: "chapter_change";
    id: string;
    status: "pending" | "applied" | "rejected";
    target: { workId: string; volumeId: string; chapterId: string };
    expectedRevision: string;
    nextHash: string;
  }>
  | Readonly<{
    kind: "chapter_create";
    id: string;
    status: "pending" | "applied" | "rejected";
    target: { workId: string; volumeId: string };
    reservedChapterId: string;
    insertAfterChapterId: string | null;
    expectedChapterListHash: string;
    nextHash: string;
    title: string;
  }>;

interface Authority {
  proposalId: string;
  expiresAt: number;
}

export class ProposalService {
  private readonly authorities = new Map<string, Authority>();

  constructor(private readonly options: ProposalServiceOptions) {}

  async createProposal(rawInput: z.infer<typeof CreateProposalInput>): Promise<ChapterChangeProposal> {
    const input = CreateProposalInput.parse(rawInput);
    const current = await this.options.readChapter(input);
    if (current.revisionToken !== input.expectedRevision) {
      throw new JizuoError("revision_conflict", "章节已在其他位置更新", {
        chapterId: input.chapterId,
        expectedRevision: input.expectedRevision,
        actualRevision: current.revisionToken,
      });
    }
    const work = await this.options.findWork(input.workId);
    const id = this.newProposalId();
    const proposal: ChangeProposalFile = {
      schemaVersion: 2,
      kind: "chapter_change",
      id,
      target: { workId: input.workId, volumeId: input.volumeId, chapterId: input.chapterId },
      expectedRevision: input.expectedRevision,
      baseHash: sha256Text(current.content),
      nextHash: sha256Text(input.nextContent),
      nextContent: input.nextContent,
      unifiedDiff: createTwoFilesPatch(
        `${current.title}@${current.revisionToken.slice(0, 8)}`,
        `${current.title}@${sha256Text(input.nextContent).slice(0, 8)}`,
        current.content,
        input.nextContent,
        "当前版本",
        "提案版本",
      ),
      status: "pending",
      createdAt: this.options.now().toISOString(),
      ...(input.workflowRunId === undefined ? {} : { workflowRunId: input.workflowRunId }),
    };
    await this.persistNewProposal(work, proposal);
    return this.toChangeDto(proposal);
  }

  async createChapterProposal(rawInput: z.infer<typeof CreateChapterProposalInput>): Promise<ChapterCreationProposal> {
    const input = CreateChapterProposalInput.parse(rawInput);
    const work = await this.options.findWork(input.target.workId);
    return this.options.withChapterListLock(input.target, async (assertLockOwner) => {
      const snapshot = await this.options.chapterListSnapshot(input.target);
      if (input.expectedChapterListHash !== snapshot.expectedChapterListHash) {
        throw new JizuoError("revision_conflict", "章节列表已变化，不能创建提案", {
          expectedChapterListHash: input.expectedChapterListHash,
          actualChapterListHash: snapshot.expectedChapterListHash,
        });
      }
      const insertAfterChapterId = input.insertAfterChapterId ?? snapshot.insertAfterChapterId;
      if (insertAfterChapterId !== snapshot.insertAfterChapterId) {
        throw new JizuoError("revision_conflict", "章节插入锚点已变化，不能创建提案", {
          insertAfterChapterId,
          actualInsertAfterChapterId: snapshot.insertAfterChapterId,
        });
      }
      const id = this.newProposalId();
      const reservedChapterId = this.options.reserveChapterId();
      StableId.parse(reservedChapterId);
      const proposal: CreationProposalFile = {
        schemaVersion: 2,
        kind: "chapter_create",
        id,
        target: input.target,
        reservedChapterId,
        insertAfterChapterId,
        expectedChapterListHash: input.expectedChapterListHash,
        nextHash: sha256Text(input.nextContent),
        title: input.title,
        nextContent: input.nextContent,
        status: "pending",
        createdAt: this.options.now().toISOString(),
        ...(input.workflowRunId === undefined ? {} : { workflowRunId: input.workflowRunId }),
      };
      await assertLockOwner();
      await this.persistNewProposal(work, proposal);
      return this.toCreationDto(proposal);
    });
  }

  async authorizeProposal(proposalId: string): Promise<string> {
    const { proposal } = await this.findProposal(StableId.parse(proposalId));
    if (proposal.status === "rejected") {
      throw new JizuoError("denied", "提案已拒绝，不能再次授权", { proposalId });
    }
    if (proposal.status === "applied") {
      // Confirmation may arrive after another approved surface applied the
      // same proposal. Re-authorize only while the chapter still proves that
      // exact immutable result.
      await this.readAppliedProposal(proposal);
    }
    const token = randomBytes(32).toString("hex");
    this.authorities.set(token, { proposalId, expiresAt: this.options.now().getTime() + 10 * 60 * 1000 });
    return token;
  }

  async applyProposal(rawInput: z.infer<typeof ApplyProposalInput>): Promise<ChapterDocument> {
    const input = ApplyProposalInput.parse(rawInput);
    const authority = this.authorities.get(input.token);
    if (authority === undefined || authority.proposalId !== input.proposalId || authority.expiresAt < this.options.now().getTime()) {
      throw new JizuoError("denied", "提案授权无效或已过期", { proposalId: input.proposalId });
    }
    this.authorities.delete(input.token);
    const { path, proposal } = await this.findProposal(input.proposalId);
    if (proposal.status === "rejected") {
      throw new JizuoError("denied", "提案已拒绝，不能再次应用", { proposalId: input.proposalId });
    }
    if (proposal.status === "applied") {
      return this.readAppliedProposal(proposal);
    }
    const document = proposal.kind === "chapter_change"
      ? await this.applyChangeProposal(proposal)
      : await this.options.createReservedChapter(this.toCreationDto(proposal));
    const applied = ProposalFile.parse({ ...proposal, status: "applied", appliedAt: this.options.now().toISOString() });
    await this.writeProposal(path, applied);
    return document;
  }

  async rejectProposal(proposalId: string): Promise<ChapterChangeProposal> {
    const rejected = await this.rejectPendingProposal(proposalId, "chapter_change");
    if (rejected.kind !== "chapter_change") {
      throw new JizuoError("denied", "提案类型不能由此入口拒绝", { proposalId, kind: rejected.kind });
    }
    return this.toChangeDto(rejected);
  }

  async rejectAnyProposal(proposalId: string): Promise<ChapterProposal> {
    const rejected = await this.rejectPendingProposal(proposalId, undefined, true);
    return rejected.kind === "chapter_change"
      ? { kind: "chapter_change", ...this.toChangeDto(rejected) }
      : this.toCreationDto(rejected);
  }

  async isWorkflowOwnedProposal(proposalId: string): Promise<boolean> {
    const { proposal } = await this.findProposal(StableId.parse(proposalId));
    return proposal.workflowRunId !== undefined;
  }

  /** Compact, read-only evidence used only to repair a lost workflow marker. */
  async inspectProposalApplication(proposalId: string): Promise<ProposalApplicationSnapshot> {
    const { proposal } = await this.findProposal(StableId.parse(proposalId));
    if (proposal.kind === "chapter_change") {
      return Object.freeze({
        kind: proposal.kind,
        id: proposal.id,
        status: proposal.status,
        target: proposal.target,
        expectedRevision: proposal.expectedRevision,
        nextHash: proposal.nextHash,
      });
    }
    return Object.freeze({
      kind: proposal.kind,
      id: proposal.id,
      status: proposal.status,
      target: proposal.target,
      reservedChapterId: proposal.reservedChapterId,
      insertAfterChapterId: proposal.insertAfterChapterId,
      expectedChapterListHash: proposal.expectedChapterListHash,
      nextHash: proposal.nextHash,
      title: proposal.title,
    });
  }

  private async rejectPendingProposal(
    proposalId: string,
    expectedKind?: ProposalFile["kind"],
    recoverWorkflowRejection = false,
  ): Promise<ProposalFile> {
    const { path, proposal } = await this.findProposal(StableId.parse(proposalId));
    if (expectedKind !== undefined && proposal.kind !== expectedKind) {
      throw new JizuoError("denied", "提案类型不能由此入口拒绝", { proposalId, kind: proposal.kind });
    }
    if (proposal.status === "rejected" && recoverWorkflowRejection && proposal.workflowRunId !== undefined) {
      return proposal;
    }
    if (proposal.status !== "pending") {
      throw new JizuoError("denied", "提案已处理，不能再次拒绝", { proposalId });
    }
    for (const [token, authority] of this.authorities) {
      if (authority.proposalId === proposalId) this.authorities.delete(token);
    }
    const rejected = ProposalFile.parse({ ...proposal, status: "rejected" });
    await this.writeProposal(path, rejected);
    return rejected;
  }

  async listProposals(target?: z.infer<typeof ChapterTarget>): Promise<ChapterChangeProposal[]> {
    const parsedTarget = target === undefined ? undefined : ChapterTarget.parse(target);
    return (await this.readProposalFiles())
      .filter((proposal): proposal is Extract<ProposalFile, { kind: "chapter_change" }> => proposal.kind === "chapter_change")
      .filter((proposal) => proposal.workflowRunId === undefined)
      .filter((proposal) => parsedTarget === undefined || (
        proposal.target.workId === parsedTarget.workId
        && proposal.target.volumeId === parsedTarget.volumeId
        && proposal.target.chapterId === parsedTarget.chapterId
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((proposal) => this.toChangeDto(proposal));
  }

  /**
   * Returns exactly one persisted proposal for the dedicated review surface.
   * Callers receive the DTO only; proposal paths and authorization capability
   * remain private to the domain service.
   */
  async getProposalPreview(proposalId: string): Promise<ChapterProposal> {
    const { proposal } = await this.findProposal(StableId.parse(proposalId));
    return proposal.kind === "chapter_change"
      ? { ...this.toChangeDto(proposal), kind: "chapter_change" }
      : this.toCreationDto(proposal);
  }

  private async applyChangeProposal(proposal: Extract<ProposalFile, { kind: "chapter_change" }>): Promise<ChapterDocument> {
    try {
      return await this.options.replaceChapter({
        ...proposal.target,
        nextContent: proposal.nextContent,
        content: proposal.nextContent,
        expectedRevision: proposal.expectedRevision,
      });
    } catch (error) {
      if (!(error instanceof JizuoError) || error.code !== "revision_conflict") throw error;
      const current = await this.options.readChapter(proposal.target);
      if (current.revisionToken !== proposal.nextHash) throw error;
      return current;
    }
  }

  private async readAppliedProposal(proposal: ProposalFile): Promise<ChapterDocument> {
    const target = proposal.kind === "chapter_change"
      ? proposal.target
      : { ...proposal.target, chapterId: proposal.reservedChapterId };
    const current = await this.options.readChapter(target);
    if (
      current.revisionToken !== proposal.nextHash
      || (proposal.kind === "chapter_create" && current.title !== proposal.title)
    ) {
      throw new JizuoError("revision_conflict", "已应用提案与当前章节不一致", {
        proposalId: proposal.id,
        chapterId: current.id,
        expectedRevision: proposal.nextHash,
        actualRevision: current.revisionToken,
      });
    }
    return current;
  }

  private newProposalId(): string {
    const id = `proposal_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    StableId.parse(id);
    return id;
  }

  private async persistNewProposal(work: WorkSummary, proposal: ProposalFile): Promise<void> {
    const directory = resolveWithin(this.options.worksRoot, work.folderName, ".jizuo", "jobs", "proposals");
    await mkdir(directory, { recursive: true });
    await writeFile(resolveWithin(directory, `${proposal.id}.json`), `${JSON.stringify(proposal, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  }

  private async readProposalFiles(): Promise<ProposalFile[]> {
    await mkdir(this.options.worksRoot, { recursive: true });
    const proposals: ProposalFile[] = [];
    for (const workEntry of await readdir(this.options.worksRoot, { withFileTypes: true })) {
      if (!workEntry.isDirectory()) continue;
      const directory = resolveWithin(this.options.worksRoot, workEntry.name, ".jizuo", "jobs", "proposals");
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        proposals.push(ProposalFile.parse(JSON.parse(await readFile(resolveWithin(directory, entry.name), "utf8"))));
      }
    }
    return proposals;
  }

  private async findProposal(proposalId: string): Promise<{ path: string; proposal: ProposalFile }> {
    await mkdir(this.options.worksRoot, { recursive: true });
    for (const workEntry of await readdir(this.options.worksRoot, { withFileTypes: true })) {
      if (!workEntry.isDirectory()) continue;
      const path = resolveWithin(this.options.worksRoot, workEntry.name, ".jizuo", "jobs", "proposals", `${proposalId}.json`);
      try {
        return { path, proposal: ProposalFile.parse(JSON.parse(await readFile(path, "utf8"))) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new JizuoError("validation_error", "提案不存在", { proposalId });
  }

  private async writeProposal(path: string, proposal: ProposalFile): Promise<void> {
    const temporary = `${path}.next`;
    await writeFile(temporary, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }

  private toChangeDto(proposal: Extract<ProposalFile, { kind: "chapter_change" }>): ChapterChangeProposal {
    const { schemaVersion: _schemaVersion, kind: _kind, appliedAt, workflowRunId: _workflowRunId, ...dto } = proposal;
    return appliedAt === undefined ? dto : { ...dto, appliedAt };
  }

  private toCreationDto(proposal: Extract<ProposalFile, { kind: "chapter_create" }>): ChapterCreationProposal {
    const { schemaVersion: _schemaVersion, appliedAt, workflowRunId: _workflowRunId, ...dto } = proposal;
    return appliedAt === undefined ? dto : { ...dto, appliedAt };
  }
}
