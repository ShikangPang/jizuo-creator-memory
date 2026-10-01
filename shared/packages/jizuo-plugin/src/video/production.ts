import { isDeepStrictEqual } from "node:util";
import { JizuoError, type VideoJob, type VideoJsonValue, type VideoProject } from "@jizuo/contracts";
import type { VideoRepository } from "@jizuo/work-domain";
import { StartVideoProductionInput, ControlVideoProductionInput } from "../../../contracts/src/video-production.ts";
import type { VideoAuthoringService } from "./authoring.ts";
import type { VideoEditingService } from "./editing-service.ts";
import { mediaJobBlocksDuplicate, type VideoGenerationService } from "./generation.ts";

type Options={repository:VideoRepository;authoring:Pick<VideoAuthoringService,"adapt">;generation:Pick<VideoGenerationService,"prepare"|"enqueue"|"control"|"recover">;editing:Pick<VideoEditingService,"roughCut"|"export"|"control"|"recover">;pollIntervalMs?:number};
const active=(job:VideoJob)=>job.status==="queued"||job.status==="running";
const production=(job:VideoJob)=>job.kind==="pipeline"&&job.snapshot.type==="production";
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Record<string,VideoJsonValue>;
const runnable=(job:VideoJob)=>active(job)&&job.state?.paused!==true;
const hasReceipt=(job:VideoJob)=>Boolean(job.remoteId||job.state?.output);

/** The parent reserves paid work and its child in one durable transaction before enqueue. */
export class VideoProductionService {
  private readonly pending=new Map<string,Promise<void>>();
  private readonly timers=new Map<string,ReturnType<typeof setTimeout>>();
  private readonly aborts=new Map<string,AbortController>();
  private closed=false;
  constructor(private readonly options:Options){}

  async start(raw:StartVideoProductionInput):Promise<VideoProject>{
    this.requireOpen();const input=StartVideoProductionInput.parse(raw);
    const {expectedRevision:_revision,requestId:_id,...parameters}=input;const request=json(parameters);
    const project=await this.options.repository.read(input.workId);
    const existing=project.jobs.find(job=>job.id===input.requestId);
    if(existing){
      if(!production(existing)||!isDeepStrictEqual(existing.snapshot.request,request))throw new JizuoError("validation_error","制作请求 ID 已用于不同参数，请使用新的请求 ID");
      this.enqueue(input.workId,existing.id);return project;
    }
    const saved=await this.options.repository.mutate(input.workId,input.expectedRevision,draft=>{
      const episode=draft.episodes.find(episode=>episode.id===input.episodeId);
      if(!episode)throw new JizuoError("validation_error","视频集不存在或已归档");
      if(input.shotIds?.some(id=>!episode.shots.some(shot=>shot.id===id&&!shot.archived)))throw new JizuoError("validation_error","所选镜头不属于当前视频集");
      if(draft.jobs.some(job=>production(job)&&job.episodeId===episode.id&&active(job)))throw new JizuoError("revision_conflict","该视频集已有自动制作任务，请先恢复或取消原任务");
      if(input.aspectRatio)episode.aspectRatio=input.aspectRatio;
      draft.jobs.push({id:input.requestId,kind:"pipeline",status:"running",episodeId:episode.id,snapshot:{type:"production",request,aspectRatio:input.aspectRatio??episode.aspectRatio??"9:16",initialVideoAssetIds:json(Object.fromEntries(episode.shots.filter(shot=>shot.videoAssetId).map(shot=>[shot.id,shot.videoAssetId]))),initialTimelineAssetIds:json(Object.fromEntries(episode.timeline.map(clip=>[clip.id,clip.assetId])))},state:{stage:"storyboard",paused:false,usedRequests:0,maxRequests:input.maxRequests,label:"自动制作"},createdAt:new Date().toISOString()});
    });
    this.enqueue(input.workId,input.requestId);return saved;
  }

