import { userErrorMessage } from "@jizuo/contracts";
import { readVideoWithTimeout } from "./read-video.ts";
import { useCallback, useSyncExternalStore } from "react";
import type { VideoProject, VideoEpisodeSummary, GetVideoProjectViewInput } from "@jizuo/contracts";
import type { JizuoContentRemote } from "../content/remote.ts";

const listeners = new Set<(project: VideoProject) => void>();
export function subscribeVideoProject(listener: (project: VideoProject) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function publishVideoProject(project: VideoProject): void {
  for (const listener of listeners) listener(project);
}
type Scope = Omit<GetVideoProjectViewInput, "workId">;
type Snapshot = { project: VideoProject | null; episodes: VideoEpisodeSummary[]; error: string | null; loading: boolean };
type Entry = ReturnType<typeof createEntry>;
const stores = new WeakMap<JizuoContentRemote, Map<string, Entry>>();
const empty: Snapshot = {project:null,episodes:[],error:null,loading:false};
const unsupported: Snapshot = {...empty,error:"当前运行时尚不支持视频，请更新后重试。"};
function createEntry(remote: JizuoContentRemote, workId: string, expire: () => void, scope?: Scope) {
  let snapshot: Snapshot = {...empty,loading:true};
  let contentToken: string | undefined;
  let failures = 0;
  const scoped = Boolean(scope && remote.getVideoProjectView && remote.getVideoJobUpdates);
  const subscribers = new Set<() => void>();
  let pending: Promise<void> | undefined;
  let activeRead: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  const emit = (next: Snapshot) => { snapshot=next; for(const listener of subscribers)listener(); };
  const accept = (project: VideoProject) => {
    if(project.workId !== workId)return;
    if(snapshot.project && snapshot.project.revision > project.revision) return;
    contentToken=undefined;
    const episodes=project.episodes.filter(episode=>!episode.deletedAt);
    if(scoped)project={...project,
      episodes:scope!.scope==="library"?project.episodes:scope!.scope==="episode"?project.episodes.filter(e=>e.id===scope!.episodeId):[],
      jobs:scope!.scope==="library"?project.jobs:scope!.scope==="episode"?project.jobs.filter(j=>j.episodeId===scope!.episodeId):[],
    };
    emit({project,episodes,error:null,loading:false});
  };
  const readView = async (controller: AbortController) => {
    const result=await readVideoWithTimeout(signal=>remote.getVideoProjectView!({workId,...scope!},signal),controller);
    if(activeRead!==controller)return;
    if(result.project.workId!==workId)throw new Error("视频集返回的作品不匹配，请重试。");
    if(snapshot.project && snapshot.project.revision>result.project.revision)return;
    contentToken=result.contentToken;
    emit({project:result.project,episodes:result.episodes,error:null,loading:false});
  };
  const cancelRead = () => {
    const previous=activeRead;
    activeRead=undefined;
    pending=undefined;
    previous?.abort();
  };
  const load = (force=false): Promise<void> => {
    if(pending && !force)return pending;
    if(force)cancelRead();
    if(timer)clearTimeout(timer);
    timer=undefined;
    const controller=new AbortController();
    activeRead=controller;
    if(force && (snapshot.error || (!snapshot.project && !snapshot.loading)))emit({...snapshot,error:null,loading:!snapshot.project});
    pending=Promise.resolve().then(async()=>{
      controller.signal.throwIfAborted();
      if(!scoped){
        const project=await readVideoWithTimeout(signal=>remote.getVideoProject!({workId},signal),controller);
        if(activeRead!==controller)return;
        if(project.workId!==workId)throw new Error("视频集返回的作品不匹配，请重试。");
        accept(project);return;
      }
      if(force || !snapshot.project || !contentToken){await readView(controller);return;}
      const knownRevision=snapshot.project.revision, knownContentToken=contentToken;
      const update=await readVideoWithTimeout(signal=>remote.getVideoJobUpdates!({workId,...scope!,knownRevision,knownContentToken},signal),controller);
      if(activeRead!==controller)return;
      if(snapshot.project && update.revision<snapshot.project.revision)return;
      if(update.unchanged){if(snapshot.error)emit({...snapshot,error:null});return;}
      if(update.contentToken!==contentToken){await readView(controller);return;}
      emit({...snapshot,project:{...snapshot.project!,revision:update.revision,jobs:update.project.jobs},error:null,loading:false});
    }).then(()=>{
      if(activeRead===controller)failures=0;
    }).catch((cause:unknown)=>{
      if(activeRead!==controller)return;
      failures=Math.min(failures+1,5);
      emit({...snapshot,loading:false,error:userErrorMessage(cause, "视频集加载失败", { operation: "useVideoProject", effect: "read" })});
    }).finally(()=>{
      if(activeRead!==controller)return;
      activeRead=undefined;
      pending=undefined;
      if(subscribers.size)timer=setTimeout(()=>{void load();},Math.min(3000 * 2 ** Math.max(0,failures-1),30_000));
    });
    return pending;
  };
  return {
    getSnapshot:()=>snapshot,
    refresh:()=>{void load(true);},
    subscribe(listener:()=>void) {
      if(expiry)clearTimeout(expiry);
      expiry=undefined;
      subscribers.add(listener);
      if(subscribers.size===1){unsubscribe=subscribeVideoProject(accept);void load(true);}
      else if(snapshot.error || (snapshot.project && pending))void load(true);
      return ()=>{
        subscribers.delete(listener);
        if(subscribers.size)return;
        if(timer)clearTimeout(timer);
        timer=undefined;
        cancelRead();
        unsubscribe?.();unsubscribe=undefined;
        // Preserve the last snapshot across tab switches without retaining whole works indefinitely.
        expiry=setTimeout(expire,30_000);
      };
    },
  };
}
function entryFor(remote:JizuoContentRemote, workId:string, scope?:Scope):Entry {
  let store=stores.get(remote);
  if(!store){store=new Map();stores.set(remote,store);}
  const key=JSON.stringify([workId,scope?.scope,scope?.episodeId]);
  let entry=store.get(key);
  if(!entry){entry=createEntry(remote,workId,()=>{store.delete(key);},scope);store.set(key,entry);}
  return entry;
}
const idleSubscribe = () => () => {};
export function useVideoProject(remote: JizuoContentRemote, workId: string | null, scope?:Scope) {
  const effectiveScope=remote.getVideoProjectView && remote.getVideoJobUpdates ? scope : undefined;
  const entry=workId && (remote.getVideoProject || remote.getVideoProjectView && remote.getVideoJobUpdates) ? entryFor(remote,workId,effectiveScope) : undefined;
  const getSnapshot=useCallback(()=>entry?.getSnapshot() ?? (workId ? unsupported : empty),[entry,workId]);
  const snapshot=useSyncExternalStore(entry?.subscribe ?? idleSubscribe,getSnapshot,getSnapshot);
  const refresh=useCallback(()=>entry?.refresh(),[entry]);
  return {...snapshot,refresh,autoRetry:Boolean(entry && snapshot.error)};
}
