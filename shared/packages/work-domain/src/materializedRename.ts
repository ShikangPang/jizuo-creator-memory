import { randomUUID } from "node:crypto";
import { access, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { JizuoError } from "@jizuo/contracts";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function renameMaterializedDirectory(input: {
  currentRoot: string;
  nextRoot: string;
  metadataName: string;
  serializedMetadata: string;
}): Promise<void> {
  if (input.currentRoot !== input.nextRoot && await exists(input.nextRoot)) {
    throw new JizuoError("revision_conflict", "同名目录已存在，无法重命名");
  }

  const temporaryName = `.jizuo-rename-${randomUUID()}.tmp`;
  const temporaryPath = join(input.currentRoot, temporaryName);
  await writeFile(temporaryPath, input.serializedMetadata, { encoding: "utf8", flag: "wx" });
  let moved = false;
  try {
    if (input.currentRoot !== input.nextRoot) {
      await rename(input.currentRoot, input.nextRoot);
      moved = true;
    }
    await rename(join(input.nextRoot, temporaryName), join(input.nextRoot, input.metadataName));
  } catch (error) {
    if (moved) {
      try {
        await rename(input.nextRoot, input.currentRoot);
      } catch {
        throw new JizuoError("transaction_recovery_required", "重命名中断，需要人工恢复目录", {
          currentRoot: input.currentRoot,
          nextRoot: input.nextRoot,
        });
      }
    }
    await rm(join(input.currentRoot, temporaryName), { force: true });
    throw error;
  }
}
