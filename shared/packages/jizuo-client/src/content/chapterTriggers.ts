import type { ChapterSummary, VolumeSummary, WorkSummary } from "@jizuo/contracts";
import type {
  InputTriggerCandidate,
  InputTriggerSource,
  ReferenceInsert,
} from "@deepseek-ai/dsh-client-ui-input-trigger/client";

import type { JizuoContentRemote } from "./remote.ts";
import { getSelection, subscribeSelection } from "./selection.ts";

export type ChapterTriggerCandidate = InputTriggerCandidate;
export type ChapterTriggerSource = InputTriggerSource & {
  readonly codec: NonNullable<InputTriggerSource["codec"]>;
};

export interface ChapterTriggerService {
  registerSource(source: ChapterTriggerSource): () => void;
}

interface ChapterReference {
  readonly work: WorkSummary;
  readonly volume: VolumeSummary;
  readonly chapter: ChapterSummary;
}

export interface ChapterExcerptReferenceInput {
  readonly target: {
    readonly workId: string;
    readonly volumeId: string;
    readonly chapterId: string;
  };
  readonly chapterTitle: string;
  readonly text: string;
}

export interface EncodedChapterExcerpt {
  readonly workId: string;
  readonly volumeId: string;
  readonly chapterId: string;
  readonly chapterTitle: string;
  readonly text: string;
}

const CURRENT_REF = "current";
const SOURCE_NAME = "jizuo";
const EXCERPT_PREFIX = "excerpt:";

function encodeExcerpt(input: ChapterExcerptReferenceInput): string {
  return `${EXCERPT_PREFIX}${encodeURIComponent(JSON.stringify({
    ...input.target,
    chapterTitle: input.chapterTitle,
    text: input.text,
  }))}`;
}

export function decodeChapterExcerptReference(ref: string): EncodedChapterExcerpt | null {
  if (!ref.startsWith(EXCERPT_PREFIX)) return null;
  try {
    const value = JSON.parse(decodeURIComponent(ref.slice(EXCERPT_PREFIX.length))) as Partial<EncodedChapterExcerpt>;
    if (typeof value.workId !== "string"
      || typeof value.volumeId !== "string"
      || typeof value.chapterId !== "string"
      || typeof value.chapterTitle !== "string"
      || typeof value.text !== "string") return null;
    return value as EncodedChapterExcerpt;
  } catch {
    return null;
  }
}

function excerptClipboardText(excerpt: Pick<EncodedChapterExcerpt, "chapterTitle" | "text">): string {
  return [
    `引用《${excerpt.chapterTitle}》选段：`,
    ...excerpt.text.split(/\r?\n/).map((line) => `> ${line}`),
  ].join("\n");
}

function serializeExcerpt(excerpt: EncodedChapterExcerpt): string {
  return [
    "[即作章节选段]",
    `workId: ${excerpt.workId}`,
    `volumeId: ${excerpt.volumeId}`,
    `chapterId: ${excerpt.chapterId}`,
    `title: ${excerpt.chapterTitle}`,
    "选段：",
    ...excerpt.text.split(/\r?\n/).map((line) => `> ${line}`),
    "请优先围绕该选段回答；需要上下文时再通过即作工具读取完整章节。",
    "[/即作章节选段]",
  ].join("\n");
}

export function createChapterExcerptReference(
  input: ChapterExcerptReferenceInput,
): ReferenceInsert {
  const label = `${input.chapterTitle} · 选段`;
  return {
    source: SOURCE_NAME,
    ref: encodeExcerpt(input),
    label,
    appearance: "file",
    clipboardText: excerptClipboardText({ chapterTitle: input.chapterTitle, text: input.text }),
  };
}

function referenceId(reference: ChapterReference): string {
  return `${reference.work.id}/${reference.volume.id}/${reference.chapter.id}`;
}

