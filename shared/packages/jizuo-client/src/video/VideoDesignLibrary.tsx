import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useSelection, setSelection as setContentSelection } from "../content/selection.ts";
import { DeleteVideoItemButton } from "./DeleteVideoItemButton.tsx";
import { VideoPager } from "./VideoPager.tsx";
import { useEffect, useRef, useState } from "react";
import type { VideoAsset, VideoAssetView, VideoDesign, VideoEpisode, VideoJob, VideoProject } from "@jizuo/contracts";
import { VideoAssetPreview } from "./VideoAssetPreview.tsx";
import { VideoErrorNotice } from "./VideoErrorNotice.tsx";
import { PanoramaViewer, type PanoramaCapture } from "./PanoramaViewer.tsx";
import { clearVideoComposerSelection, requestVideoComposer } from "./video-composer-request.ts";
import { PromptTextActions } from "./PromptTextActions.tsx";
import type { VideoAssetsRemote } from "./assets-remote.ts";
import { publishVideoProject } from "./useVideoProject.ts";
import "./video-designs.css";

const views:Record<VideoAssetView,string>={"character-sheet":"六宫格",turnaround:"三视图",front:"正面",side:"侧面",back:"背面",expression:"表情",outfit:"服装",panorama:"360° 环景",detail:"场景画面"};
function blocksDesignView(job: VideoJob, designId: string): boolean {
  if (job.kind !== "image" || job.state?.designId !== designId) return false;
  if (typeof job.state.generationBlocked === "boolean") return job.state.generationBlocked;
  return job.status === "queued" || job.status === "running" || job.status === "uncertain" || job.status === "cancelled" && (job.attempt ?? 0) > 0;
}
function PanoramaAsset({asset,project,remote}:{asset:VideoAsset;project:VideoProject;remote:VideoAssetsRemote}){
  const [url,setUrl]=useState("");const [error,setError]=useState("");
  const [retry, setRetry] = useState(0);
  const getUrl = remote.getVideoAssetUrl;
  useEffect(() => {
    let live = true;
    setUrl(""); setError("");
    if (!getUrl) setError("当前运行时尚不支持环景素材预览，请更新后重试。");
    else void getUrl({ workId: project.workId, assetId: asset.id }).then((result) => {
      if (live) {
        if (!result.url) setError("环景图片地址为空，请重新打开或导入图片。");
        else setUrl(result.url);
      }
    }).catch((cause: unknown) => { if (live) setError(userErrorMessage(cause, "环景加载失败", { operation: "VideoDesignLibrary", effect: "read" })); });
    return () => { live = false; };
  }, [asset.id, project.workId, getUrl, retry]);
  const capture=remote.importVideoAsset?async(value:PanoramaCapture)=>{
    const next=await remote.importVideoAsset!({workId:project.workId,expectedRevision:project.revision,kind:"image",label:`${asset.label} · 取景`.slice(0,120),view:"detail",...(asset.designId?{designId:asset.designId}:{}),...value});
    publishVideoProject(next);
  }:undefined;
  return <div className="jz-design-panorama">{error&&<VideoErrorNotice title="环景无法打开" message={error}>{getUrl&&<div className="jz-video-tools"><IconButton icon="reset" label={"重试打开环景"} type="button" onClick={()=>setRetry(value=>value+1)} /></div>}</VideoErrorNotice>} {url?<PanoramaViewer key={asset.id} url={url} assetId={asset.id} label={asset.label} {...(capture?{onCapture:capture}:{})}/>:!error&&<p role="status">正在打开环景…</p>}</div>;
}

