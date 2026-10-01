import { userErrorMessage } from "@jizuo/contracts";
import { ActionIcon } from "../ui/ActionIcon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { VideoTreeActions } from "./VideoTreeActions.tsx";
import { WorkDesignTree } from "./WorkDesignTree.tsx";
import { useEffect, useState } from "react";
import type { VideoAsset } from "@jizuo/contracts";
import type { JizuoContentRemote } from "../content/remote.ts";
import { getSelection, setSelection, useSelection, rememberedEpisodePage, rememberedEpisodeShot } from "../content/selection.ts";
import { CreateVideoEpisode } from "./CreateVideoEpisode.tsx";
import { useVideoProject } from "./useVideoProject.ts";
import { VideoImageViewer } from "./VideoImageViewer.tsx";
import { writeWorkImageDrag } from "./work-image-drag.ts";
import "./video.css";

function TreeImageViewer({ remote, workId, asset, close }: { remote: JizuoContentRemote; workId: string; asset: VideoAsset; close: () => void }) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!remote.getVideoAssetUrl) throw new Error("当前运行时无法预览素材");
      return remote.getVideoAssetUrl({ workId, assetId: asset.id });
    }).then(result => { if (active) setUrl(result.url); })
      .catch((cause: unknown) => { if (active) setError(userErrorMessage(cause, "素材预览失败", { operation: "VideoEpisodeTree", effect: "read" })); });
    return () => { active = false; };
  }, [remote, workId, asset.id]);
  return url ? <VideoImageViewer url={url} label={asset.label} onClose={close} />
    : <p className="jz-tree-empty" role={error ? "alert" : "status"}>{error ?? "正在打开图片…"}<IconButton icon="close" label={"关闭"} type="button" onClick={close} /></p>;
}

