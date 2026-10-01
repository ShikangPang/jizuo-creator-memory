import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { VideoClip } from "@jizuo/contracts";
import { timelineLayout, placeClipsOnMainTrack, reconcileVideoTransitions, type TimelineEdit } from "../../../contracts/src/video-editing.ts";

type Row = { layer:number; top:number; height:number };
type Target = { layer:number; top:number; height:number; insert:boolean; blocked:boolean };
export type ClipDragPreview = { ids:string[]; target?:Target; gap?:Target; shifts:Record<string,number>; startSec:number; durationSec:number };
type Options = {
  canvas:RefObject<HTMLDivElement>; scroller:RefObject<HTMLDivElement>; clips:VideoClip[]; span:number;
  revision:number; busy:boolean; trackCount:number; selected:string[];
  pause?: (()=>number) | undefined; apply:(edit:TimelineEdit,revision?:number)=>Promise<unknown>;
};
type Gesture = {
  pointerId:number; element:HTMLButtonElement; x:number; y:number; lastX:number; lastY:number;
  revision:number; clips:VideoClip[]; ids:string[]; selected:Set<string>; rows:Row[]; scale:number; offset:number;
  originLeft:number; originTop:number; layout:ReturnType<typeof timelineLayout>; started:boolean; saving:boolean;
  ghost?:HTMLElement; frame?:number; preview?:ClipDragPreview; edit?:TimelineEdit;
  slot?:{key:string;shifts:Record<string,number>;landing:number;edit?:TimelineEdit};
};