  async control(raw:ControlVideoProductionInput):Promise<VideoProject>{
    this.requireOpen();const input=ControlVideoProductionInput.parse(raw);
    let child:VideoJob|undefined;let replayed=false;
    const saved=await this.options.repository.mutate(input.workId,undefined,draft=>{
      const job=this.parent(draft,input.jobId);
      const applied=Array.isArray(job.state?.appliedBudgetRequestIds)?job.state.appliedBudgetRequestIds:[];
      const amounts=(job.state?.budgetRequestAmounts??{}) as Record<string,VideoJsonValue>;
      if(input.requestId&&applied.includes(input.requestId)){
        if(amounts[input.requestId]!==input.additionalRequests)throw new JizuoError("validation_error","预算请求 ID 已用于不同追加额度");
        replayed=true;return;
      }
      if(!active(job))throw new JizuoError("validation_error","自动制作任务已结束");
      child=draft.jobs.find(item=>item.id===job.state?.childJobId);
      if(input.action==="cancel"){job.status="cancelled";job.state={...job.state,paused:false,reason:"已取消自动制作"};return;}
      if(input.action==="pause"){job.state={...job.state,paused:true,reason:"已暂停后续步骤；进行中的生成仍会保存结果"};return;}
      const max=Number(job.state?.maxRequests??0)+(input.additionalRequests??0);
      if(max>200)throw new JizuoError("validation_error","累计请求预算不能超过 200 次");
      job.state={...job.state,maxRequests:max,paused:false,reason:"",...((input.additionalRequests??0)>0?{appliedBudgetRequestIds:[...applied,input.requestId!],budgetRequestAmounts:{...amounts,[input.requestId!]:input.additionalRequests!}}:{})};
      if(job.state.stage==="adapting")job.state.stage="storyboard"; // Explicit resume authorizes a fresh text attempt, which reserves another request.
      if(child&&child.status==="succeeded"&&child.kind!=="export"){
        const shot=draft.episodes.find(episode=>episode.id===job.episodeId)?.shots.find(shot=>shot.id===child!.shotId);
        if(child.kind==="image"?shot?.imageAssetId:shot?.videoAssetId)delete job.state.childJobId;
      }
      if(child&&child.status==="failed"&&(child.kind==="image"||child.kind==="video")&&
        (child.state?.remoteTerminal===true||child.state?.submission==="rejected"||child.state?.submission==="not-submitted")){
        const shot=draft.episodes.find(episode=>episode.id===job.episodeId)?.shots.find(shot=>shot.id===child!.shotId&&!shot.archived);
        const selected=child.kind==="image"?shot?.imageAssetId:shot?.videoAssetId;
        if(selected&&draft.assets.some(asset=>asset.id===selected&&asset.kind===child!.kind)){
          // Explicit resume accepts the author's replacement; it never retries a rejected paid child.
          delete job.state.childJobId;child=undefined;
        }
      }
    });
    if(replayed)return saved;
    if(input.action==="cancel"){
      this.clearTimer(input.jobId);this.aborts.get(input.jobId)?.abort();
      if(child&&child.state?.productionJobId===input.jobId&&active(child))await this.childControl(input.workId,child,"cancel");
    }else if(input.action==="resume"){
      if(child&&child.status!=="succeeded"&&!active(child)&&((hasReceipt(child)&&child.state?.remoteTerminal!==true)||child.kind==="export")){
        try{await this.childControl(input.workId,child,"resume");}catch{await this.pause(input.workId,input.jobId,"子任务暂时无法恢复，请在任务列表核对状态后恢复制作");}
      }
      this.enqueue(input.workId,input.jobId);
    }
    return input.action==="resume"?this.options.repository.read(input.workId):saved;
  }

  async recover(workId:string):Promise<void>{
    this.requireOpen();const project=await this.options.repository.read(workId);
    for(const job of project.jobs.filter(job=>production(job)&&runnable(job))){
      if(this.pending.has(job.id))continue;
      if(job.state?.stage==="adapting")await this.pause(workId,job.id,"剧本请求已发出但结果未保存。请检查制作稿；恢复将消耗一次新的文本请求");
      else this.enqueue(workId,job.id);
    }
  }
  async idle():Promise<void>{while(this.pending.size)await Promise.allSettled([...this.pending.values()]);}
  async close():Promise<void>{this.closed=true;for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();for(const controller of this.aborts.values())controller.abort();await this.idle();}
  private requireOpen(){if(this.closed)throw new JizuoError("runtime_unavailable","自动制作服务已关闭");}
  private parent(project:VideoProject,id:string){const job=project.jobs.find(item=>item.id===id);if(!job||!production(job))throw new JizuoError("validation_error","自动制作任务不存在");return job;}
  private clearTimer(id:string){const timer=this.timers.get(id);if(timer)clearTimeout(timer);this.timers.delete(id);}
  private enqueue(workId:string,id:string){
    if(this.closed||this.pending.has(id))return;this.clearTimer(id);
    const controller=new AbortController();this.aborts.set(id,controller);
    const task=this.run(workId,id,controller.signal).finally(()=>{this.pending.delete(id);this.aborts.delete(id);});this.pending.set(id,task);void task.catch(()=>undefined);
  }
  private later(workId:string,id:string){if(this.closed)return;this.clearTimer(id);const timer=setTimeout(()=>{this.timers.delete(id);this.enqueue(workId,id);},this.options.pollIntervalMs??2000);timer.unref?.();this.timers.set(id,timer);}
  private async patch(workId:string,id:string,update:(job:VideoJob,project:VideoProject)=>void){return this.options.repository.mutate(workId,undefined,project=>{const job=this.parent(project,id);if(active(job)){update(job,project);job.updatedAt=new Date().toISOString();}});}
  private async pause(workId:string,id:string,reason:string){await this.patch(workId,id,job=>{job.state={...job.state,paused:true,reason};});}
  private childControl(workId:string,child:VideoJob,action:"cancel"|"resume"){return child.kind==="export"?this.options.editing.control({workId,jobId:child.id,action}):this.options.generation.control({workId,jobId:child.id,action});}

