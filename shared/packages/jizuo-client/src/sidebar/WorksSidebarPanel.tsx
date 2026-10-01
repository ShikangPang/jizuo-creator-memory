import { volumeTreeKey, WritingTree } from "../plugins/WritingTree.tsx";
import { ProjectFeatures } from "../plugins/ProjectFeatures.tsx";
import { isBuiltinPluginEnabled, isWorkspacePluginAvailable, useWorkspacePlugins } from "../plugins/preferences.ts";
import { userErrorMessage } from "@jizuo/contracts";
import { ActionIcon } from "../ui/ActionIcon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import type {
  ChapterSummary,
  ImportPreview,
  TrashEntry,
  TrashImpact,
  TrashTarget,
  VolumeSummary,
  WorkSummary,
} from "@jizuo/contracts";

import type { JizuoContentRemote } from "../content/remote.ts";
import { clearSelection, getSelection, setSelection, switchWorkMode, useSelection } from "../content/selection.ts";
import "./sidebar.css";
import { VideoEpisodeTree } from "../video/VideoEpisodeTree.tsx";
import { CreateContentDialog } from "./CreateContentDialog.tsx";
import { WorkToolsDialog, type PickExportFile } from "./WorkToolsDialog.tsx";
import { WorkSessions } from "./WorkSessions.tsx";
import { MemoryPalaceEntry } from "./MemoryPalaceEntry.tsx";
import type { SessionNavigation } from "./sessionNavigation.ts";

export type CreateTarget =
  | { kind: "work" }
  | { kind: "volume"; workId: string }
  | { kind: "chapter"; workId: string; volumeId: string };

export type TreeTarget =
  | { kind: "work"; workId: string; title: string }
  | { kind: "volume"; workId: string; volumeId: string; title: string }
  | { kind: "chapter"; workId: string; volumeId: string; chapterId: string; title: string };

type DeleteState = { target: TreeTarget; impact: TrashImpact | null };
const BACKGROUND_REFRESH_INTERVAL_MS = 15_000;

export interface ImportFileSelection {
  sourcePath: string;
  format: "text" | "docx";
}

export type PickImportFile = () => Promise<ImportFileSelection | null>;
export type SubscribeWorksChanges = (
  listener: () => void,
) => (() => void) | Promise<() => void>;

function messageOf(error: unknown): string {
  return userErrorMessage(error, "操作暂未完成，请稍后再试。", { operation: "WorksSidebarPanel" });
}

function upsertById<T extends { id: string }>(items: readonly T[], item: T): T[] {
  return [...items.filter((candidate) => candidate.id !== item.id), item];
}

function targetKey(target: TreeTarget): string {
  if (target.kind === "work") return `work:${target.workId}`;
  if (target.kind === "volume") return `volume:${target.volumeId}`;
  return `chapter:${target.chapterId}`;
}

function withoutTitle(target: TreeTarget): TrashTarget {
  const { title: _title, ...value } = target;
  return value;
}

function kindName(kind: TreeTarget["kind"]): string {
  if (kind === "work") return "作品";
  if (kind === "volume") return "分卷";
  return "章节";
}

function Icon({ name }: { name: "book" | "chevron" | "document" | "folder" | "import" | "more" | "plus" | "restore" | "trash" }) {
  const names = {book:"book",chevron:"right",document:"document",folder:"folder",import:"import",more:"more",plus:"add",restore:"reset",trash:"delete"} as const;
  return <ActionIcon name={names[name]} className="jz-icon" />;
}

function impactText(impact: TrashImpact): string {
  if (impact.kind === "work") {
    return `将同时移入回收站：${impact.volumeCount} 个分卷、${impact.chapterCount} 个章节`;
  }
  if (impact.kind === "volume") return `将同时移入回收站：${impact.chapterCount} 个章节`;
  return "章节正文、计划和版本信息将一并移入回收站";
}

