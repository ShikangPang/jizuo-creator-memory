import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import {
  ChapterWorkflowRecord,
  ChapterWorkflowRecordSummary,
  JizuoError,
  ReadChapterWorkflowRecordInput,
  WorkflowChapterProjectionInput,
  type ChapterWorkflowProjectionRecord,
  type ChapterWorkflowRecord as ChapterWorkflowRecordValue,
  type ChapterWorkflowRecordSummary as ChapterWorkflowRecordSummaryValue,
} from "@jizuo/contracts";
import { z } from "zod";

import { resolveWithin } from "./paths.ts";

const WorkflowProjectionIndex = z.object({
  schemaVersion: z.literal(1),
  records: z.array(ChapterWorkflowRecordSummary).max(1_000),
}).strict();

type WorkflowProjectionIndex = z.infer<typeof WorkflowProjectionIndex>;

export interface WorkflowProjectionStoreOptions {
  chapterRoot: string;
  now: () => Date;
  assertSafePath: (path: string) => void;
  assertChapterIdentity?: () => void;
}

function projectionIdentity(record: ChapterWorkflowProjectionRecord): { recordId: string; suffix: string } {
  switch (record.kind) {
    case "memory-context": return { recordId: "memory-context", suffix: "memory-context.md" };
    case "plan": return { recordId: "chapter-plan", suffix: "chapter-plan.md" };
    case "summary": return { recordId: "final-summary", suffix: "final-summary.md" };
    case "memory-extraction": return { recordId: "memory-extraction", suffix: "memory-extraction.md" };
    case "review": {
      const round = String(record.round).padStart(2, "0");
      return { recordId: `${record.stage}-review-${round}`, suffix: `${record.stage}/review-${round}.md` };
    }
  }
}

function assertSummaryPath(summary: ChapterWorkflowRecordSummaryValue): void {
  const record = summary.kind === "review"
    ? { kind: summary.kind, label: summary.label, content: "", stage: summary.stage, round: summary.round }
    : { kind: summary.kind, label: summary.label, content: "" };
  const parsed = WorkflowChapterProjectionInput.shape.record.parse(record);
  const identity = projectionIdentity(parsed);
  const expected = `workflow/${summary.runId}/${identity.suffix}`;
  if (identity.recordId !== summary.recordId || expected !== summary.relativePath) {
    throw new JizuoError("revision_conflict", "章节流程记录索引包含非宿主生成的路径");
  }
}

/** Host-owned, indexed, read-only projections of validated workflow artifacts. */
export class WorkflowChapterProjectionStore {
  readonly #workflowRoot: string;
  readonly #indexPath: string;

  constructor(private readonly options: WorkflowProjectionStoreOptions) {
    this.#workflowRoot = resolveWithin(options.chapterRoot, "workflow");
    this.#indexPath = resolveWithin(this.#workflowRoot, "index.json");
  }

