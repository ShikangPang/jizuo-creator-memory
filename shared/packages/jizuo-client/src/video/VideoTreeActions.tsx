import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { VideoProject } from "@jizuo/contracts";
import { InlineNameEditor } from "../ui/InlineNameEditor.tsx";
import { publishVideoProject } from "./useVideoProject.ts";

/** Shared sidebar actions; the domain remains responsible for locks and reference checks. */
export function VideoTreeActions({label, kind, disabled=false, rename, remove, detail, onDeleted, children}: {
  children: ReactNode; label:string; kind:string; disabled?:boolean; detail:string;
  rename?:((name:string)=>Promise<VideoProject>) | undefined; remove?:(()=>Promise<VideoProject>) | undefined;
  onDeleted?:(project:VideoProject)=>void;
}) {
  const [menu,setMenu]=useState(false);
  const [mode,setMode]=useState<"rename"|"delete">();
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const previousMode=useRef(mode);
  const pending=useRef(false), root=useRef<HTMLDivElement>(null), trigger=useRef<HTMLButtonElement>(null), dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(previousMode.current && !mode)trigger.current?.focus();previousMode.current=mode;},[mode]);
  useEffect(()=>{
    if(!menu)return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const close=(event:MouseEvent)=>{if(!root.current?.contains(event.target as Node))setMenu(false);};
    document.addEventListener("click",close,true);
    return ()=>document.removeEventListener("click",close,true);
  },[menu]);
  useEffect(()=>{if(mode==="delete")dialog.current?.showModal();},[mode]);
  const close=()=>{if(pending.current)return;setMode(undefined);setError("");trigger.current?.focus();};
  const begin=(value:"rename"|"delete")=>{setMenu(false);setError("");setMode(value);};
  const save=async()=>{
    if(pending.current || disabled)return;
    pending.current=true;setBusy(true);setError("");
    try {
      const next=await remove!();
      if(mode==="delete")onDeleted?.(next);
      publishVideoProject(next);setMode(undefined);trigger.current?.focus();
    }catch(cause){setError(userErrorMessage(cause, "操作失败，请重试", { operation: "VideoTreeActions" }));}
    finally{pending.current=false;setBusy(false);}
  };
  if(!rename&&!remove)return <>{children}</>;
  return <>
    {mode === "rename" ? <InlineNameEditor value={label} label={`重命名${kind}`} disabled={disabled} onCancel={close}
      onSave={async name => { const next = await rename!(name); publishVideoProject(next); close(); }}/> : children}
    <div ref={root} className="jz-tree-actions jz-video-tree-actions" data-open={menu||Boolean(mode)||undefined}>
    <IconButton icon="more" label={(`打开“${label}”操作菜单`)} ref={trigger} type="button" className="jz-row-action" aria-label={`打开“${label}”操作菜单`} aria-haspopup="menu" aria-expanded={menu}
      disabled={mode === "rename"} onClick={()=>setMenu(value=>!value)} onKeyDown={event=>{if(event.key==="ArrowDown"){event.preventDefault();setMenu(true);}}} />
    {menu&&<div className="jz-row-menu" role="menu" aria-label={`${label}操作`} onKeyDown={event=>{
      const items=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      if(event.key==="Escape"){setMenu(false);trigger.current?.focus();}
      if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();const index=items.indexOf(document.activeElement as HTMLButtonElement);items[(index+(event.key==="ArrowDown"?1:items.length-1))%items.length]?.focus();}
      if(event.key==="Tab")setMenu(false);
    }}>
      {rename&&<IconButton icon="edit" label={"重命名" + (kind)} type="button" role="menuitem" disabled={disabled} onClick={()=>begin("rename")} />}
      {remove&&<IconButton icon="delete" label={"删除" + (kind)} type="button" role="menuitem" className="danger" disabled={disabled} onClick={()=>begin("delete")} />}
    </div>}
    {mode==="delete"&&<dialog ref={dialog} className="jz-confirm-dialog jz-video-tree-dialog" aria-label={`删除${label}`} onCancel={event=>{event.preventDefault();close();}}>
      <form onSubmit={event=>{event.preventDefault();void save();}}>
        <h3>删除「{label}」？</h3>
        <p>{detail}</p>
        {error&&<p role="alert">{error}</p>}
        <div className="jz-video-tools"><IconButton icon="close" label={"取消"} type="button" disabled={busy} onClick={close} /><IconButton icon="delete" label={(busy?"正在删除…":"确认删除")} type="submit" className="danger primary" disabled={busy||disabled} /></div>
      </form>
    </dialog>}
  </div></>;
}
