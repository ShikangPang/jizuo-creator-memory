import { withMemoryLock } from "./lock.ts";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import { resolveWithin } from "@jizuo/work-domain";
import { parse, stringify } from "yaml";

import { DailyTokenBudget, type BudgetSnapshot } from "./budget.ts";
import { MemoryRepository } from "./repository.ts";
import {
  DreamSettingsSchema,
  type DreamSettings,
  type EpisodeCommitResult,
  type MemoryEpisodeCandidate,
} from "./types.ts";

export class DreamSettingsRepository {
  constructor(private readonly workRoot: string) {}

  async get(): Promise<DreamSettings> {
    try {
      return DreamSettingsSchema.parse(parse(await readFile(this.path(), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { enabled: false, dailyTokenLimit: 20_000, paused: false };
    }
  }

  async set(rawSettings: DreamSettings): Promise<DreamSettings> {
    return withMemoryLock(`${this.workRoot}:dream-settings`, async () => {
      const settings = DreamSettingsSchema.parse(rawSettings);
      const path = this.path();
      await mkdir(resolveWithin(this.workRoot, "memory", "dream"), { recursive: true });
      const temporary = `${path}.next`;
      await writeFile(temporary, stringify(settings, { lineWidth: 0 }), "utf8");
      await rename(temporary, path);
      return settings;
    });
  }

  private path(): string {
    return resolveWithin(this.workRoot, "memory", "dream", "settings.yaml");
  }
}

export interface DreamChapter {
  workId: string;
  chapterId: string;
  chapterNumber: number;
  content: string;
  contentHash: string;
}

export interface DreamExtractor {
  extract(input: DreamChapter & { maxContextChars: number }): Promise<{
    candidate: MemoryEpisodeCandidate;
    usage: { totalTokens: number };
  }>;
}

export interface DreamRunResult extends Partial<Omit<EpisodeCommitResult, "status">> {
  status: "disabled" | "paused" | "paused_budget" | "committed" | "suggested" | "empty";
}

export class DreamSupervisor {
  private readonly repository: MemoryRepository;
  private readonly budget: DailyTokenBudget;
  private readonly queue: DreamChapter[] = [];
  private readonly queuedKeys = new Set<string>();
  private readonly now: () => Date;
  private readonly reservationTokens: number;
  private readonly maxContextChars: number;
  private readonly settings: DreamSettingsRepository;

  constructor(private readonly options: {
    workRoot: string;
    extractor: DreamExtractor;
    repository?: MemoryRepository;
    now?: () => Date;
    reservationTokens?: number;
    maxContextChars?: number;
  }) {
    this.repository = options.repository ?? new MemoryRepository({ workRoot: options.workRoot });
    this.settings = new DreamSettingsRepository(options.workRoot);
    this.now = options.now ?? (() => new Date());
    this.budget = new DailyTokenBudget(options.workRoot, this.now);
    this.reservationTokens = options.reservationTokens ?? 4_000;
    this.maxContextChars = options.maxContextChars ?? 12_000;
  }

  async getSettings(): Promise<DreamSettings> {
    return this.settings.get();
  }

  async setSettings(rawSettings: DreamSettings): Promise<DreamSettings> {
    return this.settings.set(rawSettings);
  }

  async discover(chapters: DreamChapter[]): Promise<number> {
    let added = 0;
    const index = await this.repository.getChapterMemoryIndex();
    for (const chapter of chapters.sort((left, right) => left.chapterNumber - right.chapterNumber)) {
      const key = this.repository.episodeKey(chapter.chapterId, chapter.contentHash);
      const coverage = index.get(chapter.chapterId);
      if (!chapter.content.trim() || this.queuedKeys.has(key) || (coverage?.formalEpisodeKeys.size ?? 0) > 0 || coverage?.attempts.has(key)) continue;
      this.queue.push(chapter);
      this.queuedKeys.add(key);
      added += 1;
    }
    return added;
  }

  async runNext(): Promise<DreamRunResult> {
    const settings = await this.getSettings();
    if (!settings.enabled) return { status: "disabled" };
    if (settings.paused) return { status: "paused" };
    const chapter = this.queue[0];
    if (chapter === undefined) return { status: "empty" };
    const coverage = (await this.repository.getChapterMemoryIndex(chapter.workId)).get(chapter.chapterId);
    if ((coverage?.formalEpisodeKeys.size ?? 0) > 0 || coverage?.attempts.has(this.repository.episodeKey(chapter.chapterId, chapter.contentHash))) {
      this.queue.shift(); this.queuedKeys.delete(this.repository.episodeKey(chapter.chapterId, chapter.contentHash));
      return this.runNext();
    }
    if (!await this.budget.reserve(this.reservationTokens, settings.dailyTokenLimit)) {
      return { status: "paused_budget" };
    }
    let actualTokens = 0;
    try {
      const extracted = await this.options.extractor.extract({
        ...chapter,
        content: chapter.content.slice(-this.maxContextChars),
        maxContextChars: this.maxContextChars,
      });
      actualTokens = extracted.usage.totalTokens;
      const result = await this.repository.commitDreamEpisodeIfUncovered(extracted.candidate);
      this.queue.shift();
      this.queuedKeys.delete(this.repository.episodeKey(chapter.chapterId, chapter.contentHash));
      return (result.status === "skipped_graph_present" || result.status === "skipped_already_processed") ? { status: "empty" } : result;
    } finally {
      await this.budget.settle(this.reservationTokens, actualTokens);
    }
  }

  async pause(): Promise<DreamSettings> {
    return this.setSettings({ ...await this.getSettings(), paused: true });
  }

  async resume(): Promise<DreamSettings> {
    return this.setSettings({ ...await this.getSettings(), paused: false });
  }

  async acceptSuggestion(episodeKey: string) {
    return this.repository.acceptSuggestion(episodeKey);
  }

  async rejectSuggestion(episodeKey: string) {
    return this.repository.rejectSuggestion(episodeKey);
  }

  async getBudget(): Promise<BudgetSnapshot> {
    return this.budget.get();
  }
}
