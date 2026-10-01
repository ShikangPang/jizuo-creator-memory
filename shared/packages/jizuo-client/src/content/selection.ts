import { isWorkspacePluginEnabled } from "../plugins/preferences.ts";
import { WORKSPACE_PLUGINS, pluginForOverlay } from "../plugins/registry.ts";
import { useSyncExternalStore } from "react";

export type JizuoOverlay = typeof WORKSPACE_PLUGINS[number]["overlays"][number] | null;

export type WorkContentMode = Exclude<typeof WORKSPACE_PLUGINS[number]["mode"], null>;

export interface JizuoSelection {
  mode?: WorkContentMode;
  episodeId?: string | null;
  shotId?: string | null;
  designId?: string | null;
  videoSection?: "style" | "media" | "assets" | "storyboard" | "shots" | "editing";
  workId: string | null;
  volumeId: string | null;
  chapterId: string | null;
  /** Display metadata carried by the tree so the inspector need not wait for a second read. */
  chapterTitle?: string | null;
  searchMatch?: { start: number; end: number; revisionToken: string; query: string } | undefined;
  overlay: JizuoOverlay;
}

const EMPTY_SELECTION: JizuoSelection = {
  workId: null,
  volumeId: null,
  chapterId: null,
  overlay: null,
};

let selection: JizuoSelection = { ...EMPTY_SELECTION };
const listeners = new Set<() => void>();

function sameSelection(left: JizuoSelection, right: JizuoSelection): boolean {
  return left.workId === right.workId
    && left.volumeId === right.volumeId
    && left.chapterId === right.chapterId
    && (left.chapterTitle ?? null) === (right.chapterTitle ?? null)
    && (left.mode ?? "novel") === (right.mode ?? "novel")
    && (left.episodeId ?? null) === (right.episodeId ?? null)
    && (left.designId ?? null) === (right.designId ?? null)
    && left.videoSection === right.videoSection
    && (left.shotId ?? null) === (right.shotId ?? null)
    && left.overlay === right.overlay
    && left.searchMatch === right.searchMatch;
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function getSelection(): JizuoSelection {
  return selection;
}

type EpisodePage = "storyboard" | "shots" | "editing";
function isEpisodePage(value: unknown): value is EpisodePage { return value === "storyboard" || value === "shots" || value === "editing"; }
const episodePageKey = (workId: string, episodeId: string) => `jizuo:episode-page:${encodeURIComponent(workId)}:${encodeURIComponent(episodeId)}`;
const workPageKey = (workId: string) => `jizuo:work-video-page:${encodeURIComponent(workId)}`;
export function rememberedEpisodePage(workId: string, episodeId: string): EpisodePage {
  try {
    const recent = window.localStorage.getItem(workPageKey(workId));
    if (isEpisodePage(recent)) return recent;
    const value = window.localStorage.getItem(episodePageKey(workId, episodeId));
    return isEpisodePage(value) ? value : "shots";
  }
  catch { return "shots"; }
}

export function rememberedEpisodeShot(workId: string, episodeId: string): string | undefined {
  try { const id = window.localStorage.getItem(`${episodePageKey(workId, episodeId)}:shot`); return id && id.length <= 256 ? id : undefined; }
  catch { return undefined; }
}

export function setSelection(patch: Partial<JizuoSelection>): void {
  const requestedPlugin = pluginForOverlay(patch.overlay ?? null);
  if (requestedPlugin && !isWorkspacePluginEnabled(patch.workId === undefined ? selection.workId : patch.workId, requestedPlugin.id)) return;
  const workChanged = patch.workId !== undefined && patch.workId !== selection.workId;
  const volumeChanged = patch.volumeId !== undefined && patch.volumeId !== selection.volumeId;
  const chapterChanged = patch.chapterId !== undefined && patch.chapterId !== selection.chapterId;
  const next: JizuoSelection = { ...selection, ...patch };
  if ((workChanged || patch.episodeId !== undefined && patch.episodeId !== selection.episodeId) && patch.shotId === undefined) delete next.shotId;

  if ((workChanged || patch.episodeId !== undefined && patch.episodeId !== selection.episodeId) && patch.videoSection === undefined) delete next.videoSection;
  if ((workChanged || patch.episodeId != null || patch.videoSection && patch.videoSection !== "assets" && patch.videoSection !== "style") && patch.designId === undefined) delete next.designId;
  if (workChanged) {
    if (patch.episodeId === undefined) delete next.episodeId;
    if (patch.mode === undefined) delete next.mode;
    if (patch.volumeId === undefined) next.volumeId = null;
    if (patch.chapterId === undefined) next.chapterId = null;
    if (patch.overlay === undefined) next.overlay = null;
  } else if (volumeChanged) {
    if (patch.chapterId === undefined) next.chapterId = null;
    if (patch.overlay === undefined) next.overlay = null;
  }
  if (next.workId === null) {
    delete next.shotId;
    delete next.designId;
    delete next.episodeId;
    delete next.mode;
    next.volumeId = null;
    next.chapterId = null;
    next.overlay = null;
  } else if (next.volumeId === null) {
    next.chapterId = null;
    if (next.overlay === "chapter" || next.overlay === "volume") next.overlay = null;
  } else if (next.chapterId === null && next.overlay === "chapter") {
    next.overlay = null;
  }
  if (patch.overlay === "chapter" || patch.overlay === "volume") {
    delete next.mode;
    delete next.episodeId;
  } else if (patch.overlay === "video" && next.workId !== null) {
    next.mode = "video";
  }
  if ((workChanged || volumeChanged || chapterChanged) && patch.chapterTitle === undefined) {
    delete next.chapterTitle;
  }
  if ((workChanged || volumeChanged || chapterChanged) && patch.searchMatch === undefined) delete next.searchMatch;
  if (next.chapterId === null) delete next.searchMatch;
  if (next.chapterId === null || next.chapterTitle === null) delete next.chapterTitle;
  if (next.mode !== "video") delete next.videoSection;
  if (next.mode === "video" && next.overlay === "video" && next.workId && next.episodeId) {
    if (patch.videoSection === undefined && (patch.episodeId != null || workChanged || patch.overlay === "video" && selection.overlay !== "video")) {
      next.videoSection = patch.shotId ? "shots" : rememberedEpisodePage(next.workId, next.episodeId);
    }
    if (next.videoSection === "shots") {
      if (patch.shotId === undefined && (patch.episodeId != null || workChanged || patch.videoSection === "shots" || patch.overlay === "video" && selection.overlay !== "video")) {
        next.shotId = rememberedEpisodeShot(next.workId, next.episodeId) ?? null;
      }
      if (next.shotId) { try { window.localStorage.setItem(`${episodePageKey(next.workId, next.episodeId)}:shot`, next.shotId); } catch { /* Optional local preference. */ } }
    }
    if (isEpisodePage(next.videoSection)) {
      try { window.localStorage.setItem(workPageKey(next.workId), next.videoSection); window.localStorage.setItem(episodePageKey(next.workId, next.episodeId), next.videoSection); } catch { /* Navigation works without local storage. */ }
    }
  }
  if (sameSelection(selection, next)) return;
  selection = next;
  persistSelection(next);
  emit();
}

export function clearSelection(): void {
  if (sameSelection(selection, EMPTY_SELECTION)) return;
  selection = { ...EMPTY_SELECTION };
  emit();
}

export function subscribeSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSelection(): JizuoSelection {
  return useSyncExternalStore(subscribeSelection, getSelection, getSelection);
}

interface RememberedWorkSelection {
  mode: WorkContentMode;
  volumeId: string | null;
  chapterId: string | null;
  chapterTitle?: string;
  episodeId: string | null;
}

function readRemembered(workId: string): RememberedWorkSelection {
  const empty: RememberedWorkSelection = { mode: "novel", volumeId: null, chapterId: null, episodeId: null };
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(`jizuo:work-selection:${workId}`) ?? "null");
    if (!raw || typeof raw !== "object") return empty;
    const value = raw as Record<string, unknown>;
    return {
      mode: value.mode === "video" ? "video" : "novel",
      volumeId: typeof value.volumeId === "string" ? value.volumeId : null,
      chapterId: typeof value.chapterId === "string" ? value.chapterId : null,
      episodeId: typeof value.episodeId === "string" ? value.episodeId : null,
      ...(typeof value.chapterTitle === "string" ? { chapterTitle: value.chapterTitle } : {}),
    };
  } catch { return empty; }
}

