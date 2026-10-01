import { composeVisualPrompt, planVisualReferences } from "../../../contracts/src/visual-style-generation.ts";
import { gptImageSize, isGptImage2 } from "../../../contracts/src/gpt-image.ts";
import { isDiscardedMediaJob } from "../../../contracts/src/media-job-policy.ts";
import { applyMediaGenerationSettings } from "../../../contracts/src/media-generation-controls.ts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { JizuoError, type VideoJob, type VideoJsonValue, type VideoProject } from "@jizuo/contracts";
import type { VideoRepository } from "@jizuo/work-domain";
import { GenerateVideoMediaInput, ControlVideoJobInput } from "../../../contracts/src/media-operations.ts";
import { MediaOutput, MediaProviderConfig, MediaGenerationRequest, resolveVideoGenerationDuration, type MediaReferenceImage } from "../../../contracts/src/media.ts";
import { LocalVideoAssets } from "./assets.ts";
import { MediaSettingsRepository } from "./settings.ts";
import { createMediaProvider, freezeMediaInput, MediaProviderError } from "./providers.ts";
import { designFor, designViewPrompts, requirePanorama } from "./designs.ts";
import { VideoAssetView } from "@jizuo/contracts";
import { dashScopeImageDimensions } from "./dashscope-models.ts";
import { getMediaInputCapabilityError } from "../../../contracts/src/media-input-capabilities.ts";
import { loadReferenceVideos, type ProbeReferenceVideo } from "./reference-videos.ts";
import { resolveKuaishouTaskConfig } from "./kuaishou-provider.ts";

const json=(value:unknown):Record<string,VideoJsonValue>=>JSON.parse(JSON.stringify(value)) as Record<string,VideoJsonValue>;
const active=(job:VideoJob)=>job.status==="queued"||job.status==="running";
function setReportedProgress(job:VideoJob,progress?:number):void {
  job.state??={};
  if(typeof progress==="number"&&Number.isFinite(progress)&&progress>=0&&progress<1)job.state.progress=progress;
  else delete job.state.progress;
}
const hasReceipt=(job:VideoJob)=>Boolean(job.remoteId||job.state?.output);
const definiteRejection=(job:VideoJob)=>job.state?.submission==="rejected"||job.state?.submission==="not-submitted";
const needsReconciliation=(job:VideoJob)=>job.status!=="succeeded"&&job.state?.remoteTerminal!==true&&!hasReceipt(job)&&!definiteRejection(job)&&(
  job.status==="running"||job.status==="uncertain"||(job.attempt??0)>0||job.state?.submission==="started"||job.state?.submission==="unknown"||job.state?.submission==="acknowledged"
);
const MAX_RECEIPT_RECOVERY = 3;
const receiptRecoveryAttempts = (job: VideoJob) => typeof job.state?.receiptRecoveryAttempts === "number" ? job.state.receiptRecoveryAttempts : 0;
/** NSPOX persists an owner-scoped idempotency key before dispatching upstream. */
function canRecoverSubmission(job: VideoJob): boolean {
  if (!needsReconciliation(job)) return false;
  const config = MediaProviderConfig.safeParse(job.snapshot.config), request = MediaGenerationRequest.safeParse(job.snapshot.request);
  return config.success && config.data.protocol === "nspox" && request.success && Boolean(request.data.idempotencyKey);
}
const temporaryProviderError = (error: unknown) => error instanceof TypeError || error instanceof MediaProviderError && !error.resultUnknown
  && (error.httpStatus === undefined || error.httpStatus === 408 || error.httpStatus === 429 || (error.httpStatus ?? 0) >= 500);
export const mediaJobBlocksDuplicate=(job:VideoJob):boolean=>!isDiscardedMediaJob(job)&&job.status!=="succeeded"&&job.state?.remoteTerminal!==true&&(active(job)||hasReceipt(job)||needsReconciliation(job));

/** Frozen inputs are checked before a new submission; receipt recovery is independent of shot/design edits. */
function submissionBlockedReason(job:VideoJob,project:VideoProject):string|undefined {
  const frozenDesign=job.snapshot.design;
  if(frozenDesign&&typeof frozenDesign==="object"&&!Array.isArray(frozenDesign)){
    const design=project.designs?.find(item=>item.id===frozenDesign.id);
    if(!design||design.deletedAt)return "设定已删除，请选择其他设定重新生成";
    if(design.locked)return "设定已锁定，请先解锁后再生成";
    if(!isDeepStrictEqual(design,frozenDesign))return "设定已修改，请按当前设定重新生成";
  }
  if(job.shotId){
    const shot=project.episodes.find(episode=>episode.id===job.episodeId)?.shots.find(shot=>shot.id===job.shotId);
    if(!shot)return "镜头已删除，请选择其他镜头重新生成";
    if(shot.locked)return "镜头已锁定，请先解锁后再生成";
    if(shot.archived)return "镜头已归档，请恢复镜头后重新生成";
    if(shot.revision!==job.shotRevision)return "镜头已有新修改或新素材，请按当前镜头重新生成";
  }
  return undefined;
}

