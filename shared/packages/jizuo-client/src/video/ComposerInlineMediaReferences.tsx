import { useEffect, useRef } from "react";
import type { VideoProject } from "@jizuo/contracts";
import type { JizuoContentRemote } from "../content/remote.ts";
import { decodeVideoImage, VIDEO_IMAGE_SOURCE, VIDEO_VIDEO_SOURCE, VIDEO_AUDIO_SOURCE } from "./main-video-composer.ts";
import "./composer-inline-media-references.css";

/** Native chips retain ownership of reference IDs and serialization. Previews live outside the editor. */
export function ComposerInlineMediaReferences({ remote, project, occurrences, imageIds, videoIds }: {
 remote: JizuoContentRemote; project: VideoProject; occurrences: readonly {source:string;ref:string;invalid?:boolean}[]; imageIds:readonly string[];videoIds:readonly string[];
}) {
 const marker=useRef<HTMLSpanElement>(null);
 const signature=JSON.stringify([project.workId,occurrences,imageIds,videoIds,project.assets.map(a=>[a.id,a.kind,a.label])]);
 useEffect(()=>{
  const card=marker.current?.closest("[data-composer-card]");
  const loadAsset=remote.getVideoAssetUrl;if(!card||!loadAsset)return;
  let active=true, popup:HTMLDivElement|undefined, trigger:HTMLElement|undefined;
  let closeTimer:ReturnType<typeof setTimeout>|undefined;
  const decorations=new Map<HTMLElement,HTMLSpanElement>();
  const urls=new Map<string,Promise<string|undefined>>();
  const audioIds=[...new Set(occurrences.filter(o=>o.source===VIDEO_AUDIO_SOURCE&&!o.invalid).map(o=>decodeVideoImage(o.ref)).filter(r=>r?.workId===project.workId).map(r=>r!.assetId))];
  const keep=()=>{clearTimeout(closeTimer);};
  const close=()=>{keep();popup?.querySelectorAll("audio,video").forEach(m=>{(m as HTMLMediaElement).pause();});popup?.remove();popup=undefined;trigger?.setAttribute("aria-expanded","false");trigger=undefined;};
  const later=()=>{keep();closeTimer=setTimeout(close,200);};
  const getUrl=(id:string)=>{
   if(!urls.has(id))urls.set(id,loadAsset({workId:project.workId,assetId:id}).then(r=>r.url).catch(()=>{urls.delete(id);return undefined;}));
   return urls.get(id)!;
  };
  const show=(node:HTMLElement,asset:VideoProject["assets"][number],label:string)=>{
   keep();if(trigger===node)return;close();trigger=node;node.setAttribute("aria-expanded","true");
   const panel=document.createElement("div");popup=panel;panel.tabIndex=-1;panel.className=`jz-media-reference-popover is-${asset.kind}`;panel.setAttribute("role","dialog");panel.setAttribute("aria-label",`${label}预览`);
   const header=document.createElement("header");header.className="jz-media-reference-popover-header";panel.append(header);
   const title=document.createElement("div");title.className="jz-media-reference-popover-title";header.append(title);
   const badge=document.createElement("strong");badge.textContent=label;title.append(badge);
   const name=document.createElement("span");name.textContent=asset.label;name.title=asset.label;title.append(name);
   const dismiss=document.createElement("button");dismiss.type="button";dismiss.textContent="×";dismiss.setAttribute("aria-label","关闭预览");dismiss.onclick=()=>{const previous=trigger;previous?.focus();close();};header.append(dismiss);
   const body=document.createElement("div");body.className="jz-media-reference-popover-body";panel.append(body);
   const status=document.createElement("span");status.setAttribute("role","status");status.textContent="正在加载预览…";body.append(status);
   panel.onmouseenter=keep;panel.onmouseleave=later;panel.addEventListener("focusin",keep);panel.addEventListener("focusout",e=>{if(!panel.contains(e.relatedTarget as Node))later();});
   document.body.append(panel);
   const rect=node.getBoundingClientRect();const width=Math.max(0,Math.min(asset.kind==="audio"?340:420,window.innerWidth-24));
   const above=rect.top-22,below=window.innerHeight-rect.bottom-22;
   const useAbove=above>=Math.min(asset.kind==="audio"?150:340,below)||above>below;
   panel.style.width=`${width}px`;panel.style.left=`${Math.max(12,Math.min(rect.left+rect.width/2-width/2,window.innerWidth-width-12))}px`;
   panel.style.maxHeight=`${Math.max(0,useAbove?above:below)}px`;
   if(useAbove)panel.style.bottom=`${window.innerHeight-rect.top+10}px`;else panel.style.top=`${rect.bottom+10}px`;
   void getUrl(asset.id).then(url=>{
    if(!active||popup!==panel)return;
    if(!url){status.textContent="预览加载失败，请关闭后重试";return;}
    const media=document.createElement(asset.kind==="image"?"img":asset.kind==="video"?"video":"audio");
    media.setAttribute("aria-label",`${label}预览内容`);
    if(media instanceof HTMLImageElement){media.alt=asset.label;media.draggable=false;}else{media.controls=true;media.preload="metadata";if(media instanceof HTMLVideoElement)media.playsInline=true;}
    media.onerror=()=>{media.remove();status.textContent="素材暂时无法预览，请关闭后重试";};media.setAttribute("src",url);status.textContent="";body.append(media);
   });
  };
  const decorate=()=>{
   const chips=Array.from(card.querySelectorAll<HTMLElement>("[data-composer-input] [data-composer-chip]"));
   if(chips.length!==occurrences.length){close();for(const node of decorations.values())node.remove();decorations.clear();return;}
   for(const [chip,node] of decorations)if(!chip.isConnected){if(trigger===node)close();decorations.delete(chip);}
   chips.forEach((chip,index)=>{
    const occurrence=occurrences[index];if(!occurrence||occurrence.invalid||chip.dataset.composerChip!==occurrence.source)return;
    const kind=occurrence.source===VIDEO_IMAGE_SOURCE?"image":occurrence.source===VIDEO_VIDEO_SOURCE?"video":occurrence.source===VIDEO_AUDIO_SOURCE?"audio":undefined;
    const ref=decodeVideoImage(occurrence.ref);if(!kind||!ref||ref.workId!==project.workId)return;
    const asset=project.assets.find(a=>a.id===ref.assetId&&a.kind===kind);const number=(kind==="image"?imageIds:kind==="video"?videoIds:audioIds).indexOf(ref.assetId)+1;
    if(!asset||!number||decorations.has(chip))return;
    const label=`@${kind==="image"?"图片":kind==="video"?"视频":"音频"}${number}`;
    const node=document.createElement("span");node.className="jz-inline-media-reference";node.contentEditable="false";node.textContent=label;node.tabIndex=0;node.setAttribute("role","button");node.setAttribute("aria-label",`预览${label}`);node.setAttribute("aria-haspopup","dialog");node.setAttribute("aria-expanded","false");
    node.onmouseenter=()=>show(node,asset,label);node.onmouseleave=later;node.onfocus=()=>show(node,asset,label);node.onblur=later;
    node.onclick=e=>{e.preventDefault();e.stopPropagation();show(node,asset,label);};
    node.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();e.stopPropagation();show(node,asset,label);popup?.focus();}};
    decorations.set(chip,node);chip.prepend(node);
    if(kind!=="audio")void getUrl(asset.id).then(url=>{
     if(!active||!url||!node.isConnected)return;
     if(kind==="image"){const img=document.createElement("img");img.alt="";img.src=url;img.draggable=false;img.onerror=()=>img.remove();node.prepend(img);}
     else{const video=document.createElement("video");video.muted=true;video.playsInline=true;video.preload="metadata";video.setAttribute("aria-hidden","true");video.onloadedmetadata=()=>{if(video.duration>0)video.currentTime=Math.min(0.1,video.duration/2);};video.src=url;video.onerror=()=>video.remove();node.prepend(video);}
    });
   });
  };
  const escape=(e:KeyboardEvent)=>{if(e.key==="Escape"&&popup){e.stopPropagation();trigger?.focus();close();}};
  const outside=(e:PointerEvent)=>{if(popup&&!popup.contains(e.target as Node)&&!trigger?.contains(e.target as Node))close();};
  decorate();const observer=new MutationObserver(decorate);observer.observe(card,{childList:true,subtree:true});
  document.addEventListener("keydown",escape,true);document.addEventListener("pointerdown",outside);window.addEventListener("resize",close);
  return()=>{active=false;close();observer.disconnect();document.removeEventListener("keydown",escape,true);document.removeEventListener("pointerdown",outside);window.removeEventListener("resize",close);for(const node of decorations.values())node.remove();};
 },[remote,signature]);
 return <span ref={marker} hidden />;
}