function persistSelection(value: JizuoSelection): void {
  if (!value.workId) return;
  const previous = readRemembered(value.workId);
  const mode = value.mode ?? "novel";
  const remembered: RememberedWorkSelection = mode === "video"
    ? { ...previous, mode, episodeId: value.episodeId ?? previous.episodeId }
    : { ...previous, mode, volumeId: value.volumeId, chapterId: value.chapterId,
      ...(value.chapterTitle ? { chapterTitle: value.chapterTitle } : {}) };
  try { window.localStorage.setItem(`jizuo:work-selection:${value.workId}`, JSON.stringify(remembered)); }
  catch { /* Navigation remains available when storage is disabled. */ }
}

export function switchWorkMode(workId: string, mode: WorkContentMode): void {
  if (!isWorkspacePluginEnabled(workId, mode === "video" ? "video" : "writing")) {
    setSelection({ workId, overlay: null });
    return;
  }
  const remembered = readRemembered(workId);
  if (mode === "video") {
    setSelection({ workId, volumeId: null, chapterId: null, mode, episodeId: remembered.episodeId,
      videoSection: remembered.episodeId ? rememberedEpisodePage(workId, remembered.episodeId) : "storyboard",
      shotId: remembered.episodeId ? rememberedEpisodeShot(workId, remembered.episodeId) ?? null : null,
      designId: null, overlay: "video" });
  } else {
    setSelection({ workId, volumeId: remembered.volumeId, chapterId: remembered.chapterId,
      chapterTitle: remembered.chapterTitle ?? null, mode, episodeId: null,
      overlay: remembered.chapterId ? "chapter" : null });
  }
}

export function restoreWorkSelection(workId: string): void {
  const rememberedMode = readRemembered(workId).mode;
  const mode = isWorkspacePluginEnabled(workId, rememberedMode === "video" ? "video" : "writing")
    ? rememberedMode : isWorkspacePluginEnabled(workId, "writing") ? "novel" : "video";
  switchWorkMode(workId, mode);
}
