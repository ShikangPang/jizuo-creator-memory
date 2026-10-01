import { randomUUID } from "node:crypto";
import { access, link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { resolveWithin } from "./paths.ts";
import { preserveRevision, sha256Text } from "./revisions.ts";

const TransactionState = z.enum(["prepared", "committing", "committed"]);

const TransactionManifest = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  state: TransactionState,
  files: z.array(z.object({
    relativePath: z.string().min(1),
    hadOriginal: z.boolean(),
    stagedHash: z.string().regex(/^[a-f0-9]{64}$/),
    installed: z.boolean().default(false),
  })),
});

type TransactionManifest = z.infer<typeof TransactionManifest>;
type TransactionFile = TransactionManifest["files"][number];

export interface FileTransactionOptions {
  workRoot: string;
  id: string;
  /** Process-local fence, deliberately absent from the durable manifest.
   * Called synchronously after async preparation and just before each rename/link. */
  assertActive?: () => void;
  /** Validates the complete revision destination before directory creation, writes and collision reads. */
  beforePreserveRevision?: (absolutePath: string) => void;
  beforeInstall?: (
    relativePath: string,
    index: number,
    context: FileTransactionInstallContext,
  ) => void | Promise<void>;
}

export interface FileTransactionInstallContext {
  readOriginal(): Promise<string | undefined>;
  targetExists(): Promise<boolean>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeManifest(transactionRoot: string, manifest: TransactionManifest): Promise<void> {
  const target = resolveWithin(transactionRoot, "manifest.json");
  const temporary = resolveWithin(transactionRoot, "manifest.json.next");
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function moveFileNoClobber(source: string, target: string, assertActive?: () => void): Promise<void> {
  assertActive?.();
  await mkdir(dirname(target), { recursive: true });
  assertActive?.();
  await link(source, target);
  await rm(source);
}

async function recoverCommittingTransaction(
  workRoot: string,
  transactionRoot: string,
  files: TransactionFile[],
): Promise<boolean> {
  let fullyRecovered = true;
  for (const [index, file] of files.entries()) {
    const target = resolveWithin(workRoot, file.relativePath);
    const backup = resolveWithin(transactionRoot, "backup", file.relativePath);
    const quarantine = resolveWithin(
      transactionRoot,
      "recovery-current",
      `${String(index).padStart(4, "0")}-${randomUUID()}`,
    );
    await mkdir(dirname(quarantine), { recursive: true });
    try {
      await rename(target, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (file.hadOriginal) {
        try {
          await moveFileNoClobber(backup, target);
        } catch (restoreError) {
          if ((restoreError as NodeJS.ErrnoException).code === "EEXIST") {
            fullyRecovered = false;
            continue;
          }
          if ((restoreError as NodeJS.ErrnoException).code !== "ENOENT") throw restoreError;
          fullyRecovered = false;
        }
      }
      continue;
    }

    const currentHash = sha256Text(await readFile(quarantine, "utf8"));
    const provenInstalled = file.installed || currentHash === file.stagedHash;
    if (!provenInstalled || currentHash !== file.stagedHash) {
      try {
        await moveFileNoClobber(quarantine, target);
      } catch (restoreError) {
        if ((restoreError as NodeJS.ErrnoException).code === "EEXIST") {
          fullyRecovered = false;
          continue;
        }
        throw restoreError;
      }
      fullyRecovered = false;
      continue;
    }

    if (file.hadOriginal) {
      try {
        await moveFileNoClobber(backup, target);
      } catch (restoreError) {
        if ((restoreError as NodeJS.ErrnoException).code === "EEXIST") {
          fullyRecovered = false;
          continue;
        }
        if ((restoreError as NodeJS.ErrnoException).code !== "ENOENT") throw restoreError;
        try {
          await moveFileNoClobber(quarantine, target);
        } catch (quarantineError) {
          if ((quarantineError as NodeJS.ErrnoException).code !== "EEXIST") throw quarantineError;
        }
        fullyRecovered = false;
        continue;
      }
    }
    await rm(quarantine, { force: true });
  }
  return fullyRecovered;
}

export class FileTransaction {
  private readonly transactionRoot: string;
  private readonly staged = new Map<string, string>();

  private constructor(private readonly options: FileTransactionOptions) {
    this.transactionRoot = resolveWithin(options.workRoot, ".jizuo", "transactions", options.id);
  }

  static async begin(options: FileTransactionOptions): Promise<FileTransaction> {
    TransactionManifest.shape.id.parse(options.id);
    const transaction = new FileTransaction(options);
    await mkdir(resolveWithin(transaction.transactionRoot, "stage"), { recursive: true });
    await mkdir(resolveWithin(transaction.transactionRoot, "backup"), { recursive: true });
    return transaction;
  }

  async stage(relativePath: string, content: string): Promise<void> {
    const target = resolveWithin(this.transactionRoot, "stage", relativePath);
    resolveWithin(this.options.workRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    this.staged.set(relativePath, content);
  }

  async commit(): Promise<void> {
    if (this.staged.size === 0) throw new Error("transaction has no staged files");
    const files: TransactionFile[] = [];
    for (const [relativePath, stagedContent] of this.staged) {
      const target = resolveWithin(this.options.workRoot, relativePath);
      this.options.assertActive?.();
      const hadOriginal = await exists(target);
      this.options.assertActive?.();
      if (hadOriginal) {
        const original = await readFile(target, "utf8");
        this.options.assertActive?.();
        await preserveRevision(this.options.workRoot, relativePath, original, (destination) => {
          this.options.assertActive?.();
          this.options.beforePreserveRevision?.(destination);
        });
      }
      files.push({ relativePath, hadOriginal, stagedHash: sha256Text(stagedContent), installed: false });
    }

    let manifest: TransactionManifest = {
      schemaVersion: 1,
      id: this.options.id,
      state: "prepared",
      files,
    };
    await writeManifest(this.transactionRoot, manifest);
    manifest = { ...manifest, state: "committing" };
    await writeManifest(this.transactionRoot, manifest);

    try {
      for (const file of files) {
        if (!file.hadOriginal) continue;
        const target = resolveWithin(this.options.workRoot, file.relativePath);
        const backup = resolveWithin(this.transactionRoot, "backup", file.relativePath);
        await mkdir(dirname(backup), { recursive: true });
        this.options.assertActive?.();
        await rename(target, backup);
      }
      for (const [index, file] of files.entries()) {
        const target = resolveWithin(this.options.workRoot, file.relativePath);
        const backup = resolveWithin(this.transactionRoot, "backup", file.relativePath);
        await this.options.beforeInstall?.(file.relativePath, index, {
          readOriginal: async () => (
            file.hadOriginal && await exists(backup) ? readFile(backup, "utf8") : undefined
          ),
          targetExists: async () => exists(target),
        });
        const staged = resolveWithin(this.transactionRoot, "stage", file.relativePath);
        await moveFileNoClobber(staged, target, this.options.assertActive);
        files[index] = { ...file, installed: true };
        manifest = { ...manifest, files: [...files] };
        await writeManifest(this.transactionRoot, manifest);
      }
      manifest = { ...manifest, state: "committed" };
      await writeManifest(this.transactionRoot, manifest);
    } catch (error) {
      if (await recoverCommittingTransaction(this.options.workRoot, this.transactionRoot, files)) {
        await rm(this.transactionRoot, { recursive: true, force: true });
      }
      throw error;
    }

    await rm(this.transactionRoot, { recursive: true, force: true });
  }

  async rollback(): Promise<void> {
    const manifestPath = resolveWithin(this.transactionRoot, "manifest.json");
    if (await exists(manifestPath)) {
      const manifest = TransactionManifest.parse(JSON.parse(await readFile(manifestPath, "utf8")));
      if (manifest.state === "committing") {
        if (!(await recoverCommittingTransaction(
          this.options.workRoot,
          this.transactionRoot,
          manifest.files,
        ))) return;
      }
    }
    await rm(this.transactionRoot, { recursive: true, force: true });
  }
}

export async function recoverTransactions(workRoot: string): Promise<string[]> {
  const transactionsRoot = resolveWithin(workRoot, ".jizuo", "transactions");
  await mkdir(transactionsRoot, { recursive: true });
  const recovered: string[] = [];
  for (const entry of await readdir(transactionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const transactionRoot = resolveWithin(transactionsRoot, entry.name);
    try {
      const manifest = TransactionManifest.parse(
        JSON.parse(await readFile(resolveWithin(transactionRoot, "manifest.json"), "utf8")),
      );
      if (manifest.state === "committing") {
        if (!(await recoverCommittingTransaction(workRoot, transactionRoot, manifest.files))) continue;
        recovered.push(manifest.id);
      }
      await rm(transactionRoot, { recursive: true, force: true });
    } catch {
      // Unknown transaction folders are retained for diagnostics instead of being destroyed.
    }
  }
  return recovered;
}