function DesignCard({design,project,remote,selectionRequest,active,pager}:{design:VideoDesign;project:VideoProject;remote:VideoAssetsRemote;selectionRequest:number;active?:boolean | undefined;pager:React.ReactNode}){
  const [busy,setBusy]=useState(false);const busyRef=useRef(false);const [error,setError]=useState("");const [opened,setOpened]=useState<string>();
  const view: VideoAssetView=design.kind==="character"?"character-sheet":"detail";
  const assets=project.assets.filter(asset=>asset.designId===design.id);
  const jobs=project.jobs.filter(job=>blocksDesignView(job,design.id));
  const needsReview = jobs.some(job=>job.status!=="queued"&&job.status!=="running");
  const run=async(action:()=>Promise<VideoProject>)=>{if(busyRef.current)return;busyRef.current=true;setBusy(true);setError("");try{publishVideoProject(await action());}catch(cause){setError(userErrorMessage(cause, "设定操作失败", { operation: "VideoDesignLibrary" }));}finally{busyRef.current=false;setBusy(false);}};
  const appliedSelection = useRef(0);
  const wasActive = useRef(false);
  useEffect(() => {
    if (active === false) { wasActive.current = false; return; }
    const selected = selectionRequest && selectionRequest !== appliedSelection.current;
    const entered = active === true && !wasActive.current;
    wasActive.current = active === true;
    if (selected) appliedSelection.current = selectionRequest;
    if (selected || entered) {
      requestVideoComposer({ workId: project.workId, designId: design.id, view,
        title: design.name, action: "select", kind: "image", promptMode: "reference",
        aspectRatio: design.kind === "character" && !["turnaround", "character-sheet"].includes(view) ? "3:4" : "16:9" });
    }
  }, [selectionRequest, active]);
  return <><div className="jz-design-navigation">{pager}
    <DeleteVideoItemButton remote={remote} input={{workId:project.workId,expectedRevision:project.revision,kind:"design",id:design.id}} label={design.name} detail="已生成的素材仍保留在素材库中。" disabled={busy||design.locked}/>
  </div><section className="jz-design-card"><article className="jz-video-editor" aria-label={`${design.name}`}>
    <div className="jz-design-content">
      {error&&<VideoErrorNotice title="设定操作未完成" message={error}/>}
      <PromptTextActions prompt={design.description} readOnly />
      {design.locked&&remote.saveVideoDesign&&<div className="jz-design-legacy-lock"><small>此设定来自旧版锁定状态。</small><button type="button" disabled={busy} onClick={()=>void run(()=>remote.saveVideoDesign!({workId:project.workId,expectedRevision:project.revision,design:{...design,locked:false}}))}>恢复编辑</button></div>}
      {assets.length > 0 && <small>{assets.length} 个备选 · 新生成会追加保留</small>}
      {jobs.length>0&&<small role="status">{needsReview?"该设定有待核对任务，可在任务记录中处理。":"该设定正在生成图片，仍可准备下一版提示词。"}</small>}
      {assets.length>0&&<div className="jz-video-asset-grid">{assets.map((asset,index)=><figure key={asset.id}><VideoAssetPreview workId={project.workId} asset={asset} remote={remote}/><figcaption>备选 {index + 1} · {asset.view?views[asset.view]:asset.label}</figcaption>
        {asset.panorama&&<IconButton icon="fit" label={(opened===asset.id?"收起环景":"打开环景取景")} type="button" onClick={()=>setOpened(opened===asset.id?undefined:asset.id)} />}
      </figure>)}</div>}
      {opened&&assets.find(asset=>asset.id===opened)?.panorama&&<PanoramaAsset asset={assets.find(asset=>asset.id===opened)!} project={project} remote={remote}/>}
    </div>
  </article></section></>;
}

