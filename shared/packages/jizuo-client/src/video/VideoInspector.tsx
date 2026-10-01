import { userErrorMessage } from "@jizuo/contracts";
import { useVideoPanelWidth } from "./useVideoPanelWidth.ts";
import type { StoryboardChatRequest } from "./storyboard-chat.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { WorkVisualStyle } from "./WorkVisualStyle.tsx";
import { useEffect, useRef, useState } from "react";
import type { JizuoContentRemote } from "../content/remote.ts";
import { setSelection, useSelection } from "../content/selection.ts";
import { applyConversationInset, clearConversationInset } from "../overlay/shellChrome.ts";
import { clearVideoComposerSelection } from "./video-composer-request.ts";
import { CreateVideoEpisode } from "./CreateVideoEpisode.tsx";
import { useVideoProject } from "./useVideoProject.ts";
import { VideoStoryboardEditor } from "./VideoStoryboardEditor.tsx";
import { VideoAssetsPanel } from "./VideoAssetsPanel.tsx";
import { VideoDesignLibrary } from "./VideoDesignLibrary.tsx";
import { VideoShotsPanel } from "./VideoShotsPanel.tsx";
import { VideoEditingPanel } from "./VideoEditingPanel.tsx";
import { VideoTaskHistory } from "./VideoTaskHistory.tsx";
import "./video.css";

export interface VideoEpisodeQuote { workId: string; episodeId: string; title: string; text: string }
export interface VideoInspectorProps {
  remote: JizuoContentRemote;
  close?: () => void;
  onGenerateStoryboard?: ((request: StoryboardChatRequest) => Promise<void>) | undefined;
  onQuoteEpisode?: (quote: VideoEpisodeQuote) => void | Promise<void>;
}

