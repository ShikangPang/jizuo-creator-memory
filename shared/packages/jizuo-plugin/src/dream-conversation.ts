import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DreamModelConversationSchema, type DreamModelConversation } from "@jizuo/memory-domain";
import { writeDreamJson } from "./dream-checkpoint.ts";
import type { DreamModelDetail } from "./dream-model.ts";

/** One file per request, separate from extracted memory and its acceptance rules. */
export class DreamConversationRecorder {
  readonly value: DreamModelConversation;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = Promise.resolve();
  private writeError: unknown;
  constructor(readonly directory: string, initial: Pick<DreamModelConversation, "part" | "from" | "to" | "modelSelection"> & { content: string }, private readonly now: () => Date, private readonly currentDirectory?: () => Promise<string | null>) {
    const { content, ...segment } = initial;
    const at = now().toISOString();
    this.value = { ...segment, id: randomUUID(), startedAt: at, updatedAt: at, state: "running", request: { content, system: "" }, output: "", reasoning: "" };
  }
  detail(detail: DreamModelDetail): void {
    if (this.value.state !== "running") return;
    if (detail.type === "request") this.value.request = { system: detail.system, content: detail.content, maxOutputTokens: detail.maxOutputTokens };
    else { this.value.output = detail.text; this.value.reasoning = detail.reasoning; }
    this.changed();
  }
  usage(tokens: number): void { this.value.usedTokens = tokens; this.changed(); }
  private changed(): void {
    this.value.updatedAt = this.now().toISOString();
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.enqueue(); }, 1000);
      this.timer.unref?.();
    }
  }
  private enqueue(): void {
    const value = structuredClone(this.value);
    this.pending = this.pending.then(async () => {
      const directory = this.currentDirectory ? await this.currentDirectory() : this.directory;
      if (directory) await writeDreamJson(join(directory, `${value.id}.json`), value);
    })
      .then(() => { this.writeError = undefined; }, (error: unknown) => { this.writeError = error; });
  }
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    this.enqueue(); await this.pending;
    if (this.writeError) throw this.writeError;
  }
  async finish(state: "completed" | "failed" | "cancelled", error?: string): Promise<void> {
    this.value.state = state; this.value.updatedAt = this.now().toISOString(); this.value.finishedAt = this.value.updatedAt;
    if (error) this.value.error = error;
    await this.flush();
  }
}

export async function readDreamConversations(directory: string, live?: DreamModelConversation): Promise<DreamModelConversation[]> {
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return live ? [structuredClone(live)] : []; throw error; }
  const records = await Promise.all(files.filter((file) => /^[\da-f-]{36}\.json$/i.test(file)).map(async (file) => DreamModelConversationSchema.parse(JSON.parse(await readFile(join(directory, file), "utf8")))));
  const result = records.filter((record) => record.id !== live?.id).map((record) => record.state === "running" ? { ...record, state: "interrupted" as const } : record);
  if (live) result.push(structuredClone(live));
  return result.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.part - b.part);
}