function sameGenerationTarget(left:VideoJob,right:VideoJob):boolean {
  if(left.kind!==right.kind)return false;
  if(left.shotId)return left.shotId===right.shotId;
  const design=left.snapshot.design;const otherDesign=right.snapshot.design;
  return Boolean(design&&typeof design==="object"&&!Array.isArray(design)&&typeof design.id==="string"
    &&otherDesign&&typeof otherDesign==="object"&&!Array.isArray(otherDesign)&&design.id===otherDesign.id&&left.snapshot.view===right.snapshot.view);
}

function otherSubmissionBlockedReason(job:VideoJob,project:VideoProject,dispatch=false):string|undefined {
  const position=project.jobs.findIndex(item=>item.id===job.id);
  const blocked=project.jobs.some((other,index)=>{
    if(other.id===job.id||!sameGenerationTarget(job,other)||!mediaJobBlocksDuplicate(other))return false;
    // A durable queue with multiple initial candidates must let one claim, never cancel them all.
    if(dispatch&&position>=0&&other.status==="queued"&&!hasReceipt(other)&&!needsReconciliation(other))return index<position;
    return true;
  });
  return blocked?`${job.shotId?"该镜头":"该设定视图"}已有其他进行中或待核对的${job.kind==="image"?"图片":"视频"}任务，请先处理该任务`:undefined;
}

function restartIssue(job:VideoJob,project:VideoProject):{code:"validation_error"|"quota_exceeded"|"revision_conflict";message:string}|undefined {
  if(job.status==="succeeded"||needsReconciliation(job))return undefined;
  if(job.state?.remoteTerminal===true)return {code:"validation_error",message:"服务方已结束该任务，请创建新的生成任务"};
  if(hasReceipt(job))return undefined;
  const reason=submissionBlockedReason(job,project)??otherSubmissionBlockedReason(job,project);
  if(reason)return {code:"revision_conflict",message:reason};
  const limit=typeof job.state?.maxAttempts==="number"?job.state.maxAttempts:3;
  if((job.attempt??0)>=limit)return {code:"quota_exceeded",message:"该任务已达到请求次数上限，请核对批次预算后创建新的生成任务"};
  return undefined;
}

/** Derived before redaction so the UI never guesses recovery from attempt counts or provider errors. */
export function mediaJobRecoveryState(job:VideoJob,project:VideoProject):{hasReceipt:boolean;needsReconciliation:boolean;canRecoverSubmission?:boolean;restartReason?:string} {
  const issue=restartIssue(job,project);
  return {...(canRecoverSubmission(job)?{canRecoverSubmission:true}:{}),hasReceipt:hasReceipt(job),needsReconciliation:!isDiscardedMediaJob(job)&&needsReconciliation(job),...(issue?{restartReason:issue.message}:{})};
}

function assertCanResume(job:VideoJob,project:VideoProject):void {
  if(needsReconciliation(job)&&!canRecoverSubmission(job))throw new JizuoError("transaction_recovery_required","尚未确认服务方是否接收请求，请先核对，不能自动重复提交");
  const issue=restartIssue(job,project);
  if(issue)throw new JizuoError(issue.code,issue.message);
}

/** Batch parents summarize their persisted children; production pipeline jobs have another type. */
export function refreshMediaBatches(project:VideoProject):void {
  for(const batch of project.jobs.filter(job=>job.kind==="pipeline"&&job.snapshot.type==="batch")){
    const ids=batch.state?.childJobIds;
    if(!Array.isArray(ids))continue;
    const children=project.jobs.filter(job=>ids.includes(job.id));
    const unfinished=children.some(job=>!isDiscardedMediaJob(job)&&(active(job)||needsReconciliation(job)));
    batch.status=unfinished?"running":children.some(job=>isDiscardedMediaJob(job)||job.status==="failed"||job.status==="cancelled")?"failed":"succeeded";
    batch.state={...batch.state,stage:"batch",progress:children.length?Math.round(children.filter(job=>job.status==="succeeded").length/children.length*100):100};
  }
}
type Options={repository:VideoRepository;settings:MediaSettingsRepository;assets:LocalVideoAssets;provider?:ReturnType<typeof createMediaProvider>;pollIntervalMs?:number;normalizeReference?:(path:string,width:number,height:number)=>Promise<Uint8Array>;hostReference?:(ref:string,bytes:Uint8Array,mimeType:string)=>Promise<string>;probeReferenceVideo?:ProbeReferenceVideo};

/** Each paid request has a durable submission intent and frozen inputs before network activity. */
export class VideoGenerationService {
  private readonly provider:ReturnType<typeof createMediaProvider>;
  private readonly pending=new Map<string,Promise<void>>();
  private readonly aborts=new Map<string,AbortController>();
  private readonly timers=new Map<string,ReturnType<typeof setTimeout>>();
  private closed=false;
  constructor(private readonly options:Options){this.provider=options.provider??createMediaProvider();}