export function VideoEpisodeTree({ remote, workId }: { remote: JizuoContentRemote; workId: string }) {
  const selection = useSelection();
  const { project, episodes, error, loading, refresh, autoRetry } = useVideoProject(remote, workId, {scope:"overview"});
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [episodesExpanded, setEpisodesExpanded] = useState(true);
  const [expandedImagesWorkId, setExpandedImagesWorkId] = useState<string | null>(null);
  const [openedImage, setOpenedImage] = useState<{ workId: string; assetId: string }>();
  const images = project?.assets.filter(asset => asset.kind === "image" && !asset.panorama && !asset.deletedAt) ?? [];
  const imagesExpanded = expandedImagesWorkId === workId;
  const viewingImage = openedImage?.workId === workId ? images.find(asset => asset.id === openedImage.assetId) : undefined;
  return <div className="jz-video-tree" role="group" aria-label="视频集目录">
    {loading && <p className="jz-tree-empty">正在加载视频集…</p>}
    {error && <p className="jz-sidebar-error" role="alert">{error}{autoRetry && <span>正在自动重试，也可立即重试。</span>}<IconButton icon="reset" label={"重试"} type="button" onClick={refresh} /></p>}
    {project && <WorkDesignTree key={workId} project={project} remote={remote}/>}
    {project && <div role="treeitem" aria-expanded={imagesExpanded}>
      <div className="jz-tree-row" data-selected={selection.workId === workId && selection.videoSection === "media" || undefined}>
        <button type="button" className="jz-tree-chevron" aria-label={`${imagesExpanded ? "收起" : "展开"}素材库`} aria-expanded={imagesExpanded} onClick={() => setExpandedImagesWorkId(imagesExpanded ? null : workId)}><ActionIcon name={imagesExpanded ? "down" : "right"} /></button>
        <button type="button" className="jz-tree-main" aria-label="素材库" aria-current={selection.workId === workId && selection.videoSection === "media" ? "page" : undefined} onClick={() => setSelection({workId, episodeId: null, shotId: null, designId: null, videoSection: "media", overlay: "video"})}>
          <span className="jz-tree-title">素材库</span><span className="jz-tree-count">{project.assets.length || ""}</span>
        </button>
      </div>
      {imagesExpanded && <div className="jz-tree-children chapters" role="group" aria-label="图片素材">
        {images.map(asset => <div key={asset.id} role="treeitem" className="jz-tree-row">
          <VideoTreeActions label={asset.label} kind="素材" detail="素材将从素材库移除；仍被引用时会提示先解除引用。"
            rename={remote.renameVideoAsset ? label=>remote.renameVideoAsset!({workId,assetId:asset.id,expectedRevision:project!.revision,label}) : undefined}
            remove={remote.deleteVideoItem ? ()=>remote.deleteVideoItem!({workId,id:asset.id,kind:"asset",expectedRevision:project!.revision}) : undefined}>
            <button type="button" className="jz-tree-main" aria-label={`查看${asset.label}大图`} title="点击查看大图，拖到聊天框添加参考图片"
              draggable onDragStart={event => writeWorkImageDrag(event.dataTransfer, { workId, assetId: asset.id })}
              onClick={() => setOpenedImage({ workId, assetId: asset.id })}>
              <span className="jz-tree-title">{asset.label}</span>
            </button>
          </VideoTreeActions>

        </div>)}
      </div>}
    </div>}
    {project && <div role="treeitem" aria-expanded={episodesExpanded}>
      <div className="jz-tree-row">
        <button type="button" className="jz-tree-chevron" aria-label={`${episodesExpanded ? "收起" : "展开"}视频集`} aria-expanded={episodesExpanded} onClick={() => setEpisodesExpanded(value => !value)}><ActionIcon name={episodesExpanded ? "down" : "right"} /></button>
        <button type="button" className="jz-tree-main" onClick={() => setEpisodesExpanded(value => !value)}>
          <span className="jz-tree-title">视频集</span><span className="jz-tree-count">{episodes.length || ""}</span>
        </button>
        {remote.createVideoEpisode && <IconButton icon="add" label="新建视频集" type="button" onClick={() => { setEpisodesExpanded(true); setCreating(true); }} />}
      </div>
      {episodesExpanded && <div role="group" aria-label="视频集列表" className="jz-tree-children chapters">
    {!loading && episodes.length === 0 && <p className="jz-tree-empty">暂无视频集</p>}
    {episodes.map((episode, index) => {
      const selected = selection.workId === workId && selection.episodeId === episode.id && selection.videoSection !== "style";
      const open = expanded.has(episode.id);
      const shots = episode.shots.filter(shot => !shot.archived);
      const choose = (videoSection: "storyboard" | "shots" | "editing", shotId?: string) => {
        setExpanded(current => new Set(current).add(episode.id));
        setSelection({ workId, episodeId: episode.id, designId: null, shotId: videoSection === "storyboard" ? null : shotId ?? shots.find(shot => shot.id === (selection.workId === workId && selection.episodeId === episode.id ? selection.shotId : null))?.id ?? shots.find(shot => shot.id === rememberedEpisodeShot(workId, episode.id))?.id ?? shots[0]?.id ?? null, videoSection, overlay: "video" });
      };
      return <div key={episode.id} role="treeitem" aria-expanded={open}>
        <div className="jz-tree-row" data-selected={selected || undefined}>
          <button type="button" className="jz-tree-chevron" aria-label={`${open ? "收起" : "展开"}${episode.title}`} aria-expanded={open}
            onClick={() => setExpanded(current => { const next = new Set(current); if (open) next.delete(episode.id); else next.add(episode.id); return next; })}><ActionIcon name={open ? "down" : "right"} /></button>
          <VideoTreeActions label={episode.title} kind="视频集" detail="视频集将从目录移除，已有素材与历史记录会保留。"
            rename={remote.updateVideoEpisode ? title=>remote.updateVideoEpisode!({workId,episodeId:episode.id,expectedRevision:project.revision,patch:{title}}) : undefined}
            remove={remote.deleteVideoEpisode ? ()=>remote.deleteVideoEpisode!({workId,episodeId:episode.id,expectedRevision:project.revision}) : undefined}
            onDeleted={next=>{const current=getSelection();if(current.workId===workId&&current.episodeId===episode.id)setSelection({episodeId:next.episodes.find(item=>!item.deletedAt)?.id??null,shotId:null,videoSection:next.episodes.some(item=>!item.deletedAt)?"shots":"assets"});}}>
            <button type="button" className="jz-tree-main" aria-current={selected ? "true" : undefined} onClick={() => choose(selected && (selection.videoSection === "editing" || selection.videoSection === "storyboard") ? selection.videoSection : rememberedEpisodePage(workId, episode.id))}>
              <span className="jz-video-episode-number">{String(index + 1).padStart(2, "0")}</span><span className="jz-tree-title">{episode.title}</span><span className="jz-tree-count">{episode.shots.filter(shot => !shot.archived).length || ""}</span>
            </button>
          </VideoTreeActions>

        </div>
        {open && <div className="jz-tree-children chapters" role="group" aria-label={`${episode.title}制作目录`}>
          <div role="treeitem" className="jz-tree-row" data-selected={selected && selection.videoSection === "storyboard" || undefined}>
            <button type="button" className="jz-tree-main" aria-current={selected && selection.videoSection === "storyboard" ? "page" : undefined} onClick={() => choose("storyboard")}><span className="jz-tree-title">剧本与制作稿</span></button>
          </div>
          <div role="treeitem" aria-expanded={true}>
            <div className="jz-tree-row"><button type="button" className="jz-tree-main" onClick={() => choose("shots")}><span className="jz-tree-title">镜头</span></button></div>
            <div role="group" aria-label={`${episode.title}镜头列表`} className="jz-tree-children chapters">
              {shots.map((shot, shotIndex) => {
                const assets = project.assets.filter(asset => !asset.deletedAt && (asset.episodeId === episode.id && asset.shotId === shot.id || asset.id === shot.imageAssetId || asset.id === shot.videoAssetId));
                const generated = assets.some(asset => asset.kind === "video") ? "已有视频" : assets.some(asset => asset.kind === "image" && !asset.panorama && !asset.deletedAt) ? "已有图片" : "";
                const current = selected && (selection.videoSection ?? "shots") === "shots" && selection.shotId === shot.id;
                return <div key={shot.id} role="treeitem" className="jz-tree-row" data-selected={current || undefined}>
                  <VideoTreeActions label={shot.title} kind="镜头" disabled={shot.locked} detail="镜头将从目录移除，已生成素材保留。"
                    rename={remote.updateVideoEpisode ? async title=>{
                      // Directory summaries must never replace complete shot records.
                      const latest=remote.getVideoProjectView
                        ? (await remote.getVideoProjectView({workId,scope:"episode",episodeId:episode.id})).project
                        : await remote.getVideoProject!({workId});
                      const current=latest.episodes.find(item=>item.id===episode.id && !item.deletedAt);
                      if(!current?.shots.some(item=>item.id===shot.id && !item.archived))throw new Error("镜头已不存在，请刷新目录");
                      return remote.updateVideoEpisode!({workId,episodeId:episode.id,expectedRevision:latest.revision,patch:{shots:current.shots.map(item=>item.id===shot.id?{...item,title}:item)}});
                    } : undefined}
                    remove={remote.deleteVideoItem ? ()=>remote.deleteVideoItem!({workId,id:shot.id,kind:"shot",expectedRevision:project.revision}) : undefined}
                    onDeleted={next=>{const current=getSelection();if(current.workId===workId&&current.episodeId===episode.id&&current.shotId===shot.id)setSelection({shotId:next.episodes.find(item=>item.id===episode.id)?.shots.find(item=>!item.archived)?.id??null});}}>
                    <button type="button" className="jz-tree-main" aria-current={current ? "page" : undefined} onClick={() => choose("shots", shot.id)} title={shot.title}>
                      <span className="jz-video-episode-number">{String(shotIndex + 1).padStart(2, "0")}</span><span className="jz-tree-title">{shot.title}</span>
                      {generated && <small className="jz-video-shot-result">{generated}</small>}
                    </button>
                  </VideoTreeActions>
                </div>;
              })}
              {!shots.length && <p className="jz-tree-empty">暂无镜头</p>}
            </div>
          </div>
          <div role="treeitem" className="jz-tree-row" data-selected={selected && selection.videoSection === "editing" || undefined}>
            <button type="button" className="jz-tree-main" aria-current={selected && selection.videoSection === "editing" ? "page" : undefined} onClick={() => choose("editing")}><span className="jz-tree-title">剪辑</span></button>
          </div>
        </div>}

      </div>;
    })}
    {creating && <CreateVideoEpisode remote={remote} workId={workId} close={() => setCreating(false)} />}
      </div>}
    </div>}
    {viewingImage && <TreeImageViewer key={`${workId}/${viewingImage.id}`} remote={remote} workId={workId} asset={viewingImage} close={() => setOpenedImage(undefined)} />}
  </div>;
}
