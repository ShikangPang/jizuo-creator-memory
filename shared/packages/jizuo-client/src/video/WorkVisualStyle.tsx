import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useSelection } from "../content/selection.ts";
import { useEffect, useRef, useState } from "react";
import type { VideoProject, VisualStyleDraft } from "@jizuo/contracts";
import { visualStylePresets, visualStyleText } from "../../../contracts/src/visual-style.ts";
import type { VideoAssetsRemote } from "./assets-remote.ts";
import { VideoReferencePicker } from "./VideoReferencePicker.tsx";
import { publishVideoProject } from "./useVideoProject.ts";
import "./work-visual-style.css";

const drafts = new Map<string, { base: string; value: VisualStyleDraft }>();
const signature = (project: VideoProject) => JSON.stringify(project.visualStyle ?? null);
function initial(project: VideoProject): VisualStyleDraft {
  if (!project.visualStyle) return structuredClone(visualStylePresets[0]!);
  const { revision: _revision, ...style } = project.visualStyle;
  return style;
}
export function WorkVisualStyle({ project, remote }: { project: VideoProject; remote: VideoAssetsRemote }) {
  return <StyleEditor key={project.workId} project={project} remote={remote}/>;
}
function StyleEditor({ project: incomingProject, remote }: { project: VideoProject; remote: VideoAssetsRemote }) {
  const [savedProject, setSavedProject] = useState(incomingProject);
  const project = incomingProject.revision >= savedProject.revision ? incomingProject : savedProject;
  const selection=useSelection();
  const [scope,setScope]=useState<"current"|"designs"|"episode">("designs");
  const cached = drafts.get(project.workId);
  const [value, setValue] = useState<VisualStyleDraft>(() => cached?.value ?? initial(project));
  const base = useRef(cached?.base ?? signature(project));
  const [dirty, setDirty] = useState(Boolean(cached));
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const conflict = dirty && base.current !== signature(project);
  const update = (patch: Partial<VisualStyleDraft>) => {
    const next = { ...value, ...patch }; setValue(next); setDirty(true); setError("");
    drafts.set(project.workId, { base: base.current, value: next });
  };
  useEffect(() => {
    // Read the current draft, not the dirty value captured by a pending effect.
    if (!drafts.has(project.workId)) { base.current = signature(project); setValue(initial(project)); }
  }, [project.visualStyle, dirty]);
  const reset = () => { drafts.delete(project.workId); base.current = signature(project); setValue(initial(project)); setDirty(false); setError(""); };
  const save = async (style: VisualStyleDraft) => {
    if (busyRef.current || conflict || !remote.saveWorkVisualStyle) return;
    const submittedDraft = drafts.get(project.workId);
    busyRef.current = true; setBusy(true); setError("");
    try {
      const next = await remote.saveWorkVisualStyle({ workId: project.workId, expectedRevision: project.revision, style });
      const pending = drafts.get(project.workId);
      base.current = signature(next);
      setSavedProject(next);
      if (pending && pending !== submittedDraft) {
        drafts.set(project.workId, { base: base.current, value: pending.value });
      } else {
        drafts.delete(project.workId); setValue(initial(next)); setDirty(false);
      }
      publishVideoProject(next);
    } catch (cause) { setError(userErrorMessage(cause, "画风保存失败，原设置未修改", { operation: "WorkVisualStyle" })); }
    finally { busyRef.current = false; setBusy(false); }
  };
  useEffect(() => {
    if (!dirty || busy || conflict || error || !remote.saveWorkVisualStyle || !value.name.trim() || !value.description.trim()) return;
    const timer = window.setTimeout(() => { void save(value); }, 500);
    return () => window.clearTimeout(timer);
  }, [value, dirty, busy, conflict, error, project.revision, remote.saveWorkVisualStyle]);
  const currentWork=selection.workId===project.workId;
  const episode=currentWork?project.episodes.find(item=>item.id===selection.episodeId&&!item.deletedAt):undefined;
  const design=currentWork?project.designs?.find(item=>item.id===selection.designId&&!item.deletedAt):undefined;
  const shot=episode?.shots.find(item=>item.id===selection.shotId&&!item.archived);
  const canAlign=scope==="designs"?Boolean(project.designs?.some(item=>!item.deletedAt)):scope==="episode"?Boolean(episode):Boolean(design||shot);
  const history=project.stylePromptHistory?.at(-1);
  const undo=async()=>{
    if(!history||!remote.undoStyledPrompts||busyRef.current)return;
    busyRef.current=true;setBusy(true);setError("");
    try{publishVideoProject(await remote.undoStyledPrompts({workId:project.workId,expectedRevision:project.revision,historyId:history.id}));}
    catch(cause){setError(userErrorMessage(cause, "撤销失败，现有提示词未修改", { operation: "WorkVisualStyle" }));}
    finally{busyRef.current=false;setBusy(false);}
  };
  return <section className="jz-work-visual-style">
    <div className="jz-work-style-heading"><div><span className="jz-work-style-eyebrow">当前画风</span><h3 title={visualStyleText(project.visualStyle)}>{project.visualStyle?.name ?? "选择作品的视觉风格"}</h3><span className="jz-work-style-status" role="status">{busy ? "正在保存…" : error ? "保存失败 · 修改已保留" : conflict ? "画风冲突 · 修改已保留" : dirty ? "等待自动保存" : project.visualStyle ? "已保存 · 全作品生效" : "尚未设置"}</span></div>
      <div className="jz-work-style-actions">
        <IconButton icon="chat" label={"与 AI 讨论画风"} type="button" disabled={busy} onClick={() => window.dispatchEvent(new CustomEvent("jizuo:work-style-discuss",{detail:{workId:project.workId,scope:"style"}}))} />
        {dirty && <IconButton icon="reset" label={"重新载入画风"} type="button" disabled={busy} onClick={reset} />}
      </div>
    </div>
    <div className="jz-work-visual-style-editor" aria-label="作品画风设置">

      {error && <p role="alert">{error} {dirty && <button type="button" disabled={busy || conflict} onClick={() => setError("")}>重试自动保存</button>}</p>}
      {conflict && <p role="alert">作品画风已在其他位置更新，本地草稿已保留，请重新载入后核对。</p>}
      <div className="jz-work-style-main"><h4>风格设定</h4>
      <label>画风<select value={value.preset} onChange={event => update({ ...structuredClone(visualStylePresets.find(item => item.preset === event.target.value)!), referenceAssetIds: value.referenceAssetIds })}>{visualStylePresets.map(item => <option key={item.preset} value={item.preset}>{item.name}</option>)}</select></label>
      {value.preset === "custom" && <label>画风名称<input value={value.name} maxLength={80} onChange={event => update({ name: event.target.value })}/></label>}
      <label>风格描述<textarea rows={4} maxLength={6000} value={value.description} onChange={event => update({ description: event.target.value })}/></label>
      <label>避免出现<textarea aria-label="画风避免内容" rows={2} maxLength={2000} value={value.avoid} onChange={event => update({ avoid: event.target.value })}/></label>
      </div>
      <div className="jz-work-style-references"><h4>视觉参考</h4><p>添加能体现色彩、笔触或光影的图片。</p>
      <VideoReferencePicker label="画风参考图" assets={project.assets.filter(asset => !asset.deletedAt)} selected={value.referenceAssetIds} onChange={referenceAssetIds => update({ referenceAssetIds })} workId={project.workId} remote={remote} max={8}/>
      <small>从素材库选择，最多 8 张。支持参考图的模型会使用这些图片。</small>
      </div>
      {project.visualStyle && <section className="jz-work-style-align"><h4>按当前画风整理提示词</h4>
        <p>在主聊天中优化并保存所选范围，保留已选素材和剪辑，不生成图片或视频。</p>
        <div className="jz-work-style-scope"><label>整理范围<select value={scope} disabled={busy} onChange={event=>setScope(event.target.value as typeof scope)}><option value="current">当前人物、场景或镜头</option><option value="designs">作品人物与场景</option><option value="episode">当前视频章节</option></select></label>
        <IconButton icon="sparkles" label={"在聊天中整理"} type="button" disabled={busy||dirty||!canAlign} onClick={()=>window.dispatchEvent(new CustomEvent("jizuo:work-style-discuss",{detail:{workId:project.workId,scope,...(scope==="episode"?{episodeId:episode!.id}:scope==="current"?design?{designId:design.id}:{episodeId:episode!.id,shotId:shot!.id}:{})}}))} /></div>
        {dirty&&<small>画风修改自动保存后，即可整理提示词。</small>}
      </section>}
      {history && <details><summary>最近一次提示词整理</summary>
        <p>{history.undone?"已撤销":`已更新 ${history.changes.length} 项提示词，跳过 ${history.skippedIds.length} 个锁定对象。`}</p>
        {!history.undone&&history.changes.length>0&&<IconButton icon="undo" label={"撤销本次整理"} type="button" disabled={busy||!remote.undoStyledPrompts} onClick={()=>void undo()} />}
        {history.changes.map(({edit,before})=><details key={`${edit.kind}/${edit.id}`}><summary>{project.designs?.find(item=>item.id===edit.id)?.name??project.episodes.flatMap(item=>item.shots).find(item=>item.id===edit.id)?.title??"已移除对象"} · {edit.kind==="video"?"视频提示词":"图片提示词"}</summary><label>修改前<textarea readOnly rows={3} value={before??""}/></label><label>修改后<textarea readOnly rows={3} value={edit.prompt}/></label></details>)}
      </details>}

    </div>
  </section>;
}
