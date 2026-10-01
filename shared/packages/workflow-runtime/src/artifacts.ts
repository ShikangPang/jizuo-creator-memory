import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { type WorkflowArtifactHandle, type WorkflowArtifactKind, type WorkflowArtifactRecord, WorkflowRepository } from "./repository.ts";

export interface WriteWorkflowArtifactInput {
  readonly runId: string;
  readonly kind: WorkflowArtifactKind;
  readonly contents: string | Uint8Array;
}

type ArtifactCommit = (input: {
  artifactRef: string;
  runId: string;
  kind: WorkflowArtifactKind;
  relativePath: string;
  sha256: string;
  byteSize: number;
}) => WorkflowArtifactRecord;

/** File-backed large payload store. Callers can supply bytes and kind, never a filename. */
export class WorkflowArtifactStore {
  readonly #root: string;
  readonly #repository: WorkflowRepository;
  readonly #commit: ArtifactCommit;

  public constructor(root: string, repository: WorkflowRepository, commit: ArtifactCommit) {
    this.#root = root;
    this.#repository = repository;
    this.#commit = commit;
  }

  async write(input: WriteWorkflowArtifactInput): Promise<WorkflowArtifactHandle> {
    const bytes = typeof input.contents === "string" ? Buffer.from(input.contents, "utf8") : Buffer.from(input.contents);
    const artifactRef = `runs/${input.runId}/${input.kind}/${randomUUID()}.json`;
    const destination = this.resolveRelativePath(artifactRef);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx");
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, destination);
      // Windows cannot open directories through Node's ordinary file API.
      // Keep the file fsync and atomic rename on every platform; directory
      // fsync is an additional durability barrier on POSIX only.
      if (process.platform !== "win32") {
        const directory = await open(dirname(destination), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      const record = this.#commit({
        artifactRef,
        runId: input.runId,
        kind: input.kind,
        relativePath: artifactRef,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.byteLength,
      });
      return { artifactRef: record.artifactRef, sha256: record.sha256, byteSize: record.byteSize };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async read(artifactRef: string): Promise<Buffer> {
    const artifact = this.#repository.getArtifact(artifactRef);
    if (!artifact) throw new Error(`Unknown workflow artifact: ${artifactRef}`);
    if (artifact.status !== "ready") throw new Error(`Workflow artifact is not readable: ${artifactRef}`);
    try {
      const bytes = await readFile(this.resolveRelativePath(artifact.relativePath));
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== artifact.byteSize || digest !== artifact.sha256) throw new Error("artifact-integrity-mismatch");
      return bytes;
    } catch (error) {
      this.#repository.quarantineArtifact(artifactRef, error instanceof Error ? error.message : "artifact-read-failed");
      throw new Error(`Artifact integrity verification failed: ${artifactRef}`, { cause: error });
    }
  }

  resolveRelativePath(relativePath: string): string {
    if (typeof relativePath !== "string" || relativePath.length === 0 || isAbsolute(relativePath)) throw new Error("Invalid relative artifact path");
    const root = resolve(this.#root);
    const candidate = resolve(root, relativePath);
    const pathFromRoot = relative(root, candidate);
    if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
      throw new Error("Invalid relative artifact path");
    }
    return candidate;
  }
}
