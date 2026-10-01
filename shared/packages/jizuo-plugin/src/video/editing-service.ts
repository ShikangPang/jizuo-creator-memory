import { GetVideoClipFramesInput, shotVideoCandidates, type VideoClipFrames } from "@jizuo/contracts";
import { extractClipFrames } from "./clip-frames.ts";
import { visibleVideoPath } from "@jizuo/work-domain";
import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { JizuoError, VideoProject, type VideoEpisode, type VideoJob, type VideoJsonValue } from "@jizuo/contracts";
import type { VideoRepository } from "@jizuo/work-domain";
import { legacySubtitleTexts, EditVideoTimelineInput, ExportVideoInput, RoughCutVideoInput, VideoOutputSettings, videoOutputDimensions, VideoTimelineHistoryInput, RestoreVideoTimelineInput, type VideoTimelineHistory } from "../../../contracts/src/video-editing.ts";
import { ControlVideoJobInput } from "../../../contracts/src/media-operations.ts";
import { LocalVideoAssets } from "./assets.ts";
import { discoverMediaExecutable, probeMedia, throwIfAborted } from "./ffmpeg.ts";
import { renderVideo } from "./renderer.ts";
import { applyTextEdit, applyTimelineEdit, buildRoughCut, timelineLayout, validateTimeline } from "./timeline.ts";

const active = (job: VideoJob) => job.status === "queued" || job.status === "running";
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
const json = (value: unknown): Record<string, VideoJsonValue> => JSON.parse(JSON.stringify(value)) as Record<string, VideoJsonValue>;
const content = (episode: VideoEpisode) => { const { status: _status, ...rest } = episode; return rest; };

/** Probe locally imported audio/video instead of trusting an extension or supplied duration. */
export async function loadVideoMediaMetadata(path: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const metadata = await probeMedia(await discoverMediaExecutable("ffprobe"), resolve(path), signal);
  if ((!metadata.audio && !metadata.video) || !Number.isFinite(metadata.durationSec) || metadata.durationSec <= 0) {
    throw new JizuoError("validation_error", "素材没有可播放的音视频流或有效时长");
  }
  return metadata;
}

/** Local exports are safely restartable: every render uses the immutable job snapshot. */
export class VideoEditingService {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly renderer: typeof renderVideo;
  private closed = false;

  constructor(private readonly repository: VideoRepository, private readonly assets: LocalVideoAssets, options: { renderer?: typeof renderVideo } = {}) {
    this.renderer = options.renderer ?? renderVideo;
  }

  private requireOpen(): void {
    if (this.closed) throw new JizuoError("runtime_unavailable", "视频剪辑服务已关闭");
  }

  async roughCut(raw: RoughCutVideoInput): Promise<VideoProject> {
    this.requireOpen();
    const input = RoughCutVideoInput.parse(raw);
    return this.repository.mutate(input.workId, input.expectedRevision, (project) => {
      const episode = project.episodes.find((item) => item.id === input.episodeId && !item.deletedAt);
      if (!episode) throw new JizuoError("validation_error", "视频集不存在");
      const selected = new Set<string>();
      for (const selection of input.selections ?? []) {
        const shot = episode.shots.find(shot => shot.id === selection.shotId && !shot.archived);
        if (!shot || selected.has(shot.id)) throw new JizuoError("validation_error", "组装选择中的镜头不存在或重复");
        selected.add(shot.id);
        if (shot.locked && shot.videoAssetId !== selection.assetId) throw new JizuoError("validation_error", `镜头「${shot.title}」已锁定，请先解锁再选用视频`);
        if (!shotVideoCandidates(project, episode.id, shot).some(asset => asset.id === selection.assetId)) throw new JizuoError("validation_error", `镜头「${shot.title}」的视频版本已不可用，请重新选择`);
        shot.videoAssetId = selection.assetId;
      }
      const timeline = buildRoughCut(project, input.episodeId);
      if (!timeline.length) {
        const shots = episode.shots.filter(shot => !shot.archived);
        const pending = shots.filter(shot => shotVideoCandidates(project, episode.id, shot).length);
        if (pending.length) throw new JizuoError("validation_error", `${pending.length} 个镜头已有生成视频，尚未选用。请在剪辑页选择视频版本后组装，无需重新生成。`);
        if (!shots.length) throw new JizuoError("validation_error", "当前集还没有镜头。可先创建镜头，或从已有素材直接加入时间线。");
        throw new JizuoError("validation_error", "当前镜头还没有可用的视频文件。镜头描述或图片不等于视频；可到镜头制作生成视频，也可从已有素材加入时间线。");
      }
      episode.timeline = timeline; episode.texts = []; episode.status = "editing";
      validateTimeline(project, input.episodeId);
    });
  }

