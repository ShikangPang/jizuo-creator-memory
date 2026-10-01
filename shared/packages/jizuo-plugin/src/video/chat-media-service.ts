import { createHash } from "node:crypto";
import { resolve, dirname, basename } from "node:path";
import { ChatMediaInput, JizuoError, type VideoProject } from "@jizuo/contracts";
import type { JizuoService } from "../service.ts";
import { projectVideoForClient } from "./projection.ts";
export interface ChatMediaContext { sessionId:string; callId:string; cwd?:string }
export interface ChatReferenceImage { id:string; name?:string; mimeType:string; read():Promise<Uint8Array> }
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
export class ChatMediaService {
 private readonly pending=new Map<string,Promise<unknown>>();
 constructor(private readonly domain:JizuoService){}
 private serial<T>(id:string,operation:()=>Promise<T>):Promise<T>{
  const previous=this.pending.get(id)??Promise.resolve();
  const task=previous.catch(()=>undefined).then(operation);this.pending.set(id,task);
  void task.finally(()=>{if(this.pending.get(id)===task)this.pending.delete(id);}).catch(()=>undefined);return task;
 }
 private async target(context:ChatMediaContext){
  if(context.cwd)for(const work of await this.domain.listWorks()){
   const {path}=await this.domain.resolveWorkPath(work.id);
   const current=resolve(path), previous=resolve(context.cwd);
   const suffix=`--${work.id.replace(/^work_/,"")}`;
   if(current===previous || dirname(current)===dirname(previous)&&basename(previous).endsWith(suffix))return work.id;
  }
  return (await this.domain.chatMediaRepository.ensureSessionSpace(context.sessionId)).workId;
 }
 async generate(context:ChatMediaContext,raw:ChatMediaInput,references:ChatReferenceImage[]=[],signal?:AbortSignal){
  signal?.throwIfAborted();
  const input=ChatMediaInput.parse(raw);
  if(!context.sessionId||context.sessionId.length>128||!context.callId)throw new JizuoError("denied","生成必须来自当前聊天");
  const workId=await this.target(context);
  return this.serial(workId,async()=>{
   signal?.throwIfAborted();
   const engine=this.domain.videoGeneration;if(!engine)throw new JizuoError("runtime_unavailable","媒体生成尚未连接");
   await this.domain.chatMediaRepository.remember(context.sessionId,workId);
   const key=hash(JSON.stringify([context.sessionId,context.callId]));
   const fingerprint=hash(JSON.stringify(input));
   let project=await this.domain.video.read(workId);
   let job=project.jobs.find(job=>job.snapshot.chatCallKey===key);
   if(job){if(job.snapshot.chatFingerprint!==fingerprint)throw new JizuoError("validation_error","同一次生成调用的内容已改变，请先查询原任务");}
   else {
    const ids=[...(input.referenceAssetIds??[])];
    for(const id of ids)if(!project.assets.some(asset=>asset.id===id&&asset.kind==="image"&&!asset.deletedAt))throw new JizuoError("denied","参考图片不属于当前素材空间或已删除");
    const attachments=(input.referenceAttachmentIds??[]).map(id=>{
     const ref=references.find(ref=>ref.id===id);if(!ref)throw new JizuoError("denied","参考图片不属于当前聊天，请重新引用");return ref;
    });
    if(ids.length+attachments.length>14)throw new JizuoError("validation_error","参考图片最多 14 张");
    for(const ref of attachments){
     if(!this.domain.videoMedia)throw new JizuoError("runtime_unavailable","素材导入尚未连接");
     if(!["image/png","image/jpeg","image/webp"].includes(ref.mimeType))throw new JizuoError("validation_error","参考图需使用 PNG、JPEG 或 WebP");
     const bytes=await ref.read();if(bytes.length>20_000_000)throw new JizuoError("validation_error","参考图片过大");
     project=await this.domain.videoMedia.import({workId,expectedRevision:project.revision,kind:"image",label:(ref.name??"聊天参考图").slice(0,120),mimeType:ref.mimeType as "image/png",base64:Buffer.from(bytes).toString("base64")});
     ids.push(project.assets.at(-1)!.id);
    }
    const {referenceAttachmentIds:_,...generation}=input;
    signal?.throwIfAborted();
    project=await engine.generate({...generation,workId,expectedRevision:project.revision,sourceSessionId:context.sessionId,referenceAssetIds:ids,selectResult:false},{key,fingerprint},signal);
    job=project.jobs.find(job=>job.snapshot.chatCallKey===key);
   }
   if(!job)throw new JizuoError("runtime_unavailable","未找到已提交的媒体任务");
   return {workId,jobId:job.id,status:job.status};
  });
 }
 async list(sessionId:string):Promise<VideoProject[]>{
  const spaces=await this.domain.chatMediaRepository.listSpaces(sessionId);
  const result:VideoProject[]=[];
  for(const workId of spaces){
   let project:VideoProject;
   try {project=await this.domain.video.read(workId);}catch(error){if((error as {code?:string}).code==="ENOENT"||(error as {code?:string}).code==="not_found")continue;throw error;}
   const jobs=project.jobs.filter(job=>job.state?.sourceSessionId===sessionId);
   if(!jobs.length)continue;
   const assetIds=new Set(jobs.flatMap(job=>job.resultAssetIds??[]));
   result.push(projectVideoForClient(project,{jobs,episodes:[],assets:project.assets.filter(asset=>assetIds.has(asset.id))}));
  }
  return result;
 }
 async control(sessionId:string,workId:string,jobId:string,action:"cancel"|"resume"|"reconcile",remoteId?:string){
  if(!(await this.domain.chatMediaRepository.listSpaces(sessionId)).includes(workId))throw new JizuoError("denied","任务不属于当前聊天");
  const job=(await this.domain.video.read(workId)).jobs.find(job=>job.id===jobId);
  if(job?.state?.sourceSessionId!==sessionId)throw new JizuoError("denied","任务不属于当前聊天");
  if(!this.domain.videoGeneration)throw new JizuoError("runtime_unavailable","媒体生成尚未连接");
  await this.domain.videoGeneration.control({workId,jobId,action,...(remoteId?{remoteId}:{})});
  return this.list(sessionId);
 }
}
