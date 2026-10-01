import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useEditorPreference } from "./editor-preferences.ts";
import { VideoEditorFrame } from "./VideoEditorFrame.tsx";
import { VideoToolIcon } from "./VideoToolIcon.tsx";
import { DeleteVideoItemButton } from "./DeleteVideoItemButton.tsx";
import { VideoShotDetailsEditor, hasVideoShotDetailsDraft } from "./VideoShotDetailsEditor.tsx";
import { VideoPager } from "./VideoPager.tsx";
import { useCallback, useId, useEffect, useRef, useState, type CSSProperties } from "react";
import { getSelection, setSelection, useSelection } from "../content/selection.ts";
import type { VideoEpisode, VideoProject } from "@jizuo/contracts";
import type { VideoShotsRemote } from "./shots-remote.ts";
export type { VideoBatchRequest, VideoShotsRemote } from "./shots-remote.ts";
import { publishVideoProject } from "./useVideoProject.ts";
import { VideoErrorNotice } from "./VideoErrorNotice.tsx";
import { VideoShotCard, hasVideoShotDraft } from "./VideoShotCard.tsx";
import { clearVideoComposerSelection } from "./video-composer-request.ts";
export { VideoMediaPreview, VideoJobControls } from "./VideoShotMedia.tsx";
import "./video-editing.css";
import "./video-shots.css";

