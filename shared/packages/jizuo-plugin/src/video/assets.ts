import { assetFilenameBase } from "./asset-filenames.ts";
import { ensureVideoDirectory, visibleVideoPath, VideoRepository } from "@jizuo/work-domain";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { JizuoError, VideoAsset, VideoRelativePath } from "@jizuo/contracts";

const EXTENSIONS:Record<string,string> = { "image/png":"png", "image/jpeg":"jpg", "image/webp":"webp", "video/mp4":"mp4", "video/webm":"webm", "audio/mpeg":"mp3", "audio/wav":"wav", "audio/x-wav":"wav", "audio/mp4":"m4a", "audio/ogg":"ogg" };
const MAX_BYTES=256*1024*1024;
type AssetMetadata=Pick<VideoAsset,"kind"|"label"> & Partial<Pick<VideoAsset,"episodeId"|"shotId"|"durationSec"|"sourceJobId"|"sourceUrl"|"designId"|"view"|"panorama"|"panoramaSource">>;

/** Reject mislabeled HTML/JSON before persisting; codec/stream validation belongs to the renderer. */
function hasMediaSignature(bytes:Uint8Array,mimeType:string):boolean {
  const begins=(signature:number[])=>signature.every((value,index)=>bytes[index]===value);
  const ascii=(offset:number,length:number)=>Buffer.from(bytes.subarray(offset,offset+length)).toString("ascii");
  if(mimeType==="image/png")return begins([137,80,78,71,13,10,26,10]);
  if(mimeType==="image/jpeg")return begins([255,216,255]);
  if(mimeType==="image/webp")return ascii(0,4)==="RIFF"&&ascii(8,4)==="WEBP";
  if(mimeType==="video/mp4"||mimeType==="audio/mp4")return bytes.length>=12&&ascii(4,4)==="ftyp";
  if(mimeType==="video/webm")return begins([26,69,223,163]);
  if(mimeType==="audio/wav"||mimeType==="audio/x-wav")return ascii(0,4)==="RIFF"&&ascii(8,4)==="WAVE";
  if(mimeType==="audio/mpeg")return ascii(0,3)==="ID3"||(bytes[0]===255&&((bytes[1]??0)&224)===224);
  if(mimeType==="audio/ogg")return ascii(0,4)==="OggS";
  return false;
}

/** Only server-created, immutable work-relative assets are served. Token lives for this host process. */
export class LocalVideoAssets {
  private readonly token=randomBytes(32).toString("hex");
  private server:Server|undefined;
  private starting:Promise<number>|undefined;
  constructor(
    private readonly resolveWork:(workId:string)=>Promise<{path:string}>,
    private readonly findAsset:(workId:string,assetId:string)=>Promise<VideoAsset|undefined>,
  ) {}

