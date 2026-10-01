import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ReplaceDesignPromptInput, SaveVideoDesignInput, TagVideoAssetInput } from "../../../contracts/src/video-designs.ts";
import { designFor, requirePanorama } from "./designs.ts";
import { JizuoError, type VideoProject } from "@jizuo/contracts";
import type { VideoRepository } from "@jizuo/work-domain";
import { ImportVideoAssetInput } from "../../../contracts/src/media-operations.ts";
import { RenameVideoAssetInput, SelectVideoAssetInput } from "../../../contracts/src/asset-operations.ts";
import type { LocalVideoAssets } from "./assets.ts";

export class VideoMediaService {
  constructor(private readonly repository:VideoRepository,private readonly assets:LocalVideoAssets,
    private readonly probe?:(path:string)=>Promise<{durationSec:number;video:boolean;audio:boolean}>){}

  async saveDesign(raw:SaveVideoDesignInput):Promise<VideoProject>{
    const input=SaveVideoDesignInput.parse(raw);
    return this.repository.mutate(input.workId,input.expectedRevision,project=>{
      const designs=project.designs??=[];
      const old=input.design.id?designs.find(item=>item.id===input.design.id&&!item.deletedAt):undefined;
      if(input.design.id&&!old)throw new JizuoError("validation_error","设定不属于当前作品");
      if(old?.locked&&!isDeepStrictEqual({...old,locked:false},{...input.design,locked:false}))throw new JizuoError("validation_error","设定已锁定，请先解锁后修改");
      if(old&&old.kind!==input.design.kind)throw new JizuoError("validation_error","不能更改设定类型");
      const design={...input.design,id:old?.id??randomUUID()};
      if(old)designs[designs.indexOf(old)]=design;else designs.push(design);
    });
  }

  async replaceDesignPrompt(raw:ReplaceDesignPromptInput):Promise<VideoProject>{
    const input=ReplaceDesignPromptInput.parse(raw);
    return this.repository.mutate(input.workId,input.expectedRevision,project=>{
      const design=designFor(project,input.designId);
      design!.description=input.prompt;
    });
  }

  async tag(raw:TagVideoAssetInput):Promise<VideoProject>{
    const input=TagVideoAssetInput.parse(raw);
    return this.repository.mutate(input.workId,input.expectedRevision,project=>{
      const asset=project.assets.find(item=>item.id===input.assetId&&item.kind==="image");
      if(!asset)throw new JizuoError("validation_error","图片不属于当前作品");
      if(asset.designId&&project.designs?.some(item=>item.id===asset.designId&&!item.deletedAt))designFor(project,asset.designId);
      designFor(project,input.designId,input.view);
      if(input.view==="panorama"&&!asset.panorama)throw new JizuoError("validation_error","请通过环景导入入口验证图片后使用");
      asset.designId=input.designId;asset.view=input.view;
    });
  }

  async import(raw:ImportVideoAssetInput):Promise<VideoProject>{
    const input=ImportVideoAssetInput.parse(raw);
    const project=await this.repository.read(input.workId);
    if(project.revision!==input.expectedRevision)throw new JizuoError("revision_conflict","作品素材已变化，请刷新后导入");
    if(input.kind!=="image"&&!this.probe)throw new JizuoError("runtime_unavailable","音视频导入组件尚未连接");
    if(input.kind!=="image"&&(input.designId||input.view||input.panorama||input.panoramaSource))throw new JizuoError("validation_error","设定和环景信息只能用于图片");
    const source=input.panoramaSource?project.assets.find(asset=>asset.id===input.panoramaSource!.assetId):undefined;
    const reusesLockedScene=!!input.designId&&input.view==="detail"&&!input.panorama&&!!source?.panorama&&source.designId===input.designId;
    // Taking a new camera frame reuses the frozen scene without editing its design or base references.
    if(!reusesLockedScene)designFor(project,input.designId,input.panorama?"panorama":input.view);
    if(input.panorama&&input.view&&input.view!=="panorama")throw new JizuoError("validation_error","环景原图需要选择环景视图");
    const bytes=Buffer.from(input.base64,"base64");
    if(input.panorama||input.view==="panorama")requirePanorama(bytes);
    const asset=await this.assets.write(input.workId,{kind:input.kind,label:input.label,
      ...(input.designId?{designId:input.designId}:{}),...(input.panorama?{view:"panorama" as const}:input.view?{view:input.view}:{}),
      ...(input.panorama||input.view==="panorama"?{panorama:{projection:"equirectangular" as const}}:{}),...(input.panoramaSource?{panoramaSource:input.panoramaSource}:{})},bytes,input.mimeType);
    if(input.kind!=="image"){
      const metadata=await this.probe!(await this.assets.safePath(input.workId,asset.path));
      if(input.kind==="video"&&!metadata.video||input.kind==="audio"&&!metadata.audio)throw new JizuoError("validation_error","素材内容与所选类型不符");
      asset.durationSec=metadata.durationSec;
    }
    return this.repository.mutate(input.workId,input.expectedRevision,draft=>{draft.assets.push(asset);});
  }

  async rename(raw:RenameVideoAssetInput):Promise<VideoProject>{
    const input=RenameVideoAssetInput.parse(raw);
    return this.repository.mutate(input.workId,input.expectedRevision,project=>{
      const asset=project.assets.find(item=>item.id===input.assetId);
      if(!asset)throw new JizuoError("validation_error","素材不属于当前作品");
      asset.label=input.label;
    });
  }

  async select(raw:SelectVideoAssetInput):Promise<VideoProject>{
    const input=SelectVideoAssetInput.parse(raw);
    return this.repository.mutate(input.workId,input.expectedRevision,project=>{
      const asset=project.assets.find(item=>item.id===input.assetId&&item.kind===input.kind);
      const shot=project.episodes.find(item=>item.id===input.episodeId)?.shots.find(item=>item.id===input.shotId);
      if(asset?.panorama)throw new JizuoError("validation_error","请先打开环景取景，再选用取景图片");
      if(!asset||!shot||shot.archived)throw new JizuoError("validation_error","素材或镜头不属于当前作品");
      if(shot.locked)throw new JizuoError("validation_error","请先解锁镜头再替换素材");
      if(input.kind==="image"){shot.imageAssetId=asset.id;delete shot.videoAssetId;}
      else shot.videoAssetId=asset.id;
    });
  }
}