export function VideoInspector({ remote, close, onQuoteEpisode, onGenerateStoryboard }: VideoInspectorProps) {
  const selection = useSelection();
  const [expanded, setExpanded] = useState(false);
  const surface = useRef<HTMLElement>(null);
  const panel = useVideoPanelWidth(surface);
  const [creating, setCreating] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const tab = selection.videoSection ?? (selection.episodeId ? "shots" : "assets");
  useEffect(() => { if (tab === "editing") setExpanded(true); }, [tab]);
  const episodePage = tab === "storyboard" || tab === "shots" || tab === "editing";
  const { project, episodes, loading, error, refresh } = useVideoProject(remote, selection.workId,
    episodePage ? selection.episodeId ? {scope:"episode",episodeId:selection.episodeId} : {scope:"overview"} : {scope:"library"});
  const [editingClipId, setEditingClipId] = useState<string>();
  const body = useRef<HTMLDivElement>(null);
  const selectTab = (stage: "storyboard" | "shots" | "assets" | "media" | "editing") => {
    setSelection({ videoSection: stage, ...((stage === "assets" || stage === "media") ? {episodeId:null,shotId:null,designId:null} : stage === "storyboard" ? {shotId:null} : {}) });
    if (body.current) body.current.scrollTop = 0;
  };
  useEffect(() => {
    const openAssets = () => selectTab("media");
    window.addEventListener("jizuo:video-assets", openAssets);
    return () => window.removeEventListener("jizuo:video-assets", openAssets);
  }, []);
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
    if (tab === "storyboard" && selection.workId && selection.episodeId) {
      clearVideoComposerSelection({workId: selection.workId, episodeId: selection.episodeId});
    }
  }, [tab, selection.workId, selection.episodeId]);
  // Changing query scope must not unmount hidden clip forms and discard unsaved input.
  const lastLoaded = useRef(project);
  useEffect(() => { if(project)lastLoaded.current=project; }, [project]);
  const episodeProject = project ?? (lastLoaded.current?.workId===selection.workId ? lastLoaded.current : null);
  const episode = episodeProject?.episodes.find((item) => item.id === selection.episodeId);
  useEffect(() => { setEditingClipId(undefined); }, [selection.workId, selection.episodeId]);
  useEffect(() => {
    if (editingClipId && !episode?.timeline.some(clip => clip.id === editingClipId)) setEditingClipId(undefined);
  }, [editingClipId, episode?.timeline]);
  useEffect(() => {
    const update = () => applyConversationInset(surface.current?.getBoundingClientRect().width || panel.width, false);
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    if (surface.current) observer?.observe(surface.current);
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); clearConversationInset(); };
  }, [expanded, panel.width]);
  useEffect(() => { setCreating(false); setQuoteError(null); }, [selection.workId]);
  const quote = async (): Promise<void> => {
    if (!episode || !project || !onQuoteEpisode) return;
    try {
      await onQuoteEpisode({ workId: project.workId, episodeId: episode.id, title: episode.title,
        text: [`视频集：${episode.title}`, episode.script, ...episode.shots.map((shot, index) => `${index + 1}. ${shot.title}：${shot.description}${shot.dialogue ? `\n对白：${shot.dialogue}` : ""}`)].filter(Boolean).join("\n\n") });
    } catch (cause) { setQuoteError(userErrorMessage(cause, "引用失败，请重试", { operation: "VideoInspector" })); }
  };
  return <section ref={surface} data-plugin="jizuo" data-surface="video-inspector" data-expanded={expanded} style={{ width: expanded ? undefined : panel.width }} aria-label="视频制作">
    {!expanded && <div className="jz-video-resize" role="separator" aria-label="调整工作区与对话框比例" aria-orientation="vertical" aria-valuemin={panel.min} aria-valuemax={panel.max} aria-valuenow={panel.width} tabIndex={0} title="拖动调整宽度，双击恢复默认" onPointerDown={panel.startDrag} onKeyDown={panel.onKeyDown} onDoubleClick={panel.reset} />}
    <header className="jz-video-header"><div><h2>{tab === "style" ? "作品画风" : tab === "media" ? "素材库" : tab === "assets" ? "作品设定库" : episode?.title ?? "视频制作"}</h2><p>{tab === "style" ? "全作品统一应用于人物、场景、镜头图片和视频" : tab === "media" ? `${project?.assets.length ?? 0} 项素材 · 图片、视频与音频` : tab === "assets" ? "人物与场景供整个作品共用" : episode ? `${episode.shots.length} 个镜头 · ${episode.sourceChapters.length} 个原著章节` : "将作品整理为视频集"}</p></div>
      <div className="jz-video-tools">
        <IconButton icon="fit" label={(expanded ? "并排聊天" : "展开工作区")} type="button" aria-pressed={expanded} onClick={() => setExpanded(value => !value)} />
        {episodePage && project && episode && <VideoTaskHistory key={`${project.workId}/${episode.id}`} project={project} episode={episode} remote={remote} />}
        {episodePage && episode && onQuoteEpisode && <IconButton icon="chat" label={"引用到 AI"} type="button" onClick={() => { void quote(); }} />}
        {tab !== "style" && remote.createVideoEpisode && selection.workId && <IconButton icon="add" label={"新建视频集"} type="button" onClick={() => setCreating(true)} />}
        <IconButton icon="close" label={"关闭视频制作"} type="button" aria-label="关闭视频制作" onClick={() => { setSelection({ overlay: null }); close?.(); }} />
      </div>
    </header>
    {episodePage && episode && <div className="jz-video-context-bar">
      <p className="jz-video-current-target">当前：{episode.title}{selection.shotId && episode.shots.find(item => item.id === selection.shotId) ? ` / ${episode.shots.find(item => item.id === selection.shotId)!.title}` : ""}</p>
      <nav aria-label="视频制作阶段" className="jz-video-stage-nav">
        {([ ["storyboard", "制作稿"], ["shots", "镜头制作"], ["editing", "剪辑与导出"] ] as const).map(([stage, label], index) => <button key={stage} type="button" aria-current={tab === stage ? "page" : undefined} onClick={() => selectTab(stage)}><span aria-hidden="true">{index + 1}</span>{label}</button>)}
      </nav>
    </div>}
    <div ref={body} className="jz-video-body">
      {creating && selection.workId && <CreateVideoEpisode key={selection.workId} remote={remote} workId={selection.workId} close={() => setCreating(false)} />}
      {loading && <p role="status">正在加载视频集…</p>}
      {error && <p role="alert">{error} <IconButton icon="reset" label={"重试"} type="button" onClick={refresh} /></p>}
      {quoteError && <p role="alert">{quoteError}</p>}
      {!loading && project && !episode && episodePage && <div className="jz-video-empty"><h3>{episodes.length ? "选择一个视频集" : "还没有视频集"}</h3><p>{episodes.length ? "从左侧目录选择视频集，查看制作进度。" : "新建视频集，开始整理制作稿和镜头。"}</p>
        {episodes.map((item) => <button key={item.id} type="button" onClick={() => setSelection({ episodeId: item.id, overlay: "video" })}>{item.title}</button>)}
      </div>}
      {project && tab === "style" && <div id="video-panel-style" role="region" aria-label="作品画风">
        <WorkVisualStyle key={`style/${project.workId}`} project={project} remote={remote}/>
      </div>}
      {project && tab === "media" && <div id="video-panel-media" role="region" aria-label="素材库">
        <VideoAssetsPanel key={`media/${project.workId}`} project={project} remote={remote}/>
      </div>}
      {project && <div id="video-panel-assets" role="region" aria-label="设定库" hidden={tab !== "assets"}>
        <VideoDesignLibrary key={`assets/${project.workId}`} project={project} remote={remote} active={tab === "assets"}/>
      </div>}
      {episode && <>
        <div id="video-panel-storyboard" role="region" aria-label="剧本与制作稿" hidden={tab !== "storyboard"}>
          {episodeProject && <VideoStoryboardEditor key={`${episodeProject.workId}/${episode.id}`} project={episodeProject} episode={episode} remote={remote} onGenerateStoryboard={onGenerateStoryboard} />}
        </div>
        <div id="video-panel-shots" role="region" aria-label="镜头" hidden={tab !== "shots"}>
          {episodeProject && <VideoShotsPanel key={`shots/${episodeProject.workId}/${episode.id}`} project={episodeProject} episode={episode} remote={remote} active={tab === "shots"} />}
        </div>
        <div id="video-panel-editing" role="region" aria-label="剪辑" hidden={tab !== "editing"}>
          {episodeProject && <VideoEditingPanel episodes={episodes} key={`editing/${episodeProject.workId}/${episode.id}`} project={episodeProject} episode={episode} remote={remote} active={tab === "editing"} selectedClipId={editingClipId} onSelectClip={setEditingClipId} />}
        </div>
      </>}
    </div>
  </section>;
}
