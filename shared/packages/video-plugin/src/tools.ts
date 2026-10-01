import { createHash } from "node:crypto";
import { readEpisodeSources } from "../../jizuo-plugin/src/video/episode-sources.ts";
import { renderSkillPrompt } from "../../contracts/src/skill-prompt.ts";
import { MEDIA_PROMPT_RULES } from "../../contracts/src/media-prompt-rules.generated.ts";
import { SaveWorkVisualStyleInput, SaveStyledPromptsInput, UndoStyledPromptsInput } from "../../contracts/src/visual-style.ts";
import { StartVideoProductionInput, ControlVideoProductionInput } from "../../contracts/src/video-production.ts";
import { VideoTimelineHistoryInput, RestoreVideoTimelineInput, RoughCutVideoInput, EditVideoTimelineInput, ExportVideoInput } from "../../contracts/src/video-editing.ts";
import { GenerateSpeechInput } from "../../contracts/src/video-speech.ts";
import { projectVideoForClient } from "../../jizuo-plugin/src/video/projection.ts";
import { SubmitVideoBatchInput, GenerateVideoMediaInput, ControlVideoJobInput } from "../../contracts/src/media-operations.ts";
import { RenameVideoAssetInput, SelectVideoAssetInput } from "../../contracts/src/asset-operations.ts";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { z } from "zod";
import { ReplaceDesignPromptInput, SaveVideoDesignInput, TagVideoAssetInput, ExtractVideoDesignsInput, JizuoError, GetVideoProjectInput, CreateVideoEpisodeInput, UpdateVideoEpisodeInput } from "@jizuo/contracts";
import { AdaptVideoEpisodeInput, ReplaceVideoPromptInput } from "../../contracts/src/video-authoring.ts";
import type { ToolsContext } from "../../writing-plugin/src/tools.ts";
import { toolInputSchema, parseToolInput, withToolInputRepair } from "../../writing-plugin/src/tool-input-schema.ts";
import type { JizuoService } from "../../jizuo-plugin/src/service.ts";