/** Pointer capture keeps internal drags at display refresh rate, including outside the source row. */
export function useVideoClipDrag(options:Options) {
  const latest=useRef(options); latest.current=options;
  const active=useRef<Gesture>();
  const suppressClick=useRef(false);
  const landingRef=useRef<HTMLDivElement>(null);
  const [preview,setPreview]=useState<ClipDragPreview>();
  const clear=(state=active.current) => {
    if (!state || active.current!==state) return;
    active.current=undefined;
    if (state.frame!==undefined) cancelAnimationFrame(state.frame);
    state.ghost?.remove();
    if (state.element.hasPointerCapture?.(state.pointerId)) state.element.releasePointerCapture(state.pointerId);
    setPreview(undefined);
  };
  useEffect(()=>{
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape" && active.current && !active.current.saving){event.preventDefault();clear();}};
    const cancel=()=>{if(!active.current?.saving)clear();};
    window.addEventListener("keydown",escape,true); window.addEventListener("blur",cancel); window.addEventListener("resize",cancel);
    return ()=>{window.removeEventListener("keydown",escape,true);window.removeEventListener("blur",cancel);window.removeEventListener("resize",cancel);clear();};
  },[]);
  useLayoutEffect(()=>{if(active.current && active.current.revision!==options.revision)clear();},[options.revision]);

  const paint=(state:Gesture) => {
    if(active.current!==state || state.saving)return;
    const {canvas,scroller,span,trackCount}=latest.current;
    const area=canvas.current; if(!area)return;
    const bounds=area.getBoundingClientRect();
    const viewport=scroller.current?.getBoundingClientRect();
    const sectionBox=area.closest(".jz-editing-timeline")?.getBoundingClientRect();
    const section=sectionBox?.height ? sectionBox : bounds;
    const x=state.lastX, y=state.lastY;
    const inside=x>=Math.max(bounds.left,viewport?.left ?? bounds.left) && x<=Math.min(bounds.right,viewport?.right || bounds.right) && y>=section.top && y<=section.bottom;
    if(state.ghost)state.ghost.style.transform=`translate3d(${state.originLeft+x-state.x}px,${state.originTop+y-state.y}px,0)`;
    let target:Target|undefined;
    let localY=y-bounds.top;
    const previous=state.preview?.gap;
    // Keep an opened gap stable while the pointer moves through it. Hit-test the original rows.
    if(previous) {
      if(localY>=previous.top-7 && localY<=previous.top+previous.height+7)target=previous;
      else if(localY>previous.top+previous.height)localY-=previous.height;
    }
    const first=state.rows[0], last=state.rows.at(-1);
    if(inside && first && last && !target) {
      const edge=state.rows.find(row=>Math.abs(localY-row.top)<=7);
      if(edge || localY>=last.top+last.height-7 || localY>=first.top-14 && localY<first.top) {
        const layer=edge ? edge.layer>=0 ? edge.layer+1 : edge.layer : localY>=last.top+last.height-7 ? last.layer-1 : first.layer+1;
        target={layer,top:edge?.top ?? (localY>=last.top+last.height-7 ? last.top+last.height : first.top),height:first.height,insert:true,blocked:trackCount>=8};
      } else {
        const row=state.rows.find(row=>localY>=row.top && localY<row.top+row.height);
        if(row)target={...row,insert:false,blocked:false};
      }
    }
    if(!inside)target=undefined;
    const layout=state.layout;
    const moving=layout.clips.filter(item=>state.selected.has(item.clip.id));
    const startSec=Math.max(0,(x-bounds.left)/state.scale-state.offset);
    const durationSec=Math.max(...moving.map(item=>item.startSec+item.durationSec))-Math.min(...moving.map(item=>item.startSec));
    let shifts:Record<string,number>={};
    delete state.edit;
    let landing=startSec;
    try { if(target && !target.blocked) {
      if(target.layer===0 && !target.insert && moving.every(item=>!item.clip.videoLayer)) {
        const rest=layout.mainClips.filter(item=>!state.selected.has(item.clip.id));
        const time=(x-bounds.left)/state.scale;
        const before=rest.find(item=>time<item.startSec+item.durationSec/2);
        const key=`main:${before?.clip.id ?? "end"}`;
        if(state.slot?.key===key) {
          shifts=state.slot.shifts;landing=state.slot.landing;if(state.slot.edit)state.edit=state.slot.edit;
        } else {
        const ids=state.clips.filter(clip=>!state.selected.has(clip.id)).map(clip=>clip.id);
        const index=before ? ids.indexOf(before.clip.id) : rest.length ? ids.indexOf(rest.at(-1)!.clip.id)+1 : 0;
        ids.splice(index,0,...state.ids);
        const byId=new Map(state.clips.map(clip=>[clip.id,clip]));
        const reordered=timelineLayout(reconcileVideoTransitions(state.clips,ids.map(id=>byId.get(id)!)));
        const starts=new Map(layout.mainClips.map(item=>[item.clip.id,item.startSec]));
        for(const item of reordered.mainClips)shifts[item.clip.id]=(item.startSec-starts.get(item.clip.id)!)*state.scale;
        landing=Math.min(...reordered.mainClips.filter(item=>state.ids.includes(item.clip.id)).map(item=>item.startSec));
        if(ids.some((id,i)=>id!==state.clips[i]?.id))state.edit={op:"reorder",clipIds:ids};
        state.slot={key,shifts,landing,...(state.edit?{edit:state.edit}:{})};
        }
      } else {
        state.edit={op:"moveVideoClips",clipIds:state.ids,layer:target.layer,startSec,...(target.insert?{newVideoTrack:true}:{})};
        if(target.layer===0) {
          const placed=timelineLayout(placeClipsOnMainTrack(state.clips,state.ids,startSec));
          for(const item of placed.mainClips){const old=layout.mainClips.find(old=>old.clip.id===item.clip.id);if(old)shifts[item.clip.id]=(item.startSec-old.startSec)*state.scale;}
          landing=Math.min(...placed.mainClips.filter(item=>state.ids.includes(item.clip.id)).map(item=>item.startSec));
        }
      }
    }} catch {delete state.edit;if(target)target={...target,blocked:true};}
    const gap=inside ? target?.insert && !target.blocked ? target : previous : undefined;
    const next:ClipDragPreview={ids:state.ids,...(target?{target}:{}),...(gap?{gap}:{}),shifts,startSec:landing,durationSec};
    // Ghost movement is a compositor-only update; React only renders changed placement feedback.
    const previousPreview=state.preview;state.preview=next;
    if(!previousPreview || JSON.stringify([next.target,next.gap,next.shifts,next.durationSec])!==JSON.stringify([previousPreview.target,previousPreview.gap,previousPreview.shifts,previousPreview.durationSec]))setPreview(next);
    if(landingRef.current)landingRef.current.style.left=`${landing/span*100}%`;
  };
  const tick=(state:Gesture) => {
    if(active.current!==state || state.saving)return;
    const viewport=latest.current.scroller.current, area=latest.current.canvas.current;
    if(viewport && area) {
      const box=viewport.getBoundingClientRect();
      if(viewport.clientWidth && state.lastY>=box.top && state.lastY<=box.bottom) {
        const speed=state.lastX<box.left+36 ? -Math.min(14,(box.left+36-state.lastX)/3) : state.lastX>box.right-36 ? Math.min(14,(state.lastX-box.right+36)/3) : 0;
        viewport.scrollLeft+=speed;
      }
      const section=area.closest<HTMLElement>(".jz-editing-timeline"), visible=section?.getBoundingClientRect();
      if(section && visible && section.scrollHeight>section.clientHeight && state.lastX>=visible.left && state.lastX<=visible.right) {
        section.scrollTop+=state.lastY<box.top+24 ? -10 : state.lastY>visible.bottom-24 ? 10 : 0;
      }
    }
    paint(state); state.frame=requestAnimationFrame(()=>tick(state));
  };
  const begin=(event:PointerEvent<HTMLButtonElement>,clip:VideoClip) => {
    suppressClick.current=false;
    if(latest.current.busy || active.current || event.button!==0 || event.shiftKey)return;
    const area=latest.current.canvas.current; if(!area)return;
    const bounds=area.getBoundingClientRect(); if(!bounds.width)return;
    const ids=latest.current.selected.includes(clip.id) ? latest.current.clips.filter(item=>latest.current.selected.includes(item.id)).map(item=>item.id) : [clip.id];
    const frames=timelineLayout(latest.current.clips).clips.filter(item=>ids.includes(item.clip.id));
    const start=Math.min(...frames.map(item=>item.startSec));
    const rows=[...area.querySelectorAll<HTMLElement>("[data-video-layer]")].map(row=>{const box=row.getBoundingClientRect();return {layer:Number(row.dataset.videoLayer),top:box.top-bounds.top,height:box.height};});
    const scale=bounds.width/latest.current.span;
    const top=Math.min(...frames.map(item=>rows.find(row=>row.layer===(item.clip.videoLayer ?? 0))?.top ?? 0))+2;
    active.current={pointerId:event.pointerId,element:event.currentTarget,x:event.clientX,y:event.clientY,lastX:event.clientX,lastY:event.clientY,revision:latest.current.revision,clips:latest.current.clips,layout:timelineLayout(latest.current.clips),ids,selected:new Set(ids),rows,scale,offset:(event.clientX-bounds.left)/scale-start,originLeft:bounds.left+start*scale,originTop:bounds.top+top,started:false,saving:false};
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move=(event:PointerEvent<HTMLButtonElement>) => {
    const state=active.current; if(!state || state.saving)return;
    state.lastX=event.clientX;state.lastY=event.clientY;
    if(!state.started && Math.hypot(event.clientX-state.x,event.clientY-state.y)<4)return;
    event.preventDefault();event.stopPropagation();
    if(!state.started) {
      state.started=true;suppressClick.current=true;latest.current.pause?.();
      const ghost=document.createElement("div");ghost.className="jz-video-editing jz-pointer-ghost";ghost.setAttribute("aria-hidden","true");
      const area=latest.current.canvas.current!, bounds=area.getBoundingClientRect();
      for(const item of timelineLayout(state.clips).clips.filter(item=>state.ids.includes(item.clip.id))) {
        const original=[...area.querySelectorAll<HTMLElement>("[data-clip-id]")].find(element=>element.dataset.clipId===item.clip.id);
        if(!original)continue;
        const copy=original.cloneNode(true) as HTMLElement;
        copy.removeAttribute("data-clip-id");copy.dataset.selected="true";
        copy.querySelectorAll("button").forEach(button=>{button.tabIndex=-1;button.draggable=false;});
        copy.querySelectorAll(".jz-trim-handle,.jz-track-junction").forEach(element=>element.remove());
        copy.style.left=`${bounds.left+item.startSec*state.scale-state.originLeft}px`;
        copy.style.top=`${bounds.top+(state.rows.find(row=>row.layer===(item.clip.videoLayer ?? 0))?.top ?? 0)+2-state.originTop}px`;
        copy.style.width=`${item.durationSec*state.scale}px`;
        ghost.appendChild(copy);
      }
      document.body.appendChild(ghost);state.ghost=ghost;
      tick(state);
    }
  };
  const end=(event:PointerEvent<HTMLButtonElement>) => {
    const state=active.current;if(!state || state.saving)return;
    if(!state.started){clear(state);return;}
    event.preventDefault();event.stopPropagation();
    state.lastX=event.clientX;state.lastY=event.clientY;paint(state);
    const edit=state.edit;
    if(!edit || latest.current.busy || state.revision!==latest.current.revision){clear(state);return;}
    state.saving=true;
    if(state.frame!==undefined)cancelAnimationFrame(state.frame);
    if(state.element.hasPointerCapture?.(state.pointerId))state.element.releasePointerCapture(state.pointerId);
    const target=state.preview?.target, bounds=latest.current.canvas.current?.getBoundingClientRect();
    if(state.ghost && target && bounds) {
      state.ghost.dataset.settling="true";
      state.ghost.style.transform=`translate3d(${bounds.left+state.preview!.startSec*state.scale}px,${bounds.top+target.top+2}px,0)`;
    }
    void Promise.resolve(latest.current.apply(edit,state.revision)).then(()=>clear(state),()=>clear(state));
  };
  return {preview,landingRef,begin,move,end,cancel:()=>{if(!active.current?.saving)clear();},suppressClick};
}