  async edit(raw: EditVideoTimelineInput): Promise<VideoProject> {
    this.requireOpen();
    const input = EditVideoTimelineInput.parse(raw);
    return this.repository.mutate(input.workId, input.expectedRevision, (project) => {
      const episode = project.episodes.find((item) => item.id === input.episodeId);
      if (!episode) throw new JizuoError("validation_error", "视频集不存在");
      const savedText = input.edit.op === "saveText" ? [...(episode.texts ?? []), ...legacySubtitleTexts(episode).map(item => item.text)].find(text => input.edit.op === "saveText" && text.id === input.edit.text.id) : undefined;
      const timingChanged = input.edit.op === "saveText" && savedText && (savedText.startSec !== input.edit.text.startSec || savedText.endSec !== input.edit.text.endSec);
      if (input.edit.op === "pasteTexts" || input.edit.op === "applyTextFont" || input.edit.op === "batchText" || input.edit.op === "moveTextsToTrack" || timingChanged) {
        const legacy = legacySubtitleTexts(episode);
        episode.texts = [...(episode.texts ?? []), ...legacy.map(item => item.text)];
        for (const clip of episode.timeline) {
          const entries = legacy.filter(item => item.clipId === clip.id);
          if (!entries.length) continue;
          if (clip.subtitleCues) {
            const removed = new Set(entries.map(item => item.cueIndex));
            clip.subtitleCues = clip.subtitleCues.filter((_, index) => !removed.has(index));
            clip.subtitle = clip.subtitleCues.map(cue => cue.text).join("\n");
          } else { clip.subtitle = ""; clip.subtitleCues = []; }
        }
        if (input.edit.op === "moveTextsToTrack" && input.edit.target.kind === "new") {
          const target = input.edit.target;
          const tracks = episode.textTracks ?? [];
          if (tracks.length >= 16) throw new Error("最多添加 16 条文本轨道");
          if (tracks.some(track => track.id === target.track.id)) throw new Error("文本轨道已存在");
          const index = target.beforeTrackId ? tracks.findIndex(track => track.id === target.beforeTrackId) : tracks.length;
          if (index < 0) throw new Error("文本轨道已变化，请重新拖动");
          episode.textTracks = [...tracks.slice(0, index), target.track, ...tracks.slice(index)];
        }
        episode.texts = applyTextEdit(episode, input.edit);
      } else if (input.edit.op === "saveText" || input.edit.op === "removeText" || input.edit.op === "splitText") {
        const id = input.edit.op === "removeText" ? input.edit.textId : input.edit.text.id;
        const legacy = legacySubtitleTexts(episode).find(item => item.text.id === id);
        if (legacy) {
          const clip = episode.timeline.find(clip => clip.id === legacy.clipId)!;
          if (clip.subtitleCues) {
            clip.subtitleCues = clip.subtitleCues.filter((_, index) => index !== legacy.cueIndex);
            clip.subtitle = clip.subtitleCues.map(cue => cue.text).join("\n");
          } else { clip.subtitle = ""; clip.subtitleCues = []; }
          episode.texts = [...(episode.texts ?? []), legacy.text];
        }
        episode.texts = applyTextEdit(episode, input.edit);
      }
      else if ((input.edit.op === "placeVisual" || input.edit.op === "moveVideoClips") && input.edit.newVideoTrack) {
        if ((episode.videoTrackCount ?? 0) + (episode.videoTrackBelowCount ?? 0) >= 8) throw new Error("最多添加 8 条独立视频轨道");
        const layer = input.edit.op === "moveVideoClips" ? input.edit.layer : input.edit.videoLayer ?? (episode.videoTrackCount ?? 0) + 1;
        if (layer === 0 || layer < -(episode.videoTrackBelowCount ?? 0) - 1 || layer > (episode.videoTrackCount ?? 0) + 1) throw new Error("视频轨道已变化，请重新拖动");
        episode.timeline = episode.timeline.map(clip => {
          if (!clip.videoLayer) return clip;
          if (layer > 0 && clip.videoLayer >= layer) return {...clip,videoLayer:clip.videoLayer + 1};
          if (layer < 0 && clip.videoLayer <= layer) return {...clip,videoLayer:clip.videoLayer - 1};
          return clip;
        });
        if (layer > 0) episode.videoTrackCount = (episode.videoTrackCount ?? 0) + 1;
        else episode.videoTrackBelowCount = (episode.videoTrackBelowCount ?? 0) + 1;
        episode.timeline = applyTimelineEdit(episode, input.edit.op === "moveVideoClips" ? input.edit : { ...input.edit, videoLayer: layer });
      }
      else if (input.edit.op === "addVideoTrack") {
        if ((episode.videoTrackCount ?? 0) + (episode.videoTrackBelowCount ?? 0) >= 8) throw new Error("最多添加 8 条独立视频轨道");
        episode.videoTrackCount = (episode.videoTrackCount ?? 0) + 1;
      } else if (input.edit.op === "removeVideoTrack") {
        const layer=input.edit.layer;
        if (layer > (episode.videoTrackCount ?? 0) || layer < -(episode.videoTrackBelowCount ?? 0)) throw new Error("视频轨道不存在");
        episode.timeline=episode.timeline.filter(clip=>clip.videoLayer!==layer).map(clip=> {
          if (!clip.videoLayer) return clip;
          if (layer > 0 && clip.videoLayer > layer) return {...clip,videoLayer:clip.videoLayer - 1};
          if (layer < 0 && clip.videoLayer < layer) return {...clip,videoLayer:clip.videoLayer + 1};
          return clip;
        });
        if (layer > 0) episode.videoTrackCount=(episode.videoTrackCount ?? 0)-1;
        else episode.videoTrackBelowCount=(episode.videoTrackBelowCount ?? 0)-1;
      }
      else if (input.edit.op === "removeTextTrack") {
        const trackId = input.edit.trackId;
        if (!episode.textTracks?.some(track => track.id === trackId)) throw new Error("文本轨道不存在");
        episode.textTracks = episode.textTracks.filter(track => track.id !== trackId);
        episode.texts = (episode.texts ?? []).filter(text => text.trackId !== trackId);
      }
      else if (input.edit.op === "addTextTrack") {
        const tracks = episode.textTracks ?? [];
        if (tracks.length >= 16) throw new Error("最多添加 16 条文本轨道");
        if (tracks.some(track => input.edit.op === "addTextTrack" && track.id === input.edit.track.id)) throw new Error("文本轨道已存在");
        episode.textTracks = [...tracks, input.edit.track];
      } else episode.timeline = applyTimelineEdit(episode, input.edit);
      validateTimeline(project, input.episodeId); episode.status = "editing";
    });
  }

