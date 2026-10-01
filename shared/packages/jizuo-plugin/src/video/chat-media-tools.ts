import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { Session } from "@deepseek-ai/dsh-session";
import { z } from "zod";
import { ChatMediaInput, JizuoError } from "@jizuo/contracts";
import { toolInputSchema, parseToolInput, withToolInputRepair } from "../../../writing-plugin/src/tool-input-schema.ts";
import type { ToolsContext } from "../tools.ts";
import type { ChatMediaService, ChatReferenceImage } from "./chat-media-service.ts";
type ImageRef=Extract<ReturnType<Session["deriveMessages"]>[number]["content"][number],{type:"image"}>["attachment"];
export interface ChatAttachmentReader { readImage(ref:ImageRef,signal?:AbortSignal):Promise<{data:Uint8Array}> }
export function sessionImageReferences(session:Session,reader:ChatAttachmentReader|undefined,signal:AbortSignal):ChatReferenceImage[]{
 const images=new Map<string,ChatReferenceImage>();
 for(const message of session.deriveMessages())if(message.role==="user")for(const part of message.content){
  if(part.type!=="image")continue;
  const ref=part.attachment;
  images.set(ref.attachmentId,{id:ref.attachmentId,...(ref.name?{name:ref.name}:{}),mimeType:ref.mediaType,read:async()=>{
   signal.throwIfAborted();if(!reader)throw new JizuoError("runtime_unavailable","聊天附件读取服务尚未连接");
   return (await reader.readImage(ref,signal)).data;
  }});
 }
 return [...images.values()];
}
export function registerChatMediaTools(ctx:ToolsContext,service:ChatMediaService,attachments:()=>ChatAttachmentReader|undefined):void{
 const register=(name:string,description:string,schema:z.ZodType,run:(input:unknown,exec:Parameters<ToolDefinition["execute"]>[1])=>Promise<unknown>,readOnly=false)=>{
  ctx.tools.register(withToolInputRepair(defineTool({name,description:`${description}\n业务参数放在 input 对象内。Schema: ${JSON.stringify(z.toJSONSchema(schema, { io: "input" }))}`,
   parameters:{input:toolInputSchema(schema,"工具参数对象；直接传对象，不能传 JSON 字符串")},
   output:{schema:{type:"json"},render:(_args,value)=>[{type:"text" as const,text:JSON.stringify(value)}]},
   isConcurrencySafe:()=>readOnly,
   execute:async(args,exec)=>{
    exec.signal.throwIfAborted();const session=exec.agent?.session;
    if(!session?.id)throw new JizuoError("denied","此工具只能从当前聊天调用");
    if((exec.agent?.options as {subagentDepth?:number})?.subagentDepth||session.header.origin==="subagent"||(session.header as {delegationDepth?:number}).delegationDepth)throw new JizuoError("denied","聊天媒体任务必须由主代理执行");
    const parsed=parseToolInput(schema,args.input,name);
    return JSON.parse(JSON.stringify(await run(parsed,exec))) as never;
   },
  }) as ToolDefinition, schema));
 };
 register("jizuo_generate_chat_media","调用已配置的图片或视频模型，在当前聊天生成一份媒体，不需要作品。用户明确要求或已授权创作任务时直接调用；意图不清先询问；仅讨论提示词不生成。批量先确认数量和用途，先做一份样例。referenceAttachmentIds 来自 jizuo_list_chat_media 的 attachments；referenceAssetIds 来自当前素材空间的历史结果。返回 queued/running 只代表已提交，请查询状态，禁止因等待而重新生成。",ChatMediaInput,async(raw,exec)=>{
  const session=exec.agent!.session;
  return service.generate({sessionId:session.id,callId:exec.callId,...(session.header.cwd?{cwd:session.header.cwd}:{})},raw as ChatMediaInput,sessionImageReferences(session,attachments(),exec.signal),exec.signal);
 });
 register("jizuo_list_chat_media","查询当前聊天的媒体生成任务、结果素材和可用参考图片附件。生成未完成时查此工具，不能重复提交。",z.object({}).strict(),async(_input,exec)=>({
  projects:await service.list(exec.agent!.session.id),
  attachments:sessionImageReferences(exec.agent!.session,attachments(),exec.signal).map(({read:_,...metadata})=>metadata),
 }),true);
 const Control=z.object({workId:z.string().min(1),jobId:z.string().min(1),action:z.enum(["cancel","resume","reconcile"]),remoteId:z.string().min(1).max(512).optional()}).strict();
 register("jizuo_control_chat_media","控制当前聊天的媒体任务。cancel 取消本地任务，resume 恢复已有任务，reconcile 使用服务方任务 ID 核对结果。未知结果不得重新付费生成。",Control,async(raw,exec)=>{
  const input=Control.parse(raw);return service.control(exec.agent!.session.id,input.workId,input.jobId,input.action,input.remoteId);
 });
}