export function VideoDesignLibrary({project,episode,remote,active}:{project:VideoProject;episode?:VideoEpisode | undefined;remote:VideoAssetsRemote;active?:boolean | undefined}){
  const contentSelection=useSelection();
  const [sourceEpisodeId,setSourceEpisodeId]=useState(episode?.id??"");
  const sourceEpisode=project.episodes.find(item=>item.id===sourceEpisodeId)??episode;
  const [filter,setFilter]=useState<"character"|"scene">("character");const [creation,setCreation]=useState({character:"",scene:""});const name=creation[filter];const setName=(name:string)=>setCreation(current=>({...current,[filter]:name}));const [busy,setBusy]=useState(false);const busyRef=useRef(false);const [error,setError]=useState("");
  const [expandedIds,setExpandedIds]=useState<Record<"character"|"scene",string|null>>(()=>({character:project.designs?.find(design=>design.kind==="character")?.id??null,scene:project.designs?.find(design=>design.kind==="scene")?.id??null}));
  const [selection,setSelection]=useState({id:"",revision:0});
  const selectDesign=(id:string)=>{if(contentSelection.workId===project.workId&&contentSelection.videoSection==="assets")setContentSelection({designId:id});setExpandedIds(current=>({...current,[filter]:id}));setSelection(current=>({id,revision:current.revision+1}));};
  const [search,setSearch]=useState("");
  const appliedTreeSelection=useRef<string>();
  const treeSelectionKey=`${contentSelection.workId}/${contentSelection.designId}`;
  useEffect(()=>{
    if(contentSelection.workId!==project.workId||active===false||!contentSelection.designId)return;
    const selected=project.designs?.find(item=>item.id===contentSelection.designId);
    if(!selected)return;
    appliedTreeSelection.current=treeSelectionKey;
    setFilter(selected.kind);setSearch("");
    setExpandedIds(current=>({...current,[selected.kind]:selected.id}));
    setSelection(current=>({id:selected.id,revision:current.revision+1}));
  },[contentSelection.workId,contentSelection.designId,active,project.workId]);
  const visibleDesigns=(project.designs??[]).filter(design=>design.kind===filter&&`${design.name} ${design.description} ${design.version}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const activeDesign=visibleDesigns.find(design=>design.id===expandedIds[filter])??visibleDesigns[0];
  const pendingTreeSelection=appliedTreeSelection.current!==treeSelectionKey&&contentSelection.workId===project.workId&&contentSelection.designId&&project.designs?.some(item=>item.id===contentSelection.designId)&&activeDesign?.id!==contentSelection.designId;
  useEffect(() => {
    if (active === true && !activeDesign) clearVideoComposerSelection({ workId: project.workId, ...(episode?{episodeId:episode.id}:{}) });
  }, [active, activeDesign?.id, filter, project.workId, episode?.id]);
  const knownDesigns=useRef(new Set((project.designs??[]).map(design=>design.id)));
  useEffect(()=>{
    const added=(project.designs??[]).filter(design=>!knownDesigns.current.has(design.id));
    knownDesigns.current=new Set((project.designs??[]).map(design=>design.id));
    if(added.length)setExpandedIds(current=>({character:added.find(design=>design.kind==="character")?.id??current.character,scene:added.find(design=>design.kind==="scene")?.id??current.scene}));
  },[project.designs]);
  const run=async(action:()=>Promise<VideoProject>)=>{if(busyRef.current)return;busyRef.current=true;setBusy(true);setError("");try{publishVideoProject(await action());}catch(cause){setError(userErrorMessage(cause, "设定操作失败", { operation: "VideoDesignLibrary" }));}finally{busyRef.current=false;setBusy(false);}};
  return <section className="jz-video-design-library jz-video-editor" aria-label="人物与场景设定库">
    <div className="jz-design-start"><div><h3>人物与场景设定</h3><p>选择设定，在主聊天中讨论或使用提示词生成参考图。</p></div>
      {remote.extractVideoDesigns&&sourceEpisode&&<IconButton icon="sparkles" label={(busy?"处理中…":"AI 提取设定")} type="button" className="jz-design-extract" disabled={busy} onClick={()=>void run(()=>remote.extractVideoDesigns!({workId:project.workId,expectedRevision:project.revision,episodeId:sourceEpisode.id}))} />}
    </div>
    {!episode&&remote.extractVideoDesigns&&project.episodes.length>0&&<label>提取来源<select value={sourceEpisodeId} disabled={busy} onChange={event=>setSourceEpisodeId(event.target.value)}><option value="">选择视频章节</option>{project.episodes.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
    <div className="jz-video-tools jz-design-categories">{(["character","scene"] as const).map(kind=><button type="button" key={kind} aria-pressed={filter===kind} onClick={()=>{if(contentSelection.workId===project.workId)setContentSelection({designId:null});setFilter(kind);const selected=(project.designs??[]).find(design=>design.id===expandedIds[kind]&&design.kind===kind)??project.designs?.find(design=>design.kind===kind);if(selected)setSelection(current=>({id:selected.id,revision:current.revision+1}));}}>{kind==="character"?"人物":"场景"} · {(project.designs??[]).filter(design=>design.kind===kind).length}</button>)}</div>
    {error&&<VideoErrorNotice title="设定操作未完成" message={error}/>}
    <label>搜索设定<input type="search" value={search} placeholder="名称或提示词" onChange={event=>setSearch(event.target.value)}/></label>
    {search.trim()&&!visibleDesigns.length&&<p role="status">没有匹配的设定</p>}
    {remote.saveVideoDesign&&<details className="jz-design-create"><summary>新建{filter==="character"?"人物":"场景"}设定</summary><label>名称<input value={name} maxLength={120} disabled={busy} onChange={event=>setName(event.target.value)}/></label><IconButton icon="add" label={"创建设定"} type="button" disabled={busy||!name.trim()} onClick={()=>void run(async()=>{const next=await remote.saveVideoDesign!({workId:project.workId,expectedRevision:project.revision,design:{kind:filter,name:name.trim(),description:"",version:"初版",locked:false,referenceAssetIds:[]}});setName("");return next;})} /></details>}
    {activeDesign&&<DesignCard key={`${project.workId}/${activeDesign.id}`} design={activeDesign} project={project} remote={remote} active={pendingTreeSelection?false:active} selectionRequest={selection.id===activeDesign.id?selection.revision:0} pager={<VideoPager label={filter==="character"?"人物":"场景"} items={visibleDesigns.map(design=>({id:design.id,title:`${design.name}`}))} currentId={activeDesign.id} onChange={selectDesign} disabled={busy}/>}/>}
    {!(project.designs??[]).some(design=>design.kind===filter)&&<p className="jz-video-assets-note">暂无{filter==="character"?"人物":"场景"}设定，可手动新建或从本集原著与剧本提取。</p>}
  </section>;
}