  async clipFrames(raw: GetVideoClipFramesInput, signal?: AbortSignal): Promise<VideoClipFrames> {
    this.requireOpen();
    const input = GetVideoClipFramesInput.parse(raw);
    const project = await this.repository.read(input.workId);
    if (project.revision !== input.expectedRevision) throw new JizuoError("revision_conflict", "剪辑已更新，请重新提取首末帧");
    const clip = project.episodes.find(episode => episode.id === input.episodeId)?.timeline.find(clip => clip.id === input.clipId);
    if (!clip || clip.track === "audio") throw new JizuoError("validation_error", "画面片段不存在");
    const { path, asset } = await this.assets.pathFor(input.workId, clip.assetId);
    if (!["image", "video", "export"].includes(asset.kind)) throw new JizuoError("validation_error", "素材不含画面");
    const frames = await extractClipFrames(path, clip.inSec, clip.outSec, asset.kind === "image", signal);
    return { clipId: clip.id, inSec: clip.inSec, outSec: clip.outSec, ...frames };
  }

  async timelineHistory(raw: VideoTimelineHistoryInput): Promise<VideoTimelineHistory> {
    this.requireOpen();
    const input = VideoTimelineHistoryInput.parse(raw);
    const current = await this.repository.read(input.workId);
    const episode = current.episodes.find((item) => item.id === input.episodeId);
    if (!episode) throw new JizuoError("validation_error", "视频集不存在");
    const seen = new Set([JSON.stringify([episode.timeline, episode.texts ?? [], episode.textTracks ?? [], episode.videoTrackCount ?? 0, episode.videoTrackBelowCount ?? 0])]), versions: VideoTimelineHistory["versions"] = [];
    for (const revision of await this.repository.listRevisionNumbers(input.workId)) {
      if (revision >= current.revision) continue;
      const historical = await this.repository.readRevision(input.workId, revision);
      const oldEpisode = historical.episodes.find((item) => item.id === input.episodeId);
      if (!oldEpisode) continue;
      const key = JSON.stringify([oldEpisode.timeline, oldEpisode.texts ?? [], oldEpisode.textTracks ?? [], oldEpisode.videoTrackCount ?? 0, oldEpisode.videoTrackBelowCount ?? 0]);
      if (seen.has(key)) continue;
      seen.add(key);
      versions.push({ revision, clipCount: oldEpisode.timeline.length, durationSec: timelineLayout(oldEpisode.timeline).durationSec });
      if (versions.length === 20) break;
    }
    return { versions };
  }