  private async run(workId:string,id:string,signal:AbortSignal):Promise<void>{
    try{
      while(!this.closed&&!signal.aborted){
        const project=await this.options.repository.read(workId);const job=this.parent(project,id);if(!runnable(job))return;
        const input=StartVideoProductionInput.parse({...(job.snapshot.request as Record<string,VideoJsonValue>),...(job.snapshot.aspectRatio?{aspectRatio:job.snapshot.aspectRatio}:{}),requestId:id,expectedRevision:project.revision});
        const episode=project.episodes.find(item=>item.id===job.episodeId);
        if(!episode){await this.pause(workId,id,"视频集已归档或删除，请检查制作稿");return;}
        const child=project.jobs.find(item=>item.id===job.state?.childJobId);
        if(child){
          if(active(child)){
            if(child.kind!=="export"&&child.state?.productionJobId!==id&&!hasReceipt(child)){await this.pause(workId,id,"原镜头任务尚无回执，请在任务列表处理后恢复；本流程不会替其他任务提交付费请求");return;}
            if(child.kind==="export")await this.options.editing.recover(workId);
            else await this.options.generation.recover(workId,[child.id]);
            this.later(workId,id);return;
          }
          if(child.status!=="succeeded"){
            await this.pause(workId,id,hasReceipt(child)?"子任务未完成，已有服务端回执；请检查模型凭证或任务错误后恢复":"子任务失败或提交结果不明。请在任务列表核对回执，自动制作不会重复提交");return;
          }
          if(child.kind==="export"){
            if(child.state?.stale){await this.pause(workId,id,"导出期间时间线已变化，旧成片已保留；请取消本流程后按当前时间线重新导出");return;}
            await this.patch(workId,id,parent=>{if(!runnable(parent))return;parent.status="succeeded";parent.resultAssetIds=child.resultAssetIds??[];parent.state={...parent.state,stage:"done",progress:100};});return;
          }
          const shot=episode.shots.find(item=>item.id===child.shotId);
          const selected=child.kind==="image"?shot?.imageAssetId:shot?.videoAssetId;
          if(!selected||!child.resultAssetIds?.includes(selected)){await this.pause(workId,id,"镜头在生成期间被修改，结果已保留为候选；请选择所需素材后恢复");return;}
          await this.patch(workId,id,parent=>{if(parent.state?.childJobId===child.id)delete parent.state.childJobId;});continue;
        }
        if(job.state?.stage==="adapting"){
          await this.pause(workId,id,"剧本请求结果未保存。请检查制作稿；恢复将消耗一次新的文本请求");return;
        }
        if(job.state?.stage==="storyboard"){
          if(!episode.shots.some(shot=>!shot.archived)){
            if(Number(job.state?.usedRequests)>=Number(job.state?.maxRequests)){await this.pause(workId,id,"请求预算已用完，请增加预算后恢复");return;}
            const reserved=await this.options.repository.mutate(workId,project.revision,draft=>{const parent=this.parent(draft,id);if(!runnable(parent))return;parent.state={...parent.state,stage:"adapting",usedRequests:Number(parent.state?.usedRequests)+1};});
            if(this.parent(reserved,id).state?.stage!=="adapting")return;
            await this.options.authoring.adapt({workId,episodeId:episode.id,expectedRevision:reserved.revision,...(input.instructions?{instructions:input.instructions}:{})},signal);
          }
          await this.patch(workId,id,parent=>{parent.state={...parent.state,stage:"images",...(input.pauseAfterStoryboard?{paused:true,reason:"分镜已就绪，请确认后恢复生成"}:{})};});continue;
        }
        const targets=input.shotIds?input.shotIds.map(shotId=>episode.shots.find(shot=>shot.id===shotId&&!shot.archived)):episode.shots.filter(shot=>!shot.archived);
        if(targets.some(shot=>!shot)||!targets.length){await this.pause(workId,id,"目标镜头已删除或归档，请检查制作范围");return;}
        const imageShot=targets.find(shot=>!shot!.imageAssetId&&!shot!.videoAssetId);
        const videoShot=targets.find(shot=>!shot!.videoAssetId);
        const shot=imageShot??videoShot;const kind=imageShot?"image":"video";
        if(shot){
          if(shot.locked){await this.pause(workId,id,`镜头「${shot.title}」已锁定但缺少${kind==="image"?"图片":"视频"}，请补齐素材或解锁后恢复`);return;}
          const unresolved=project.jobs.find(item=>item.shotId===shot.id&&item.kind===kind&&mediaJobBlocksDuplicate(item));
          if(unresolved){
            await this.patch(workId,id,parent=>{if(runnable(parent))parent.state={...parent.state,stage:kind==="image"?"images":"videos",childJobId:unresolved.id};});
            if(!hasReceipt(unresolved)){await this.pause(workId,id,"该镜头已有任务，请先在任务列表完成或核对原任务，避免重复请求");return;}
            continue;
          }
          if(Number(job.state?.usedRequests)>=Number(job.state?.maxRequests)){await this.pause(workId,id,"请求预算已用完，请增加预算后恢复");return;}
          const prepared=await this.options.generation.prepare({workId,episodeId:episode.id,shotId:shot.id,expectedRevision:project.revision,kind,...(input.aspectRatio?{aspectRatio:input.aspectRatio}:{})},project);
          prepared.state={...prepared.state,productionJobId:id,maxAttempts:1};
          let allocated=false;
          await this.options.repository.mutate(workId,project.revision,draft=>{const parent=this.parent(draft,id);if(!runnable(parent))return;
            if(Number(parent.state?.usedRequests)>=Number(parent.state?.maxRequests))throw new JizuoError("validation_error","请求预算已用完");
            draft.jobs.push(prepared);parent.state={...parent.state,stage:kind==="image"?"images":"videos",usedRequests:Number(parent.state?.usedRequests)+1,childJobId:prepared.id};allocated=true;
          });
          if(allocated)this.options.generation.enqueue(workId,prepared.id);continue;
        }
        if(job.state?.stage!=="editing"&&job.state?.stage!=="export"){await this.patch(workId,id,parent=>{if(runnable(parent))parent.state={...parent.state,stage:"editing"};});continue;}
        if(!episode.timeline.length){await this.options.editing.roughCut({workId,episodeId:episode.id,expectedRevision:project.revision});continue;}
        if(targets.some(shot=>!episode.timeline.some(clip=>clip.shotId===shot!.id))){await this.pause(workId,id,"部分目标镜头尚未加入时间线，请将缺少镜头加入时间线或重建粗剪后恢复；人工剪辑已保留");return;}
        const initialVideos=(job.snapshot.initialVideoAssetIds??{}) as Record<string,VideoJsonValue>;
        const replacements=episode.timeline.filter(clip=>targets.some(shot=>shot!.id===clip.shotId&&shot!.videoAssetId!==initialVideos[shot!.id]&&shot!.videoAssetId!==clip.assetId));
        if(replacements.length){
          const initialClips=(job.snapshot.initialTimelineAssetIds??{}) as Record<string,VideoJsonValue>;
          if(replacements.some(clip=>initialClips[clip.id]!==clip.assetId)){
            await this.pause(workId,id,"时间线片段在制作期间新增、拆分或更换了素材，或缺少原始剪辑记录；请确认片段与镜头选中版本后恢复，人工剪辑已保留");return;
          }
          for(const clip of replacements){const selected=targets.find(shot=>shot!.id===clip.shotId)!.videoAssetId;const asset=project.assets.find(asset=>asset.id===selected);
            if(!asset?.durationSec||asset.durationSec<clip.outSec){await this.pause(workId,id,"新视频不足以覆盖现有剪辑区间，请调整该片段裁剪后恢复；原时间线已保留");return;}}
          await this.options.repository.mutate(workId,project.revision,draft=>{const current=draft.episodes.find(item=>item.id===episode.id)!;
            for(const clip of current.timeline.filter(clip=>replacements.some(replacement=>replacement.id===clip.id))){const target=targets.find(shot=>shot!.id===clip.shotId);if(target?.videoAssetId)clip.assetId=target.videoAssetId;}
          });continue;
        }
        await this.options.editing.export({workId,episodeId:episode.id,expectedRevision:project.revision,...(input.aspectRatio?{aspectRatio:input.aspectRatio}:{})},{productionJobId:id});
      }
    }catch(error){
      if(this.closed||signal.aborted)return;
      if(error instanceof JizuoError&&error.code==="revision_conflict"){this.later(workId,id);return;}
      await this.pause(workId,id,error instanceof JizuoError?error.message:"自动制作步骤未完成，请检查任务和制作稿后恢复");
    }
  }
}
