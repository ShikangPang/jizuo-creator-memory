import { readVideoWithTimeout } from "./read-video.ts";
import type { VideoJob, VideoProject } from "@jizuo/contracts";
import type { JizuoContentRemote } from "../content/remote.ts";
import { subscribeVideoProject } from "./useVideoProject.ts";

export interface ImageChatPending { kind?: "image" | "video"; prompt: string; model?: string; label?: string; error?: string }
export interface ImageChatEntry {
  id: string; workId: string; createdAt: string;
  job?: VideoJob; project?: VideoProject; pending?: ImageChatPending;
}
export interface ImageChatSubmissionObserver {
  start(sessionId: string, workId: string, pending: ImageChatPending): string;
  accepted(sessionId: string, id: string, project: VideoProject): void;
  failed(sessionId: string, id: string, message: string): void;
}
const EMPTY: readonly ImageChatEntry[] = Object.freeze([]);
const active = (job: VideoJob) => job.status === "queued" || job.status === "running";
const storageKey = (sessionId: string) => `jizuo.image-chat.works.v1:${sessionId}`;

/** Jobs and prompts remain in the work repository; browser storage contains only a work index. */
export function createImageChatStore(remote: JizuoContentRemote, options: {
  storage?: Pick<Storage, "getItem" | "setItem">;
  pollIntervalMs?: number;
  changed?: (sessionId: string, hasImages: boolean) => void;
} = {}) {
  const snapshots = new Map<string, readonly ImageChatEntry[]>();
  const works = new Map<string, Set<string>>();
  const projects = new Map<string, VideoProject>();
  const sessionProjects = new Map<string, VideoProject>();
  const sessionWorkKey = (sessionId:string,workId:string) => JSON.stringify([sessionId,workId]);
  const listeners = new Map<string, Set<() => void>>();
  const initialized = new Set<string>();
  const errors = new Map<string, string>();
  const loading = new Map<string, Promise<void>>();
  const reads = new Map<string, AbortController>();
  let timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
  const getSnapshot = (sessionId: string) => snapshots.get(sessionId) ?? EMPTY;
  const notify = (sessionId: string) => {
    listeners.get(sessionId)?.forEach(listener => listener());
    options.changed?.(sessionId, getSnapshot(sessionId).length > 0);
  };
  const remember = (sessionId: string, workId?: string) => {
    let ids = works.get(sessionId);
    if (!ids) {
      ids = new Set<string>();
      try {
        const saved: unknown = JSON.parse(options.storage?.getItem(storageKey(sessionId)) ?? "[]");
        if (Array.isArray(saved)) for (const id of saved) if (typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/.test(id)) ids.add(id);
      } catch { /* A corrupt browser index does not prevent new generation. */ }
      works.set(sessionId, ids);
    }
    if (workId && !ids.has(workId)) {
      ids.add(workId);
      try { options.storage?.setItem(storageKey(sessionId), JSON.stringify([...ids])); } catch { /* Current-session progress still works without browser storage. */ }
    }
    return ids;
  };
  const accept = (project: VideoProject, onlySession?:string) => {
    if (disposed) return;
    const old = projects.get(project.workId);
    if (old && old.revision > project.revision) project = old;
    if(!onlySession)projects.set(project.workId, project);
    errors.delete(project.workId);
    for (const [sessionId, ids] of works) {
      if (!ids.has(project.workId) || onlySession && sessionId!==onlySession) continue;
      const key=sessionWorkKey(sessionId,project.workId), previous=sessionProjects.get(key);
      const current=previous && previous.revision>project.revision ? previous : project;
      sessionProjects.set(key,current);
      const prior = getSnapshot(sessionId);
      const other = prior.filter(entry => entry.workId !== project.workId || entry.pending);
      const jobs = current.jobs.filter(job => (job.kind === "image" || job.kind === "video") && job.state?.sourceSessionId === sessionId);
      const entries = jobs.map(job => ({ id: job.id, workId: current.workId, createdAt: job.createdAt ?? "", job, project:current }));
      snapshots.set(sessionId, [...other, ...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      notify(sessionId);
    }
    schedule();
  };
  const load = (workId: string, sessionId:string): Promise<void> => {
    const key=remote.getVideoJobUpdates ? sessionWorkKey(sessionId,workId) : workId;
    const pending = loading.get(key);
    if (pending) return pending;
    if (!(remote.getVideoProject || remote.getVideoJobUpdates) || disposed) return Promise.resolve();
    const controller = new AbortController();
    reads.set(key, controller);
    const task = (async()=>{
      if(!remote.getVideoJobUpdates){accept(await readVideoWithTimeout(signal => remote.getVideoProject!({workId}, signal), controller));return;}
      const known=sessionProjects.get(sessionWorkKey(sessionId,workId));
      const update=await readVideoWithTimeout(signal => remote.getVideoJobUpdates!({workId,scope:"overview",sessionId,...(known?{knownRevision:known.revision}:{})}, signal), controller);
      if(!update.unchanged)accept(update.project,sessionId);
      else if(!disposed && errors.delete(workId))notify(sessionId);
    })().catch(() => {
      // Keep the last known task status. A transient read failure is not a generation failure.
      if (!disposed) {
        errors.set(workId, "生成进度暂时无法刷新，正在重新连接。");
        for (const [sessionId, ids] of works) if (ids.has(workId)) notify(sessionId);
      }
    }).finally(() => { reads.delete(key); loading.delete(key); schedule(); });
    loading.set(key, task);
    return task;
  };
  const discoveryErrors = new Map<string,string>();
  const discover = (sessionId:string):Promise<void> => {
    if(!remote.getChatMedia || disposed)return Promise.resolve();
    const key=`discovery:${sessionId}`, pending=loading.get(key);
    if(pending)return pending;
    const controller=new AbortController();reads.set(key,controller);
    const task=readVideoWithTimeout(signal=>remote.getChatMedia!({sessionId},signal),controller).then(next=>{
      if(disposed||controller.signal.aborted)return;
      discoveryErrors.delete(sessionId);
      for(const project of next){remember(sessionId,project.workId);accept(project,sessionId);}
      notify(sessionId);
    }).catch(()=>{
      if(!disposed){discoveryErrors.set(sessionId,"生成进度暂时无法刷新，正在重新连接。");notify(sessionId);}
    }).finally(()=>{loading.delete(key);reads.delete(key);schedule();});
    loading.set(key,task);return task;
  };
  function schedule() {
    if (timer || disposed) return;
    const ids = new Map<string,{workId:string;sessionId:string}>();
    for (const [sessionId, subscribers] of listeners) if (subscribers.size) {
      const add=(workId:string)=>ids.set(sessionWorkKey(sessionId,workId),{workId,sessionId});
      for (const workId of remember(sessionId)) if (!sessionProjects.has(sessionWorkKey(sessionId,workId)) || errors.has(workId)) add(workId);
      for (const entry of getSnapshot(sessionId)) if (entry.job && active(entry.job)) add(entry.workId);
    }
    const sessionIds=remote.getChatMedia ? [...listeners.keys()] : [];
    if (!ids.size && !sessionIds.length) return;
    timer = setTimeout(() => { timer = undefined;
      const tasks=[...sessionIds.filter(id=>listeners.has(id)).map(discover), ...[...ids.values()].filter(({sessionId})=>listeners.has(sessionId)).map(({workId,sessionId})=>load(workId,sessionId))];
      void Promise.all(tasks).finally(schedule);
    }, options.pollIntervalMs ?? 3000);
  }
  const ensure = (sessionId: string) => {
    if (disposed || initialized.has(sessionId)) return;
    initialized.add(sessionId);
    if(remote.getChatMedia)void discover(sessionId);
    for (const workId of remember(sessionId)) void load(workId,sessionId);
  };
  const observer: ImageChatSubmissionObserver = {
    start(sessionId, workId, pending) {
      remember(sessionId, workId);
      const id = `pending-${crypto.randomUUID()}`;
      snapshots.set(sessionId, [...getSnapshot(sessionId), { id, workId, pending, createdAt: new Date().toISOString() }]);
      notify(sessionId);
      return id;
    },
    accepted(sessionId, id, project) {
      snapshots.set(sessionId, getSnapshot(sessionId).filter(entry => entry.id !== id));
      accept(project);
    },
    failed(sessionId, id, message) {
      snapshots.set(sessionId, getSnapshot(sessionId).map(entry => entry.id === id && entry.pending ? { ...entry, pending: { ...entry.pending, error: message } } : entry));
      notify(sessionId);
    },
  };
  const stop = subscribeVideoProject(accept);
  return {
    ...observer, getSnapshot, ensure,
    getError: (sessionId: string) => discoveryErrors.get(sessionId) ?? [...(works.get(sessionId) ?? [])].map(workId => errors.get(workId)).find(Boolean),
    refresh(sessionId: string) { if(remote.getChatMedia){void discover(sessionId);return;} for (const workId of remember(sessionId)) void load(workId,sessionId); },
    subscribe(sessionId: string, listener: () => void) {
      const subscribers = listeners.get(sessionId) ?? new Set();
      subscribers.add(listener); listeners.set(sessionId, subscribers);
      ensure(sessionId); schedule();
      return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(sessionId); };
    },
    dispose() { disposed = true; if (timer) clearTimeout(timer); for (const controller of reads.values()) controller.abort(); reads.clear(); stop(); listeners.clear(); },
  };
}
export type ImageChatStore = ReturnType<typeof createImageChatStore>;
