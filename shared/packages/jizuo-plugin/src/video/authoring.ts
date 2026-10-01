import { renderSkillPrompt } from "../../../contracts/src/skill-prompt.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ExtractVideoDesignsInput, VideoDesign, JizuoError, VideoShot, type VideoProject } from "@jizuo/contracts";
import { DiscussVideoPromptInput, AdaptVideoEpisodeInput } from "../../../contracts/src/video-authoring.ts";
import type { JizuoService } from "../service.ts";


export type VideoTextGenerator = (request: { system: string; prompt: string; signal?: AbortSignal }) => Promise<string>;

const designNameKey = (name: string) => name.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase("en-US");

const MAX_SOURCE_CHARACTERS = 100_000;
const MAX_PROMPT_CHARACTERS = 250_000;
const MAX_RESPONSE_CHARACTERS = 600_000;
const GeneratedShot = VideoShot.pick({ title: true, description: true, dialogue: true, prompt: true, durationSec: true }).extend({
  id: VideoShot.shape.id.optional(),
  videoPrompt: z.string().trim().min(1).max(32000),
  referenceAssetIds: VideoShot.shape.referenceAssetIds.max(100).optional(),
}).strict();
const Adaptation = z.object({ script: z.string().trim().max(500_000), shots: z.array(GeneratedShot).min(1).max(200) }).strict();
type GeneratedShot = z.infer<typeof GeneratedShot>;
function invalid(message: string): never { throw new JizuoError("validation_error", message); }
function repair(message: string): never { throw new JizuoError("model_repair", message); }
function conflict(message: string): never { throw new JizuoError("revision_conflict", message); }

function parseAdaptation(raw: string): z.infer<typeof Adaptation> {
  if (raw.length > MAX_RESPONSE_CHARACTERS) repair(`模型输出超过 ${MAX_RESPONSE_CHARACTERS} 字符，请缩小改编范围`);
  const trimmed = raw.trim();
  const text = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)?.[1] ?? trimmed;
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { repair("改编结果不是有效 JSON，请重试"); }
  const result = Adaptation.safeParse(value);
  if (!result.success) repair("改编结果不符合剧本与分镜格式，请重试");
  return result.data;
}

/** Generates only video authoring state. The novel is read-only throughout adaptation. */
export class VideoAuthoringService {
  constructor(private readonly domain: JizuoService, private readonly generateText: VideoTextGenerator) {}

