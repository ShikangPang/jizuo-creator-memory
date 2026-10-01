import { useEffect, useRef, useState } from "react";
import type { VideoAssetPreviewRemote } from "./assets-remote.ts";

// Decode only visible strips. A small contact sheet repeats without extra video elements.
export function VideoClipFilmstrip({remote, workId, assetId, image, start, end}: {remote?: VideoAssetPreviewRemote | undefined; workId:string; assetId:string; image:boolean; start:number; end:number}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible,setVisible] = useState(false), [url,setUrl] = useState("");
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, {root:ref.current.closest(".jz-track-scroll"),rootMargin:"120px"});
    observer.observe(ref.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !remote?.getVideoAssetUrl) return;
    let cancelled = false; let video: HTMLVideoElement | undefined; let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelWait: (()=>void) | undefined;
    const cleanup = () => { cancelWait?.(); clearTimeout(timeout); if(video) { video.pause(); video.removeAttribute("src"); video.load(); } };
    setUrl("");
    void (async () => {
      const result = await remote.getVideoAssetUrl!({workId,assetId}); if(cancelled)return;
      if(image) { setUrl(result.url); return; }
      video=document.createElement("video"); video.muted=true; video.preload="auto"; video.crossOrigin="anonymous";
      const wait = (name:string, action:()=>void) => new Promise<void>((resolve,reject) => {
        const done = () => { clearTimeout(timeout); video?.removeEventListener(name,ok); video?.removeEventListener("error",fail); cancelWait=undefined; };
        const ok = () => { done(); resolve(); }; const fail = () => { done(); reject(new Error("thumbnail unavailable")); };
        cancelWait=fail; video!.addEventListener(name,ok,{once:true}); video!.addEventListener("error",fail,{once:true}); timeout=setTimeout(fail,8000); action();
      });
      await wait("loadeddata",()=>{video!.src=result.url;}); if(cancelled)return;
      const canvas=document.createElement("canvas"); canvas.width=240; canvas.height=36; const context=canvas.getContext("2d"); if(!context)return;
      for(let index=0;index<3;index++) {
        const at=Math.max(0,Math.min(Number.isFinite(video.duration)?video.duration-.03:end,start+(end-start)*(index+.5)/3));
        if(Math.abs(video.currentTime-at)>.01) await wait("seeked",()=>{video!.currentTime=at;}); if(cancelled)return;
        const ratio=Math.max(80/video.videoWidth,36/video.videoHeight), width=video.videoWidth*ratio,height=video.videoHeight*ratio;
        context.save(); context.beginPath(); context.rect(index*80,0,80,36); context.clip(); context.drawImage(video,index*80+(80-width)/2,(36-height)/2,width,height); context.restore();
      }
      if(!cancelled)setUrl(canvas.toDataURL("image/jpeg",.65));
    })().catch(()=>{}).finally(cleanup);
    return () => {cancelled=true;cleanup();};
  },[visible,remote,workId,assetId,image,start,end]);
  return <span ref={ref} aria-hidden="true" className="jz-clip-filmstrip" style={url ? {backgroundImage:`url(${JSON.stringify(url)})`} : undefined}/>;
}