  async restoreTimeline(raw: RestoreVideoTimelineInput): Promise<VideoProject> {
    this.requireOpen();
    const input = RestoreVideoTimelineInput.parse(raw);
    const historical = await this.repository.readRevision(input.workId, input.revision);
    const oldEpisode = historical.episodes.find((item) => item.id === input.episodeId);
    if (!oldEpisode) throw new JizuoError("validation_error", "该历史版本没有当前视频集");
    return this.repository.mutate(input.workId, input.expectedRevision, (current) => {
      if (input.revision >= current.revision) throw new JizuoError("validation_error", "只能恢复以前的剪辑版本");
      const episode = current.episodes.find((item) => item.id === input.episodeId);
      if (!episode) throw new JizuoError("validation_error", "视频集不存在");
      if (isDeepStrictEqual([episode.timeline, episode.texts ?? [], episode.textTracks ?? [], episode.videoTrackCount ?? 0, episode.videoTrackBelowCount ?? 0], [oldEpisode.timeline, oldEpisode.texts ?? [], oldEpisode.textTracks ?? [], oldEpisode.videoTrackCount ?? 0, oldEpisode.videoTrackBelowCount ?? 0])) throw new JizuoError("validation_error", "该历史版本与当前时间线相同");
      episode.timeline = structuredClone(oldEpisode.timeline);
      episode.texts = structuredClone(oldEpisode.texts ?? []);
      episode.textTracks = structuredClone(oldEpisode.textTracks ?? []);
      episode.videoTrackCount=oldEpisode.videoTrackCount ?? 0;
      episode.videoTrackBelowCount=oldEpisode.videoTrackBelowCount ?? 0;
      // Validate against today's assets and shots: restoring a timeline never resurrects either.
      validateTimeline(current, input.episodeId);
      episode.status = "editing";
    });
  }

  async export(raw: ExportVideoInput, internal?: { productionJobId: string }): Promise<VideoProject> {
    this.requireOpen();
    const input = ExportVideoInput.parse(raw); let jobId: string = randomUUID();
    const next = await this.repository.mutate(input.workId, input.expectedRevision, (project) => {
      const parent = internal ? project.jobs.find((job) => job.id === internal.productionJobId) : undefined;
      if (internal) {
        if (!parent || parent.kind !== "pipeline" || parent.snapshot.type !== "production" || parent.episodeId !== input.episodeId) throw new JizuoError("validation_error", "导出父任务不是当前视频集的生产任务");
        if (!active(parent)) throw new JizuoError("validation_error", "生产任务已停止，不能启动导出");
        const existing = project.jobs.find((job) => job.kind === "export" && job.episodeId === input.episodeId && job.state?.productionJobId === parent.id);
        if (existing) {
          jobId = existing.id; parent.state = { ...parent.state, childJobId: existing.id, stage: "export" }; return;
        }
      }
      validateTimeline(project, input.episodeId);
      const episode = project.episodes.find((item) => item.id === input.episodeId)!;
      if (timelineLayout(episode.timeline).clips.length === 0) throw new JizuoError("validation_error", "请先创建画面时间线再导出");
      if (project.jobs.some((job) => job.kind === "export" && job.episodeId === episode.id && active(job))) throw new JizuoError("revision_conflict", "该视频集已有进行中的导出任务");
      if (input.aspectRatio !== undefined) episode.aspectRatio = input.aspectRatio;
      const aspectRatio = input.aspectRatio ?? episode.aspectRatio ?? "9:16";
      const snapshot = json({ project: { ...project, episodes: [episode], jobs: [] }, output: { aspectRatio, ...videoOutputDimensions(aspectRatio) } });
      project.jobs.push({ id: jobId, kind: "export", status: "queued", episodeId: episode.id, snapshot,
        attempt: 0, state: { progress: 0, ...(parent ? { productionJobId: parent.id } : {}) }, createdAt: new Date().toISOString() });
      if (parent) parent.state = { ...parent.state, childJobId: jobId, stage: "export" };
    });
    this.enqueue(input.workId, jobId);
    return next;
  }