  save(rawInput: unknown): ChapterWorkflowRecordSummaryValue {
    const input = WorkflowChapterProjectionInput.parse(rawInput);
    this.guard(this.#workflowRoot);
    const identity = projectionIdentity(input.record);
    const relativePath = `workflow/${input.runId}/${identity.suffix}`;
    const destination = resolveWithin(this.options.chapterRoot, relativePath);
    const index = this.readIndex();
    const existing = index.records.find((record) => record.runId === input.runId && record.recordId === identity.recordId);
    if (existing) {
      if (
        existing.relativePath !== relativePath
        || existing.kind !== input.record.kind
        || existing.label !== input.record.label
        || existing.stage !== (input.record.kind === "review" ? input.record.stage : undefined)
        || existing.round !== (input.record.kind === "review" ? input.record.round : undefined)
      ) {
        throw new JizuoError("revision_conflict", "章节流程记录索引与重试输入不一致");
      }
      this.installRecord(destination, input.record.content);
      return existing;
    }

    this.ensureParentDirectories(destination);
    this.installRecord(destination, input.record.content);
    const summary = ChapterWorkflowRecordSummary.parse({
      runId: input.runId,
      recordId: identity.recordId,
      relativePath,
      kind: input.record.kind,
      label: input.record.label,
      ...(input.record.kind === "review" ? { stage: input.record.stage, round: input.record.round } : {}),
      updatedAt: this.options.now().toISOString(),
    });
    this.writeIndex({ schemaVersion: 1, records: [...index.records, summary] });
    return summary;
  }

  list(): ChapterWorkflowRecordSummaryValue[] {
    const index = this.readIndex();
    for (const summary of index.records) {
      assertSummaryPath(summary);
      this.guard(resolveWithin(this.options.chapterRoot, summary.relativePath));
    }
    return [...index.records];
  }

  read(rawInput: unknown): ChapterWorkflowRecordValue {
    const input = ReadChapterWorkflowRecordInput.parse(rawInput);
    const summary = this.readIndex().records.find((record) => record.runId === input.runId && record.recordId === input.recordId);
    if (!summary) throw new JizuoError("validation_error", "章节流程记录不存在");
    assertSummaryPath(summary);
    const path = resolveWithin(this.options.chapterRoot, summary.relativePath);
    const content = this.readNoFollow(path, "章节流程记录不存在");
    return ChapterWorkflowRecord.parse({ ...summary, content });
  }

  private guard(path: string): void {
    this.options.assertChapterIdentity?.();
    this.options.assertSafePath(path);
  }

  private ensureParentDirectories(destination: string): void {
    const directories = [this.#workflowRoot];
    let current = this.#workflowRoot;
    for (const segment of relative(this.#workflowRoot, dirname(destination)).split(sep).filter(Boolean)) {
      current = resolveWithin(current, segment);
      directories.push(current);
    }
    for (const directory of directories) {
      this.guard(directory);
      try { mkdirSync(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      this.guard(directory);
    }
  }

  private installRecord(destination: string, content: string): void {
    const current = this.readNoFollow(destination, undefined);
    if (current !== undefined) {
      if (current !== content) throw new JizuoError("revision_conflict", "章节流程记录已存在且内容不匹配，不能覆盖");
      return;
    }
    const temporary = join(dirname(destination), `.record-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      this.guard(temporary);
      descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(descriptor, content, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      this.guard(destination);
      try { linkSync(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const installed = this.readNoFollow(destination, undefined);
        if (installed !== content) throw new JizuoError("revision_conflict", "章节流程记录在安装时发生变化");
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  private readIndex(): WorkflowProjectionIndex {
    const raw = this.readNoFollow(this.#indexPath, undefined);
    if (raw === undefined) return { schemaVersion: 1, records: [] };
    let parsed: WorkflowProjectionIndex;
    try {
      parsed = WorkflowProjectionIndex.parse(JSON.parse(raw));
      const keys = new Set<string>();
      const paths = new Set<string>();
      for (const summary of parsed.records) {
        assertSummaryPath(summary);
        const key = `${summary.runId}\0${summary.recordId}`;
        if (keys.has(key) || paths.has(summary.relativePath)) throw new Error("duplicate workflow projection record");
        keys.add(key);
        paths.add(summary.relativePath);
      }
    } catch {
      throw new JizuoError("revision_conflict", "章节流程记录索引损坏，不能安全读取或覆盖");
    }
    return parsed;
  }

  private writeIndex(index: WorkflowProjectionIndex): void {
    const serialized = `${JSON.stringify(WorkflowProjectionIndex.parse(index), null, 2)}\n`;
    const temporary = resolveWithin(this.#workflowRoot, `.index-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      this.guard(this.#indexPath);
      this.guard(temporary);
      descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      this.guard(this.#indexPath);
      renameSync(temporary, this.#indexPath);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  private readNoFollow(path: string, missingMessage: string | undefined): string | undefined {
    this.guard(path);
    let descriptor: number;
    try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (missingMessage === undefined) return undefined;
        throw new JizuoError("validation_error", missingMessage);
      }
      throw error;
    }
    try { return readFileSync(descriptor, "utf8"); }
    finally { closeSync(descriptor); }
  }
}