  async safePath(workId:string, relativePath:string, createParents=false):Promise<string> {
    VideoRelativePath.parse(relativePath);
    relativePath=visibleVideoPath(relativePath);
    const root=resolve((await this.resolveWork(workId)).path);
    if((await lstat(root)).isSymbolicLink())throw new JizuoError("validation_error","作品目录不能为符号链接");
    const base=await realpath(root);
    await ensureVideoDirectory(base);
    const parts=relativePath.split("/");
    let current=base;
    for(let i=0;i<parts.length;i++) {
      current=join(current,parts[i]!);
      if (createParents && i<parts.length-1) await mkdir(current,{mode:0o700}).catch((error:NodeJS.ErrnoException)=>{if(error.code!=="EEXIST")throw error;});
      try { const info=await lstat(current); if(info.isSymbolicLink())throw new JizuoError("validation_error","素材路径包含符号链接"); }
      catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error; }
    }
    if(relative(base,current).startsWith(".."))throw new JizuoError("validation_error","素材路径超出作品目录");
    return current;
  }

  async write(workId:string,metadata:AssetMetadata,bytes:Uint8Array,mimeType:string):Promise<VideoAsset> {
    const extension=EXTENSIONS[mimeType];
    const family=metadata.kind==="export"?"video":metadata.kind;
    if(!extension || !mimeType.startsWith(`${family}/`))throw new JizuoError("validation_error","不支持的素材类型");
    if(bytes.length===0 || bytes.length>MAX_BYTES)throw new JizuoError("validation_error","素材为空或超过 256 MB 限制");
    if(!hasMediaSignature(bytes,mimeType))throw new JizuoError("validation_error","素材内容与声明的媒体格式不符");
    const id=randomUUID();
    const project=await new VideoRepository(this.resolveWork).read(workId);
    const base=assetFilenameBase(metadata,project);
    for(let sequence=1;sequence<=100000;sequence++) {
      const asset=VideoAsset.parse({...metadata,id,mimeType,path:`${base}-${String(sequence).padStart(3,"0")}.${extension}`});
      const destination=await this.safePath(workId,asset.path,true);
      // Exclusive creation reserves distinct names even for concurrent results.
      let handle;
      try {handle=await open(destination,"wx",0o600);}
      catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")continue;throw error;}
      try {await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
      return asset;
    }
    throw new JizuoError("validation_error","同名素材数量过多，请调整素材名称");
  }

  async pathFor(workId:string,assetId:string):Promise<{path:string;asset:VideoAsset}> {
    const asset=await this.findAsset(workId,assetId);
    if(!asset||asset.deletedAt)throw new JizuoError("validation_error","素材不存在");
    if(!visibleVideoPath(asset.path).startsWith("video/assets/"))throw new JizuoError("validation_error","素材不在视频资产目录");
    const path=await this.safePath(workId,asset.path);
    if(!(await stat(path)).isFile())throw new JizuoError("validation_error","素材不是普通文件");
    return {path,asset};
  }

  async urlFor(workId:string,assetId:string):Promise<string> {
    await this.pathFor(workId,assetId);
    const port=await this.start();
    return `http://127.0.0.1:${port}/asset/${encodeURIComponent(workId)}/${encodeURIComponent(assetId)}?token=${this.token}`;
  }

  private start():Promise<number> {
    if(this.starting)return this.starting;
    this.starting=new Promise((resolvePort,reject)=>{
      const server=createServer((request,response)=>{
        void (async()=>{
          const url=new URL(request.url??"/","http://127.0.0.1");
          const supplied=Buffer.from(url.searchParams.get("token")??"");
          const expected=Buffer.from(this.token);
          if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){response.writeHead(403).end();return;}
          if(request.method!=="GET"&&request.method!=="HEAD"){response.writeHead(405).end();return;}
          const match=/^\/asset\/([^/]+)\/([^/]+)$/.exec(url.pathname);
          if(!match){response.writeHead(404).end();return;}
          const {path,asset}=await this.pathFor(decodeURIComponent(match[1]!),decodeURIComponent(match[2]!));
          const info=await stat(path);if(!info.isFile())throw new Error("not file");
          let start=0,end=info.size-1;let partial=false;
          const range=request.headers.range;
          if(range){
            const parsed=/^bytes=(\d*)-(\d*)$/.exec(range);
            if(!parsed||(!parsed[1]&&!parsed[2])){response.writeHead(416,{"Content-Range":`bytes */${info.size}`}).end();return;}
            if(!parsed[1])start=Math.max(0,info.size-Number(parsed[2]));
            else{start=Number(parsed[1]);if(parsed[2])end=Math.min(end,Number(parsed[2]));}
            if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=info.size){response.writeHead(416,{"Content-Range":`bytes */${info.size}`}).end();return;}
            partial=true;
          }
          response.writeHead(partial?206:200,{
            "Content-Type":asset.mimeType,"Content-Length":end-start+1,"Accept-Ranges":"bytes",
            "Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Access-Control-Allow-Origin":"*",
            ...(partial?{"Content-Range":`bytes ${start}-${end}/${info.size}`}:{})
          });
          if(request.method==="HEAD"){response.end();return;}
          await pipeline(createReadStream(path,{start,end}),response);
        })().catch(()=>{if(!response.headersSent)response.writeHead(404);response.end();});
      });
      this.server=server;
      server.once("error",(error)=>{this.starting=undefined;reject(error);});
      server.listen(0,"127.0.0.1",()=>{const address=server.address();if(address&&typeof address!=="string"){server.unref();resolvePort(address.port);}else reject(new Error("视频预览服务无法启动"));});
    });
    return this.starting;
  }

  async close():Promise<void>{
    const server=this.server;this.server=undefined;this.starting=undefined;
    if(!server)return;
    server.closeAllConnections();await new Promise<void>((resolveClose)=>{server.close(()=>resolveClose());});
  }
}