export function WorksSidebarPanel({
  remote,
  pickImportFile,
  pickExportFile,
  subscribeWorksChanges,
  openWorkSession,
  sessionNavigation,
  createWorkRequest = 0,
  workspaceMode = false,
  onWorksChanged,
  extraWorkspaces,
}: {
  remote: JizuoContentRemote;
  workspaceMode?: boolean;
  onWorksChanged?: (works: WorkSummary[]) => void;
  extraWorkspaces?: (query: string, works: WorkSummary[]) => ReactNode;
  openWorkSession?: (workId: string) => Promise<void>;
  sessionNavigation?: SessionNavigation;
  createWorkRequest?: number;
  pickImportFile?: PickImportFile;
  pickExportFile?: PickExportFile;
  subscribeWorksChanges?: SubscribeWorksChanges;
}) {
  const selection = useSelection();
  const [query, setQuery] = useState("");
  const pluginEnabled = useWorkspacePlugins();
  const [workTool, setWorkTool] = useState<{ workId: string; title: string; mode: "export" | "search" } | null>(null);
  const novelAvailable = isWorkspacePluginAvailable("writing") && isBuiltinPluginEnabled("writing");
  const videoAvailable = isWorkspacePluginAvailable("video") && isBuiltinPluginEnabled("video");
  const [projectKind, setProjectKind] = useState<"novel" | "video">(() => novelAvailable ? "novel" : videoAvailable ? "video" : "novel");
  const [works, setWorks] = useState<WorkSummary[]>([]);
  const [volumes, setVolumes] = useState<Record<string, VolumeSummary[]>>({});
  const [chapters, setChapters] = useState<Record<string, ChapterSummary[]>>({});
  const [expandedWorkId, setExpandedWorkId] = useState<string | null>(null);
  const [expandedVolume, setExpandedVolume] = useState<{ workId: string; volumeId: string } | null>(null);
  const expandedVolumeId = expandedVolume?.workId === expandedWorkId ? expandedVolume.volumeId : null;
  const setExpandedVolumeId = (volumeId: string | null, workId = expandedWorkId) => {
    setExpandedVolume(volumeId && workId ? {workId, volumeId} : null);
  };
  const [createTarget, setCreateTarget] = useState<CreateTarget | null>(null);
  const [createTitle, setCreateTitle] = useState("");
  const [menuTarget, setMenuTarget] = useState<TreeTarget | null>(null);
  const [renameTarget, setRenameTarget] = useState<TreeTarget | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [deleteState, setDeleteState] = useState<DeleteState | null>(null);
  const [trashItems, setTrashItems] = useState<TrashEntry[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [permanentTarget, setPermanentTarget] = useState<TrashEntry | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importTitle, setImportTitle] = useState("");
  const [retryWorkId, setRetryWorkId] = useState<string | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const sessionPending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const worksRef = useRef(works);
  worksRef.current = works;
  const expandedWorkRef = useRef<string | null>(null);
  const expandedVolumeRef = useRef<string | null>(null);
  expandedWorkRef.current = expandedWorkId;
  expandedVolumeRef.current = expandedVolumeId;

  const selectedProjectKind = works.find(work => work.id === selection.workId)?.projectKind;
  useEffect(() => {
    if (selectedProjectKind === "video" && videoAvailable || selectedProjectKind === "novel" && novelAvailable) setProjectKind(selectedProjectKind);
  }, [selection.workId, selectedProjectKind]);

  useEffect(() => {
    if (projectKind === "novel" && !novelAvailable && videoAvailable) setProjectKind("video");
    if (projectKind === "video" && !videoAvailable && novelAvailable) setProjectKind("novel");
  }, [novelAvailable, videoAvailable, projectKind]);

  useEffect(() => { onWorksChanged?.(works); }, [works, onWorksChanged]);

  const loadWorks = async (): Promise<void> => {
    const items = await remote.listWorks();
    setWorks(items);
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    remote.listWorks().then((items) => {
      if (active) setWorks(items);
    }).catch((cause: unknown) => {
      if (active) setError(messageOf(cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [remote]);

  const loadVolumes = async (workId: string): Promise<void> => {
    if (works.find(work => work.id === workId)?.projectKind === "video") return;
    if (!pluginEnabled(workId, "writing")) return;
    try {
      const items = await remote.listVolumes({ workId });
      setVolumes((current) => ({ ...current, [workId]: items }));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  useEffect(() => {
    if (selection.workId === null) return;
    setExpandedWorkId(selection.workId);
    void loadVolumes(selection.workId);
  }, [selection.workId, remote, pluginEnabled(selection.workId, "writing")]);

  useEffect(() => {
    if (selection.workId && selection.volumeId && selection.chapterId) setExpandedVolumeId(selection.volumeId, selection.workId);
  }, [selection.workId, selection.volumeId, selection.chapterId]);

  const loadChapters = async (workId: string, volumeId: string): Promise<void> => {
    try {
      const items = await remote.listChapters({ workId, volumeId });
      setChapters((current) => ({ ...current, [volumeTreeKey(workId, volumeId)]: items }));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  useEffect(() => {
    if (expandedWorkId === null || expandedVolumeId === null || !pluginEnabled(expandedWorkId, "writing")) return;
    let active = true;
    let refreshing = false;
    let initial = true;
    const refresh = async (): Promise<void> => {
      if (refreshing) return;
      refreshing = true;
      try {
        const items = await remote.listChapters({
          workId: expandedWorkId,
          volumeId: expandedVolumeId,
        });
        if (active) setChapters((current) => ({ ...current, [volumeTreeKey(expandedWorkId, expandedVolumeId)]: items }));
      } catch (cause) {
        if (active && initial) setError(messageOf(cause));
      } finally {
        refreshing = false;
        initial = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, BACKGROUND_REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [expandedVolumeId, expandedWorkId, remote, pluginEnabled(expandedWorkId, "writing")]);

  useEffect(() => {
    if (subscribeWorksChanges === undefined) return;
    let active = true;
    let unlisten = (): void => undefined;
    let refreshing = false;
    let refreshQueued = false;
    const refresh = async (): Promise<void> => {
      if (refreshing) {
        refreshQueued = true;
        return;
      }
      refreshing = true;
      do {
        refreshQueued = false;
        const workId = expandedWorkRef.current;
        const volumeId = expandedVolumeRef.current;
        try {
          const nextWorks = await remote.listWorks();
          if (!active) return;
          setWorks(nextWorks);
          if (workId !== null && worksRef.current.find(work => work.id === workId)?.projectKind !== "video" && pluginEnabled(workId, "writing")) {
            const nextVolumes = await remote.listVolumes({ workId });
            if (!active) return;
            setVolumes((current) => ({ ...current, [workId]: nextVolumes }));
          }
          if (workId !== null && volumeId !== null && pluginEnabled(workId, "writing")) {
            const nextChapters = await remote.listChapters({ workId, volumeId });
            if (!active) return;
            setChapters((current) => ({ ...current, [volumeTreeKey(workId, volumeId)]: nextChapters }));
          }
        } catch {
          // The low-frequency refresh remains as a fallback after transient watcher refresh failures.
        }
      } while (active && refreshQueued);
      refreshing = false;
    };
    Promise.resolve(subscribeWorksChanges(() => { void refresh(); })).then((dispose) => {
      if (active) unlisten = dispose;
      else dispose();
    }).catch(() => {
      // Browser previews and shells without Tauri events continue on the fallback timer.
    });
    return () => {
      active = false;
      unlisten();
    };
  }, [remote, subscribeWorksChanges]);

  const beginCreate = (target: CreateTarget): void => {
    if (target.kind === "work") setShowTrash(false);
    setCreateTarget(target);
    setCreateTitle("");
    setMenuTarget(null);
    setError(null);
  };

  useEffect(() => {
    if (createWorkRequest > 0) beginCreate({ kind: "work" });
  }, [createWorkRequest]);

  const openConversation = async (workId: string, fresh = false): Promise<void> => {
    const open = fresh ? sessionNavigation?.newWorkSession : openWorkSession;
    if (open === undefined || sessionPending.current) return;
    sessionPending.current = true;
    setSessionBusy(true);
    setRetryWorkId(null);
    setError(null);
    try {
      await open(workId);
      if (workspaceMode) setSelection({ overlay: null });
    } catch (cause) {
      setRetryWorkId(workId);
      setError(`作品已保存，无法打开作品会话：${messageOf(cause)}`);
    } finally {
      sessionPending.current = false;
      setSessionBusy(false);
    }
  };

  const beginImport = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const selected = await pickImportFile?.();
      if (selected == null) return;
      if (remote.previewImport === undefined) throw new Error("当前运行时不支持作品导入，请重新启动即作");
      const preview = await remote.previewImport(selected);
      setImportPreview(preview);
      setImportTitle(preview.suggestedTitle);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async (): Promise<void> => {
    const workTitle = importTitle.trim();
    if (importPreview === null || workTitle === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (remote.applyImport === undefined) throw new Error("当前运行时不支持作品导入，请重新启动即作");
      const imported = await remote.applyImport({
        sourcePath: importPreview.sourcePath,
        format: importPreview.format,
        previewHash: importPreview.previewHash,
        workTitle,
      });
      setWorks((current) => upsertById(current, imported.work));
      setVolumes((current) => ({ ...current, [imported.work.id]: [imported.volume] }));
      setExpandedWorkId(imported.work.id);
      setExpandedVolumeId(imported.volume.id, imported.work.id);
      setSelection({ workId: imported.work.id });
      setImportPreview(null);
      setImportTitle("");
      void loadChapters(imported.work.id, imported.volume.id);
      await openConversation(imported.work.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const title = createTitle.trim();
    if (createTarget === null || title === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (createTarget.kind === "work") {
        const created = await remote.createWork({ title, projectKind });
        setWorks((current) => upsertById(current, created));
        setExpandedWorkId(created.id);
        switchWorkMode(created.id, projectKind);
        setCreateTarget(null);
        setCreateTitle("");
        await openConversation(created.id);
      } else if (createTarget.kind === "volume") {
        const created = await remote.createVolume({ workId: createTarget.workId, title });
        setVolumes((current) => ({
          ...current,
          [createTarget.workId]: upsertById(current[createTarget.workId] ?? [], created),
        }));
        setExpandedWorkId(createTarget.workId);
        setExpandedVolumeId(created.id, createTarget.workId);
        setSelection({ workId: createTarget.workId, volumeId: created.id });
      } else {
        const created = await remote.createChapter({
          workId: createTarget.workId,
          volumeId: createTarget.volumeId,
          title,
          content: "",
          plan: "",
        });
        setChapters((current) => ({
          ...current,
          [volumeTreeKey(createTarget.workId, createTarget.volumeId)]: upsertById(current[volumeTreeKey(createTarget.workId, createTarget.volumeId)] ?? [], created),
        }));
        setSelection({
          workId: created.workId,
          volumeId: created.volumeId,
          chapterId: created.id,
          chapterTitle: created.title,
          overlay: "chapter",
        });
      }
      setCreateTarget(null);
      setCreateTitle("");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const beginRename = (target: TreeTarget): void => {
    setRenameTarget(target);
    setRenameTitle(target.title);
    setMenuTarget(null);
    setError(null);
  };

  const rename = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const title = renameTitle.trim();
    if (renameTarget === null || title === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (renameTarget.kind === "work") {
        const renamed = await remote.renameWork({ workId: renameTarget.workId, title });
        setWorks((current) => upsertById(current, renamed));
      } else if (renameTarget.kind === "volume") {
        const renamed = await remote.renameVolume({
          workId: renameTarget.workId,
          volumeId: renameTarget.volumeId,
          title,
        });
        setVolumes((current) => ({
          ...current,
          [renameTarget.workId]: upsertById(current[renameTarget.workId] ?? [], renamed),
        }));
      } else {
        const renamed = await remote.renameChapter({
          workId: renameTarget.workId,
          volumeId: renameTarget.volumeId,
          chapterId: renameTarget.chapterId,
          title,
        });
        setChapters((current) => ({
          ...current,
          [volumeTreeKey(renameTarget.workId, renameTarget.volumeId)]: upsertById(current[volumeTreeKey(renameTarget.workId, renameTarget.volumeId)] ?? [], renamed),
        }));
        if (selection.chapterId === renamed.id) setSelection({ chapterTitle: renamed.title });
      }
      setRenameTarget(null);
      setRenameTitle("");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const beginDelete = async (target: TreeTarget): Promise<void> => {
    setMenuTarget(null);
    setDeleteState({ target, impact: null });
    setError(null);
    try {
      const impact = await remote.inspectTrashTarget(withoutTitle(target));
      setDeleteState((current) => current === null || targetKey(current.target) !== targetKey(target)
        ? current
        : { target, impact });
    } catch (cause) {
      setDeleteState(null);
      setError(messageOf(cause));
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (deleteState?.impact === null || deleteState === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const entry = await remote.moveToTrash(withoutTitle(deleteState.target));
      const target = deleteState.target;
      if (target.kind === "work") {
        setWorks((current) => current.filter((item) => item.id !== target.workId));
        setVolumes((current) => {
          const next = { ...current };
          delete next[target.workId];
          return next;
        });
        if (selection.workId === target.workId) clearSelection();
        if (expandedWorkId === target.workId) {
          setExpandedWorkId(null);
          setExpandedVolumeId(null);
        }
      } else if (target.kind === "volume") {
        setVolumes((current) => ({
          ...current,
          [target.workId]: (current[target.workId] ?? []).filter((item) => item.id !== target.volumeId),
        }));
        setChapters((current) => {
          const next = { ...current };
          delete next[volumeTreeKey(target.workId, target.volumeId)];
          return next;
        });
        if (selection.volumeId === target.volumeId) setSelection({ volumeId: null });
        if (expandedVolumeId === target.volumeId) setExpandedVolumeId(null);
      } else {
        setChapters((current) => ({
          ...current,
          [volumeTreeKey(target.workId, target.volumeId)]: (current[volumeTreeKey(target.workId, target.volumeId)] ?? []).filter((item) => item.id !== target.chapterId),
        }));
        if (selection.chapterId === target.chapterId) setSelection({ chapterId: null, overlay: null });
      }
      setTrashItems((current) => [entry, ...current.filter((item) => item.trashId !== entry.trashId)]);
      setDeleteState(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const openTrash = async (): Promise<void> => {
    setShowTrash(true);
    setMenuTarget(null);
    setLoading(true);
    setError(null);
    try {
      setTrashItems(await remote.listTrash());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  };

  const restore = async (entry: TrashEntry): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await remote.restoreFromTrash({ workId: entry.workId, trashId: entry.trashId });
      setTrashItems((current) => current.filter((item) => item.trashId !== entry.trashId));
      await loadWorks();
      if (expandedWorkId !== null) await loadVolumes(expandedWorkId);
      if (expandedWorkId !== null && expandedVolumeId !== null) {
        await loadChapters(expandedWorkId, expandedVolumeId);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const permanentlyDelete = async (): Promise<void> => {
    if (permanentTarget === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await remote.deleteFromTrash({ workId: permanentTarget.workId, trashId: permanentTarget.trashId });
      setTrashItems((current) => current.filter((item) => item.trashId !== permanentTarget.trashId));
      setPermanentTarget(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const cancelRenameOnEscape = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      setRenameTarget(null);
      setRenameTitle("");
    }
  };

  const renderRename = (target: TreeTarget) => (
    <form className="jz-inline-rename" onSubmit={(event) => { void rename(event); }}>
      <input
        aria-label={`重命名${kindName(target.kind)}`}
        autoFocus
        disabled={busy}
        value={renameTitle}
        onChange={(event) => { setRenameTitle(event.target.value); }}
        onKeyDown={cancelRenameOnEscape}
      />
      <IconButton icon="apply" label={"保存名称"} type="submit" className="jz-row-action" aria-label="保存名称" disabled={busy || renameTitle.trim() === ""} />
      <IconButton icon="close" label={"取消重命名"} type="button" className="jz-row-action" aria-label="取消重命名" disabled={busy} onClick={() => { setRenameTarget(null); }} />
    </form>
  );

  const renderMenu = (target: TreeTarget) => menuTarget !== null && targetKey(menuTarget) === targetKey(target) && (
    <div className="jz-row-menu" role="menu" aria-label={`${target.title}操作`}>
      {target.kind === "work" && <>
        {pluginEnabled(target.workId, "writing") && remote.searchWork && <IconButton icon="search" label={"全书搜索"} type="button" role="menuitem" onClick={() => { setMenuTarget(null); setWorkTool({ ...target, mode: "search" }); }} />}
        {pluginEnabled(target.workId, "writing") && remote.exportWork && <IconButton icon="export" label={"导出作品"} type="button" role="menuitem" onClick={() => { setMenuTarget(null); setWorkTool({ ...target, mode: "export" }); }} />}
      </>}
      {target.kind === "volume" && (
        <IconButton icon="outline" label={"编辑分卷大纲"}
          type="button"
          role="menuitem"
          onClick={() => {
            setMenuTarget(null);
            setSelection({ workId: target.workId, volumeId: target.volumeId, overlay: "volume" });
          }}
         />
      )}
      <IconButton icon="edit" label={"重命名" + (kindName(target.kind))} type="button" role="menuitem" onClick={() => { beginRename(target); }} />
      <IconButton icon="delete" label={"删除" + (kindName(target.kind))} type="button" role="menuitem" className="danger" onClick={() => { void beginDelete(target); }} />
    </div>
  );

  const renderActions = (target: TreeTarget, onCreate?: () => void, createLabel?: string) => (
    <div className="jz-tree-actions">
      {onCreate !== undefined && createLabel !== undefined && (
        <button type="button" className="jz-row-action" aria-label={createLabel} onClick={onCreate}>
          <Icon name="plus" />
        </button>
      )}
      <button
        type="button"
        className="jz-row-action"
        aria-label={`打开“${target.title}”操作菜单`}
        aria-expanded={menuTarget !== null && targetKey(menuTarget) === targetKey(target)}
        onClick={() => {
          setMenuTarget((current) => current !== null && targetKey(current) === targetKey(target) ? null : target);
        }}
      >
        <Icon name="more" />
      </button>
      {renderMenu(target)}
    </div>
  );

  return (
    <nav className="jz-works-panel" aria-label="作品与章节">
      {workTool && <WorkToolsDialog key={`${workTool.workId}:${workTool.mode}`} work={workTool} mode={workTool.mode} remote={remote} {...(pickExportFile ? { pickExportFile } : {})} close={() => setWorkTool(null)} />}
      {retryWorkId !== null && <IconButton icon="reset" label={"重试打开会话"} type="button" disabled={sessionBusy} onClick={() => { void openConversation(retryWorkId); }} />}
      <div className="jz-works-toolbar">
        <div>
          <strong>{showTrash ? "回收站" : workspaceMode ? "工作区" : "项目"}</strong>
          <span>{showTrash ? `${trashItems.length} 项` : `${works.length} 个项目`}</span>
        </div>
        {showTrash ? (
          <IconButton icon="left" label={"返回作品"} type="button" className="jz-toolbar-action textual" onClick={() => { setShowTrash(false); setError(null); }} />
        ) : (
          <div className="jz-toolbar-actions">
            {pickImportFile && novelAvailable && <button
              type="button"
              className="jz-toolbar-action"
              aria-label="导入 TXT 或 DOCX"
              title="导入 TXT 或 DOCX"
              disabled={busy}
              onClick={() => { void beginImport(); }}
            >
              <Icon name="import" />
            </button>}
            <button type="button" className="jz-toolbar-action" aria-label="新建项目" onClick={() => { beginCreate({ kind: "work" }); }}>
              <Icon name="plus" />
            </button>
          </div>
        )}
      </div>

      {!showTrash && <input className="jz-project-search" aria-label="搜索工作区" placeholder="搜索项目或工作区" value={query} onChange={event => setQuery(event.target.value)} />}
      {!showTrash && !workspaceMode && <MemoryPalaceEntry />}

      {createTarget !== null && <CreateContentDialog
        kind={createTarget.kind} projectKind={projectKind} onProjectKindChange={setProjectKind} availableKinds={[...(novelAvailable ? ["novel" as const] : []), ...(videoAvailable ? ["video" as const] : [])]}
        context={createTarget.kind === "work" ? undefined : [
          works.find((work) => work.id === createTarget.workId)?.title,
          createTarget.kind === "chapter"
            ? volumes[createTarget.workId]?.find((volume) => volume.id === createTarget.volumeId)?.title
            : undefined,
        ].filter(Boolean).join(" / ")}
        title={createTitle} busy={busy} error={error}
        onTitleChange={setCreateTitle} onSubmit={(event) => { void create(event); }}
        close={() => { setCreateTarget(null); setCreateTitle(""); setError(null); }}
      />}
      {error !== null && createTarget === null && <p className="jz-sidebar-error" role="alert">{error}</p>}
      {loading && <div className="jz-tree-skeleton" aria-label="正在加载"><i /><i /><i /></div>}

      {!showTrash && !loading && works.length === 0 && !workspaceMode && (
        <div className="jz-sidebar-empty"><Icon name="book" /><strong>还没有{projectKind === "video" ? "视频" : "小说"}项目</strong><span>{projectKind === "video" ? "独立创建视频项目，再选择小说章节生成剧本。" : "创建小说项目，开始整理章节。"}</span></div>
      )}

      {!showTrash && (
        <div className="jz-work-tree" role="tree" aria-label="作品目录">
          {works.filter(work => work.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map((work) => {
            const workExpanded = expandedWorkId === work.id;
            const writingEnabled = work.projectKind !== "video" && pluginEnabled(work.id, "writing");
            const videoEnabled = pluginEnabled(work.id, "video") && !!remote.getVideoProject;
            const videoMode = videoEnabled && (work.projectKind === "video" || work.hasLegacyVideo === true && selection.workId === work.id && selection.mode === "video");
            const target: TreeTarget = { kind: "work", workId: work.id, title: work.title };
            const renaming = renameTarget !== null && targetKey(renameTarget) === targetKey(target);
            return (
              <section key={work.id} className="jz-work-node" role="treeitem" aria-expanded={workExpanded}>
                <div className="jz-tree-row jz-tree-work" data-selected={selection.workId === work.id || undefined}>
                  {renaming ? renderRename(target) : (
                    <>
                      <button type="button" className="jz-row-action" aria-label={`${workExpanded ? "折叠" : "展开"}${work.title}`} onClick={() => {
                        setExpandedWorkId(workExpanded ? null : work.id);
                        if (!workExpanded) void loadVolumes(work.id);
                      }}><span className={`jz-tree-chevron ${workExpanded ? "expanded" : ""}`}><Icon name="chevron" /></span></button>
                      <button
                        type="button"
                        className="jz-tree-main"
                        aria-current={selection.workId === work.id ? "page" : undefined}
                        aria-expanded={workExpanded}
                        onClick={() => {
                          setExpandedWorkId(work.id);
                          setMenuTarget(null);
                          if (remote.getVideoProject) switchWorkMode(work.id, work.projectKind ?? "novel");
                          else setSelection({ workId: work.id });
                          setExpandedVolumeId(getSelection().volumeId, work.id);
                          // A changed selection loads volumes in the effect above.
                          // Only refresh here when reopening the same work.
                          if (selection.workId === work.id) void loadVolumes(work.id);
                          void openConversation(work.id);
                        }}
                      >

                        <span className="jz-tree-kind work" title={work.projectKind === "video" ? "视频项目" : "小说项目"} aria-hidden="true"><ActionIcon name={work.projectKind === "video" ? "video" : "novel"} className="jz-icon" /></span>
                        <span className="jz-tree-title">{work.title}</span>
                      </button>
                      {workspaceMode && sessionNavigation && <IconButton icon="chat" label={`在${work.title}新建对话`} className="jz-row-action jz-work-new-chat" disabled={sessionBusy} onClick={() => { void openConversation(work.id, true); }} />}
                      {renderActions(target, videoMode || !writingEnabled ? undefined : () => { beginCreate({ kind: "volume", workId: work.id }); }, videoMode || !writingEnabled ? undefined : "新建分卷")}
                    </>
                  )}
                </div>

                {workExpanded && (
                  <div className="jz-work-sections" role="group">
                    {sessionNavigation !== undefined && <WorkSessions workId={work.id} navigation={sessionNavigation} showCreate={!workspaceMode} showHeading={!workspaceMode} />}
                    <div className="jz-work-files" role="group" aria-label="作品文件">
                    <div className="jz-work-section-heading"><span><Icon name="folder" />作品文件</span>
                      {work.hasLegacyVideo && videoEnabled && <button type="button" onClick={() => switchWorkMode(work.id, videoMode ? "novel" : "video")}>{videoMode ? "返回小说章节" : "历史视频内容"}</button>}
                    </div>
                    {videoMode ? <VideoEpisodeTree key={work.id} remote={remote} workId={work.id} /> : writingEnabled ? <>
                    <WritingTree work={work} volumes={volumes} chapters={chapters} expandedVolumeId={expandedVolumeId}
                      renameTarget={renameTarget} setExpandedVolumeId={setExpandedVolumeId} closeMenu={() => setMenuTarget(null)}
                      beginCreate={beginCreate} renderRename={renderRename} renderActions={renderActions} />
                    </> : <p className="jz-tree-empty">可直接聊天，或在项目功能中启用编辑插件。</p>}
                    <ProjectFeatures workId={work.id} projectKind={work.projectKind ?? "novel"} />
                    </div>
                  </div>
                )}
              </section>
            );
          })}
          {extraWorkspaces?.(query, works)}
        </div>
      )}

      {showTrash && !loading && (
        <div className="jz-trash-list" aria-label="回收站项目">
          {trashItems.length === 0 && (
            <div className="jz-sidebar-empty"><Icon name="trash" /><strong>回收站是空的</strong><span>删除的作品内容会暂存在这里。</span></div>
          )}
          {trashItems.map((entry) => (
            <article className="jz-trash-item" key={entry.trashId}>
              <span className="jz-tree-kind"><Icon name={entry.kind === "work" ? "book" : entry.kind === "volume" ? "folder" : "document"} /></span>
              <div><strong>{entry.title}</strong><span>{kindName(entry.kind)} · {new Date(entry.trashedAt).toLocaleDateString("zh-CN")}</span></div>
              <div className="jz-trash-actions">
                <button type="button" aria-label={`恢复“${entry.title}”`} disabled={busy} onClick={() => { void restore(entry); }}><Icon name="restore" /></button>
                <button type="button" className="danger" aria-label={`永久删除“${entry.title}”`} disabled={busy} onClick={() => { setPermanentTarget(entry); }}><Icon name="trash" /></button>
              </div>
            </article>
          ))}
        </div>
      )}

      {!showTrash && (
        <IconButton icon="delete" label={`回收站${trashItems.length ? `（${trashItems.length}）` : ""}`} className="jz-trash-entry" onClick={() => { void openTrash(); }} />
      )}

      {deleteState !== null && (
        <div className="jz-dialog-backdrop">
          <section className="jz-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="jz-delete-title">
            <span className="jz-dialog-icon danger"><Icon name="trash" /></span>
            <h3 id="jz-delete-title">删除{deleteState.target.title}</h3>
            {deleteState.impact === null ? <p>正在检查包含的内容…</p> : <p>{impactText(deleteState.impact)}</p>}
            <small>之后可从即作回收站恢复。</small>
            <div>
              <IconButton icon="close" label={"取消"} type="button" disabled={busy} onClick={() => { setDeleteState(null); }} />
              <IconButton icon="delete" label={"移到回收站"} type="button" className="danger primary" disabled={busy || deleteState.impact === null} onClick={() => { void confirmDelete(); }} />
            </div>
          </section>
        </div>
      )}

      {permanentTarget !== null && (
        <div className="jz-dialog-backdrop">
          <section className="jz-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="jz-permanent-title">
            <span className="jz-dialog-icon danger"><Icon name="trash" /></span>
            <h3 id="jz-permanent-title">永久删除{permanentTarget.title}</h3>
            <p>此操作无法撤销，相关文件将被彻底删除。</p>
            <div>
              <IconButton icon="close" label={"取消"} type="button" disabled={busy} onClick={() => { setPermanentTarget(null); }} />
              <IconButton icon="delete" label={"永久删除"} type="button" className="danger primary" disabled={busy} onClick={() => { void permanentlyDelete(); }} />
            </div>
          </section>
        </div>
      )}

      {importPreview !== null && (
        <div className="jz-dialog-backdrop">
          <section className="jz-confirm-dialog jz-import-dialog" role="dialog" aria-modal="true" aria-labelledby="jz-import-title">
            <header>
              <span className="jz-dialog-icon"><Icon name="import" /></span>
              <div>
                <h3 id="jz-import-title">导入作品</h3>
                <small>{importPreview.format === "docx" ? "DOCX 文档" : "TXT 文本"} · {importPreview.chapters.length} 个章节</small>
              </div>
            </header>
            <label className="jz-import-title-field">
              <span>作品名称</span>
              <input
                aria-label="导入后的作品名称"
                autoFocus
                disabled={busy}
                value={importTitle}
                onChange={(event) => { setImportTitle(event.target.value); }}
              />
            </label>
            <div className="jz-import-chapters" aria-label="识别到的章节">
              {importPreview.chapters.map((chapter, index) => (
                <div key={`${index}:${chapter.title}`}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{chapter.title}</strong>
                </div>
              ))}
            </div>
            {importPreview.warnings.length > 0 && (
              <p className="jz-import-warning">解析提示：{importPreview.warnings.join("；")}</p>
            )}
            <div className="jz-import-actions">
              <IconButton icon="close" label={"取消导入"}
                type="button"
                aria-label="取消导入"
                disabled={busy}
                onClick={() => { setImportPreview(null); setImportTitle(""); }}
               />
              <IconButton icon="import" label={"确认导入"}
                type="button"
                className="primary"
                aria-label="确认导入"
                disabled={busy || importTitle.trim() === ""}
                onClick={() => { void confirmImport(); }}
               />
            </div>
          </section>
        </div>
      )}
    </nav>
  );
}