  async generate(raw:GenerateVideoMediaInput, invocation?:{key:string;fingerprint:string},signal?:AbortSignal):Promise<VideoProject>{
    signal?.throwIfAborted();
    if(this.closed)throw new JizuoError("runtime_unavailable","视频任务服务已关闭");
    const input=GenerateVideoMediaInput.parse(raw);
    const project=await this.options.repository.read(input.workId);
    if(invocation){
      const existing=project.jobs.find(job=>job.snapshot.chatCallKey===invocation.key);
      if(existing){
        if(existing.snapshot.chatFingerprint!==invocation.fingerprint)throw new JizuoError("validation_error","同一次生成调用的内容已改变，请先查询原任务");
        return project;
      }
    }
    const job=await this.prepare(input,project);
    signal?.throwIfAborted();
    if(invocation){job.snapshot.chatCallKey=invocation.key;job.snapshot.chatFingerprint=invocation.fingerprint;}
    const next=await this.options.repository.mutate(input.workId,input.expectedRevision,draft=>{draft.jobs.push(job);});
    if(signal?.aborted){await this.control({workId:input.workId,jobId:job.id,action:"cancel"});signal.throwIfAborted();}
    this.enqueue(input.workId,job.id);
    return next;
  }

  /** Prepare a validated immutable job without spending; batch callers persist all jobs atomically. */
  async prepare(raw:GenerateVideoMediaInput,project:VideoProject):Promise<VideoJob>{
    if(this.closed)throw new JizuoError("runtime_unavailable","视频任务服务已关闭");
    const input=GenerateVideoMediaInput.parse(raw);
    if(project.workId!==input.workId)throw new JizuoError("validation_error","视频制作稿不属于当前作品");
    if(project.revision!==input.expectedRevision)throw new JizuoError("revision_conflict","视频制作稿已变化，请刷新后生成");
    const episode=project.episodes.find(item=>item.id===input.episodeId);
    const shot=episode?.shots.find(item=>item.id===input.shotId);
    if(input.episodeId&&!episode)throw new JizuoError("validation_error","视频集不存在");
    if(input.shotId&&!shot)throw new JizuoError("validation_error","镜头不属于当前视频集");
    if(shot?.locked||shot?.archived)throw new JizuoError("validation_error","请先解锁镜头再生成");
    if(input.kind==="video"&&!shot&&!(input.sourceSessionId&&input.prompt?.trim()))throw new JizuoError("validation_error","请先保存分镜再生成视频");
    if(shot&&project.jobs.some(job=>job.shotId===shot.id&&job.kind===input.kind&&mediaJobBlocksDuplicate(job)))throw new JizuoError("revision_conflict","该镜头已有进行中或待核对的生成任务，请先恢复或核对原任务");
    let config=await this.options.settings.resolveConnection(input.kind,input.connectionId);
    if(!config)throw new JizuoError("credential_required",`请在设置中配置${input.kind==="image"?"图片":"视频"}模型`);
    if(!await this.options.settings.vault.resolve(config.credentialRef))throw new JizuoError("credential_required",config.protocol === "nspox" ? "请登录选择该模型时使用的 NSPOX 账号" : "请先保存该媒体模型的 API Key");
    if(input.kind!=="image"&&(input.designId||input.view))throw new JizuoError("validation_error","设定视图仅支持图片生成");
    if(input.shotId&&(input.designId||input.view))throw new JizuoError("validation_error","请在设定库生成视图，再选择取景图片用于镜头");
    const design=designFor(project,input.designId,input.view);
    // Normalize only new requests; recovery continues using the exact saved view and prompt.
    if(design?.kind==="character"&&!input.view)input.view="character-sheet";
    if((input.view==="turnaround"||input.view==="character-sheet")){
      input.aspectRatio??="16:9";
      if(!["16:9","4:3","21:9"].includes(input.aspectRatio))throw new JizuoError("validation_error","人物合成设定图需要横向画幅，请选择 16:9、4:3 或 21:9");
    }
    if(design&&project.jobs.some(job=>{const old=job.snapshot.design;return old&&typeof old==="object"&&!Array.isArray(old)&&old.id===design.id&&job.snapshot.view===input.view&&mediaJobBlocksDuplicate(job);}))throw new JizuoError("revision_conflict","该设定视图已有进行中或待核对的任务，请先处理原任务");
    const subjectReferenceIds=input.referenceAssetIds??design?.referenceAssetIds??(input.kind==="video"&&shot?.imageAssetId?[shot.imageAssetId]:shot?.referenceAssetIds??[]);
    if(input.videoImageRoles && (input.kind!=="video" || input.videoImageRoles.length!==subjectReferenceIds.length))throw new JizuoError("validation_error","视频图片用途必须与所选图片一一对应");
    const styleReferences = planVisualReferences(config, input.kind, subjectReferenceIds, input.videoImageRoles, project.visualStyle?.referenceAssetIds ?? []);
    const referenceIds = styleReferences.ids;
    const referenceRoles = styleReferences.roles;
    try { config=applyMediaGenerationSettings(config,input.kind,input.generationSettings,referenceIds.length>0); }
    catch(error){throw new JizuoError("validation_error",error instanceof Error?error.message:"生成参数无效");}
    if(input.kind!=="video"&&input.durationSeconds!==undefined)throw new JizuoError("validation_error","图片生成不支持视频时长");
    const capabilityError=getMediaInputCapabilityError(config,{kind:input.kind,
      references:referenceIds.map((_,index)=>({url:"https://reference.invalid/image",...(referenceRoles?{role:referenceRoles[index]!}:{})})),
      ...(input.referenceVideoAssetIds?{videoReferences:input.referenceVideoAssetIds}:{})});
    if(capabilityError)throw new JizuoError("validation_error",capabilityError);
    const videoReferences=await loadReferenceVideos(project,input.referenceVideoAssetIds??[],this.options.assets,this.options.probeReferenceVideo);
    const references:MediaReferenceImage[]=[];
    for(const assetId of referenceIds){
      const {path,asset}=await this.options.assets.pathFor(input.workId,assetId);
      if(asset.panorama)throw new JizuoError("validation_error","请先打开环景取景，将取景画面用作参考图");
      if(!["image/png","image/jpeg","image/webp"].includes(asset.mimeType))throw new JizuoError("validation_error","参考素材必须是图片");
      if(config.protocol==="nspox") {
        if(this.options.hostReference){
          try{references.push({url:await this.options.hostReference(config.credentialRef,await readFile(path),asset.mimeType)});}
          catch(error){throw new JizuoError("validation_error",error instanceof Error?error.message:"NSPOX reference upload failed");}
          continue;
        }
        if(!asset.sourceUrl) throw new JizuoError("validation_error","NSPOX 参考图需要 HTTPS 链接，当前素材只有本地文件。请使用带远程链接的生成图片，或切换支持本地参考图的模型。");
        references.push({url:asset.sourceUrl}); continue;
      }
      const normalized=input.kind==="video"&&config.protocol==="openai"&&this.options.normalizeReference
        ? await this.options.normalizeReference(path,input.aspectRatio==="16:9"?1280:720,input.aspectRatio==="16:9"?720:1280) : undefined;
      const bytes=normalized?Buffer.from(normalized):await readFile(path);if(bytes.length>10*1024*1024)throw new JizuoError("validation_error","参考图超过 10 MB，请先缩小图片");
      references.push({base64:bytes.toString("base64"),mimeType:normalized?"image/png":asset.mimeType as "image/png"|"image/jpeg"|"image/webp"});
    }
    if(referenceRoles)references.forEach((ref,index)=>{ref.role=referenceRoles[index];});
    const basePrompt=input.prompt??(input.kind==="video"?shot?.videoPrompt:shot?.prompt)??design?.description??"";
    if(!basePrompt.trim())throw new JizuoError("validation_error",`请先填写${input.kind==="image"?"图片":"视频"}提示词`);
    const prompt=composeVisualPrompt(project,basePrompt,input.view?designViewPrompts[input.view]:undefined,styleReferences.positions);
    if(!prompt.trim())throw new JizuoError("validation_error","请先填写生成提示词");
    const request:MediaGenerationRequest={kind:input.kind,prompt,...(references.length?{references}:{}),...(videoReferences.length?{videoReferences}:{})};
    if(input.kind==="video"){
      const modernDash=config.protocol==="dashscope"&&(config.options?.videoApi==="wan2.7"||(!config.options?.videoApi&&config.model.startsWith("wan2.7")));
      const duration=resolveVideoGenerationDuration(config,shot?.durationSec??5,input.durationSeconds);
      if(duration!==undefined)request.durationSeconds=duration;
      if(config.protocol==="dashscope"&&references.length===0&&!modernDash){
        if(input.aspectRatio&&!['16:9','9:16','1:1'].includes(input.aspectRatio))throw new JizuoError("validation_error","该视频模型仅支持横屏、竖屏或方形画幅");
        request.width=input.aspectRatio==="1:1"?960:input.aspectRatio==="16:9"?1280:720;request.height=input.aspectRatio==="1:1"?960:input.aspectRatio==="16:9"?720:1280;
      }else if(config.protocol==="dashscope" && modernDash) request.aspectRatio=input.aspectRatio??"9:16";
      else if(config.protocol!=="dashscope" && config.protocol!=="tencent") request.aspectRatio=input.aspectRatio??"9:16";
    }else if(config.protocol==="openai"||config.protocol==="nspox"){
      if(isGptImage2(config.model)) {
        const size=input.generationSettings?.imageSize ?? gptImageSize(input.generationSettings?.imageAspectRatio ?? input.aspectRatio ?? "9:16",input.generationSettings?.imageResolution);
        if(size==="auto")request.automaticSize=true;
        else { const [w,h]=size.split("x").map(Number);request.width=w!;request.height=h!; }
      } else {
      const landscape=input.aspectRatio==="16:9"||(input.view==="turnaround"||input.view==="character-sheet");
      request.width=landscape?1536:1024;
      request.height=landscape||input.aspectRatio==="1:1"?1024:1536;
      }
    }else{
      const ratio=input.aspectRatio??"9:16";
      const sizes=config.protocol==="ark"?{
        "16:9":[2688,1536],"9:16":[1536,2688],"1:1":[2048,2048],"4:3":[2368,1728],"3:4":[1728,2368],"21:9":[3072,1312],
      }:/^qwen-image(?:$|-plus|-max)/.test(config.model)?{
        "16:9":[1664,928],"9:16":[928,1664],"1:1":[1328,1328],"4:3":[1472,1104],"3:4":[1104,1472],"21:9":undefined,
      }:{"16:9":[1536,864],"9:16":[864,1536],"1:1":[1024,1024],"4:3":[1360,1024],"3:4":[1024,1360],"21:9":[1792,768]};
      const dimensions=config.protocol==="dashscope"?dashScopeImageDimensions(config.model,ratio):sizes[ratio];
      if(!dimensions)throw new JizuoError("validation_error","该图片模型不支持所选画幅，请更换画幅或模型");
      if(config.model!=="qwen-image-edit"){request.width=dimensions[0]!;request.height=dimensions[1]!;}
    }
    if(input.generationSettings?.imageSize && input.generationSettings.imageSize!=="auto"){
      const [width,height]=input.generationSettings.imageSize.split("x").map(Number);
      if(input.view==="panorama")throw new JizuoError("validation_error","360° 环景使用固定的 2048 × 1024 尺寸");
      if((input.view==="turnaround"||input.view==="character-sheet")&&width!<=height!)throw new JizuoError("validation_error","人物合成设定图需要横向图片尺寸");
      request.width=width!;request.height=height!;
    }
    if(input.view==="panorama"){delete request.automaticSize;request.width=2048;request.height=1024;}
    if((input.view==="turnaround"||input.view==="character-sheet")&&(request.automaticSize||request.width!<=request.height!))throw new JizuoError("validation_error","人物合成设定图需要横向图片尺寸");
    let snapshot:ReturnType<typeof freezeMediaInput>;
    try{snapshot=freezeMediaInput(config,request);}catch(error){throw new JizuoError("validation_error",error instanceof MediaProviderError?error.message:"媒体生成参数无效，请检查模型支持的画幅和时长");}
    // Reference identities belong to the private execution snapshot for deletion/recovery checks, not display state.
    const job:VideoJob={id:randomUUID(),kind:input.kind,status:"queued",snapshot:json({...snapshot,referenceAssetIds:referenceIds,...(input.referenceVideoAssetIds?.length?{referenceVideoAssetIds:input.referenceVideoAssetIds}:{}),...(project.visualStyle?{visualStyle:project.visualStyle,styleReferencesTextOnly:styleReferences.textOnly}:{}),...(input.selectResult===false?{selectResult:false}:{}),...(design?{design}:{}),...(input.view?{view:input.view}:{})}),attempt:0,createdAt:new Date().toISOString(),
      state:{label:input.label??design?.name??shot?.title??(input.kind==="image"?"参考图":"视频"),...(input.sourceSessionId?{sourceSessionId:input.sourceSessionId}:{}),...(design?{designId:design.id}:{}),...(input.view?{view:input.view}:{})},
      ...(episode?{episodeId:episode.id}:{}),...(shot?{shotId:shot.id,shotRevision:shot.revision}:{})};
    return job;
  }

