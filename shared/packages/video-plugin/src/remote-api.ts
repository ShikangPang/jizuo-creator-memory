import type { GetVideoProjectViewInput, GetVideoJobUpdatesInput } from "@jizuo/contracts";
import { createVideoQueries } from "../../jizuo-plugin/src/video/queries.ts";
import { copyVideoExport } from "../../jizuo-plugin/src/video/save-export.ts";
import { projectVideoForClient } from "../../jizuo-plugin/src/video/projection.ts";
import type { Context } from "@deepseek-ai/cordis";

import { SessionId, type Session, type SessionStore } from "@deepseek-ai/dsh-session";

import { JizuoError } from "@jizuo/contracts";

import type { JizuoService } from "../../jizuo-plugin/src/service.ts";

/** Feature-owned handlers; the core RPC namespace delegates here for compatibility. */
export class VideoRemoteApi {
  constructor(private readonly ctx: Context, readonly domain: JizuoService) {}
  private videoQueries?: ReturnType<typeof createVideoQueries>;

  async getVideoProjectView(request:GetVideoProjectViewInput,signal:AbortSignal){
    signal.throwIfAborted();
    return (this.videoQueries??=createVideoQueries(this.domain.video)).getView(request);
  }

  async getVideoJobUpdates(request:GetVideoJobUpdatesInput,signal:AbortSignal){
    signal.throwIfAborted();
    return (this.videoQueries??=createVideoQueries(this.domain.video)).getJobs(request);
  }

