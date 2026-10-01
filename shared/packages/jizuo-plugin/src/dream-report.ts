import { MemoryRepository, classifyDreamChapter, type DreamChapterProgress } from "@jizuo/memory-domain";
import type { ChapterDocument } from "@jizuo/contracts";
import type { JizuoService } from "./service.ts";
import { DREAM_CHUNK_CHARS, dreamCheckpointPath, readDreamCheckpoint, readDreamFailure } from "./dream-checkpoint.ts";
import { DREAM_RETRY_DELAY_MS } from "./dream-errors.ts";

export interface DreamChapterSnapshot { document: ChapterDocument; progress: DreamChapterProgress; failureScope?: "chapter" | "work" }
export async function readDreamChapterSnapshot(service: JizuoService, workId: string): Promise<DreamChapterSnapshot[]> {
  const { path } = await service.resolveWorkPath(workId);
  const repository = new MemoryRepository({ workRoot: path });
  const index = await repository.getChapterMemoryIndex(workId);
  const rows: DreamChapterSnapshot[] = [];
  for (const volume of await service.listVolumes(workId)) {
    for (const summary of await service.listChapters({ workId, volumeId: volume.id })) {
      const document = await service.readChapter({ workId, volumeId: volume.id, chapterId: summary.id });
      const coverage = index.get(document.id);
      const key = repository.episodeKey(document.id, document.revisionToken);
      const checkpointPath = dreamCheckpointPath(path, document.id, document.revisionToken);
      let checkpoint = null;
      const failure = await readDreamFailure(checkpointPath);
      let lastError = failure?.message;
      try { checkpoint = await readDreamCheckpoint(checkpointPath, document.content.length); }
      catch (error) { lastError = error instanceof Error ? error.message : "梦境进度无法读取"; }
      const classified = classifyDreamChapter({ hasFormalMemory: (coverage?.formalEpisodeKeys.size ?? 0) > 0,
        formalRevisionMatches: coverage?.formalEpisodeKeys.has(key) ?? false,
        source: !document.content.trim() ? "empty" : document.liveDraft !== undefined ? "editing" : "saved",
        attempt: coverage?.attempts.get(key) ?? (lastError ? "failed" : checkpoint && checkpoint.offset > 0 ? "partial" : "none") });
      const state = classified === "failed" && failure?.capacityState ? (failure.capacityState === "exceeded" ? "capacity_exceeded" : "capacity_unknown") : classified;
      const wholeChapter = !checkpoint || checkpoint.version === 3;
      const finished = ["graphed", "awaiting_review", "rejected", "no_facts"].includes(state);
      const processedChars = finished ? document.content.length : checkpoint?.offset ?? 0;
      const updatedAt = failure?.updatedAt ?? checkpoint?.updatedAt;
      const segments = checkpoint?.segments ?? [];
      const unknownEnd = segments[0]?.from ?? checkpoint?.offset ?? 0;
      const modelSegments = [...(unknownEnd > 0 ? [{ from: 0, to: unknownEnd }] : []), ...segments];
      rows.push({ document, ...(failure?.scope ? { failureScope: failure.scope } : {}), progress: { volumeId: volume.id, volumeTitle: volume.title, chapterId: document.id, chapterTitle: document.title,
        chapterNumber: document.order, ...(wholeChapter ? { processingMode: "chapter" as const } : {}), state, processedChars, totalChars: document.content.length,
        completedParts: wholeChapter ? (processedChars === document.content.length && processedChars > 0 ? 1 : 0) : Math.ceil(processedChars / DREAM_CHUNK_CHARS), totalParts: wholeChapter ? 1 : Math.ceil(document.content.length / DREAM_CHUNK_CHARS),
        ...(modelSegments.length ? { modelSegments } : {}),
        ...(updatedAt ? { updatedAt } : {}), ...(["failed", "capacity_exceeded", "capacity_unknown"].includes(state) && lastError ? { lastError } : {}),
        ...(["failed", "capacity_exceeded", "capacity_unknown"].includes(state) && failure?.scope === "work" ? { nextRetryAt: failure.retryAt ?? new Date(Date.parse(failure.updatedAt) + DREAM_RETRY_DELAY_MS).toISOString() } : {}) } });
    }
  }
  return rows;
}