  enqueue(workId:string,jobId:string):void{
    if(this.closed||this.pending.has(jobId))return;
    const controller=new AbortController();this.aborts.set(jobId,controller);
    const promise=this.step(workId,jobId,controller.signal).finally(()=>{this.pending.delete(jobId);this.aborts.delete(jobId);});
    this.pending.set(jobId,promise);
    // step records failures durably. A storage error remains observable through idle() and recovery.
    void promise.catch(()=>undefined);
  }
  private schedule(workId:string,jobId:string):void{
    if(this.closed)return;
    const existing=this.timers.get(jobId);if(existing)clearTimeout(existing);
    const timer=setTimeout(()=>{this.timers.delete(jobId);this.enqueue(workId,jobId);},this.options.pollIntervalMs??3000);
    timer.unref?.();this.timers.set(jobId,timer);
  }
  private async patch(workId:string,jobId:string,mutate:(job:VideoJob,project:VideoProject)=>void):Promise<void>{
    await this.options.repository.mutate(workId,undefined,project=>{const job=project.jobs.find(item=>item.id===jobId);if(!job)throw new Error("任务记录不存在");mutate(job,project);job.updatedAt=new Date().toISOString();refreshMediaBatches(project);});
  }
  private async step(workId:string,jobId:string,signal:AbortSignal):Promise<void>{
    let job=(await this.options.repository.read(workId)).jobs.find(item=>item.id===jobId);
    if(!job||!active(job))return;
    try{
      const request=MediaGenerationRequest.parse(job.snapshot.request);
      const config=resolveKuaishouTaskConfig(MediaProviderConfig.parse(job.snapshot.config),request);
      const key=await this.options.settings.vault.resolve(config.credentialRef);
      if(!key)throw new JizuoError("credential_required","任务使用的模型凭据不可用，请恢复该凭据");
      let output=job.state?.output===undefined?undefined:MediaOutput.parse(job.state.output);
      if(!output){
        if(job.remoteId){
          const polled=await this.provider.poll(config,key,job.remoteId,signal);
          if(polled.status==="running"){
            if(job.error || job.state?.progress!==polled.progress)await this.patch(workId,jobId,current=>{delete current.error;setReportedProgress(current,polled.progress);});
            this.schedule(workId,jobId);return;
          }
          if(polled.status==="failed"){
            await this.patch(workId,jobId,current=>{current.state={...current.state,remoteTerminal:true};});
            throw new MediaProviderError(polled.message,"rejected");
          }
          output=polled.output;
        }else{
          if((job.status!=="queued"||needsReconciliation(job))&&!canRecoverSubmission(job)){
            await this.patch(workId,jobId,current=>{current.status="uncertain";current.error="提交结果尚未确认，请先核对服务方任务，避免重复计费";});return;
          }
          let claimed=false;
          await this.patch(workId,jobId,(current,project)=>{
            if (canRecoverSubmission(current) && active(current)) {
              if (receiptRecoveryAttempts(current) >= MAX_RECEIPT_RECOVERY) return;
              current.status = "running";
              current.state = {...current.state, receiptRecoveryAttempts: receiptRecoveryAttempts(current) + 1, submission: "unknown"};
              delete current.state.discarded;
              claimed = true; return;
            }
            if(current.status!=="queued"||hasReceipt(current)||needsReconciliation(current))return;
            const blockedReason=submissionBlockedReason(current,project)??otherSubmissionBlockedReason(current,project,true);
            if(blockedReason){
              current.status="cancelled";current.error=`${blockedReason}；本次尚未向服务方提交`;current.state={...current.state,submission:"not-submitted"};return;
            }
            const limit=typeof current.state?.maxAttempts==="number"?current.state.maxAttempts:3;
            if((current.attempt??0)>=limit){current.status="failed";current.error="该任务已达到请求次数上限";return;}
            current.status="running";current.attempt=(current.attempt??0)+1;current.state={...current.state,submission:"started"};setReportedProgress(current);claimed=true;
          });
          if(!claimed)return;
          signal.throwIfAborted();
          const submitted=await this.provider.submit(config,key,request,signal);
          if(submitted.status==="running"){
            await this.patch(workId,jobId,current=>{current.remoteId=submitted.remoteId;current.state={...current.state,submission:"acknowledged"};setReportedProgress(current,submitted.progress);});
            this.schedule(workId,jobId);return;
          }
          output=submitted.output;
        }
        const savedOutput=json(output);
        await this.patch(workId,jobId,current=>{current.state={...current.state,output:savedOutput,submission:"acknowledged"};setReportedProgress(current);});
      }
      signal.throwIfAborted();
      if(!output.mimeType.startsWith(`${request.kind}/`)) throw new MediaProviderError("生成结果类型与任务不符，请核对原任务", "unknown");
      const downloaded=await this.provider.download(config,key,output,signal);
      if(!downloaded.mimeType.startsWith(`${request.kind}/`)) throw new MediaProviderError("下载素材类型与任务不符，请核对原任务", "unknown");
      signal.throwIfAborted();
      job=(await this.options.repository.read(workId)).jobs.find(item=>item.id===jobId)!;
      if(job.status==="cancelled"||job.status==="succeeded")return;
      const view=VideoAssetView.optional().parse(job.snapshot.view);
      if(view==="panorama") {
        try{requirePanorama(downloaded.bytes);}
        catch(error){await this.patch(workId,jobId,current=>{current.state={...current.state,remoteTerminal:true};});throw error;}
      }
      const designId=job.snapshot.design&&typeof job.snapshot.design==="object"&&!Array.isArray(job.snapshot.design)?job.snapshot.design.id:undefined;
      const asset=await this.options.assets.write(workId,{kind:job.kind as "image"|"video",label:String(job.state?.label??"生成素材").slice(0,120),
        ...("url" in output && !output.requiresAuth && output.url.length<=8192 && new URL(output.url).protocol==="https:" && !new URL(output.url).username && !new URL(output.url).password ? {sourceUrl:output.url} : {}),
        ...(typeof designId==="string"?{designId}:{}),...(view?{view}:{}),...(view==="panorama"?{panorama:{projection:"equirectangular" as const}}:{}),
        sourceJobId:job.id,...(job.episodeId?{episodeId:job.episodeId}:{}),...(job.shotId?{shotId:job.shotId}:{}),
        ...(request.kind==="video"&&request.durationSeconds?{durationSec:request.durationSeconds}:{})},downloaded.bytes,downloaded.mimeType);
      await this.patch(workId,jobId,(current,project)=>{
        if(current.status==="succeeded"||current.resultAssetIds?.length)return;
        project.assets.push(asset);current.resultAssetIds=[asset.id];
        // Keep every candidate, but only select a result whose exact shot version is still current.
        if(current.status!=="cancelled"){
          current.status="succeeded";current.state={...current.state,remoteTerminal:true};setReportedProgress(current);delete current.error;
          const shot=project.episodes.find(item=>item.id===current.episodeId)?.shots.find(item=>item.id===current.shotId);
          if(current.snapshot.selectResult!==false&&shot&&shot.revision===current.shotRevision&&!shot.locked&&!shot.archived){if(current.kind==="image")shot.imageAssetId=asset.id;else shot.videoAssetId=asset.id;}
        }
        if(current.state)delete current.state.output;
      });
    }catch(error){
      if(this.closed)return;
      job=(await this.options.repository.read(workId)).jobs.find(item=>item.id===jobId)!;
      if (!hasReceipt(job) && error instanceof MediaProviderError && error.remoteId) {
        await this.patch(workId,jobId,current=>{current.remoteId=error.remoteId!;current.state={...current.state,submission:"acknowledged"};});
        job=(await this.options.repository.read(workId)).jobs.find(item=>item.id===jobId)!;
      }
      if (active(job) && canRecoverSubmission(job) && !signal.aborted && temporaryProviderError(error) && (!(error instanceof MediaProviderError)||error.submission==="unknown") && receiptRecoveryAttempts(job) < MAX_RECEIPT_RECOVERY) {
        await this.patch(workId,jobId,current=>{
          if (!active(current)) return;
          current.status="running";current.state={...current.state,submission:"unknown"};delete current.state.discarded;
          current.error="提交回执暂未收到，正在恢复原请求结果。";
        });
        this.schedule(workId,jobId);return;
      }
      if(hasReceipt(job) && job.state?.remoteTerminal !== true && !signal.aborted) {
        if(error instanceof MediaProviderError && error.resultUnknown) {
          await this.patch(workId,jobId,current=>{if(current.status!=="running")return;current.status="uncertain";current.error=error.message;current.state={...current.state,remoteResultUnknown:true};delete current.state.discarded;});
          return;
        }
        const temporary = temporaryProviderError(error);
        if(temporary) {
          await this.patch(workId,jobId,current=>{if(current.status!=="running")return;current.error="暂时无法查询任务，正在恢复连接；不会重新提交生成。";});
          this.schedule(workId,jobId);return;
        }
      }
      await this.patch(workId,jobId,current=>{
        if(current.status==="cancelled")return;
        if(current.status==="succeeded")return;
        if(!hasReceipt(current)&&error instanceof MediaProviderError)current.state={...current.state,submission:error.submission};
        const ambiguous=!hasReceipt(current)&&current.status==="running"&&(!(error instanceof MediaProviderError)||error.submission==="unknown");
        current.status=ambiguous?"uncertain":"failed";
        current.state={...current.state,...(ambiguous?{submission:"unknown"}:{})};
        delete current.state.discarded;
        current.error=error instanceof MediaProviderError?error.message:error instanceof JizuoError?error.message:signal.aborted?"任务已停止":"生成任务失败，可查看配置后重试";
      });
    }
  }

