import { IconButton } from "../ui/IconButton.tsx";
import { createPortal } from "react-dom";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JizuoContentRemote } from "../content/remote.ts";
import type { ImageChatStore, ImageChatEntry } from "./image-chat-store.ts";
import { ChatImageGenerationCard } from "./ChatImageGenerationCard.tsx";

/** This surface is mounted inside the native transcript, independently of composer mode. */
export function ChatImageConversation({ remote, store, sessionId }: {
  remote: JizuoContentRemote; store: ImageChatStore; sessionId: string;
}) {
  const entries = useSyncExternalStore(listener => store.subscribe(sessionId, listener), () => store.getSnapshot(sessionId));
  const error = useSyncExternalStore(listener => store.subscribe(sessionId, listener), () => store.getError(sessionId));
  if (!entries.length && !error) return null;
  return <section className="jz-chat-image-conversation" aria-label="对话媒体生成记录" data-session-id={sessionId}>
    {entries.map(entry => <TimelineImageEntry key={`${entry.workId}/${entry.id}`} remote={remote} entry={entry} sessionId={sessionId} />)}
    {error && <p role="status">{error} <IconButton icon="reset" label={"刷新进度"} type="button" onClick={() => store.refresh(sessionId)} /></p>}
  </section>;
}


/** Keep portal-owned media at its creation point, rather than below every later text turn. */
function TimelineImageEntry({remote,entry,sessionId}:{remote:JizuoContentRemote;entry:ImageChatEntry;sessionId:string}) {
  const marker=useRef<HTMLSpanElement>(null);
  const [host]=useState(()=>document.createElement("div"));
  useLayoutEffect(()=>{
    const fallback=marker.current?.parentElement;
    const flow=fallback?.closest<HTMLElement>("[data-chat-flow]");
    if(!fallback)return;
    host.dataset.jzMediaEntry=entry.id;
    host.dataset.sessionId=sessionId;
    const time=Date.parse(entry.createdAt);
    const place=()=>{
      const next=flow && Number.isFinite(time) ? Array.from(flow.querySelectorAll<HTMLElement>(":scope > [data-chat-flow-key][data-jz-chat-time]"))
        .find(row=>["user","steering"].includes(row.dataset.chatFlowKind??"") && Number(row.dataset.jzChatTime)>time) : undefined;
      if(next){
        let following=host.nextElementSibling;
        while(following&&!following.hasAttribute("data-chat-flow-key"))following=following.nextElementSibling;
        if(host.parentElement!==flow||following!==next)flow!.insertBefore(host,next);
      }
      else if(host.parentElement!==fallback)fallback.append(host);
    };
    place();
    const observer=new MutationObserver(place);
    if(flow)observer.observe(flow,{childList:true,subtree:true,attributes:true,attributeFilter:["data-jz-chat-time"]});
    return()=>{observer.disconnect();host.remove();};
  },[host,entry.id,entry.createdAt,sessionId]);
  return <><span ref={marker} hidden />{createPortal(<ChatImageGenerationCard remote={remote} workId={entry.workId}
    {...(entry.project ? {project:entry.project} : {})} {...(entry.job ? {job:entry.job} : {})} {...(entry.pending ? {pending:entry.pending} : {})}/>,host)}</>;
}
