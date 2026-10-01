import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { JizuoError } from "@jizuo/contracts";
import { z } from "zod";

const StoredWorkLocations = z.object({
  schemaVersion: z.literal(1),
  createRoot: z.string().min(1),
  roots: z.array(z.string().min(1)).min(1),
}).strict();

interface StoredLocations {
  readonly schemaVersion: 1;
  readonly createRoot: string;
  readonly roots: readonly string[];
}

export interface WorkLocationStatus {
  readonly path: string;
  readonly available: boolean;
  readonly reason?: string;
}

export interface WorkLocations extends StoredLocations {
  readonly statuses: readonly WorkLocationStatus[];
  readonly warning?: string;
}

export interface FileWorkLocationRegistryOptions {
  readonly configPath: string;
  readonly defaultRoot: string;
  readonly protectedRoots?: readonly string[];
  readonly platform?: NodeJS.Platform;
}

function errorReason(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

export class FileWorkLocationRegistry {
  readonly configPath: string;
  readonly defaultRoot: string;
  private readonly protectedRoots: readonly string[];
  private readonly platform: NodeJS.Platform;

  constructor(options: FileWorkLocationRegistryOptions) {
    this.configPath = resolve(options.configPath);
    this.defaultRoot = resolve(options.defaultRoot);
    this.protectedRoots = (options.protectedRoots ?? []).map((root) => resolve(root));
    this.platform = options.platform ?? process.platform;
  }

  async read(): Promise<WorkLocations> {
    const stored = await this.readStored();
    const statuses = await Promise.all(stored.value.roots.map((path) => (
      this.statusFor(path, path === stored.value.createRoot)
    )));
    const unavailableHistorical = statuses.some((status) => (
      status.path !== stored.value.createRoot && !status.available
    ));
    const activeUnavailable = statuses.some((status) => (
      status.path === stored.value.createRoot && !status.available
    ));
    const warnings = [
      stored.warning,
      activeUnavailable ? "当前作品存储位置不可用，新建作品将失败。" : undefined,
      unavailableHistorical ? "部分历史作品位置当前不可用，已保留记录并继续加载其他位置。" : undefined,
    ].filter((warning): warning is string => warning !== undefined);
    return {
      ...stored.value,
      statuses,
      ...(warnings.length === 0 ? {} : { warning: warnings.join(" ") }),
    };
  }

  async setCreateRoot(path: string): Promise<WorkLocations> {
    const createRoot = this.validateSelectedPath(path);
    await this.assertWritable(createRoot);
    const stored = await this.readStored();
    const value: StoredLocations = {
      schemaVersion: 1,
      createRoot,
      roots: this.uniquePaths([createRoot, ...stored.value.roots]),
    };
    await this.persist(value);
    return this.read();
  }

  async resetCreateRoot(): Promise<WorkLocations> {
    await this.assertWritable(this.defaultRoot);
    const stored = await this.readStored();
    const value: StoredLocations = {
      schemaVersion: 1,
      createRoot: this.defaultRoot,
      roots: this.uniquePaths([this.defaultRoot, ...stored.value.roots]),
    };
    await this.persist(value);
    return this.read();
  }

  private async readStored(): Promise<{ value: StoredLocations; warning?: string }> {
    const fallback = this.normalizeStored({
      schemaVersion: 1,
      createRoot: this.defaultRoot,
      roots: [this.defaultRoot],
    });
    let source: string;
    try {
      source = await readFile(this.configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: fallback };
      return {
        value: fallback,
        warning: `无法读取作品存储设置，已临时使用默认位置（${errorReason(error)}）。`,
      };
    }
    try {
      return { value: this.normalizeStored(StoredWorkLocations.parse(JSON.parse(source))) };
    } catch {
      return {
        value: fallback,
        warning: "无法读取作品存储设置，已临时使用默认位置；原设置文件未被修改。",
      };
    }
  }

  private normalizeStored(input: StoredLocations): StoredLocations {
    const createRoot = resolve(input.createRoot);
    return {
      schemaVersion: 1,
      createRoot,
      roots: this.uniquePaths([createRoot, ...input.roots.map((root) => resolve(root))]),
    };
  }

  private uniquePaths(paths: readonly string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const path of paths) {
      const normalized = resolve(path);
      const key = this.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
    }
    return result;
  }

  private validateSelectedPath(path: string): string {
    if (typeof path !== "string" || path.trim().length === 0 || !isAbsolute(path)) {
      throw new JizuoError("validation_error", "作品存储位置必须是绝对路径", { path });
    }
    const candidate = resolve(path);
    if (this.protectedRoots.some((root) => isWithin(root, candidate))) {
      throw new JizuoError("validation_error", "不能把即作设置或运行时目录用作作品存储位置", {
        path: candidate,
      });
    }
    return candidate;
  }

  private async statusFor(path: string, writable: boolean): Promise<WorkLocationStatus> {
    try {
      if (writable) await this.probeWritable(path);
      else await readdir(path);
      return { path, available: true };
    } catch (error) {
      return { path, available: false, reason: errorReason(error) };
    }
  }

  private async assertWritable(path: string): Promise<void> {
    try {
      await this.probeWritable(path);
    } catch (error) {
      throw new JizuoError("runtime_unavailable", "所选作品存储位置不可写，请检查文件夹权限", {
        path,
        reason: errorReason(error),
      });
    }
  }

  private async probeWritable(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
    await readdir(path);
    const probe = resolve(path, `.jizuo-write-probe-${randomUUID()}`);
    try {
      await writeFile(probe, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    } finally {
      await rm(probe, { force: true }).catch(() => undefined);
    }
  }

  private async persist(value: StoredLocations): Promise<void> {
    const directory = dirname(this.configPath);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.configPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, this.configPath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