function selectedReferenceId(): string | null {
  const selection = getSelection();
  if (selection.workId === null || selection.volumeId === null || selection.chapterId === null) {
    return null;
  }
  return `${selection.workId}/${selection.volumeId}/${selection.chapterId}`;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function matchesQuery(reference: ChapterReference, query: string): boolean {
  if (query === "") return true;
  const haystack = [
    reference.chapter.title,
    reference.volume.title,
    reference.work.title,
    reference.chapter.id,
    reference.volume.id,
    reference.work.id,
  ].join("\n").toLocaleLowerCase();
  return haystack.includes(query.toLocaleLowerCase());
}

async function loadReferences(
  remote: JizuoContentRemote,
  signal: AbortSignal,
): Promise<ChapterReference[]> {
  assertNotAborted(signal);
  const works = await remote.listWorks();
  const references: ChapterReference[] = [];
  for (const work of works) {
    assertNotAborted(signal);
    const volumes = await remote.listVolumes({ workId: work.id });
    for (const volume of volumes) {
      assertNotAborted(signal);
      const chapters = await remote.listChapters({ workId: work.id, volumeId: volume.id });
      for (const chapter of chapters) references.push({ work, volume, chapter });
    }
  }
  assertNotAborted(signal);
  return references;
}

function serializeReference(reference: ChapterReference): string {
  return [
    "[即作当前章节]",
    `workId: ${reference.work.id}`,
    `volumeId: ${reference.volume.id}`,
    `chapterId: ${reference.chapter.id}`,
    `title: ${reference.chapter.title}`,
    "请通过即作工具读取章节；未经用户确认，不要覆盖正文。",
  ].join("\n");
}

export function createChapterTriggerSource(remote: JizuoContentRemote): ChapterTriggerSource {
  let cachedReferences: readonly ChapterReference[] = [];

  const findReference = async (ref: string, signal: AbortSignal): Promise<ChapterReference | null> => {
    const resolved = ref === CURRENT_REF ? selectedReferenceId() : ref;
    if (resolved === null) return null;
    const references = await loadReferences(remote, signal);
    cachedReferences = references;
    return references.find((reference) => referenceId(reference) === resolved) ?? null;
  };

  const labelFor = (ref: string): string => {
    if (ref === CURRENT_REF) return "当前章节";
    const excerpt = decodeChapterExcerptReference(ref);
    if (excerpt !== null) return `${excerpt.chapterTitle} · 选段`;
    return cachedReferences.find((reference) => referenceId(reference) === ref)?.chapter.title ?? "章节";
  };

  return {
    trigger: "@",
    name: SOURCE_NAME,
    order: 30,
    showGroupTitle: true,
    async candidates(_session, { query, signal }) {
      const references = await loadReferences(remote, signal);
      cachedReferences = references;
      const candidates: InputTriggerCandidate[] = [];
      const currentId = selectedReferenceId();
      if (currentId !== null && (query === "" || "当前章节".includes(query))) {
        const current = references.find((reference) => referenceId(reference) === currentId);
        candidates.push({
          name: "当前章节",
          description: current === undefined
            ? currentId
            : `${current.work.title} / ${current.volume.title} / ${current.chapter.title}`,
          value: CURRENT_REF,
        });
      }
      for (const reference of references) {
        if (!matchesQuery(reference, query)) continue;
        candidates.push({
          name: reference.chapter.title,
          description: `${reference.work.title} / ${reference.volume.title}`,
          value: referenceId(reference),
        });
      }
      return candidates;
    },
    onPick({ candidate }) {
      const ref = candidate.value;
      if (ref === undefined) return undefined;
      const label = candidate.name;
      return {
        insert: {
          source: SOURCE_NAME,
          ref,
          label,
          clipboardText: `@${label}`,
        },
      };
    },
    lexicon() {
      const names = cachedReferences.map((reference) => reference.chapter.title);
      return selectedReferenceId() === null ? names : ["当前章节", ...names];
    },
    subscribeLexicon(_session, listener) {
      return subscribeSelection(listener);
    },
    codec: {
      clipboardText(ref) {
        const excerpt = decodeChapterExcerptReference(ref);
        if (excerpt !== null) return excerptClipboardText(excerpt);
        return `@${labelFor(ref)}`;
      },
      async serialize(ref, signal) {
        const excerpt = decodeChapterExcerptReference(ref);
        if (excerpt !== null) return serializeExcerpt(excerpt);
        const reference = await findReference(ref, signal);
        if (reference === null) {
          if (ref === CURRENT_REF) return "当前没有打开的章节。请先在左侧作品树中选择章节。";
          throw new Error("引用的章节不存在或已被移动");
        }
        return serializeReference(reference);
      },
    },
  };
}

export function registerChapterTriggers(
  service: ChapterTriggerService | undefined,
  remote: JizuoContentRemote,
): () => void {
  if (service === undefined) return () => undefined;
  return service.registerSource(createChapterTriggerSource(remote));
}
