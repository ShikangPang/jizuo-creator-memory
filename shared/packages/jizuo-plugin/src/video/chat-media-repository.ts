import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { JizuoError, StableId } from "@jizuo/contracts";

const SessionId = z.string().min(1).max(128);
const Manifest = z.object({ sessionId: SessionId, spaces: z.array(StableId) });
export const isChatMediaSpace = (id: string) => /^chat_[a-f0-9]{48}$/.test(id);
const spaceId = (sessionId: string) => `chat_${createHash("sha256").update(SessionId.parse(sessionId)).digest("hex").slice(0,48)}`;
export class ChatMediaRepository {
  private readonly root: string;
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(settingsRoot: string) { this.root = join(settingsRoot,"chat-media"); }
  private async directory(path: string, create = false) {
    if (create) await mkdir(path,{recursive:true,mode:0o700});
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new JizuoError("denied","会话素材目录无效");
  }
  private async read(id: string) {
    if (!isChatMediaSpace(id)) throw new JizuoError("denied","会话素材标识无效");
    await this.directory(this.root); const path = join(this.root,id); await this.directory(path);
    const file = join(path,"session.json");
    if ((await lstat(file)).isSymbolicLink()) throw new JizuoError("denied","会话素材索引无效");
    const manifest = Manifest.parse(JSON.parse(await readFile(file,"utf8")));
    if (spaceId(manifest.sessionId) !== id) throw new JizuoError("denied","会话素材归属不匹配");
    return manifest;
  }
  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const task = previous.catch(()=>undefined).then(operation);
    this.pending.set(id,task);
    void task.finally(()=>{if(this.pending.get(id)===task)this.pending.delete(id);}).catch(()=>undefined);
    return task;
  }
  async ensureSessionSpace(sessionId: string) {
    const id = spaceId(sessionId);
    await this.serialize(id,async()=>{
      await this.directory(this.root,true); await this.directory(join(this.root,id),true);
      try { await this.read(id); }
      catch(error) {
        if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
        await this.save(id,{sessionId,spaces:[id]});
      }
    });
    return {workId:id,path:join(this.root,id)};
  }
  private async save(id:string, manifest:z.infer<typeof Manifest>) {
    const path=join(this.root,id), temporary=join(path,`${randomUUID()}.tmp`);
    await writeFile(temporary,JSON.stringify(manifest),{mode:0o600,flag:"wx"});
    await rename(temporary,join(path,"session.json"));
  }
  async remember(sessionId:string, workId:string) {
    StableId.parse(workId);
    const own=await this.ensureSessionSpace(sessionId);
    if(isChatMediaSpace(workId)&&workId!==own.workId)throw new JizuoError("denied","不能引用其他会话素材空间");
    await this.serialize(own.workId,async()=>{
      const manifest=await this.read(own.workId);
      if(!manifest.spaces.includes(workId))await this.save(own.workId,{...manifest,spaces:[...manifest.spaces,workId]});
    });
  }
  async listSpaces(sessionId:string):Promise<string[]> {
    try{return (await this.read(spaceId(sessionId))).spaces;}
    catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw error;}
  }
  async resolveMediaPath(workId:string) { await this.read(workId); return {path:join(this.root,workId)}; }
  async listRecoverySpaces():Promise<string[]> {
    try { await this.directory(this.root); }
    catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw error;}
    const ids=(await readdir(this.root)).filter(isChatMediaSpace);
    const valid=await Promise.all(ids.map(async id=>{try {await this.read(id);return id;}catch{return undefined;}}));
    return valid.filter((id):id is string=>id!==undefined);
  }
}
