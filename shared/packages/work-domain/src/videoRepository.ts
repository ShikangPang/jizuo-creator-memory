import { ensureVideoDirectory, visibleVideoPath } from "./video-directory.ts";
import { saveStyledPrompts, undoStyledPrompts } from "./video-style-prompts.ts";
import { SaveWorkVisualStyleInput, SaveStyledPromptsInput, UndoStyledPromptsInput } from "../../contracts/src/visual-style.ts";
import { isDiscardedMediaJob } from "../../contracts/src/media-job-policy.ts";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { DeleteVideoItemInput, DeleteVideoEpisodeInput, CreateVideoEpisodeInput, JizuoError, ReplaceVideoPromptInput, StableId, UpdateVideoEpisodeInput, VideoProject, type VideoJob, type VideoShot, type VideoSourceChapter } from "@jizuo/contracts";
import { resolveWithin } from "./paths.ts";

const VIDEO_REVISION_LIMIT = 20;

function blocksEpisodeDeletion(job: VideoJob): boolean {
  if(isDiscardedMediaJob(job))return false;
  if (job.status === "queued" || job.status === "running") return true;
  if (job.status === "succeeded" || job.state?.remoteTerminal === true) return false;
  if (job.kind === "image" || job.kind === "video") {
    if (job.remoteId || job.state?.output) return true;
    if (job.state?.submission === "rejected" || job.state?.submission === "not-submitted") return false;
    return job.status === "uncertain" || (job.attempt ?? 0) > 0 || ["started", "unknown", "acknowledged"].includes(String(job.state?.submission));
  }
  return job.status === "uncertain" || job.kind === "audio" && Boolean(job.state?.submissionStarted || job.state?.output);
}

/** Frozen requests and durable reference metadata outlive selection changes in the UI. */
function deletedLibraryReference(job: VideoJob, deletedIds: Set<string>): string | undefined {
  if (deletedIds.size === 0) return undefined;
  const find = (value: unknown): string | undefined => {
    if (typeof value === "string") return deletedIds.has(value) ? value : undefined;
    if (!value || typeof value !== "object") return undefined;
    for (const entry of Object.values(value)) {
      const id = find(entry);
      if (id) return id;
    }
    return undefined;
  };
  let references: unknown = job.snapshot;
  if (job.kind === "export") {
    const frozen = VideoProject.safeParse(job.snapshot.project);
    const episode = frozen.success && frozen.data.episodes.length === 1 ? frozen.data.episodes[0] : undefined;
    if (episode && episode.id === job.episodeId) {
      // Older export snapshots contain the whole library, including deleted history.
      // Rendering reads only participating timeline assets, not shot references or designs.
      // Keep using the frozen timeline so later edits cannot unlock an in-flight input.
      references = episode.timeline.filter(clip => !clip.excluded).map(clip => clip.assetId);
    }
  }
  return find(references) ?? find([
    job.state?.designId, job.state?.referenceAssetIds, job.state?.referenceVideoAssetIds, job.resultAssetIds,
  ]);
}

