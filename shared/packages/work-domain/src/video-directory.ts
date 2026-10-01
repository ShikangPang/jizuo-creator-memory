import { lstat, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { JizuoError } from "@jizuo/contracts";

export const visibleVideoPath = (path: string) => path.startsWith(".jizuo/video/") ? path.slice(".jizuo/".length) : path;
const info = async (path: string) => {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};
/** Rename the complete directory so assets, snapshots and project state move together. */
const migrations = new Map<string, Promise<void>>();
export async function ensureVideoDirectory(root: string): Promise<void> {
  const pending = migrations.get(root);
  if (pending) return pending;
  const operation = migrate(root);
  migrations.set(root, operation);
  try { await operation; } finally { if (migrations.get(root) === operation) migrations.delete(root); }
}

async function migrate(root: string): Promise<void> {
  const legacyParent = join(root, ".jizuo"), legacy = join(legacyParent, "video"), destination = join(root, "video");
  if ((await info(legacyParent))?.isSymbolicLink()) throw new JizuoError("validation_error", "作品内部目录不能为符号链接");
  const [old, current] = await Promise.all([info(legacy), info(destination)]);
  if (old?.isSymbolicLink() || current?.isSymbolicLink()) throw new JizuoError("validation_error", "视频目录不能为符号链接");
  if (old && !old.isDirectory() || current && !current.isDirectory()) throw new JizuoError("validation_error", "视频路径不是文件夹");
  if (old) {
    if (current && await info(legacy)) throw new JizuoError("validation_error", "作品同时存在 video 和旧视频目录，请先核对目录，避免覆盖已有文件");
    if (await info(join(legacy, "write.lock"))) {
      let dead = false;
      try {
        const lock = join(legacy, "write.lock"), ownerFile = join(lock, "owner.json");
        if ((await info(lock))?.isSymbolicLink() || (await info(ownerFile))?.isSymbolicLink()) throw new Error("Invalid lock");
        const owner = JSON.parse(await readFile(ownerFile, "utf8"));
        if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
        }
      } catch { /* Unknown ownership is not proof that the old writer stopped. */ }
      if (!dead) throw new JizuoError("validation_error", "旧视频目录正在使用，请关闭旧版应用后重试迁移");
    }
    try { await rename(legacy, destination); }
    catch (error) {
      // Another reader may have completed the same atomic rename.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !(await info(destination))?.isDirectory()) throw error;
    }
  } else if (!current) await mkdir(destination, {recursive:true,mode:0o700});
}