  async renameVideoAsset(request: import("@jizuo/contracts").RenameVideoAssetInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoMedia) throw new JizuoError("runtime_unavailable", "素材重命名尚未连接");
    return projectVideoForClient(await this.domain.videoMedia.rename(request));
  }

  async getVideoTimelineHistory(request: import("@jizuo/contracts").VideoTimelineHistoryInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoEditing) throw new JizuoError("runtime_unavailable", "剪辑历史尚未连接");
    return await this.domain.videoEditing.timelineHistory(request);
  }

  async restoreVideoTimeline(request: import("@jizuo/contracts").RestoreVideoTimelineInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoEditing) throw new JizuoError("runtime_unavailable", "剪辑恢复尚未连接");
    return projectVideoForClient(await this.domain.videoEditing.restoreTimeline(request));
  }

  async startVideoProduction(request: import("@jizuo/contracts").StartVideoProductionInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoProduction) throw new JizuoError("runtime_unavailable", "自动制作尚未连接");
    return projectVideoForClient(await this.domain.videoProduction.start(request));
  }

  async controlVideoProduction(request: import("@jizuo/contracts").ControlVideoProductionInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoProduction) throw new JizuoError("runtime_unavailable", "自动制作尚未连接");
    return projectVideoForClient(await this.domain.videoProduction.control(request));
  }

  async copyVideoExport(request: import("@jizuo/contracts").CopyVideoExportInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoAssets) throw new JizuoError("runtime_unavailable", "成片保存尚未连接");
    return copyVideoExport(this.domain.videoAssets, request);
  }

  async roughCutVideo(request: import("@jizuo/contracts").RoughCutVideoInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoEditing) throw new JizuoError("runtime_unavailable", "剪辑配音服务尚未连接");
    return projectVideoForClient(await this.domain.videoEditing.roughCut(request));
  }

  async getVideoClipFrames(request: import("@jizuo/contracts").GetVideoClipFramesInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoEditing) throw new JizuoError("runtime_unavailable", "剪辑服务尚未连接");
    return this.domain.videoEditing.clipFrames(request, signal);
  }

  async editVideoTimeline(request: import("@jizuo/contracts").EditVideoTimelineInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoEditing) throw new JizuoError("runtime_unavailable", "剪辑配音服务尚未连接");
    return projectVideoForClient(await this.domain.videoEditing.edit(request));
  }

  async exportVideo(request: import("@jizuo/contracts").ExportVideoInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoEditing) throw new JizuoError("runtime_unavailable", "剪辑配音服务尚未连接");
    return projectVideoForClient(await this.domain.videoEditing.export(request));
  }

  async generateVideoSpeech(request: import("@jizuo/contracts").GenerateSpeechInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoSpeech) throw new JizuoError("runtime_unavailable", "剪辑配音服务尚未连接");
    return projectVideoForClient(await this.domain.videoSpeech.generate(request));
  }

  async getSpeechSettings(_request: Record<string, never>, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.speechSettings) throw new JizuoError("runtime_unavailable", "配音设置尚未连接");
    return this.domain.speechSettings.get();
  }

  async saveSpeechSettings(request: import("@jizuo/contracts").SaveSpeechSettingsInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.speechSettings) throw new JizuoError("runtime_unavailable", "配音设置尚未连接");
    return this.domain.speechSettings.save(request);
  }

  async submitVideoBatch(request: import("@jizuo/contracts").SubmitVideoBatchInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoBatch) throw new JizuoError("runtime_unavailable", "批量生成尚未连接");
    return projectVideoForClient(await this.domain.videoBatch.submit(request));
  }

  async generateVideoMedia(request: import("@jizuo/contracts").GenerateVideoMediaInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoGeneration) throw new JizuoError("runtime_unavailable", "媒体生成尚未连接");
    if (request.sourceSessionId !== undefined) {
      // Opening history does not resume its Agent. A durable ordinary session
      // is a valid media destination even while absent from the live store.
      // Never create an identity from client input or adopt a subagent history.
      const sessions = (this.ctx as unknown as { sessions?: Pick<SessionStore, "get" | "flush"> }).sessions;
      const id = SessionId(request.sourceSessionId), session = sessions?.get(id);
      if (session?.header.origin === "subagent") throw new JizuoError("denied", "当前对话不可用，请重新打开对话后生成");
      const persistence = this.ctx.get("sessionPersistence") as {stat?: (id: Session["id"]) => Promise<{header: Session["header"];sizeBytes?:number} | undefined>} | undefined;
      if (typeof persistence?.stat !== "function" || session && !sessions?.flush) throw new JizuoError("runtime_unavailable", "当前运行时无法保存图片对话，请更新后重试");
      // The native Agent owns its write handle. Flushing materializes an empty
      // header; verify storage before accepting a paid job, without inventing events.
      if (session && !await sessions!.flush(session)) throw new JizuoError("runtime_unavailable", "当前运行时无法保存图片对话，请重新打开后重试");
      const stored = await persistence.stat(id);
      signal.throwIfAborted();
      if (!stored || stored.header.id !== id || stored.header.origin === "subagent") throw new JizuoError("denied", "当前对话不可用，请重新打开对话后生成");
      // The pinned JSONL backend also lists unflushed pending headers. A cold
      // identity must have a physical artifact before a paid job can refer to it.
      if (!session && !(typeof stored.sizeBytes === "number" && stored.sizeBytes > 0)) throw new JizuoError("runtime_unavailable", "当前对话尚未保存完成，请稍后重试生成");
      const current = sessions?.get(id);
      if (current?.header.origin === "subagent" || session && current !== session) throw new JizuoError("denied", "当前对话已关闭，请重新打开后生成");
    }
    if(request.sourceSessionId)await this.domain.chatMediaRepository.remember(request.sourceSessionId,request.workId);
    return projectVideoForClient(await this.domain.videoGeneration.generate(request));
  }

  async controlVideoJob(request: import("@jizuo/contracts").ControlVideoJobInput, signal: AbortSignal) {
    signal.throwIfAborted();
    const job = (await this.domain.video.read(request.workId)).jobs.find(item => item.id === request.jobId);
    if (request.action === "abandon" && job?.kind !== "image" && job?.kind !== "video") throw new JizuoError("validation_error", "仅图片和视频生成任务支持结束本地跟进");
    const handler = job?.kind === "export" ? this.domain.videoEditing : job?.kind === "audio" ? this.domain.videoSpeech : this.domain.videoGeneration;
    if (!handler) throw new JizuoError("runtime_unavailable", "任务服务尚未连接");
    return projectVideoForClient(await handler.control(request));
  }

  async saveStyledPrompts(request: import("@jizuo/contracts").SaveStyledPromptsInput, signal: AbortSignal) {
    signal.throwIfAborted();return projectVideoForClient(await this.domain.video.saveStyledPrompts(request));
  }

  async undoStyledPrompts(request: import("@jizuo/contracts").UndoStyledPromptsInput, signal: AbortSignal) {
    signal.throwIfAborted();return projectVideoForClient(await this.domain.video.undoStyledPrompts(request));
  }

  async saveWorkVisualStyle(request: import("@jizuo/contracts").SaveWorkVisualStyleInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return projectVideoForClient(await this.domain.video.saveVisualStyle(request));
  }

  async saveVideoDesign(request: import("@jizuo/contracts").SaveVideoDesignInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoMedia) throw new JizuoError("runtime_unavailable", "设定库尚未连接");
    return projectVideoForClient(await this.domain.videoMedia.saveDesign(request));
  }

  async tagVideoAsset(request: import("@jizuo/contracts").TagVideoAssetInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoMedia) throw new JizuoError("runtime_unavailable", "设定库尚未连接");
    return projectVideoForClient(await this.domain.videoMedia.tag(request));
  }

  async extractVideoDesigns(request: import("@jizuo/contracts").ExtractVideoDesignsInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoAuthoring) throw new JizuoError("runtime_unavailable", "视频创作尚未连接");
    return projectVideoForClient(await this.domain.videoAuthoring.extractDesigns(request, signal));
  }

  async importVideoAsset(request: import("@jizuo/contracts").ImportVideoAssetInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoMedia) throw new JizuoError("runtime_unavailable", "素材管理尚未连接");
    return projectVideoForClient(await this.domain.videoMedia.import(request));
  }

  async selectVideoAsset(request: import("@jizuo/contracts").SelectVideoAssetInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoMedia) throw new JizuoError("runtime_unavailable", "素材管理尚未连接");
    return projectVideoForClient(await this.domain.videoMedia.select(request));
  }

  async getVideoAssetUrl(request: { workId: string; assetId: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoAssets) throw new JizuoError("runtime_unavailable", "素材预览尚未连接");
    return { url: await this.domain.videoAssets.urlFor(request.workId, request.assetId) };
  }

  async discussVideoPrompt(request: import("@jizuo/contracts").DiscussVideoPromptInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoAuthoring) throw new JizuoError("runtime_unavailable", "提示词讨论模型尚未连接");
    return projectVideoForClient(await this.domain.videoAuthoring.discussPrompt(request, signal));
  }

  async adaptVideoEpisode(request: import("@jizuo/contracts").AdaptVideoEpisodeInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.videoAuthoring) throw new JizuoError("runtime_unavailable", "制作稿模型尚未连接");
    return projectVideoForClient(await this.domain.videoAuthoring.adapt(request, signal));
  }

  async getVideoProject(request: { workId: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    return projectVideoForClient(await this.domain.video.read(request.workId));
  }

  async createVideoEpisode(request: import("@jizuo/contracts").CreateVideoEpisodeInput, signal: AbortSignal) {
    signal.throwIfAborted();
    for (const source of request.sourceChapters) await this.domain.readChapter({ workId: source.sourceWorkId ?? request.workId, volumeId: source.volumeId, chapterId: source.chapterId });
    return projectVideoForClient(await this.domain.video.createEpisode(request));
  }

  async deleteVideoItem(request: import("@jizuo/contracts").DeleteVideoItemInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return projectVideoForClient(await this.domain.video.deleteItem(request));
  }

  async deleteVideoEpisode(request: import("@jizuo/contracts").DeleteVideoEpisodeInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return projectVideoForClient(await this.domain.video.deleteEpisode(request));
  }

  async updateVideoEpisode(request: import("@jizuo/contracts").UpdateVideoEpisodeInput, signal: AbortSignal) {
    signal.throwIfAborted();
    for (const source of request.patch.sourceChapters ?? []) await this.domain.readChapter({ workId: source.sourceWorkId ?? request.workId, volumeId: source.volumeId, chapterId: source.chapterId });
    return projectVideoForClient(await this.domain.video.updateEpisode(request));
  }
}
