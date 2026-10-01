import { readFile, writeFile } from "node:fs/promises";

import { StableId } from "@jizuo/contracts";
import { parse, stringify } from "yaml";
import { z } from "zod";

export const WorkFile = z.object({
  schema_version: z.literal(1),
  id: StableId,
  title: z.string().min(1),
  project_kind: z.enum(["novel", "video"]).optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type WorkFile = z.infer<typeof WorkFile>;

export async function readWorkFile(path: string): Promise<WorkFile> {
  return WorkFile.parse(parse(await readFile(path, "utf8")));
}

export async function createWorkFile(path: string, value: WorkFile): Promise<void> {
  await writeFile(path, stringify(value, { lineWidth: 0 }), { encoding: "utf8", flag: "wx" });
}