export function VideoShotsPanel({ project, episode, remote, active }: { project: VideoProject; episode: VideoEpisode; remote: VideoShotsRemote; active?: boolean | undefined }) {
  return <VideoShotsWorkspace key={`${project.workId}/${episode.id}`} project={project} episode={episode} remote={remote} active={active}/>;
}
function VideoShotsWorkspace({ project, episode, remote, active }: { project: VideoProject; episode: VideoEpisode; remote: VideoShotsRemote; active?: boolean | undefined }) {
  const selection = useSelection();
  const tabsId = useId();
  const [sidebarTab, setSidebarTab] = useEditorPreference("shotsTab", "prompts", (value): value is string => ["details", "prompts"].includes(String(value)));
  const sidebarTabs = [{id:"details", label:"镜头资料"}, {id:"prompts", label:"提示词"}];
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
  const [split, setSplit] = useEditorPreference("shotsSplit", 38, (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 25 && value <= 65);
  const splitRoot = useRef<HTMLDivElement>(null);
  const resizing = useRef(false);
  const resize = (clientX: number) => {
    const box = splitRoot.current?.getBoundingClientRect();
    if (box?.width) setSplit(Math.max(25, Math.min(65, (clientX - box.left) / box.width * 100)));
  };
  const [fullscreen, setFullscreen] = useState(false);
  const exitFullscreen = useCallback(() => setFullscreen(false), []);
  useEffect(() => { if (active === false) setFullscreen(false); }, [active]);
  const [, refreshDrafts] = useState(0);
  const aspectRatio = episode.aspectRatio ?? "9:16";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const shots = episode.shots.filter((shot) => !shot.archived);
  const visibleShots = shots;
  const requestedId = selection.workId === project.workId && selection.episodeId === episode.id ? selection.shotId : undefined;
  const [activeId, setActiveId] = useState(() => shots.find(shot => shot.id === requestedId)?.id ?? shots[0]?.id);
  const [selectionRequest, setSelectionRequest] = useState(0);
  const activeShot = visibleShots.find(shot => shot.id === activeId) ?? visibleShots[0];
  useEffect(() => {
    if (active === false || !requestedId || !shots.some(shot => shot.id === requestedId)) return;
    if (activeId !== requestedId) { setActiveId(requestedId); }
  }, [requestedId, active]);
  const chooseShot = (id: string | undefined) => {
    setActiveId(id);
    if (active !== false) setSelection({ workId: project.workId, episodeId: episode.id, shotId: id ?? null, videoSection: "shots", overlay: "video" });
    setSelectionRequest(value => value + 1);
  };
  useEffect(() => {
    if (active === true && !activeShot) clearVideoComposerSelection({ workId: project.workId, episodeId: episode.id });
  }, [active, activeShot?.id, project.workId, episode.id]);
  useEffect(() => {
    if (active === false) return;
    if (requestedId && shots.some(shot => shot.id === requestedId) && requestedId !== activeShot?.id) return;
    const selected = getSelection();
    if (selected.workId === project.workId && selected.episodeId === episode.id) setSelection({ shotId: activeShot?.id ?? null });
  }, [project.workId, episode.id, activeShot?.id, active, requestedId]);
  const run = async (operation: () => Promise<VideoProject>, success?: () => void) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { publishVideoProject(await operation()); success?.(); }
    catch (cause) { setError(userErrorMessage(cause, "操作失败，任务状态需核对", { operation: "VideoShotsPanel" })); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <VideoEditorFrame fullscreen={fullscreen} exit={exitFullscreen}><section className="jz-video-shots jz-video-editor" aria-label="镜头视频">

    {error && <VideoErrorNotice title="视频操作未完成" message={error} />}
    {!shots.length && <p>暂无镜头，请先在制作稿中生成镜头。</p>}
    <div className="jz-shots-navigation">    {activeShot && <VideoPager label="镜头" items={visibleShots} currentId={activeShot.id} onChange={chooseShot} disabled={busy}/>}    {activeShot && <DeleteVideoItemButton compact buttonLabel="删除镜头" key={`delete/${activeShot.id}`} remote={remote} input={{workId:project.workId,expectedRevision:project.revision,kind:"shot",id:activeShot.id}} label={activeShot.title} detail="生成素材保留，可从已删除镜头中恢复。" disabled={busy||activeShot.locked||activeShot.promptLocked||hasVideoShotDraft(project.workId,episode.id,activeShot.id)||hasVideoShotDetailsDraft(project.workId,episode.id,activeShot.id)}/>}    <button type="button" className="jz-video-icon-button" aria-label={fullscreen ? "退出镜头全屏" : "全屏镜头制作"} title={fullscreen ? "退出全屏" : "全屏镜头制作"} onClick={() => setFullscreen(value => !value)}><VideoToolIcon name={fullscreen ? "focus" : "fit"}/></button></div>
    <div ref={splitRoot} className="jz-shots-main" style={{"--jz-shots-split": `${split}%`} as CSSProperties}><aside className="jz-shots-info" aria-label="镜头资料">
    <nav className="jz-shots-sidebar-tabs" role="tablist" aria-label="镜头制作栏目">{sidebarTabs.map((tab,index) => <IconButton icon={tab.id === "details" ? "text" : "chat"} label={(tab.label)} key={tab.id} type="button" role="tab" id={`${tabsId}-${tab.id}-tab`} aria-controls={`${tabsId}-${tab.id}`} aria-selected={sidebarTab === tab.id} tabIndex={sidebarTab === tab.id ? 0 : -1}
      onClick={() => setSidebarTab(tab.id)} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? sidebarTabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : sidebarTabs.length - 1)) % sidebarTabs.length;
        setSidebarTab(sidebarTabs[next]!.id);
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
      }} />)}</nav>
    <div role="tabpanel" id={`${tabsId}-details`} aria-labelledby={`${tabsId}-details-tab`} hidden={sidebarTab !== "details"} className="jz-shots-tab-content">
    {activeShot && <VideoShotDetailsEditor key={`edit/${activeShot.id}`} project={project} episode={episode} shot={activeShot} remote={remote} busy={busy} run={run} onDraftChange={() => refreshDrafts(value => value + 1)}/>}


    {remote.updateVideoEpisode && episode.shots.some(shot => shot.archived) && <details><summary>已删除镜头</summary>
      {episode.shots.filter(shot => shot.archived).map(shot => <div className="jz-video-tools" key={shot.id}><span>{shot.title}</span>
        <IconButton icon={"undo"} label={"恢复镜头"} type="button" disabled={busy} onClick={() => void run(() => remote.updateVideoEpisode!({ workId: project.workId, episodeId: episode.id, expectedRevision: project.revision,
          patch: { shots: episode.shots.map(item => item.id === shot.id ? { ...item, archived: false } : item) } }), () => { setActiveId(shot.id); })} />
      </div>)}
    </details>}
    </div>
    <div ref={setControlsHost} role="tabpanel" id={`${tabsId}-prompts`} aria-labelledby={`${tabsId}-prompts-tab`} hidden={sidebarTab !== "prompts"} className="jz-shots-tab-content jz-shots-prompt-controls" />
    </aside><div className="jz-shots-divider" role="separator" aria-label="调整镜头资料与播放器宽度" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={65} aria-valuenow={Math.round(split)} tabIndex={0}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); resizing.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (resizing.current) resize(event.clientX); }}
      onPointerUp={event => { resizing.current = false; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { resizing.current = false; }} onLostPointerCapture={() => { resizing.current = false; }}
      onDoubleClick={() => setSplit(38)} onKeyDown={event => { if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); setSplit(value => Math.max(25, Math.min(65, value + (event.key === "ArrowLeft" ? -2 : 2)))); }} />
    <div className="jz-shots-generation">    {activeShot && <VideoShotCard controlsHost={controlsHost} key={activeShot.id} project={project} episode={episode} shot={activeShot} index={shots.indexOf(activeShot)} remote={remote} busy={busy || hasVideoShotDetailsDraft(project.workId,episode.id,activeShot.id)} aspectRatio={aspectRatio} run={run} active={active} selectionRequest={selectionRequest} onDraftChange={() => refreshDrafts((value) => value + 1)} />}</div></div>
  </section></VideoEditorFrame>;
}