/** Video tools share the work repository and right-side native AI session. */
export function registerVideoTools(ctx: ToolsContext, service: JizuoService & {videoAuthoring?: import("../../jizuo-plugin/src/video/authoring.ts").VideoAuthoringService}): void {
  const register = <T>(name:string,description:string,schema:z.ZodType<T>,execute:(input:T,signal:AbortSignal,exec:Parameters<ToolDefinition["execute"]>[1])=>Promise<unknown>,readOnly=false) => {
    const definition=defineTool({
      name, description: renderSkillPrompt("media-tool-1",{v0:String(description),v1:String(JSON.stringify(z.toJSONSchema(schema, { io: "input" })))}),
      parameters: { input: toolInputSchema(schema, MEDIA_PROMPT_RULES["media-tool-2"]) },
      // render feeds the model; presentResult is only the compact UI card.
      output: { schema: { type: "json" }, render: (_args, value) => [{type:"text" as const,text:JSON.stringify(value)}] },
      presentResult: (_args, result) => result.isError ? undefined : {
        card: "generic", content: [{type:"text",text:readOnly?"已读取视频项目":"视频项目已更新"}],
      },
      isConcurrencySafe: () => readOnly,
      execute: async(args,exec)=>{
        exec.signal.throwIfAborted();
        const agent=exec.agent;
        const header=agent?.session.header as {origin?:string;delegationDepth?:number}|undefined;
        const depth=(agent?.options as {subagentDepth?:number}|undefined)?.subagentDepth??0;
        if(!readOnly&&(depth>0||(header?.delegationDepth??0)>0||header?.origin==="subagent"))throw new JizuoError("denied","视频修改和生成任务必须由主代理执行");
        const parsed=parseToolInput(schema,args.input,name);
        const data=parsed as {workId?:string};
        if(data.workId?.startsWith("chat_")) {
          const sessionId=exec.agent?.session.id;
          if(!sessionId || !(await service.chatMediaRepository.listSpaces(sessionId)).includes(data.workId))throw new JizuoError("denied","不能读取或修改其他会话的媒体");
        }
        const result = await execute(parsed,exec.signal,exec);
        const projected = result && typeof result === "object" && "schemaVersion" in result && "episodes" in result ? projectVideoForClient(result as import("@jizuo/contracts").VideoProject) : result;
        return JSON.parse(JSON.stringify(projected)) as never;
      },
    });
    ctx.tools.register(withToolInputRepair(definition as ToolDefinition, schema));
  };
  register("jizuo_read_video_project",MEDIA_PROMPT_RULES["media-tool-3"],GetVideoProjectInput,input=>service.video.read(input.workId),true);
  register("jizuo_read_video_episode_sources", MEDIA_PROMPT_RULES["media-tool-episode-sources"], UpdateVideoEpisodeInput.pick({workId:true,episodeId:true}).extend({includeContent:z.boolean().optional()}), (input,signal)=>readEpisodeSources(service,input,signal), true);
  register("jizuo_replace_design_prompt",MEDIA_PROMPT_RULES["media-tool-4"],ReplaceDesignPromptInput,async input=>{
    if(!service.videoMedia)throw new JizuoError("runtime_unavailable","设定库尚未连接");
    return service.videoMedia.replaceDesignPrompt(input);
  });
  register("jizuo_save_styled_prompts",MEDIA_PROMPT_RULES["media-tool-5"],SaveStyledPromptsInput,input=>service.video.saveStyledPrompts(input));
  register("jizuo_undo_styled_prompts",MEDIA_PROMPT_RULES["media-tool-6"],UndoStyledPromptsInput,input=>service.video.undoStyledPrompts(input));
  register("jizuo_save_work_visual_style",MEDIA_PROMPT_RULES["media-tool-7"],SaveWorkVisualStyleInput,input=>service.video.saveVisualStyle(input));
  register("jizuo_create_video_episode",MEDIA_PROMPT_RULES["media-tool-8"],CreateVideoEpisodeInput,input=>service.video.createEpisode(input));
  register("jizuo_update_video_episode",MEDIA_PROMPT_RULES["media-tool-9"],UpdateVideoEpisodeInput,input=>service.video.updateEpisode(input));
  register("jizuo_replace_video_prompt",MEDIA_PROMPT_RULES["media-tool-10"],ReplaceVideoPromptInput,input=>service.video.replaceShotPrompt(input));
  register("jizuo_adapt_video_episode",MEDIA_PROMPT_RULES["media-tool-11"],AdaptVideoEpisodeInput,async(input,signal)=>{
    if(!service.videoAuthoring)throw new JizuoError("runtime_unavailable","制作稿模型尚未连接");
    return service.videoAuthoring.adapt(input,signal);
  });
  register("jizuo_save_video_design",MEDIA_PROMPT_RULES["media-tool-12"],SaveVideoDesignInput,async input=>{
    if(!service.videoMedia)throw new JizuoError("runtime_unavailable","设定库尚未连接");
    return service.videoMedia.saveDesign(input);
  });
  register("jizuo_tag_video_asset",MEDIA_PROMPT_RULES["media-tool-13"],TagVideoAssetInput,async input=>{
    if(!service.videoMedia)throw new JizuoError("runtime_unavailable","设定库尚未连接");
    return service.videoMedia.tag(input);
  });
  register("jizuo_extract_video_designs",MEDIA_PROMPT_RULES["media-tool-14"],ExtractVideoDesignsInput,async(input,signal)=>{
    if(!service.videoAuthoring)throw new JizuoError("runtime_unavailable","设定提取尚未连接");
    return service.videoAuthoring.extractDesigns(input,signal);
  });
  register("jizuo_generate_video_media",MEDIA_PROMPT_RULES["media-tool-15"],GenerateVideoMediaInput,async (input,_signal,exec)=>{
    if(!service.videoGeneration)throw new JizuoError("runtime_unavailable","媒体生成尚未连接");
    const sourceSessionId=exec.agent?.session.id;
    if(!sourceSessionId)throw new JizuoError("denied","媒体生成必须从当前聊天调用");
    await service.chatMediaRepository.remember(sourceSessionId,input.workId);
    const {expectedRevision:_,sourceSessionId:__,...request}=input;
    const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
    return service.videoGeneration.generate({...input,sourceSessionId},{key:hash([sourceSessionId,exec.callId]),fingerprint:hash(request)},_signal);
  });
  register("jizuo_control_video_job",MEDIA_PROMPT_RULES["media-tool-16"],ControlVideoJobInput,async input=>{
    const job=(await service.video.read(input.workId)).jobs.find(item=>item.id===input.jobId);
    const handler=job?.kind==="export"?service.videoEditing:job?.kind==="audio"?service.videoSpeech:service.videoGeneration;
    if(!handler)throw new JizuoError("runtime_unavailable","任务服务尚未连接");
    return handler.control(input);
  });
  register("jizuo_select_video_asset",MEDIA_PROMPT_RULES["media-tool-17"],SelectVideoAssetInput,async input=>{
    if(!service.videoMedia)throw new JizuoError("runtime_unavailable","素材管理尚未连接");
    return service.videoMedia.select(input);
  });

  register("jizuo_submit_video_batch",MEDIA_PROMPT_RULES["media-tool-18"],SubmitVideoBatchInput,async input=>{
    if(!service.videoBatch)throw new JizuoError("runtime_unavailable","批量生成尚未连接");
    return service.videoBatch.submit(input);
  });
  register("jizuo_rough_cut_video",MEDIA_PROMPT_RULES["media-tool-19"],RoughCutVideoInput,async input=>{
    if(!service.videoEditing)throw new JizuoError("runtime_unavailable","剪辑配音服务尚未连接");
    return service.videoEditing.roughCut(input);
  });
  register("jizuo_edit_video_timeline",MEDIA_PROMPT_RULES["media-tool-20"],EditVideoTimelineInput,async input=>{
    if(!service.videoEditing)throw new JizuoError("runtime_unavailable","剪辑配音服务尚未连接");
    return service.videoEditing.edit(input);
  });
  register("jizuo_export_video",MEDIA_PROMPT_RULES["media-tool-21"],ExportVideoInput,async input=>{
    if(!service.videoEditing)throw new JizuoError("runtime_unavailable","剪辑配音服务尚未连接");
    return service.videoEditing.export(input);
  });
  register("jizuo_generate_video_speech",MEDIA_PROMPT_RULES["media-tool-22"],GenerateSpeechInput,async input=>{
    if(!service.videoSpeech)throw new JizuoError("runtime_unavailable","剪辑配音服务尚未连接");
    return service.videoSpeech.generate(input);
  });

  register("jizuo_rename_video_asset",MEDIA_PROMPT_RULES["media-tool-23"],RenameVideoAssetInput,async input=>{
    if(!service.videoMedia)throw new JizuoError("runtime_unavailable","素材重命名尚未连接");
    return service.videoMedia.rename(input);
  });
  register("jizuo_read_video_timeline_history",MEDIA_PROMPT_RULES["media-tool-24"],VideoTimelineHistoryInput,async input=>{
    if(!service.videoEditing)throw new JizuoError("runtime_unavailable","剪辑历史尚未连接");
    return service.videoEditing.timelineHistory(input);
  },true);
  register("jizuo_restore_video_timeline",MEDIA_PROMPT_RULES["media-tool-25"],RestoreVideoTimelineInput,async input=>{
    if(!service.videoEditing)throw new JizuoError("runtime_unavailable","剪辑恢复尚未连接");
    return service.videoEditing.restoreTimeline(input);
  });

  register("jizuo_start_video_production",MEDIA_PROMPT_RULES["media-tool-26"],StartVideoProductionInput,async input=>{
    if(!service.videoProduction)throw new JizuoError("runtime_unavailable","自动制作尚未连接");
    return service.videoProduction.start(input);
  });
  register("jizuo_control_video_production",MEDIA_PROMPT_RULES["media-tool-27"],ControlVideoProductionInput,async input=>{
    if(!service.videoProduction)throw new JizuoError("runtime_unavailable","自动制作尚未连接");
    return service.videoProduction.control(input);
  });

}
