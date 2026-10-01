import { createHash } from "node:crypto";
import type { GetVideoProjectViewInput, GetVideoJobUpdatesInput, VideoProjectView, VideoJobUpdates, VideoProject, VideoEpisodeSummary } from "@jizuo/contracts";
import type { VideoRepository } from "../../../work-domain/src/videoRepository.ts";
import { projectVideoForClient } from "./projection.ts";

/** Only query projections are cached; commands always read/validate authoritative state. */
export function createVideoQueries(repository: Pick<VideoRepository,"query">) {
  const views = new WeakMap<VideoProject,Map<string,VideoProjectView>>();
  function view(source:VideoProject,input:GetVideoProjectViewInput):VideoProjectView {
    const key=JSON.stringify([input.scope,input.episodeId]);
    let cache=views.get(source);if(!cache){cache=new Map();views.set(source,cache);}
    const existing=cache.get(key);if(existing)return existing;
    const episodes:VideoEpisodeSummary[]=source.episodes.filter(e=>!e.deletedAt).map(e=>({id:e.id,title:e.title,status:e.status,
      shots:e.shots.filter(s=>!s.archived).map(s=>({id:s.id,title:s.title,locked:s.locked,...(s.imageAssetId?{imageAssetId:s.imageAssetId}:{}),...(s.videoAssetId?{videoAssetId:s.videoAssetId}:{})}))}));
    const selected=input.scope==="library"?source.episodes:input.scope==="episode"?source.episodes.filter(e=>e.id===input.episodeId):[];
    const jobs=input.scope==="library"?source.jobs:input.scope==="episode"?source.jobs.filter(j=>j.episodeId===input.episodeId):[];
    const project=projectVideoForClient(source,{episodes:selected,jobs});
    const {revision:_revision,jobs:_jobs,...content}=project;
    const contentToken=createHash("sha256").update(JSON.stringify({content,episodes})).digest("hex");
    const result={project,episodes,contentToken};cache.set(key,result);
    if(cache.size>24)cache.delete(cache.keys().next().value!);
    return result;
  }
  return {
    getView(input:GetVideoProjectViewInput):Promise<VideoProjectView>{return repository.query(input.workId,source=>view(source,input));},
    getJobs(input:GetVideoJobUpdatesInput):Promise<VideoJobUpdates>{return repository.query(input.workId,source=>{
      if(source.revision===input.knownRevision && (!input.knownContentToken || view(source,input).contentToken===input.knownContentToken))return {workId:source.workId,revision:source.revision,unchanged:true} as const;
      const scoped=view(source,input);
      const jobs=input.sessionId?source.jobs.filter(j=>(j.kind==="image"||j.kind==="video")&&j.state?.sourceSessionId===input.sessionId):scoped.project.jobs;
      const ids=new Set(jobs.flatMap(j=>j.resultAssetIds??[]));
      // Recovery decisions need the real chapter context, but never send that context in progress responses.
      const projected=input.sessionId?projectVideoForClient(source,{episodes:[],jobs,assets:source.assets.filter(a=>ids.has(a.id))}):scoped.project;
      const project:VideoProject={schemaVersion:1,workId:source.workId,revision:source.revision,episodes:[],jobs:projected.jobs,assets:projected.assets.filter(a=>ids.has(a.id))};
      return {workId:source.workId,revision:source.revision,unchanged:false,contentToken:scoped.contentToken,project} as const;
    });},
  };
}
