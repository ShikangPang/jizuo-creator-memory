import { userErrorMessage } from "@jizuo/contracts";
import { ActionIcon } from "../ui/ActionIcon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { openWorkStyle } from "./open-work-style.ts";
import { useState, type FormEvent } from "react";
import type { VideoProject } from "@jizuo/contracts";
import type { JizuoContentRemote } from "../content/remote.ts";
import { getSelection, setSelection, useSelection } from "../content/selection.ts";
import { VideoTreeActions } from "./VideoTreeActions.tsx";
import { publishVideoProject } from "./useVideoProject.ts";

export function WorkDesignTree({ project, remote }: { project: VideoProject; remote: JizuoContentRemote }) {
  const selection = useSelection();
  const [expanded, setExpanded] = useState(false);
  const [creatingKind, setCreatingKind] = useState<"character" | "scene" | null>(null);
  const [newName, setNewName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const designs = (project.designs ?? []).filter(item => !item.deletedAt);
  const selected = selection.workId === project.workId && selection.overlay === "video" && selection.videoSection === "assets";
  const open = (designId: string | null = null) => {
    setExpanded(true);
    setSelection({ workId: project.workId, episodeId: null, shotId: null, designId, videoSection: "assets", overlay: "video" });
  };
  const createDesign = async (event: FormEvent) => {
    event.preventDefault();
    if (!creatingKind || !newName.trim() || createBusy || !remote.saveVideoDesign) return;
    setCreateBusy(true); setCreateError("");
    try {
      const next = await remote.saveVideoDesign({ workId: project.workId, expectedRevision: project.revision,
        design: { kind: creatingKind, name: newName.trim(), description: "", version: "初版", locked: false, referenceAssetIds: [] } });
      const created = next.designs?.find(item => item.kind === creatingKind && !project.designs?.some(previous => previous.id === item.id));
      if (!created) throw new Error("新设定未出现在保存结果中，请刷新后重试。");
      publishVideoProject(next);
      setCreatingKind(null); setNewName("");
      open(created.id);
    } catch (cause) { setCreateError(userErrorMessage(cause, "创建设定失败", { operation: "WorkDesignTree" })); }
    finally { setCreateBusy(false); }
  };
  return <div role="treeitem" aria-expanded={expanded}>
    <div className="jz-tree-row" data-selected={selected || undefined}>
      <button type="button" className="jz-tree-chevron" aria-label={`${expanded ? "收起" : "展开"}作品设定库`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{<ActionIcon name={expanded ? "down" : "right"} />}</button>
      <button type="button" className="jz-tree-main" aria-current={selected ? "page" : undefined} onClick={() => open()}>
        <span className="jz-tree-title">设定库</span><span className="jz-tree-count">{designs.length || ""}</span>
      </button>
    </div>
    {expanded && <div role="group" aria-label="作品设定库" className="jz-tree-children chapters">
    <div role="treeitem" className="jz-tree-row" data-selected={selection.workId === project.workId && selection.videoSection === "style" || undefined}>
      <button type="button" className="jz-tree-main" aria-label="作品画风" aria-current={selection.workId === project.workId && selection.videoSection === "style" ? "page" : undefined} onClick={() => openWorkStyle(project.workId)}>
        <span className="jz-tree-title">作品画风</span><span className="jz-tree-count">{project.visualStyle?.name ?? "未设置"}</span>
      </button>
    </div>

      {(["character", "scene"] as const).map(kind => <div role="group" aria-label={kind === "character" ? "人物" : "场景"} key={kind}>
        <div className="jz-tree-row"><span className="jz-tree-title">{kind === "character" ? "人物" : "场景"}</span>
          {remote.saveVideoDesign && <IconButton icon="add" label={`新建${kind === "character" ? "人物" : "场景"}设定`} type="button" disabled={createBusy} onClick={() => { setCreatingKind(kind); setNewName(""); setCreateError(""); }} />}
        </div>
        {creatingKind === kind && <form className="jz-tree-create" aria-label={`新建${kind === "character" ? "人物" : "场景"}设定`} onSubmit={event => { void createDesign(event); }}>
          <input aria-label={`新建${kind === "character" ? "人物" : "场景"}名称`} autoFocus maxLength={120} value={newName} disabled={createBusy} onChange={event => setNewName(event.target.value)} />
          <IconButton icon="add" label="创建" type="submit" disabled={createBusy || !newName.trim()} />
          <IconButton icon="close" label="取消" type="button" disabled={createBusy} onClick={() => setCreatingKind(null)} />
          {createError && <p role="alert">{createError}</p>}
        </form>}
        {designs.filter(item => item.kind === kind).map(design => <div key={design.id} role="treeitem">
          <div className="jz-tree-row" data-selected={selected && selection.designId === design.id || undefined}>
            <VideoTreeActions label={design.name} kind={kind==="character"?"人物":"场景"} disabled={design.locked} detail="将从整个作品的设定库移除，已生成素材保留。"
              rename={remote.saveVideoDesign ? name=>remote.saveVideoDesign!({workId:project.workId,expectedRevision:project.revision,design:{...design,name}}) : undefined}
              remove={remote.deleteVideoItem ? ()=>remote.deleteVideoItem!({workId:project.workId,expectedRevision:project.revision,kind:"design",id:design.id}) : undefined}
              onDeleted={()=>{const current=getSelection();if(current.workId===project.workId&&current.designId===design.id)setSelection({designId:null});}}>
              <button type="button" className="jz-tree-main" aria-current={selected && selection.designId === design.id ? "page" : undefined} onClick={() => open(design.id)}>
                <span className="jz-tree-title">{design.name}</span>
              </button>
            </VideoTreeActions>

          </div>
        </div>)}
        {!designs.some(item => item.kind === kind) && <p className="jz-tree-empty">暂无{kind === "character" ? "人物" : "场景"}</p>}
      </div>)}
    </div>}
  </div>;
}
