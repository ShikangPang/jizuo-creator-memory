import { isDeepStrictEqual } from "node:util";
import { JizuoError, type VideoJob, type VideoJsonValue, type VideoProject } from "@jizuo/contracts";
import type { VideoRepository } from "@jizuo/work-domain";
import { SubmitVideoBatchInput } from "../../../contracts/src/media-operations.ts";
import { VideoGenerationService, mediaJobBlocksDuplicate, refreshMediaBatches } from "./generation.ts";

/** Idempotency and budget are durable before any child can submit a paid request. */
export class VideoBatchGenerationService {
  constructor(private readonly options:{repository:VideoRepository;generation:VideoGenerationService}){}

  async submit(raw:SubmitVideoBatchInput):Promise<VideoProject>{
    const input=SubmitVideoBatchInput.parse(raw);
    const project=await this.options.repository.read(input.workId);
    const {expectedRevision:_revision,batchId:_batchId,...parameters}=input;
    const request=JSON.parse(JSON.stringify(parameters)) as Record<string,VideoJsonValue>;
    const existing=project.jobs.find(job=>job.id===input.batchId);
    if(existing){
      if(existing.kind!=="pipeline"||existing.snapshot.type!=="batch"||!isDeepStrictEqual(existing.snapshot.request,request))throw new JizuoError("validation_error","批次 ID 已用于不同参数，请使用新的批次 ID");
      await this.options.generation.recover(input.workId,Array.isArray(existing.state?.childJobIds)?existing.state.childJobIds.filter((id):id is string=>typeof id==="string"):[]);
      return this.options.repository.read(input.workId);
    }
    if(project.revision!==input.expectedRevision)throw new JizuoError("revision_conflict","制作稿已变化，请刷新后开始批次");
    const episode=project.episodes.find(episode=>episode.id===input.episodeId);
    if(!episode||input.shotIds.some(id=>!episode.shots.some(shot=>shot.id===id)))throw new JizuoError("validation_error","所选镜头不属于当前视频集");
    const children:VideoJob[]=[];
    for(const id of input.shotIds){
      const shot=episode.shots.find(shot=>shot.id===id)!;
      if(shot.locked||shot.archived||project.jobs.some(job=>job.shotId===id&&job.kind===input.kind&&mediaJobBlocksDuplicate(job)))continue;
      if(children.length>=input.maxRequests)break;
      const job=await this.options.generation.prepare({workId:input.workId,episodeId:input.episodeId,shotId:id,expectedRevision:input.expectedRevision,kind:input.kind,...(input.aspectRatio?{aspectRatio:input.aspectRatio}:{})},project);
      // Each allocated request can be submitted once; explicit child retry cannot bypass the batch cap.
      job.state={...job.state,batchId:input.batchId,maxAttempts:1};
      children.push(job);
    }
    const batch:VideoJob={id:input.batchId,kind:"pipeline",status:children.length?"running":"succeeded",episodeId:input.episodeId,
      snapshot:{type:"batch",request},createdAt:new Date().toISOString(),
      state:{label:`${input.kind==="video"?"视频":"图片"}批次`,stage:"batch",usedRequests:children.length,maxRequests:input.maxRequests,childJobIds:children.map(job=>job.id)}};
    const saved=await this.options.repository.mutate(input.workId,input.expectedRevision,draft=>{draft.jobs.push(batch,...children);refreshMediaBatches(draft);});
    for(const job of children)this.options.generation.enqueue(input.workId,job.id);
    return saved;
  }
}
