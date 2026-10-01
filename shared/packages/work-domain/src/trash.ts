import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";

import { JizuoError, StableId, type TrashEntry } from "@jizuo/contracts";
import { z } from "zod";

import { resolveWithin } from "./paths.ts";

const TrashManifest = z.object({
  schemaVersion: z.literal(1),
  trashId: StableId,
  kind: z.enum(["work", "volume", "chapter"]),
  workId: StableId,
  volumeId: StableId.optional(),
  chapterId: StableId.optional(),
  title: z.string().min(1),
  volumeCount: z.number().int().nonnegative(),
  chapterCount: z.number().int().nonnegative(),
  originalRelativePath: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  trashedAt: z.string().datetime(),
}).superRefine((value, context) => {
  if (value.kind !== "work" && value.volumeId === undefined) {
    context.addIssue({ code: "custom", path: ["volumeId"], message: "分卷和章节回收项必须包含分卷 ID" });
  }
  if (value.kind === "chapter" && value.chapterId === undefined) {
    context.addIssue({ code: "custom", path: ["chapterId"], message: "章节回收项必须包含章节 ID" });
  }
});

type TrashManifest = z.infer<typeof TrashManifest>;

function toTrashEntry(manifest: TrashManifest): TrashEntry {
  return {
    trashId: manifest.trashId,
    kind: manifest.kind,
    workId: manifest.workId,
    ...(manifest.volumeId === undefined ? {} : { volumeId: manifest.volumeId }),
    ...(manifest.chapterId === undefined ? {} : { chapterId: manifest.chapterId }),
    title: manifest.title,
    volumeCount: manifest.volumeCount,
    chapterCount: manifest.chapterCount,
    originalRelativePath: manifest.originalRelativePath,
    contentHash: manifest.contentHash,
    trashedAt: manifest.trashedAt,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function directoryHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolveWithin(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        hash.update(relative(root, path));
        hash.update("\0");
        hash.update(await readFile(path));
        hash.update("\0");
      }
    }
  };
  await visit(root);
  return hash.digest("hex");
}

function trashRoot(worksRoot: string): string {
  return resolveWithin(worksRoot, ".jizuo", "trash");
}

async function readManifest(worksRoot: string, trashId: string): Promise<TrashManifest> {
  const itemRoot = resolveWithin(trashRoot(worksRoot), StableId.parse(trashId));
  try {
    return TrashManifest.parse(JSON.parse(await readFile(resolveWithin(itemRoot, "manifest.json"), "utf8")));
  } catch {
    throw new JizuoError("validation_error", "回收站项目不存在或已损坏", { trashId });
  }
}

export async function moveDirectoryToTrash(input: {
  worksRoot: string;
  itemRoot: string;
  trashId: string;
  kind: "work" | "volume" | "chapter";
  workId: string;
  volumeId?: string;
  chapterId?: string;
  title: string;
  volumeCount: number;
  chapterCount: number;
  now: Date;
}): Promise<TrashEntry> {
  const originalRelativePath = relative(input.worksRoot, input.itemRoot);
  resolveWithin(input.worksRoot, originalRelativePath);
  const root = trashRoot(input.worksRoot);
  await mkdir(root, { recursive: true });
  const itemTrashRoot = resolveWithin(root, StableId.parse(input.trashId));
  const manifest: TrashManifest = {
    schemaVersion: 1,
    trashId: input.trashId,
    kind: input.kind,
    workId: input.workId,
    volumeId: input.volumeId,
    chapterId: input.chapterId,
    title: input.title,
    volumeCount: input.volumeCount,
    chapterCount: input.chapterCount,
    originalRelativePath,
    contentHash: await directoryHash(input.itemRoot),
    trashedAt: input.now.toISOString(),
  };
  await mkdir(itemTrashRoot);
  try {
    await writeFile(
      resolveWithin(itemTrashRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await rename(input.itemRoot, resolveWithin(itemTrashRoot, "payload"));
  } catch (error) {
    await rm(itemTrashRoot, { recursive: true, force: true });
    throw error;
  }
  return toTrashEntry(manifest);
}

export async function listTrashEntries(worksRoot: string): Promise<TrashEntry[]> {
  const root = trashRoot(worksRoot);
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const manifests: TrashEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      manifests.push(toTrashEntry(await readManifest(worksRoot, entry.name)));
    } catch {
      // A damaged entry remains on disk for diagnostics and manual recovery.
    }
  }
  return manifests.sort((left, right) => right.trashedAt.localeCompare(left.trashedAt));
}

export async function restoreDirectoryFromTrash(input: {
  worksRoot: string;
  workId: string;
  trashId: string;
  targetRoot?: string;
}): Promise<TrashEntry> {
  const root = resolveWithin(trashRoot(input.worksRoot), StableId.parse(input.trashId));
  const manifest = await readManifest(input.worksRoot, input.trashId);
  if (manifest.workId !== input.workId) {
    throw new JizuoError("denied", "回收站项目不属于当前作品", { trashId: input.trashId });
  }
  const payload = resolveWithin(root, "payload");
  if (await directoryHash(payload) !== manifest.contentHash) {
    throw new JizuoError("transaction_recovery_required", "回收站内容校验失败", { trashId: input.trashId });
  }
  const target = input.targetRoot ?? resolveWithin(input.worksRoot, manifest.originalRelativePath);
  resolveWithin(input.worksRoot, relative(input.worksRoot, target));
  if (await exists(target)) {
    throw new JizuoError("revision_conflict", "原位置已有内容，无法恢复", {
      trashId: input.trashId,
      originalRelativePath: manifest.originalRelativePath,
    });
  }
  await mkdir(dirname(target), { recursive: true });
  await rename(payload, target);
  await rm(root, { recursive: true, force: true });
  return toTrashEntry(manifest);
}

export async function deleteTrashEntry(input: {
  worksRoot: string;
  workId: string;
  trashId: string;
}): Promise<{ deleted: true }> {
  const manifest = await readManifest(input.worksRoot, input.trashId);
  if (manifest.workId !== input.workId) {
    throw new JizuoError("denied", "回收站项目不属于当前作品", { trashId: input.trashId });
  }
  await rm(resolveWithin(trashRoot(input.worksRoot), StableId.parse(input.trashId)), {
    recursive: true,
    force: false,
  });
  return { deleted: true };
}
