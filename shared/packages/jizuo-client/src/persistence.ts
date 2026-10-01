import type { ChapterTarget } from "@jizuo/contracts";

export const DRAFT_STORAGE_PREFIX = "jizuo/drafts/v1";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PersistedDraft {
  content: string;
  revisionToken: string;
}

export interface DraftPersistence {
  load(target: ChapterTarget): PersistedDraft | null;
  save(target: ChapterTarget, draft: PersistedDraft): boolean;
  clear(target: ChapterTarget): boolean;
}

function keyOf(target: ChapterTarget): string {
  return [
    DRAFT_STORAGE_PREFIX,
    target.workId,
    target.volumeId,
    target.chapterId,
  ].join("/");
}

export function browserStorage(): KeyValueStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function createDraftPersistence(
  storage: KeyValueStorage | undefined = browserStorage(),
): DraftPersistence {
  return {
    load(target) {
      if (storage === undefined) return null;
      try {
        const raw = storage.getItem(keyOf(target));
        if (raw === null) return null;
        const parsed = JSON.parse(raw) as Partial<PersistedDraft>;
        if (typeof parsed.content !== "string" || typeof parsed.revisionToken !== "string") return null;
        return { content: parsed.content, revisionToken: parsed.revisionToken };
      } catch {
        return null;
      }
    },
    save(target, draft) {
      if (storage === undefined) return false;
      try {
        storage.setItem(keyOf(target), JSON.stringify(draft));
        return true;
      } catch {
        return false;
      }
    },
    clear(target) {
      if (storage === undefined) return false;
      try {
        storage.removeItem(keyOf(target));
        return true;
      } catch {
        return false;
      }
    },
  };
}
