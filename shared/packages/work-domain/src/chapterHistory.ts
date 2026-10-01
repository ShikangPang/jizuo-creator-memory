import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  ChapterRevisionDocument,
  ChapterRevisionSource,
  ChapterRevisionSummary,
  JizuoError,
  RevisionToken,
  StableId,
  type ChapterRevisionDocument as ChapterRevisionDocumentValue,
  type ChapterRevisionSource as ChapterRevisionSourceValue,
  type ChapterRevisionSummary as ChapterRevisionSummaryValue,
} from "@jizuo/contracts";
import { z } from "zod";

import { resolveWithin } from "./paths.ts";
import { preserveRevision, sha256Text } from "./revisions.ts";

const EditSessionId = z.string().regex(/^edit_[A-Za-z0-9_-]{8,75}$/);

const ChapterHistoryEntry = ChapterRevisionSummary.extend({
  contentRelativePath: z.string().min(1),
  editSessionId: EditSessionId.optional(),
  workflowRunId: StableId.optional(),
  workflowEffectId: z.enum(["write", "revise", "continuity-revise", "style-revise", "ai-trace-revise"]).optional(),
  workflowRevisionRound: z.number().int().min(0).max(10).optional(),
}).strict();

const ChapterHistoryIndex = z.object({
  schemaVersion: z.literal(1),
  chapterId: StableId,
  entries: z.array(ChapterHistoryEntry),
}).strict();

type ChapterHistoryIndexValue = z.infer<typeof ChapterHistoryIndex>;

export interface ChapterHistoryCheckpoint {
  source: ChapterRevisionSourceValue;
  label: string;
  editSessionId?: string;
  workflowRunId?: string;
  workflowEffectId?: "write" | "revise" | "continuity-revise" | "style-revise" | "ai-trace-revise";
  workflowRevisionRound?: number;
}

export interface ChapterHistoryLocation {
  workRoot: string;
  chapterId: string;
  contentRelativePath: string;
}

export class ChapterHistoryStore {
  constructor(private readonly options: {
    now: () => Date;
    assertSafePath: (path: string) => void;
  }) {}

  async record(input: ChapterHistoryLocation & {
    content: string;
    checkpoint: ChapterHistoryCheckpoint;
  }): Promise<void> {
    const chapterId = StableId.parse(input.chapterId);
    const checkpoint = {
      source: ChapterRevisionSource.parse(input.checkpoint.source),
      label: z.string().trim().min(1).max(120).parse(input.checkpoint.label),
      ...(input.checkpoint.editSessionId === undefined
        ? {}
        : { editSessionId: EditSessionId.parse(input.checkpoint.editSessionId) }),
      ...(input.checkpoint.workflowRunId === undefined
        ? {}
        : { workflowRunId: StableId.parse(input.checkpoint.workflowRunId) }),
      ...(input.checkpoint.workflowEffectId === undefined
        ? {}
        : { workflowEffectId: input.checkpoint.workflowEffectId }),
      ...(input.checkpoint.workflowRevisionRound === undefined
        ? {}
        : { workflowRevisionRound: z.number().int().min(0).max(10).parse(input.checkpoint.workflowRevisionRound) }),
    };
    if (input.content.trim() === "") return;

    const index = await this.readIndex(input.workRoot, chapterId);
    if (
      checkpoint.editSessionId !== undefined
      && index.entries.some((entry) => entry.editSessionId === checkpoint.editSessionId)
    ) return;

    const revision = await preserveRevision(
      input.workRoot,
      input.contentRelativePath,
      input.content,
      (path) => this.options.assertSafePath(path),
    );
    const entry = ChapterHistoryEntry.parse({
      revision,
      createdAt: this.options.now().toISOString(),
      contentRelativePath: input.contentRelativePath,
      ...checkpoint,
    });
    await this.writeIndex(input.workRoot, {
      ...index,
      entries: [...index.entries, entry],
    });
  }

  async list(input: ChapterHistoryLocation & { currentRevision: string }): Promise<ChapterRevisionSummaryValue[]> {
    const currentRevision = RevisionToken.parse(input.currentRevision);
    const index = await this.readIndex(input.workRoot, StableId.parse(input.chapterId));
    const seen = new Set<string>();
    const result: ChapterRevisionSummaryValue[] = [];
    for (const entry of [...index.entries].reverse()) {
      if (entry.revision === currentRevision || seen.has(entry.revision)) continue;
      seen.add(entry.revision);
      const content = await this.readSnapshot(input, entry.revision, entry.contentRelativePath);
      if (content.trim() === "") continue;
      result.push(ChapterRevisionSummary.parse({
        revision: entry.revision,
        createdAt: entry.createdAt,
        source: entry.source,
        label: entry.label,
      }));
    }
    return result;
  }

  async read(input: ChapterHistoryLocation & { revision: string }): Promise<ChapterRevisionDocumentValue> {
    const revision = RevisionToken.parse(input.revision);
    const index = await this.readIndex(input.workRoot, StableId.parse(input.chapterId));
    const entry = [...index.entries].reverse().find((candidate) => candidate.revision === revision);
    if (entry === undefined) {
      throw new JizuoError("validation_error", "指定章节历史版本不存在", {
        chapterId: input.chapterId,
        revision,
      });
    }
    const content = await this.readSnapshot(input, revision, entry.contentRelativePath);
    return ChapterRevisionDocument.parse({
      revision: entry.revision,
      createdAt: entry.createdAt,
      source: entry.source,
      label: entry.label,
      content,
    });
  }

  private async readIndex(workRoot: string, chapterId: string): Promise<ChapterHistoryIndexValue> {
    const path = this.indexPath(workRoot, chapterId);
    try {
      const raw = await readFile(path, "utf8");
      return ChapterHistoryIndex.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, chapterId, entries: [] };
      }
      throw new JizuoError("transaction_recovery_required", "章节历史索引损坏，需恢复后重试", {
        chapterId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async writeIndex(workRoot: string, index: ChapterHistoryIndexValue): Promise<void> {
    const path = this.indexPath(workRoot, index.chapterId);
    const temporaryPath = `${path}.next-${randomUUID().replaceAll("-", "")}`;
    this.options.assertSafePath(dirname(path));
    this.options.assertSafePath(temporaryPath);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(ChapterHistoryIndex.parse(index), null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      this.options.assertSafePath(path);
      await rename(temporaryPath, path);
    } catch (error) {
      throw new JizuoError("transaction_recovery_required", "章节历史索引写入失败，正文未覆盖", {
        chapterId: index.chapterId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async readSnapshot(
    input: ChapterHistoryLocation,
    revision: string,
    contentRelativePath: string,
  ): Promise<string> {
    try {
      const path = resolveWithin(input.workRoot, ".jizuo", "revisions", revision, contentRelativePath);
      this.options.assertSafePath(path);
      const content = await readFile(path, "utf8");
      if (sha256Text(content) !== revision) throw new Error("revision hash mismatch");
      return content;
    } catch (error) {
      throw new JizuoError("transaction_recovery_required", "章节历史正文损坏或缺失，需恢复后重试", {
        chapterId: input.chapterId,
        revision,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private indexPath(workRoot: string, chapterId: string): string {
    const path = resolveWithin(workRoot, ".jizuo", "revision-history", `${chapterId}.json`);
    this.options.assertSafePath(path);
    return path;
  }
}