  async discussPrompt(raw: DiscussVideoPromptInput, signal?: AbortSignal): Promise<VideoProject> {
    const input = DiscussVideoPromptInput.parse(raw);
    signal?.throwIfAborted();
    const project = await this.domain.video.read(input.workId);
    if (project.revision !== input.expectedRevision) conflict("制作稿已更新，请刷新后继续讨论");
    const episode = project.episodes.find(item => item.id === input.episodeId);
    const index = episode?.shots.findIndex(item => item.id === input.shotId) ?? -1;
    const shot = episode?.shots[index];
    if (!episode || !shot || shot.archived) invalid("讨论镜头不属于当前视频集");
    if ((shot.promptDiscussion?.length ?? 0) >= 100) invalid("该镜头讨论已达 100 轮，请使用已有建议编辑草稿");
    const referenceIds = input.referenceAssetIds ?? shot.referenceAssetIds;
    if (referenceIds.some(id => !project.assets.some(asset => asset.id === id && asset.kind === "image" && !asset.deletedAt && !asset.panorama))) invalid("参考图片已不可用，请重新选择");
    const schema = z.object({ reply: z.string().trim().min(1).max(10000), prompt: z.string().trim().min(1).max(32000) }).strict();
    const prompt = JSON.stringify({
      visualStyle: project.visualStyle,
      script: episode.script, shot: { ...shot, promptDiscussion: undefined },
      previousShot: episode.shots[index - 1] ? { title: episode.shots[index - 1]!.title, description: episode.shots[index - 1]!.description, videoPrompt: episode.shots[index - 1]!.videoPrompt } : null,
      nextShot: episode.shots[index + 1] ? { title: episode.shots[index + 1]!.title, description: episode.shots[index + 1]!.description } : null,
      designs: (project.designs ?? []).filter(design => !design.deletedAt),
      referenceAssets: project.assets.filter(asset => referenceIds.includes(asset.id)).map(({id,label,designId,view}) => ({id,label,designId,view})),
      history: shot.promptDiscussion ?? [], draftPrompt: input.draftPrompt ?? shot.videoPrompt ?? "",
      userMessage: input.message,
    });
    const system = renderSkillPrompt("shot-discussion-system", {schema:JSON.stringify(z.toJSONSchema(schema))});
    if (prompt.length + system.length > MAX_PROMPT_CHARACTERS) invalid("当前镜头讨论上下文过长，请精简剧本或设定后重试；历史未截断");
    const rawText = await this.generateText({system,prompt,...(signal ? {signal} : {})});
    if (rawText.length > MAX_RESPONSE_CHARACTERS) repair("提示词讨论输出过长");
    let parsed: unknown;
    try { parsed = JSON.parse(rawText.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,"$1")); }
    catch { repair("AI 讨论结果格式无效，原草稿未修改，请重试"); }
    const result = schema.safeParse(parsed);
    if (!result.success) repair("AI 讨论结果缺少回复或完整提示词，请重试");
    signal?.throwIfAborted();
    return this.domain.video.mutate(input.workId,input.expectedRevision,draft => {
      const current = draft.episodes.find(item=>item.id===input.episodeId)!.shots.find(item=>item.id===input.shotId)!;
      (current.promptDiscussion ??= []).push({id:randomUUID(),createdAt:new Date().toISOString(),shotRevision:shot.revision,
        referenceAssetIds:referenceIds,message:input.message,reply:result.data.reply,prompt:result.data.prompt,basePrompt:input.draftPrompt ?? shot.videoPrompt ?? ""});
    });
  }

  async extractDesigns(raw: ExtractVideoDesignsInput, signal?: AbortSignal): Promise<VideoProject> {
    const input=ExtractVideoDesignsInput.parse(raw);
    const project=await this.domain.video.read(input.workId);
    if(project.revision!==input.expectedRevision)conflict("制作稿已更新，请刷新后提取");
    const episode=project.episodes.find(item=>item.id===input.episodeId);
    if(!episode)invalid("视频集不属于当前作品");
    const sources: Array<{sourceWorkId?:string | undefined;volumeId:string;chapterId:string;content:string;revisionToken:string}>=[];
    let length=episode.script.length;
    if(length>MAX_SOURCE_CHARACTERS)invalid("原著与剧本超过提取范围，请减少视频集章节或剧本内容");
    for(const source of episode.sourceChapters){
      signal?.throwIfAborted();
      const chapter=await this.domain.readChapter({workId:source.sourceWorkId ?? input.workId,volumeId:source.volumeId,chapterId:source.chapterId});
      length+=chapter.content.length;
      if(length>MAX_SOURCE_CHARACTERS)invalid("原著与剧本超过提取范围，请减少视频集章节");
      sources.push({...source,content:chapter.content,revisionToken:chapter.revisionToken});
    }
    if(!episode.script.trim()&&!sources.length)invalid("请先选择原著章节或填写剧本");
    const schema=z.object({designs:z.array(VideoDesign.pick({kind:true,name:true,description:true}).extend({
      description:VideoDesign.shape.description.trim().min(1).describe("可直接生图的中文基础提示词：人物稳定外观或无人场景的空间与环境；仅保留有依据的视觉特征，不含剧情、固定视角或待确认说明"),
    })).max(100)}).strict();
    const prompt=JSON.stringify({visualStyle:project.visualStyle,script:episode.script,sources,existing:(project.designs??[]).filter(design=>!design.deletedAt).map(({kind,name,description,version,locked})=>({kind,name,description,version,locked}))});
    const system=renderSkillPrompt("design-authoring-system", {schema:JSON.stringify(z.toJSONSchema(schema))});
    if(prompt.length+system.length>MAX_PROMPT_CHARACTERS)invalid("提取上下文过长，请缩小视频集范围或精简已有设定；内容未截断");
    signal?.throwIfAborted();
    const rawText=await this.generateText({system,prompt,...(signal?{signal}:{})});
    if(rawText.length>MAX_RESPONSE_CHARACTERS)repair("设定提取输出过长");
    let parsed: unknown;
    try { parsed=JSON.parse(rawText.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,"$1")); }
    catch { repair("设定提取未返回有效 JSON，请重试"); }
    const result=schema.safeParse(parsed);
    if(!result.success)repair("设定提取格式无效，请重试");
    for(const source of sources){
      const latest=await this.domain.readChapter({workId:source.sourceWorkId ?? input.workId,volumeId:source.volumeId,chapterId:source.chapterId});
      if(latest.revisionToken!==source.revisionToken)conflict("原著在提取过程中已修改，请重新提取");
    }
    signal?.throwIfAborted();
    return this.domain.video.mutate(input.workId,input.expectedRevision,draft=>{
      const designs=draft.designs??=[];
      for(const item of result.data.designs){
        if(designs.some(old=>!old.deletedAt&&old.kind===item.kind&&designNameKey(old.name)===designNameKey(item.name)))continue;
        designs.push({...item,id:randomUUID(),version:"初版",locked:false,referenceAssetIds:[]});
      }
    });
  }

  async adapt(rawInput: AdaptVideoEpisodeInput, signal?: AbortSignal): Promise<VideoProject> {
    const input = AdaptVideoEpisodeInput.parse(rawInput);
    signal?.throwIfAborted();
    const project = await this.domain.video.read(input.workId);
    if (project.revision !== input.expectedRevision) conflict("视频项目已更新，请刷新后重新改编");
    const episode = project.episodes.find((item) => item.id === input.episodeId);
    if (!episode) invalid("视频集不属于当前作品");
    if (episode.sourceChapters.length === 0) invalid("请先为视频集选择原著章节");
    if (episode.sourceChapters.length > 100) invalid("一次改编最多选择 100 章，请缩小改编范围");
    const existing = new Map(episode.shots.map((shot) => [shot.id, shot]));
    const targets = input.shotIds === undefined ? undefined : new Set(input.shotIds);
    if (targets) for (const id of targets) {
      const shot = existing.get(id);
      if (!shot || shot.archived) invalid("返工镜头不属于当前视频集的有效镜头");
      if (shot.locked) invalid("返工镜头已锁定，请先解锁");
    }

    const sources: Array<{ sourceWorkId?: string; volumeId: string; chapterId: string; title: string; content: string; revisionToken: string }> = [];
    let sourceCharacters = 0;
    for (const source of episode.sourceChapters) {
      signal?.throwIfAborted();
      const chapter = await this.domain.readChapter({ workId: source.sourceWorkId ?? input.workId, volumeId: source.volumeId, chapterId: source.chapterId });
      sourceCharacters += chapter.content.length;
      if (sourceCharacters > MAX_SOURCE_CHARACTERS) invalid(`所选原著超过 ${MAX_SOURCE_CHARACTERS} 字符，请减少章节后重试；正文未截断`);
      // Copy primitive values so neither later reads nor model execution can change this snapshot.
      sources.push({ ...(source.sourceWorkId ? { sourceWorkId: source.sourceWorkId } : {}), volumeId: source.volumeId, chapterId: source.chapterId, title: chapter.title, content: chapter.content, revisionToken: chapter.revisionToken });
    }
    const prompt = JSON.stringify({
      visualStyle: project.visualStyle,
      task: targets ? "仅返工指定镜头，保留其他镜头和剧本" : "依据原著生成视频剧本和分镜，更新已有镜头时使用原 ID",
      instructions: input.instructions ?? "",
      sources,
      episode: { title: episode.title, script: episode.script, shots: episode.shots },
      targetShotIds: input.shotIds ?? null,
      designs: (project.designs ?? []).filter(design => !design.deletedAt),
      availableReferenceAssets: project.assets.filter((asset) => asset.kind === "image" && !asset.deletedAt && !asset.panorama).map((asset) => ({ id: asset.id, label: asset.label })),
    });
    const system = renderSkillPrompt("storyboard-system", {schema:JSON.stringify(z.toJSONSchema(Adaptation))});
    if (prompt.length + system.length > MAX_PROMPT_CHARACTERS) invalid(`改编上下文超过 ${MAX_PROMPT_CHARACTERS} 字符，请缩小视频集或原著范围；上下文未截断`);
    signal?.throwIfAborted();
    const generated = parseAdaptation(await this.generateText({ system, prompt, ...(signal ? { signal } : {}) }));
    if (!targets && generated.script.length === 0) repair("整集改编结果缺少剧本，请重试");
    signal?.throwIfAborted();
    const allowedAssets = new Set(project.assets.filter((asset) => asset.kind === "image" && !asset.deletedAt && !asset.panorama).map((asset) => asset.id));
    const updates = new Map<string, GeneratedShot>();
    for (const shot of generated.shots) {
      if (shot.referenceAssetIds?.some((id) => !allowedAssets.has(id))) repair("改编结果引用了当前作品之外或非图片的素材");
      if (existing.size > 0) {
        if (!shot.id || !existing.has(shot.id)) repair("重新改编必须使用当前视频集已有镜头 ID");
        if (targets && !targets.has(shot.id)) repair("局部返工结果包含未指定的镜头");
      } else if (shot.id) repair("初次改编的镜头 ID 由系统分配，请勿生成 ID");
      const id = shot.id ?? randomUUID();
      if (updates.has(id)) repair("改编结果包含重复镜头 ID");
      updates.set(id, shot);
    }
    if (targets && [...targets].some((id) => !updates.has(id))) repair("局部返工结果缺少指定镜头");
    const shots = existing.size > 0 ? episode.shots.map((old) => {
      const next = updates.get(old.id);
      if (!next || old.locked || old.archived) return old;
      return { ...old, ...next, id: old.id, referenceAssetIds: next.referenceAssetIds ?? old.referenceAssetIds, videoPrompt: old.promptLocked ? old.videoPrompt : next.videoPrompt ?? old.videoPrompt, prompt: old.promptLocked ? old.prompt : next.prompt };
    }) : [...updates].map(([id, shot]) => ({ ...shot, id, referenceAssetIds: shot.referenceAssetIds ?? [], locked: false, promptLocked: false, revision: 0 }));

    for (const source of sources) {
      const latest = await this.domain.readChapter({ workId: source.sourceWorkId ?? input.workId, volumeId: source.volumeId, chapterId: source.chapterId });
      if (latest.revisionToken !== source.revisionToken) conflict("原著章节在改编过程中已修改，请重新改编");
    }
    signal?.throwIfAborted();
    // updateEpisode checks the revision again while holding the repository write lock.
    return this.domain.video.updateEpisode({
      workId: input.workId, episodeId: input.episodeId, expectedRevision: input.expectedRevision,
      patch: {
        shots,
        script: targets ? episode.script : generated.script,
        ...(targets ? {} : { status: "storyboard" as const }),
        sourceChapters: sources.map(({ sourceWorkId, volumeId, chapterId, revisionToken }) => ({ ...(sourceWorkId ? {sourceWorkId} : {}), volumeId, chapterId, revisionToken })),
      },
    });
  }
}