const writers = new Map<string, Promise<void>>();
function invalid(message: string): never { throw new JizuoError("validation_error", message); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

/** All durable paths are derived from the host's work resolver, never a client path. */
export class VideoRepository {
  private readonly queryCache = new Map<string, {stamp:string; project:VideoProject}>();
  private readonly queryLoads = new Map<string, Promise<VideoProject>>();
  constructor(private readonly resolveWorkPath: (workId: string) => Promise<{ path: string }>) {}

  private async root(workId: string): Promise<string> {
    StableId.parse(workId);
    const work = await this.resolveWorkPath(workId);
    const path = resolve(work.path);
    if ((await lstat(path)).isSymbolicLink()) invalid("作品目录不能为符号链接");
    const root = await realpath(path);
    await ensureVideoDirectory(root);
    return root;
  }

  private async safePath(root: string, relativePath: string, checked?: Set<string>): Promise<string> {
    relativePath = visibleVideoPath(relativePath);
    const target = resolveWithin(root, relativePath);
    let current = root;
    for (const segment of relativePath.split("/")) {
      current = join(current, segment);
      if (checked?.has(current)) continue;
      try {
        if ((await lstat(current)).isSymbolicLink()) invalid("视频目录或素材不能通过符号链接访问");
        checked?.add(current);
      } catch (error) {
        if (missing(error)) break;
        throw error;
      }
    }
    return target;
  }

  private async load(root: string, workId: string): Promise<VideoProject> {
    const file = await this.safePath(root, "video/project.json");
    let raw: string;
    try { raw = await readFile(file, "utf8"); }
    catch (error) {
      if (missing(error)) return { schemaVersion: 1, workId, revision: 0, episodes: [], assets: [], jobs: [] };
      throw error;
    }
    const result = VideoProject.safeParse(JSON.parse(raw));
    if (!result.success) invalid("视频项目格式无效");
    if (result.data.workId !== workId) invalid("视频项目不属于当前作品");
    await this.validate(root, result.data);
    return result.data;
  }

  async read(workId: string): Promise<VideoProject> { return this.load(await this.root(workId), workId); }

  /** Read-only projections borrow the validated snapshot; callers receive a clone.
   * Writes and media-file access retain their uncached validation paths. */
  async query<T>(workId: string, project: (value: VideoProject) => T): Promise<T> {
    const root = await this.root(workId);
    const key = JSON.stringify([root,workId]);
    for (let attempt=0;attempt<3;attempt++) {
      const file = await this.safePath(root,"video/project.json");
      const stamp = async () => {
        try { const value=await lstat(file,{bigint:true}); return `${value.dev}/${value.ino}/${value.size}/${value.mtimeNs}/${value.ctimeNs}`; }
        catch(error){if(missing(error))return "missing";throw error;}
      };
      const identity=await stamp(), cached=this.queryCache.get(key);
      if(cached?.stamp===identity){
        this.queryCache.delete(key);this.queryCache.set(key,cached);
        return structuredClone(project(cached.project));
      }
      const loadKey=JSON.stringify([key,identity]);
      let pending=this.queryLoads.get(loadKey);
      if(!pending){pending=this.load(root,workId);this.queryLoads.set(loadKey,pending);}
      let value:VideoProject;
      try{value=await pending;}finally{if(this.queryLoads.get(loadKey)===pending)this.queryLoads.delete(loadKey);}
      // Reject a mixed read while another process atomically replaces the file.
      await this.safePath(root,"video/project.json");
      if(await stamp()!==identity)continue;
      this.queryCache.set(key,{stamp:identity,project:value});
      while(this.queryCache.size>4)this.queryCache.delete(this.queryCache.keys().next().value!);
      return structuredClone(project(value));
    }
    throw new JizuoError("revision_conflict","视频项目正在更新，请重试读取");
  }

  /** Revision names are generated numeric identifiers, never caller-controlled paths. */
  async listRevisionNumbers(workId: string): Promise<number[]> {
    const root = await this.root(workId);
    const directory = await this.safePath(root, "video/revisions");
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (missing(error)) return []; throw error; }
    return entries.filter((entry) => entry.isFile() && /^(0|[1-9]\d*)\.json$/.test(entry.name))
      .map((entry) => Number(entry.name.slice(0, -5)))
      .filter((revision) => Number.isSafeInteger(revision) && revision >= 0)
      .sort((a, b) => b - a).slice(0, VIDEO_REVISION_LIMIT);
  }

  private async pruneRevisions(root: string): Promise<void> {
    const directory = await this.safePath(root, "video/revisions");
    const entries = await readdir(directory, { withFileTypes: true });
    const revisions = entries.filter(entry => entry.isFile() && /^(0|[1-9]\d*)\.json$/.test(entry.name))
      .map(entry => ({ name: entry.name, revision: Number(entry.name.slice(0, -5)) }))
      .filter(entry => Number.isSafeInteger(entry.revision))
      .sort((a, b) => b.revision - a.revision);
    for (const entry of revisions.slice(VIDEO_REVISION_LIMIT)) {
      const path = await this.safePath(root, `video/revisions/${entry.name}`);
      await rm(path, { force: true });
    }
  }

  async readRevision(workId: string, revision: number): Promise<VideoProject> {
    if (!Number.isSafeInteger(revision) || revision < 0) invalid("历史版本号必须为非负安全整数");
    const root = await this.root(workId);
    const file = await this.safePath(root, `video/revisions/${revision}.json`);
    let raw: unknown;
    try { raw = JSON.parse(await readFile(file, "utf8")); }
    catch (error) {
      if (missing(error)) invalid("历史版本不存在于当前作品");
      if (error instanceof SyntaxError) invalid("历史版本 JSON 格式无效");
      throw error;
    }
    const parsed = VideoProject.safeParse(raw);
    if (!parsed.success) invalid("历史版本格式无效");
    if (parsed.data.workId !== workId || parsed.data.revision !== revision) invalid("历史版本归属或版本号不匹配");
    await this.validate(root, parsed.data);
    return parsed.data;
  }

  private async validate(root: string, project: VideoProject): Promise<void> {
    const ids = new Set<string>();
    for (const item of [...(project.designs??[]), ...project.episodes, ...project.assets, ...project.jobs, ...project.episodes.flatMap((episode) => [...episode.shots, ...episode.timeline])]) {
      if (ids.has(item.id)) invalid("视频项目存在重复 ID");
      ids.add(item.id);
    }
    const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
    const episodes = new Map(project.episodes.map((episode) => [episode.id, episode]));
    const jobs = new Set(project.jobs.map((job) => job.id));
    const shots = new Map(project.episodes.flatMap((episode) => episode.shots.map((shot) => [shot.id, episode.id] as const)));
    const checkAsset = (id: string | undefined, kind?: string, field = "assetId") => {
      if (id === undefined) return;
      const asset = assets.get(id);
      if (!asset || (kind !== undefined && asset.kind !== kind)) {
        const isDesign = (project.designs ?? []).some(design => design.id === id);
        const reason = isDesign ? "这是人物或场景设定 ID，不是素材 ID；提取设定不会生成图片或视频" : asset ? `素材类型不符，实际为 ${asset.kind}` : "素材不存在于当前作品";
        throw new JizuoError("validation_error", `${field}：${JSON.stringify(id)} ${reason}。期望当前作品 assets 中${kind ? ` kind=${kind} 的` : "的"}真实素材 ID；没有素材时 referenceAssetIds 留空，imageAssetId/videoAssetId 省略，不能填写设定 ID、名称或占位符。`, {field,assetId:id,expectedKind:kind??"any",actualKind:asset?.kind??null,isDesignId:isDesign});
      }
    };
    const checkAvailable = (id: string | undefined, owner: string) => {
      if (id && assets.get(id)?.deletedAt) invalid(`素材仍被${owner}引用，请先解除引用`);
    };
    for (const id of project.visualStyle?.referenceAssetIds ?? []) {
      checkAsset(id, "image"); checkAvailable(id, "作品画风");
      if (assets.get(id)?.panorama) invalid("画风参考图请使用普通图片或环景取景图");
    }
    for (const design of project.designs ?? []) if (!design.deletedAt) {
      for (const id of design.referenceAssetIds) checkAvailable(id, `设定「${design.name}」`);
    }
    for (const episode of project.episodes) if (!episode.deletedAt) {
      for (const shot of episode.shots) if (!shot.archived) {
        for (const id of [...shot.referenceAssetIds, shot.imageAssetId, shot.videoAssetId]) checkAvailable(id, `镜头「${shot.title}」`);
      }
      for (const clip of episode.timeline) checkAvailable(clip.assetId, `「${episode.title}」的剪辑`);
    }
    for (const asset of project.assets) if (!asset.deletedAt) checkAvailable(asset.panoramaSource?.assetId, `取景素材「${asset.label}」`);
    const designs=new Map((project.designs??[]).map(item=>[item.id,item]));
    for(const design of designs.values())for(const id of design.referenceAssetIds)checkAsset(id,"image");
    for (const episode of project.episodes) {
      const localShots = new Set(episode.shots.map((shot) => shot.id));
      for (const shot of episode.shots) {
        const field = `episodes[${episode.id}].shots[${shot.id}]`;
        for (const [index, id] of shot.referenceAssetIds.entries()) checkAsset(id, "image", `${field}.referenceAssetIds[${index}]`);
        checkAsset(shot.imageAssetId, "image", `${field}.imageAssetId`);
        checkAsset(shot.videoAssetId, "video", `${field}.videoAssetId`);
      }
      for (const clip of episode.timeline) {
        checkAsset(clip.assetId);
        if (clip.shotId && !localShots.has(clip.shotId)) invalid("时间线镜头不属于当前视频集");
        const duration = assets.get(clip.assetId)?.durationSec;
        if (duration !== undefined && clip.outSec > duration + 0.001) invalid("片段超出素材时长");
      }
    }
    // Share ancestor checks only within this validation; later reads recheck the filesystem.
    const checkedPaths = new Set<string>();
    for (const asset of project.assets) {
      if(asset.designId&&!designs.has(asset.designId))invalid("素材设定不属于当前作品");
      if((asset.designId||asset.view||asset.panorama||asset.panoramaSource)&&asset.kind!=="image")invalid("设定与环景信息仅限图片素材");
      if(asset.view&&asset.designId){const kind=designs.get(asset.designId)!.kind;if((asset.view==="panorama"||asset.view==="detail")?kind!=="scene":kind!=="character")invalid("素材视图与设定类型不符");}
      if(asset.panorama&&asset.view!=="panorama")invalid("环景原图必须标记为环景视图");
      if(asset.view==="panorama"&&!asset.panorama)invalid("环景视图必须通过图片尺寸校验");
      if(asset.panorama&&asset.panoramaSource)invalid("取景画面不能同时作为环景原图");
      if(asset.panoramaSource){checkAsset(asset.panoramaSource.assetId,"image");if(asset.panoramaSource.assetId===asset.id||!assets.get(asset.panoramaSource.assetId)?.panorama)invalid("取景来源必须是当前作品的环景原图");}
      await this.safePath(root, asset.path, checkedPaths);
      if (asset.episodeId && !episodes.has(asset.episodeId)) invalid("素材视频集不属于当前作品");
      if (asset.shotId && (!shots.has(asset.shotId) || (asset.episodeId && shots.get(asset.shotId) !== asset.episodeId))) invalid("素材镜头不属于当前视频集");
      if (asset.sourceJobId && !jobs.has(asset.sourceJobId)) invalid("素材任务不属于当前作品");
    }
    for (const job of project.jobs) {
      if (job.episodeId && !episodes.has(job.episodeId)) invalid("任务视频集不属于当前作品");
      if (job.shotId && (!shots.has(job.shotId) || (job.episodeId && shots.get(job.shotId) !== job.episodeId))) invalid("任务镜头不属于当前视频集");
      for (const id of job.resultAssetIds ?? []) checkAsset(id);
    }
  }

  private preserveJobSnapshots(before: VideoProject, after: VideoProject): void {
    for (const old of before.jobs) {
      const next = after.jobs.find((job) => job.id === old.id);
      if (!next) invalid("任务记录必须保留以支持恢复");
      const frozen = (job: typeof old) => [job.kind, job.episodeId, job.shotId, job.shotRevision, job.snapshot];
      if (!isDeepStrictEqual(frozen(old), frozen(next))) invalid("任务输入快照不可修改，请创建新任务");
    }
  }

  private preserveShotEdits(before: VideoProject, after: VideoProject, preservePromptSelections = false, detachedAssetId?: string): void {
    for (const episode of before.episodes) {
      const nextEpisode = after.episodes.find((item) => item.id === episode.id);
      for (const old of episode.shots) {
        const next = nextEpisode?.shots.find((item) => item.id === old.id);
        if (!next) {
          if (old.locked || old.promptLocked) invalid("请先解锁镜头再删除");
          continue;
        }
        const content = (shot: VideoShot) => JSON.stringify([shot.title, shot.description, shot.dialogue, shot.durationSec, shot.referenceAssetIds, shot.archived]);
        const changedContent = content(old) !== content(next);
        const changedVideoPrompt = old.videoPrompt !== next.videoPrompt;
        const changedPrompt = old.prompt !== next.prompt;
        const changedImage = old.imageAssetId !== next.imageAssetId;
        const changedVideo = old.videoAssetId !== next.videoAssetId;
        if (old.locked && (changedContent || changedPrompt || changedVideoPrompt || changedImage || changedVideo)) invalid("请先解锁镜头再修改");
        if (old.promptLocked && (changedPrompt || changedVideoPrompt)) invalid("请先解锁提示词再修改");
        next.revision = old.revision;
        if (detachedAssetId) {
          const detached = { ...old, referenceAssetIds: old.referenceAssetIds.filter(id => id !== detachedAssetId) };
          if (detached.imageAssetId === detachedAssetId) delete detached.imageAssetId;
          if (detached.videoAssetId === detachedAssetId) delete detached.videoAssetId;
          // Removing one asset must not clear other selected images or videos.
          if (isDeepStrictEqual(detached, next)) {
            if (changedContent || changedImage || changedVideo) next.revision += 1;
            continue;
          }
        }
        if (changedContent || changedPrompt) {
          next.revision += 1;
          if (!preservePromptSelections || changedContent) {
            delete next.imageAssetId;
            delete next.videoAssetId;
          }
        } else if (changedVideoPrompt) {
          next.revision += 1;
          // Keep the selected result visible; new generations retain their own frozen inputs.
        } else if (changedImage || changedVideo) {
          // A human choosing a new reference invalidates in-flight results built from an older selection.
          next.revision += 1;
          if (changedImage) delete next.videoAssetId;
        }
      }
    }
  }

  private async verifySources(root: string, workId: string, sources: VideoSourceChapter[]): Promise<void> {
    if (sources.length === 0) return;
    const foreign = new Map<string, VideoSourceChapter[]>();
    for (const source of sources) {
      if (source.sourceWorkId && source.sourceWorkId !== workId) {
        const group = foreign.get(source.sourceWorkId) ?? [];
        group.push(source);
        foreign.set(source.sourceWorkId, group);
      }
    }
    for (const [sourceWorkId, chapters] of foreign) {
      const location = await this.resolveWorkPath(StableId.parse(sourceWorkId));
      if ((await lstat(location.path)).isSymbolicLink()) invalid("原著目录不能为符号链接");
      const sourceRoot = await realpath(location.path);
      const metadata = parseYaml(await readFile(await this.safePath(sourceRoot, "work.yaml"), "utf8")) as {id?: string; project_kind?: string};
      if (metadata.id !== sourceWorkId || metadata.project_kind === "video") invalid("请选择小说项目作为原著来源");
      await this.verifySources(sourceRoot, sourceWorkId, chapters);
    }
    sources = sources.filter(source => !source.sourceWorkId || source.sourceWorkId === workId);
    if (sources.length === 0) return;
    const volumesRoot = await this.safePath(root, "content/volumes");
    let volumes;
    try { volumes = await readdir(volumesRoot, { withFileTypes: true }); }
    catch (error) { if (missing(error)) invalid("所选原著章节不属于当前作品"); throw error; }
    const found = new Set<string>();
    for (const volume of volumes) {
      if (!volume.isDirectory()) continue;
      const metadataPath = await this.safePath(root, `content/volumes/${volume.name}/volume.yaml`);
      const metadata = parseYaml(await readFile(metadataPath, "utf8")) as { id?: string; work_id?: string };
      if (metadata.work_id !== workId || !sources.some((source) => source.volumeId === metadata.id)) continue;
      const chaptersPath = await this.safePath(root, `content/volumes/${volume.name}/chapters`);
      for (const chapter of await readdir(chaptersPath, { withFileTypes: true })) {
        if (!chapter.isDirectory()) continue;
        const chapterPath = await this.safePath(root, `content/volumes/${volume.name}/chapters/${chapter.name}/chapter.yaml`);
        const data = parseYaml(await readFile(chapterPath, "utf8")) as { id?: string; work_id?: string; volume_id?: string };
        if (data.work_id === workId && data.volume_id === metadata.id) found.add(`${metadata.id}/${data.id}`);
      }
    }
    if (sources.some((source) => !found.has(`${source.volumeId}/${source.chapterId}`))) invalid("所选原著章节不属于当前作品");
  }

  private async atomicWrite(root: string, relativePath: string, value: VideoProject): Promise<void> {
    const target = await this.safePath(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await this.safePath(root, relativePath);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await file.sync(); }
      finally { await file.close(); }
      await this.safePath(root, relativePath);
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }

  private async acquireLock(root: string): Promise<string> {
    const relativeLock = "video/write.lock";
    const lock = await this.safePath(root, relativeLock);
    await mkdir(dirname(lock), { recursive: true });
    const conflict = () => new JizuoError("revision_conflict", "视频项目正在写入，或写入锁归属不明；请重试");
    const ownerIsDead = async (): Promise<boolean> => {
      try {
        const file = await this.safePath(root, `${relativeLock}/owner.json`);
        const owner: unknown = JSON.parse(await readFile(file, "utf8"));
        if (!owner || typeof owner !== "object" || !("pid" in owner) || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) return false;
        try { process.kill(Number(owner.pid), 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
      } catch { return false; }
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.safePath(root, relativeLock);
      try { await mkdir(lock); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (attempt !== 0 || !await ownerIsDead()) throw conflict();
        // One recovery worker owns this marker. Recheck ownership after acquiring it;
        // a competing process may already have replaced the dead process's lock.
        const recovery = await this.safePath(root, `${relativeLock}/recovering`);
        try { await mkdir(recovery); } catch { throw conflict(); }
        if (!await ownerIsDead()) { await rm(recovery, { recursive: true, force: true }); throw conflict(); }
        await rm(lock, { recursive: true });
        continue;
      }
      try { await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 }); }
      catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
      return lock;
    }
    throw conflict();
  }

  async mutate(workId: string, expectedRevision: number | undefined, mutation: (project: VideoProject) => void, options: { preservePromptSelections?: boolean; detachedAssetId?: string | undefined } = {}): Promise<VideoProject> {
    const root = await this.root(workId);
    const previous = writers.get(root) ?? Promise.resolve();
    let release!: () => void;
    const fence = new Promise<void>((done) => { release = done; });
    writers.set(root, fence);
    await previous;
    let diskLock: string | undefined;
    try {
      diskLock = await this.acquireLock(root);
      const current = await this.load(root, workId);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new JizuoError("revision_conflict", "视频项目已更新，请刷新后重试", { expectedRevision, actualRevision: current.revision });
      const draft = structuredClone(current);
      mutation(draft);
      if (draft.workId !== workId || draft.revision !== current.revision) invalid("不可更改作品归属或项目版本");
      for (const old of current.episodes.filter(item => item.deletedAt)) {
        if (!isDeepStrictEqual(old, draft.episodes.find(item => item.id === old.id))) invalid("视频集已删除，不可继续修改");
      }
      for (const [oldItems, nextItems] of [[current.assets, draft.assets], [current.designs ?? [], draft.designs ?? []]] as const) {
        for (const old of oldItems.filter(item => item.deletedAt)) {
          if (!isDeepStrictEqual(old, nextItems.find(item => item.id === old.id))) invalid("已删除的素材或设定不可继续修改");
        }
      }
      const unavailable = new Set([...draft.assets, ...(draft.designs ?? [])].filter(item => item.deletedAt).map(item => item.id));
      for (const job of draft.jobs) {
        if (current.jobs.some(item => item.id === job.id) && !blocksEpisodeDeletion(job)) continue;
        const id = deletedLibraryReference(job, unavailable);
        if (!id) continue;
        const asset = current.assets.find(item => item.id === id);
        const design = current.designs?.find(item => item.id === id);
        if ((asset || design) && !(asset ?? design)!.deletedAt) {
          const shot = current.episodes.flatMap(item => item.shots).find(item => item.id === job.shotId);
          const label = typeof job.state?.label === "string" && job.state.label.trim() ? job.state.label : shot?.title ?? "媒体制作";
          const status = job.status === "queued" ? "排队中" : job.status === "running" ? "进行中" : "待核对";
          invalid(`${asset ? "素材" : "设定"}「${asset?.label ?? design!.name}」正被任务「${label}」（${status}）使用，请在视频工作区的「任务记录」中处理该任务后再删除`);
        }
        invalid("任务引用的素材或设定已删除");
      }
      const deleted = new Set(draft.episodes.filter(item => item.deletedAt).map(item => item.id));
      const deletedShots = new Set(draft.episodes.filter(item => item.deletedAt).flatMap(item => item.shots.map(shot => shot.id)));
      for (const job of draft.jobs) if (deleted.has(job.episodeId ?? "") || deletedShots.has(job.shotId ?? "")) {
        if (!current.jobs.some(item => item.id === job.id) || blocksEpisodeDeletion(job)) invalid("视频集有进行中或待核对的任务，请先处理任务再删除");
      }
      this.preserveShotEdits(current, draft, options.preservePromptSelections, options.detachedAssetId);
      this.preserveJobSnapshots(current, draft);
      draft.revision += 1;
      const parsed = VideoProject.safeParse(draft);
      if (!parsed.success) invalid("视频项目修改格式无效");
      for (const episode of parsed.data.episodes) {
        const old = current.episodes.find((item) => item.id === episode.id);
        if (JSON.stringify(old?.sourceChapters) !== JSON.stringify(episode.sourceChapters)) await this.verifySources(root, workId, episode.sourceChapters);
      }
      await this.validate(root, parsed.data);
      await this.atomicWrite(root, `video/revisions/${current.revision}.json`, current);
      await this.atomicWrite(root, "video/project.json", parsed.data);
      // The project is already committed. A cleanup failure must not report a failed
      // edit and invite duplicate retries; the next successful save retries pruning.
      try { await this.pruneRevisions(root); }
      catch (error) { console.warn("视频历史快照清理失败，将在下次保存时重试", error); }
      return parsed.data;
    } finally {
      try { if (diskLock) await rm(diskLock, { recursive: true, force: true }); }
      finally { release(); if (writers.get(root) === fence) writers.delete(root); }
    }
  }

  async createEpisode(rawInput: CreateVideoEpisodeInput): Promise<VideoProject> {
    const input = CreateVideoEpisodeInput.parse(rawInput);
    return this.mutate(input.workId, input.expectedRevision, (project) => {
      project.episodes.push({ id: randomUUID(), title: input.title, sourceChapters: input.sourceChapters, shots: [], timeline: [], status: "draft", script: "" });
    });
  }

  async saveStyledPrompts(raw: SaveStyledPromptsInput): Promise<VideoProject> {
    const input=SaveStyledPromptsInput.parse(raw);
    return this.mutate(input.workId,input.expectedRevision,project=>saveStyledPrompts(project,input),{preservePromptSelections:true});
  }
  async undoStyledPrompts(raw: UndoStyledPromptsInput): Promise<VideoProject> {
    const input=UndoStyledPromptsInput.parse(raw);
    return this.mutate(input.workId,input.expectedRevision,project=>undoStyledPrompts(project,input.historyId),{preservePromptSelections:true});
  }
  async saveVisualStyle(raw: SaveWorkVisualStyleInput): Promise<VideoProject> {
    const input = SaveWorkVisualStyleInput.parse(raw);
    return this.mutate(input.workId, input.expectedRevision, project => {
      if (input.style === null) delete project.visualStyle;
      else project.visualStyle = { ...input.style, revision: project.revision + 1 };
    });
  }

  async deleteItem(rawInput: DeleteVideoItemInput): Promise<VideoProject> {
    const input = DeleteVideoItemInput.parse(rawInput);
    return this.mutate(input.workId, input.expectedRevision, project => {
      if (input.kind === "shot") {
        const episode = project.episodes.find(item => !item.deletedAt && item.shots.some(shot => shot.id === input.id && !shot.archived));
        const shot = episode?.shots.find(item => item.id === input.id);
        if (!shot || !episode) invalid("镜头不存在或已删除");
        if (shot.locked || shot.promptLocked) invalid("请先解锁镜头和提示词再删除");
        if (episode.timeline.some(clip => clip.shotId === shot.id)) invalid("镜头仍在剪辑中，请先移除对应片段");
        if (project.jobs.some(job => blocksEpisodeDeletion(job) && (job.shotId === shot.id || job.episodeId === episode.id && job.kind === "pipeline"))) invalid("镜头有进行中或待核对的任务，请先处理任务");
        shot.archived = true;
        return;
      }
      // mutate validates only tasks referencing this item, plus live shot/design/timeline uses.
      if (input.kind === "design") {
        const design = project.designs?.find(item => item.id === input.id && !item.deletedAt);
        if (!design) invalid("设定不存在或已删除");
        if (design.locked) invalid("请先解锁设定再删除");
        design.deletedAt = new Date().toISOString();
      } else {
        const asset = project.assets.find(item => item.id === input.id && !item.deletedAt);
        if (!asset) invalid("素材不存在或已删除");
        if (input.detachReferences) {
          for (const design of project.designs ?? []) if (!design.deletedAt && design.referenceAssetIds.includes(asset.id)) {
            if (design.locked) invalid(`设定「${design.name}」已锁定，请先解锁后取消引用`);
            design.referenceAssetIds = design.referenceAssetIds.filter(id => id !== asset.id);
          }
          for (const episode of project.episodes) if (!episode.deletedAt) {
            for (const shot of episode.shots) if (!shot.archived) {
              shot.referenceAssetIds = shot.referenceAssetIds.filter(id => id !== asset.id);
              if (shot.imageAssetId === asset.id) delete shot.imageAssetId;
              if (shot.videoAssetId === asset.id) delete shot.videoAssetId;
            }
            episode.timeline = episode.timeline.filter(clip => clip.assetId !== asset.id);
          }
          for (const derived of project.assets) if (!derived.deletedAt && derived.panoramaSource?.assetId === asset.id) delete derived.panoramaSource;
        }
        asset.deletedAt = new Date().toISOString();
        if (project.visualStyle?.referenceAssetIds.includes(asset.id)) {
          project.visualStyle.referenceAssetIds = project.visualStyle.referenceAssetIds.filter(id => id !== asset.id);
          project.visualStyle.revision = project.revision + 1;
        }
      }
    }, { detachedAssetId: input.detachReferences ? input.id : undefined });
  }

  async deleteEpisode(rawInput: DeleteVideoEpisodeInput): Promise<VideoProject> {
    const input = DeleteVideoEpisodeInput.parse(rawInput);
    return this.mutate(input.workId, input.expectedRevision, project => {
      const episode = project.episodes.find(item => item.id === input.episodeId && !item.deletedAt);
      if (!episode) invalid("视频集不存在或已删除");
      episode.deletedAt = new Date().toISOString();
    });
  }

  async updateEpisode(rawInput: UpdateVideoEpisodeInput): Promise<VideoProject> {
    const input = UpdateVideoEpisodeInput.parse(rawInput);
    return this.mutate(input.workId, input.expectedRevision, (project) => {
      const episode = project.episodes.find((item) => item.id === input.episodeId);
      if (!episode || episode.deletedAt) invalid("视频集不属于当前作品或已删除");
      Object.assign(episode, input.patch);
    });
  }

  async replaceShotPrompt(rawInput: ReplaceVideoPromptInput): Promise<VideoProject> {
    const input = ReplaceVideoPromptInput.parse(rawInput);
    return this.mutate(input.workId, input.expectedRevision, project => {
      const episode = project.episodes.find(item => item.id === input.episodeId);
      if (!episode || episode.deletedAt) invalid("视频集不属于当前作品或已删除");
      const shot = episode.shots.find(item => item.id === input.shotId);
      if (!shot || shot.archived) invalid("镜头已移出或不属于当前视频集");
      if (shot.locked || shot.promptLocked) invalid("镜头或提示词已锁定，请先在制作稿中解锁");
      if (input.kind === "image") shot.prompt = input.prompt;
      else shot.videoPrompt = input.prompt;
    });
  }
}
