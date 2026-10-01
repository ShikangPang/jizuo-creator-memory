import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DreamModelSelectionSchema } from "@jizuo/memory-domain";
import { DreamExtractionSchema } from "./dream-model.ts";

export const DREAM_CHUNK_CHARS = 2000;
export const DREAM_OVERLAP_CHARS = 160;
export const DreamCheckpointSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]), offset: z.number().int().nonnegative(), output: DreamExtractionSchema,
  updatedAt: z.string().datetime().optional(),
  segments: z.array(z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), modelSelection: DreamModelSelectionSchema, completedAt: z.string().datetime() })).default([]),
});
export type DreamCheckpoint = z.infer<typeof DreamCheckpointSchema>;
export class DreamCheckpointError extends Error {}
export function dreamCheckpointPath(workRoot: string, chapterId: string, revision: string): string {
  return join(workRoot, "memory", "dream", "runs", `${chapterId}-${revision}.json`);
}
export async function readDreamCheckpoint(path: string, totalChars: number): Promise<DreamCheckpoint | null> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const value = DreamCheckpointSchema.parse(JSON.parse(text));
    if (value.offset > totalChars || (value.version === 3 && value.offset !== totalChars)) throw new Error("offset");
    return value;
  } catch { throw new DreamCheckpointError("梦境进度文件损坏或与正文不一致，请检查作品目录。"); }
}
export async function writeDreamJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.next`, JSON.stringify(value), "utf8");
  await rename(`${path}.next`, path);
}
const FailureSchema = z.object({ message: z.string(), updatedAt: z.string().datetime(), retryAt: z.string().datetime().optional(), scope: z.enum(["chapter", "work"]).optional(), capacityState: z.enum(["exceeded", "unknown"]).optional() });
export async function readDreamFailure(path: string): Promise<z.infer<typeof FailureSchema> | null> {
  try { return FailureSchema.parse(JSON.parse(await readFile(`${path}.failure`, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return { message: "梦境失败记录无法读取，请检查作品目录。", updatedAt: new Date(0).toISOString() }; }
}
