import { JizuoError, type VideoProject, type VideoDesign } from "@jizuo/contracts";

export { DESIGN_VIEW_PROMPTS as designViewPrompts } from "../../../contracts/src/media-prompt-rules.ts";
export function designFor(project:VideoProject,id:string|undefined,view?:string):VideoDesign|undefined {
 if(!id) {if(view&&view!=="detail"&&view!=="panorama")throw new JizuoError("validation_error","请先选择人物设定");return undefined;}
 const design=project.designs?.find(item=>item.id===id&&!item.deletedAt);
 if(!design)throw new JizuoError("validation_error","设定不属于当前作品");
 if(design.locked)throw new JizuoError("validation_error","设定已锁定，请先解锁后修改");
 if(view&&((view==="panorama"||view==="detail")?design.kind!=="scene":design.kind!=="character"))throw new JizuoError("validation_error","视图类型与人物/场景设定不符");
 return design;
}
export function imageDimensions(bytes:Uint8Array):{width:number;height:number}|undefined {
 const b=Buffer.from(bytes); if(b.length>=24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {width:b.readUInt32BE(16),height:b.readUInt32BE(20)};
 if(b.length>=30&&b.toString("ascii",0,4)==="RIFF"&&b.toString("ascii",8,12)==="WEBP") {
   const format=b.toString("ascii",12,16);
   if(format==="VP8X")return {width:b.readUIntLE(24,3)+1,height:b.readUIntLE(27,3)+1};
   if(format==="VP8 "&&b[23]===157&&b[24]===1&&b[25]===42)return {width:b.readUInt16LE(26)&16383,height:b.readUInt16LE(28)&16383};
   if(format==="VP8L"&&b[20]===47){const bits=b.readUInt32LE(21);return {width:(bits&16383)+1,height:((bits>>>14)&16383)+1};}
 }
 if(b.length>4&&b[0]===255&&b[1]===216){let at=2;while(at+4<=b.length){if(b[at]!==255)return;while(b[at]===255)at++;const marker=b[at++]!;if(marker===217||marker===218)return;if(marker===1||(marker>=208&&marker<=215))continue;if(at+2>b.length)return;const size=b.readUInt16BE(at);if(size<2||at+size>b.length)return;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&size>=7)return {width:b.readUInt16BE(at+5),height:b.readUInt16BE(at+3)};at+=size;}}
 return undefined;
}
export function requirePanorama(bytes:Uint8Array) {
 const size=imageDimensions(bytes);
 if(!size||size.width<512||size.width!==size.height*2||size.width>16384)throw new JizuoError("validation_error","360° 环景需要宽高比为 2:1 的有效图片（宽度 512～16384 像素）");
}
