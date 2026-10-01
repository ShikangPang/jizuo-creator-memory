import { useWorkspacePlugins } from "../plugins/preferences.ts";
import { userErrorMessage } from "@jizuo/contracts";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ChapterSummary } from "@jizuo/contracts";
import type { JizuoContentRemote } from "../content/remote.ts";
import { getSelection, setSelection, switchWorkMode, useSelection, type WorkContentMode } from "../content/selection.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { useVideoProject } from "../video/useVideoProject.ts";

function ChapterList({ remote, workId, close }: { remote: JizuoContentRemote; workId: string; close(): void }) {
  const selection = useSelection();
  const [groups, setGroups] = useState<Array<{ id: string; title: string; chapters: ChapterSummary[] }>>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setGroups(undefined); setError(undefined);
    void remote.listVolumes({ workId }).then(volumes => Promise.all(volumes.map(async volume => ({
      id: volume.id, title: volume.title, chapters: await remote.listChapters({ workId, volumeId: volume.id }),
    })))).then(value => { if (active) setGroups(value); }).catch((cause: unknown) => {
      if (active) setError(userErrorMessage(cause, "章节目录加载失败", { operation: "CollapsedWorkNavigation", effect: "read" }));
    });
    return () => { active = false; };
  }, [remote, workId, retry]);
  if (error) return <p role="alert">{error}<IconButton icon="reset" label="重试章节目录" onClick={() => setRetry(value => value + 1)} /></p>;
  if (!groups) return <p role="status">正在加载章节…</p>;
  if (!groups.some(group => group.chapters.length)) return <p>暂无章节，请展开作品列表新建章节。</p>;
  return <>{groups.map(group => <section key={group.id} aria-label={group.title}>
    <h4>{group.title}</h4>
    {group.chapters.map(chapter => <button key={chapter.id} type="button" title={chapter.title}
      aria-current={selection.chapterId === chapter.id && selection.volumeId === group.id ? "page" : undefined}
      onClick={() => { setSelection({ workId, volumeId: group.id, chapterId: chapter.id, chapterTitle: chapter.title, overlay: "chapter" }); close(); }}>
      {chapter.title}
    </button>)}
  </section>)}</>;
}

function EpisodeList({ remote, workId, close }: { remote: JizuoContentRemote; workId: string; close(): void }) {
  const selection = useSelection();
  const { episodes, error, loading, refresh } = useVideoProject(remote, workId, { scope: "overview" });
  return <>
    {error && <p role="alert">{error}<IconButton icon="reset" label="重试剧集目录" onClick={refresh} /></p>}
    {loading && <p role="status">正在加载剧集…</p>}
    {!loading && !error && !episodes.length && <p>暂无剧集，请展开作品列表新建剧集。</p>}
    {episodes.map((episode, index) => <button key={episode.id} type="button" title={episode.title}
      aria-current={selection.episodeId === episode.id ? "page" : undefined}
      onClick={() => { setSelection({ workId, volumeId: null, chapterId: null, episodeId: episode.id, overlay: "video" }); close(); }}>
      {index + 1}. {episode.title}
    </button>)}
  </>;
}

function DirectoryPopover({ id, anchor, title, close, children }: {
  id: string; anchor: HTMLButtonElement; title: string; close(): void; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 60, top: 100 });
  useEffect(() => {
    const positionPanel = () => {
      const rect = anchor.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(rect.right + 10, window.innerWidth - 296)),
        top: Math.max(8, Math.min(rect.top, window.innerHeight - Math.min(420, window.innerHeight - 16))) });
    };
    positionPanel();
    panel.current?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !anchor.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); anchor.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", positionPanel);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", positionPanel);
    };
  }, [anchor, close]);
  return createPortal(<div ref={panel} id={id} role="dialog" aria-label={title} tabIndex={-1} className="jz-rail-directory" style={position}>
    <header><strong>{title}</strong><IconButton icon="close" label="关闭目录" onClick={() => { close(); anchor.focus(); }} /></header>
    <div className="jz-rail-directory-items">{children}</div>
  </div>, document.body);
}

/** The rail keeps reading/editing and work libraries reachable without widening the workspace. */
export function CollapsedWorkNavigation({ remote, workId }: { remote: JizuoContentRemote; workId: string }) {
  const selection = useSelection();
  const enabled = useWorkspacePlugins();
  const writingEnabled = enabled(workId, "writing");
  const videoEnabled = enabled(workId, "video");
  const video = videoEnabled && (!writingEnabled || selection.mode === "video");
  const [directory, setDirectory] = useState<WorkContentMode>();
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => setDirectory(undefined), []);
  const openMode = (mode: WorkContentMode) => {
    close();
    switchWorkMode(workId, mode);
    const current = getSelection();
    if (mode === "video" ? !current.episodeId : !current.chapterId) setDirectory(mode);
  };
  const library = (videoSection: "style" | "assets" | "media") => {
    close(); setSelection({ workId, overlay: "video", videoSection, episodeId: null, shotId: null, designId: null });
  };
  return <>
    <span className="jz-rail-divider" />
    {writingEnabled && <IconButton icon="book" label="小说" aria-pressed={!video} onClick={() => openMode("novel")} />}
    {videoEnabled && <IconButton icon="video" label="视频剧集" aria-pressed={video} onClick={() => openMode("video")} />}
    <span className="jz-rail-divider" />
    {(writingEnabled || videoEnabled) && <IconButton ref={anchor} icon="list" label={video ? "剧集目录" : "章节目录"} aria-haspopup="dialog" aria-expanded={!!directory}
      aria-controls={directory ? id : undefined} onClick={() => setDirectory(directory ? undefined : video ? "video" : "novel")} />}
    {video && <>
      <IconButton icon="sparkles" label="作品画风" aria-pressed={selection.videoSection === "style"} onClick={() => library("style")} />
      <IconButton icon="document" label="作品设定库" aria-pressed={selection.videoSection === "assets"} onClick={() => library("assets")} />
      <IconButton icon="image" label="作品素材库" aria-pressed={selection.videoSection === "media"} onClick={() => library("media")} />
    </>}
    {enabled(workId, "memory") && <IconButton icon="memory" label="打开记忆宫殿" aria-pressed={selection.overlay === "memory"}
      onClick={() => { close(); setSelection({ overlay: "memory" }); }} />}
    {directory && enabled(workId, directory === "novel" ? "writing" : "video") && anchor.current && <DirectoryPopover id={id} anchor={anchor.current} title={directory === "novel" ? "章节目录" : "剧集目录"} close={close}>
      {directory === "novel" ? <ChapterList remote={remote} workId={workId} close={close} /> : <EpisodeList remote={remote} workId={workId} close={close} />}
    </DirectoryPopover>}
  </>;
}