  private enqueue(workId: string, jobId: string): void {
    if (this.closed || this.pending.has(jobId)) return;
    const controller = new AbortController(); this.aborts.set(jobId, controller);
    const running = this.run(workId, jobId, controller.signal).finally(() => { this.pending.delete(jobId); this.aborts.delete(jobId); });
    this.pending.set(jobId, running);
    void running.catch(() => undefined);
  }

  private async patch(workId: string, jobId: string, update: (job: VideoJob, project: VideoProject) => void): Promise<void> {
    await this.repository.mutate(workId, undefined, (project) => {
      const job = project.jobs.find((item) => item.id === jobId);
      if (!job || job.kind !== "export") throw new JizuoError("validation_error", "导出任务不存在");
      update(job, project); job.updatedAt = new Date().toISOString();
    });
  }

  private async run(workId: string, jobId: string, signal: AbortSignal): Promise<void> {
    const initial = (await this.repository.read(workId)).jobs.find((item) => item.id === jobId);
    if (!initial || !active(initial)) return;
    const stagingRelative = `video/staging/${jobId}`;
    let staging: string | undefined;
    let progressWrites = Promise.resolve(), progressError: unknown, previousProgress = -1;
    try {
      if ((initial.attempt ?? 0) >= 3) throw new JizuoError("quota_exceeded", "本地导出已达到三次尝试上限，请创建新的导出任务");
      const frozen = VideoProject.parse(initial.snapshot.project);
      if (frozen.workId !== workId || frozen.episodes.length !== 1 || frozen.episodes[0]?.id !== initial.episodeId) throw new JizuoError("validation_error", "导出任务快照不属于当前作品或视频集");
      validateTimeline(frozen, initial.episodeId!);
      const output = initial.snapshot.output === undefined
        ? videoOutputDimensions(frozen.episodes[0]!.aspectRatio ?? "9:16") : VideoOutputSettings.parse(initial.snapshot.output);
      await this.patch(workId, jobId, (job) => {
        if (!active(job)) throw new DOMException("导出已停止", "AbortError");
        job.status = "running"; job.attempt = (job.attempt ?? 0) + 1; job.state = { ...job.state, progress: 0 }; delete job.error;
      });
      throwIfAborted(signal);
      staging = await this.assets.safePath(workId, stagingRelative);
      await rm(staging, { recursive: true, force: true });
      const outputPath = await this.assets.safePath(workId, `${stagingRelative}/output.mp4`, true);
      const result = await this.renderer({ project: frozen, episodeId: initial.episodeId!, outputPath, signal, width: output.width, height: output.height,
        resolveAsset: async (id) => {
          const asset = frozen.assets.find((item) => item.id === id);
          if (!asset || !visibleVideoPath(asset.path).startsWith("video/assets/")) throw new JizuoError("validation_error", "冻结素材不在作品视频资产目录");
          return this.assets.safePath(workId, asset.path);
        },
        onProgress: (progress) => {
          const bounded = Math.max(0, Math.min(1, progress));
          if (bounded < previousProgress + 0.1 && bounded !== 1) return;
          previousProgress = bounded;
          progressWrites = progressWrites.then(async () => {
            if (signal.aborted || this.closed) return;
            await this.patch(workId, jobId, (job) => { if (job.status === "running") job.state = { ...job.state, progress: bounded }; });
          }).catch((error: unknown) => { progressError = error; this.aborts.get(jobId)?.abort(); });
        },
      });
      await progressWrites;
      if (progressError) throw progressError;
      throwIfAborted(signal);
      const info = await stat(outputPath);
      if (!info.isFile() || info.size === 0 || info.size > MAX_EXPORT_BYTES) throw new JizuoError("validation_error", "导出文件为空或超过 256 MB，请缩短视频后重试");
      const asset = await this.assets.write(workId, { kind: "export", label: `${frozen.episodes[0]!.title} 成片`.slice(0, 120),
        episodeId: initial.episodeId!, sourceJobId: jobId, durationSec: result.durationSec }, await readFile(outputPath), "video/mp4");
      try {
        await this.patch(workId, jobId, (job, project) => {
          project.assets.push(asset); job.resultAssetIds = [asset.id];
          const current = project.episodes.find((item) => item.id === job.episodeId);
          const changedAssets = frozen.episodes[0]!.timeline.some((clip) => !isDeepStrictEqual(
            frozen.assets.find((item) => item.id === clip.assetId), project.assets.find((item) => item.id === clip.assetId),
          ));
          const stale = !current || changedAssets || !isDeepStrictEqual(content(current), content(frozen.episodes[0]!));
          job.state = { ...job.state, progress: 1, subtitleMode: result.subtitleMode, stale };
          if (job.status !== "cancelled") {
            job.status = "succeeded"; delete job.error;
            if (!stale && current) current.status = "complete";
          }
        });
      } catch (error) {
        // A failed project transaction must not leave an unreferenced immutable file behind.
        const saved = await this.repository.read(workId).catch(() => undefined);
        if (saved && !saved.assets.some((item) => item.id === asset.id)) await rm(await this.assets.safePath(workId, asset.path), { force: true });
        throw error;
      }
    } catch (error) {
      await progressWrites;
      if (this.closed) return; // Keep active state: the next host can safely restart this local render.
      await this.patch(workId, jobId, (job) => {
        if (job.status === "cancelled") return;
        job.status = "failed";
        job.error = (error instanceof Error ? error.message : "本地导出失败，请检查 FFmpeg 和素材后重试").slice(0, 9500);
      });
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }

  async control(raw: ControlVideoJobInput): Promise<VideoProject> {
    this.requireOpen();
    const input = ControlVideoJobInput.parse(raw);
    const project = await this.repository.read(input.workId), job = project.jobs.find((item) => item.id === input.jobId);
    if (!job || job.kind !== "export") throw new JizuoError("validation_error", "导出任务不存在");
    if (input.action === "cancel") {
      await this.patch(input.workId, job.id, (current) => { if (active(current) || current.status === "uncertain") { current.status = "cancelled"; current.error = "本地导出已取消"; } });
      this.aborts.get(job.id)?.abort();
    } else {
      if (job.status === "succeeded") return project;
      if (active(job) && this.pending.has(job.id)) return project;
      const inFlight = this.pending.get(job.id); if (inFlight) await inFlight;
      await this.patch(input.workId, job.id, (current) => {
        if ((current.attempt ?? 0) >= 3) throw new JizuoError("quota_exceeded", "本地导出已达到三次尝试上限，请创建新的导出任务");
        current.status = "queued"; current.state = { ...current.state, progress: 0 }; delete current.error;
      });
      this.enqueue(input.workId, job.id);
    }
    return this.repository.read(input.workId);
  }

  async recover(workId: string): Promise<void> {
    this.requireOpen();
    const project = await this.repository.read(workId);
    for (const job of project.jobs.filter((item) => item.kind === "export")) {
      if (active(job)) this.enqueue(workId, job.id);
      else if (!this.pending.has(job.id)) {
        // Also clear a crash between recording cancel/success and deleting that job's staging.
        await rm(await this.assets.safePath(workId, `video/staging/${job.id}`), { recursive: true, force: true });
      }
    }
  }

  async idle(): Promise<void> { await Promise.all([...this.pending.values()]); }
  async close(): Promise<void> { this.closed = true; for (const abort of this.aborts.values()) abort.abort(); await this.idle(); }
}
