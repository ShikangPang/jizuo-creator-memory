import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { resolveWithin } from "./paths.ts";

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function preserveRevision(
  workRoot: string,
  relativePath: string,
  content: string,
  beforeAccess?: (absolutePath: string) => void,
): Promise<string> {
  const revision = sha256Text(content);
  const target = resolveWithin(workRoot, ".jizuo", "revisions", revision, relativePath);
  beforeAccess?.(target);
  await mkdir(dirname(target), { recursive: true });
  beforeAccess?.(target);
  try {
    await writeFile(target, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    beforeAccess?.(target);
    if (await readFile(target, "utf8") !== content) {
      throw new Error(`revision hash collision for ${relativePath}`);
    }
  }
  return revision;
}