  async control(raw:ControlVideoJobInput):Promise<VideoProject>{
    if(this.closed)throw new JizuoError("runtime_unavailable","视频任务服务已关闭");
    const input=ControlVideoJobInput.parse(raw);
    const project=await this.options.repository.read(input.workId);
    const job=project.jobs.find(item=>item.id===input.jobId);
    if(!job||!(job.kind==="image"||job.kind==="video"))throw new JizuoError("validation_error","媒体任务不存在");
    if(job.state?.endedLocally===true)return project;
    if(input.action==="abandon"){
      if(this.pending.has(job.id))throw new JizuoError("transaction_recovery_required","任务仍在处理，请先停止跟进，稍后再结束本地任务");
      if(!["uncertain","cancelled","failed"].includes(job.status))throw new JizuoError("validation_error","请先停止跟进，再结束本地任务");
      const timer=this.timers.get(job.id);if(timer)clearTimeout(timer);this.timers.delete(job.id);
      await this.patch(input.workId,job.id,current=>{
        if(!["uncertain","cancelled","failed"].includes(current.status))throw new JizuoError("revision_conflict","任务状态已变化，请刷新后重试");
        current.status="cancelled";
        current.state={...current.state,endedLocally:true,endedLocallyAt:new Date().toISOString()};
        setReportedProgress(current);
        current.error="已结束本地任务，可重新生成；服务方任务未取消，可能仍在执行或已计费。";
      });
      return this.options.repository.read(input.workId);
    }
    if(input.action==="cancel"){
      const timer=this.timers.get(job.id);if(timer)clearTimeout(timer);this.timers.delete(job.id);
      await this.patch(input.workId,job.id,current=>{
        if(active(current)||current.status==="uncertain"){
          // Legacy running records may lack attempt metadata; cancellation must not erase that evidence.
          if(needsReconciliation(current))current.state={...current.state,submission:"unknown"};
          current.status="cancelled";current.error="已停止本地任务；服务方已提交的生成可能继续执行";
        }
      });
      this.aborts.get(job.id)?.abort();
      return this.options.repository.read(input.workId);
    }
    // A cancelled POST may still return a receipt. Never change state beneath its owner.
    if(this.pending.has(job.id)){
      if(active(job)&&input.action!=="reconcile")return project;
      throw new JizuoError("transaction_recovery_required","任务仍在停止，请等待服务方回执后再核对或恢复");
    }
    if(job.status==="succeeded")return project;
    if(input.action==="reconcile"){
      if(hasReceipt(job)||!needsReconciliation(job))throw new JizuoError("validation_error","该任务已有回执或尚未提交，无需指定其他任务 ID");
      const frozenConfig=MediaProviderConfig.parse(job.snapshot.config);
      if(job.kind==="image"&&frozenConfig.protocol==="openai")throw new JizuoError("validation_error","当前连接使用同步图片接口，无法按任务 ID 查询。请在上游核对并下载已生成图片，再导入素材库；不要重复提交同一生成请求。");
      const config=frozenConfig.protocol==="kuaishou"?resolveKuaishouTaskConfig(frozenConfig,MediaGenerationRequest.parse(job.snapshot.request)):frozenConfig;
      const key=await this.options.settings.vault.resolve(config.credentialRef);
      if(!key)throw new JizuoError("credential_required","任务使用的模型凭据不可用，请恢复原凭据后核对");
      const receipt=input.remoteId!;
      const polled=await this.provider.poll(config,key,receipt);
      if(polled.status==="running"&&polled.remoteId!==receipt)throw new JizuoError("validation_error","服务方返回了不同的任务 ID，未确认关联");
      await this.patch(input.workId,job.id,current=>{
        if(hasReceipt(current)||!needsReconciliation(current))throw new JizuoError("revision_conflict","任务回执已变化，请刷新后核对");
        current.remoteId=receipt;current.state={...current.state,submission:"acknowledged",reconciledAt:new Date().toISOString()};
        if(polled.status==="failed"){current.status="failed";current.state.remoteTerminal=true;current.error=polled.message;}
        else{current.status="running";delete current.state.discarded;delete current.error;setReportedProgress(current,polled.status==="running"?polled.progress:undefined);if(polled.status==="succeeded")current.state.output=json(polled.output);}
      });
      if(polled.status!=="failed")this.enqueue(input.workId,job.id);
      return this.options.repository.read(input.workId);
    }
    // Reject an obsolete no-receipt task before clearing its original failure or changing history.
    assertCanResume(job,project);
    await this.patch(input.workId,job.id,(current,draft)=>{
      if(current.status==="succeeded")return;
      assertCanResume(current,draft);
      if(canRecoverSubmission(current)) current.state={...current.state,receiptRecoveryAttempts:0};
      current.status=hasReceipt(current)?"running":"queued";if(current.state){delete current.state.discarded;delete current.state.remoteResultUnknown;}setReportedProgress(current);delete current.error;
    });
    this.enqueue(input.workId,job.id);
    return this.options.repository.read(input.workId);
  }
  async recover(workId:string,jobIds?:readonly string[]):Promise<void>{
    if(this.closed)return;
    const project=await this.options.repository.read(workId);
    for(const job of project.jobs.filter(item=>(item.kind==="image"||item.kind==="video")&&(active(item)||item.status!=="cancelled"&&canRecoverSubmission(item)&&receiptRecoveryAttempts(item)<MAX_RECEIPT_RECOVERY)&&(!jobIds||jobIds.includes(item.id)))){
      if(this.pending.has(job.id))continue;
      if (canRecoverSubmission(job) && receiptRecoveryAttempts(job)<MAX_RECEIPT_RECOVERY) {
        await this.patch(workId,job.id,current=>{
          if(current.status==="cancelled"||current.status==="succeeded"||!canRecoverSubmission(current))return;
          current.status="running";current.state={...current.state,submission:"unknown"};delete current.state.discarded;
        });
        this.enqueue(workId,job.id);
      } else if(!hasReceipt(job)&&(job.status==="running"||needsReconciliation(job)))await this.patch(workId,job.id,current=>{
        if(this.pending.has(job.id)||!active(current)||hasReceipt(current))return;
        current.status="uncertain";current.error="应用中断时尚未保存服务方回执，请核对后处理";
      });
      else this.enqueue(workId,job.id);
    }
  }
  async idle():Promise<void>{await Promise.all([...this.pending.values()]);}
  async close():Promise<void>{this.closed=true;for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();for(const abort of this.aborts.values())abort.abort();await this.idle();}
}
