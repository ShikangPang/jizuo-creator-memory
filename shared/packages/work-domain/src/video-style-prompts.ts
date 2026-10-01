import { randomUUID } from "node:crypto";
import { JizuoError, type VideoProject } from "@jizuo/contracts";
import { type SaveStyledPromptsInput, type StyledPromptEdit, type StyledPromptHistory } from "../../contracts/src/visual-style.ts";

function target(project: VideoProject, edit: StyledPromptEdit) {
  if(edit.kind === "design") {
    const design=project.designs?.find(item=>item.id===edit.id&&!item.deletedAt);
    if(!design)throw new JizuoError("validation_error","整理目标设定已不存在");
    return {locked:design.locked,read:()=>design.description,set:(text:string|undefined)=>{design.description=text??"";}};
  }
  const shot=project.episodes.find(item=>item.id===edit.episodeId&&!item.deletedAt)?.shots.find(item=>item.id===edit.id&&!item.archived);
  if(!shot)throw new JizuoError("validation_error","整理目标镜头已不存在");
  return {locked:shot.locked||shot.promptLocked,read:()=>edit.kind==="image"?shot.prompt:shot.videoPrompt,
    set:(text:string|undefined)=>{if(edit.kind==="image")shot.prompt=text??"";else if(text===undefined)delete shot.videoPrompt;else shot.videoPrompt=text;}};
}
export function saveStyledPrompts(project: VideoProject, input: SaveStyledPromptsInput): void {
  if(!project.visualStyle || project.visualStyle.revision!==input.styleRevision)throw new JizuoError("revision_conflict","作品画风已变化，请读取最新画风后重新整理");
  const unique=new Set(input.edits.map(edit=>`${edit.kind}/${edit.id}`));
  if(unique.size!==input.edits.length)throw new JizuoError("validation_error","同一提示词不能在一次整理中重复修改");
  const history: StyledPromptHistory={id:randomUUID(),createdAt:new Date().toISOString(),styleRevision:input.styleRevision,changes:[],skippedIds:[]};
  for(const edit of input.edits) {
    const item=target(project,edit);
    if(item.locked){if(!history.skippedIds.includes(edit.id))history.skippedIds.push(edit.id);continue;}
    const before=item.read();
    if(before===edit.prompt)continue;
    history.changes.push({edit,...(before!==undefined?{before}:{})});item.set(edit.prompt);
  }
  project.stylePromptHistory=[...(project.stylePromptHistory??[]),history].slice(-20);
}
export function undoStyledPrompts(project: VideoProject, historyId: string): void {
  const history=project.stylePromptHistory?.find(item=>item.id===historyId&&!item.undone);
  if(!history)throw new JizuoError("validation_error","提示词整理记录不存在或已撤销");
  // Validate every target before changing any, so partial restoration cannot overwrite later edits.
  const targets=history.changes.map(change=>({change,item:target(project,change.edit)}));
  if(targets.some(({change,item})=>item.locked||item.read()!==change.edit.prompt))throw new JizuoError("revision_conflict","提示词已修改或锁定，不能覆盖后续修改；原文仍保留在整理记录中");
  for(const {change,item} of targets)item.set(change.before);
  history.undone=true;
}
