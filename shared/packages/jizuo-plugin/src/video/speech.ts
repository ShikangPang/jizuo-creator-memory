import { visibleVideoPath } from "@jizuo/work-domain";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { JizuoError, VideoRelativePath, type VideoJob, type VideoJsonValue, type VideoProject } from "@jizuo/contracts";
import type { VideoRepository } from "@jizuo/work-domain";
import { ControlVideoJobInput } from "../../../contracts/src/media-operations.ts";
import { GenerateSpeechInput, SpeechProviderConfig, SpeechText } from "../../../contracts/src/video-speech.ts";
import { LocalVideoAssets } from "./assets.ts";
import { loadVideoMediaMetadata } from "./editing-service.ts";
import { discoverMediaExecutable, throwIfAborted } from "./ffmpeg.ts";
import { SpeechSettingsRepository } from "./speech-settings.ts";
import { createSpeechProvider, SpeechProviderError } from "./speech-provider.ts";
export { createSpeechProvider, SpeechProviderError } from "./speech-provider.ts";

const active = (job: VideoJob) => job.status === "queued" || job.status === "running";
const json = (value: unknown): Record<string, VideoJsonValue> => JSON.parse(JSON.stringify(value)) as Record<string, VideoJsonValue>;
const SavedOutput = z.object({ path: VideoRelativePath, mimeType: z.enum(["audio/wav", "audio/mpeg"]) }).strict();
type Options = { repository: VideoRepository; settings: SpeechSettingsRepository; assets: LocalVideoAssets; provider?: ReturnType<typeof createSpeechProvider> };

/** One synchronous paid speech POST per durable submission intent; ambiguous results never resubmit. */
export class VideoSpeechService {
  private readonly provider: ReturnType<typeof createSpeechProvider>;
  private readonly pending = new Map<string, Promise<void>>();
  private readonly aborts = new Map<string, AbortController>();
  private closed = false;
  constructor(private readonly options: Options) { this.provider = options.provider ?? createSpeechProvider(); }
  private requireOpen(): void { if (this.closed) throw new JizuoError("runtime_unavailable", "AI 配音服务已关闭"); }

  async generate(raw: GenerateSpeechInput): Promise<VideoProject> {
    this.requireOpen(); const input = GenerateSpeechInput.parse(raw);
    const project = await this.options.repository.read(input.workId);
    if (project.revision !== input.expectedRevision) throw new JizuoError("revision_conflict", "视频制作稿已变化，请刷新后生成配音");
    const episode = project.episodes.find((item) => item.id === input.episodeId);
    if (!episode) throw new JizuoError("validation_error", "视频集不存在");
    if (project.jobs.some((job) => job.kind === "audio" && job.episodeId === episode.id && job.status !== "succeeded" && (active(job) || job.status === "uncertain" || job.state?.submissionStarted === true || Boolean(job.state?.output)))) {
      throw new JizuoError("transaction_recovery_required", "该视频集已有进行中或待核对的 AI 配音任务，请先核对现有任务，避免重复计费");
    }
    const parsedText = SpeechText.safeParse(input.text ?? episode.shots.filter((shot) => !shot.archived).map((shot) => shot.dialogue.trim()).filter(Boolean).join("\n"));
    if (!parsedText.success) throw new JizuoError("validation_error", parsedText.error.issues[0]?.message ?? "配音文本无效");
    const saved = (await this.options.settings.read()).speech;
    if (!saved) throw new JizuoError("credential_required", "请先配置 OpenAI 兼容语音模型");
    const config = SpeechProviderConfig.parse({ ...saved, ...(input.voice ? { voice: input.voice } : {}) });
    if (!await this.options.settings.vault.resolve(config.credentialRef)) throw new JizuoError("credential_required", "请先保存语音模型 API Key");
    await discoverMediaExecutable("ffprobe"); // Fail before a paid request when local audio validation is unavailable.
    const job: VideoJob = { id: randomUUID(), kind: "audio", status: "queued", episodeId: episode.id,
      snapshot: json({ config, text: parsedText.data }), attempt: 0,
      state: { service: "speech", label: `${episode.title} AI 配音`.slice(0, 120), submissionStarted: false }, createdAt: new Date().toISOString() };
    const next = await this.options.repository.mutate(input.workId, input.expectedRevision, (draft) => { draft.jobs.push(job); });
    this.enqueue(input.workId, job.id); return next;
  }

  private enqueue(workId: string, jobId: string): void {
    if (this.closed || this.pending.has(jobId)) return;
    const controller = new AbortController(); this.aborts.set(jobId, controller);
    const running = this.run(workId, jobId, controller.signal).finally(() => { this.pending.delete(jobId); this.aborts.delete(jobId); });
    this.pending.set(jobId, running); void running.catch(() => undefined);
  }
  private async patch(workId: string, jobId: string, update: (job: VideoJob, project: VideoProject) => void): Promise<void> {
    await this.options.repository.mutate(workId, undefined, (project) => {
      const job = project.jobs.find((item) => item.id === jobId);
      if (!job || job.kind !== "audio" || job.state?.service !== "speech") throw new JizuoError("validation_error", "AI 配音任务不存在");
      update(job, project); job.updatedAt = new Date().toISOString();
    });
  }

  private async run(workId: string, jobId: string, signal: AbortSignal): Promise<void> {
    let job = (await this.options.repository.read(workId)).jobs.find((item) => item.id === jobId);
    if (!job || !active(job)) return;
    try {
      const config = SpeechProviderConfig.parse(job.snapshot.config), text = SpeechText.parse(job.snapshot.text);
      let output = job.state?.output ? SavedOutput.parse(job.state.output) : undefined;
      if (!output) {
        if (job.status !== "queued" || job.state?.submissionStarted) {
          await this.patch(workId, jobId, (current) => { if (active(current)) { current.status = "uncertain"; current.error = "语音提交结果未确认，请核对服务方记录，不能自动重复提交"; } }); return;
        }
        const key = await this.options.settings.vault.resolve(config.credentialRef);
        if (!key) throw new JizuoError("credential_required", "任务使用的语音凭据不可用，请恢复该凭据");
        if ((job.attempt ?? 0) >= 3) throw new JizuoError("quota_exceeded", "配音请求已达到三次尝试上限");
        throwIfAborted(signal);
        await this.patch(workId, jobId, (current) => {
          if (current.status !== "queued") throw new DOMException("配音已停止", "AbortError");
          current.status = "running"; current.attempt = (current.attempt ?? 0) + 1;
          current.state = { ...current.state, submissionStarted: true }; delete current.error;
        });
        throwIfAborted(signal);
        const received = await this.provider.synthesize(config, key, text, signal);
        throwIfAborted(signal);
        if (received.bytes.length === 0 || received.bytes.length > 256 * 1024 * 1024) throw new SpeechProviderError("语音响应为空或超过 256 MB", "unknown");
        const relative = `video/speech/${jobId}/output.${received.mimeType === "audio/wav" ? "wav" : "mp3"}`;
        const path = await this.options.assets.safePath(workId, relative, true);
        const temporary = `${path}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, received.bytes, { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
        finally { await rm(temporary, { force: true }); }
        output = { path: relative, mimeType: received.mimeType };
        await this.patch(workId, jobId, (current) => { current.state = { ...current.state, output: json(output), responseReceived: true }; });
      }
      const expected = `video/speech/${jobId}/output.${output.mimeType === "audio/wav" ? "wav" : "mp3"}`;
      if (visibleVideoPath(output.path) !== expected) throw new JizuoError("validation_error", "配音输出路径不属于当前任务");
      throwIfAborted(signal);
      const path = await this.options.assets.safePath(workId, output.path);
      const metadata = await loadVideoMediaMetadata(path, signal);
      if (!metadata.audio || metadata.video) throw new JizuoError("validation_error", "语音接口没有返回有效的纯音频素材");
      throwIfAborted(signal);
      job = (await this.options.repository.read(workId)).jobs.find((item) => item.id === jobId)!;
      if (job.status === "cancelled") return;
      const asset = await this.options.assets.write(workId, { kind: "audio", label: String(job.state?.label ?? "AI 配音").slice(0, 120), episodeId: job.episodeId!, sourceJobId: jobId, durationSec: metadata.durationSec }, await readFile(path), output.mimeType);
      await this.patch(workId, jobId, (current, project) => {
        project.assets.push(asset); current.resultAssetIds = [asset.id];
        if (current.status !== "cancelled") { current.status = "succeeded"; delete current.error; }
        if (current.state) delete current.state.output;
      });
      await rm(await this.options.assets.safePath(workId, `video/speech/${jobId}`), { recursive: true, force: true });
    } catch (error) {
      if (this.closed) return;
      await this.patch(workId, jobId, (current) => {
        if (current.status === "cancelled" || current.status === "succeeded") return;
        const knownRejection = error instanceof SpeechProviderError && error.submission !== "unknown";
        const ambiguous = !current.state?.output && Boolean(current.state?.submissionStarted) && !knownRejection;
        current.status = ambiguous ? "uncertain" : "failed";
        if (knownRejection) current.state = { ...current.state, submissionStarted: false };
        current.error = error instanceof SpeechProviderError || error instanceof JizuoError ? error.message : ambiguous ? "语音提交结果未确认，请核对服务方记录，不能自动重复提交" : "AI 配音处理失败，请检查本地 FFmpeg 和音频文件后恢复";
      });
    }
  }

  async control(raw: ControlVideoJobInput): Promise<VideoProject> {
    this.requireOpen(); const input = ControlVideoJobInput.parse(raw);
    if (input.action === "reconcile") throw new JizuoError("validation_error", "同步语音接口不支持远端任务 ID 关联，请直接核对服务方记录");
    const project = await this.options.repository.read(input.workId), job = project.jobs.find((item) => item.id === input.jobId);
    if (!job || job.kind !== "audio" || job.state?.service !== "speech") throw new JizuoError("validation_error", "AI 配音任务不存在");
    if (input.action === "cancel") {
      await this.patch(input.workId, job.id, (current) => { if (active(current) || current.status === "uncertain") { current.status = "cancelled"; current.error = "已停止本地配音任务，已提交的服务方请求可能继续计费"; } });
      this.aborts.get(job.id)?.abort();
    } else {
      if (job.status === "succeeded" || (active(job) && this.pending.has(job.id))) return project;
      const running = this.pending.get(job.id); if (running) await running;
      await this.patch(input.workId, job.id, (current) => {
        if (!current.state?.output && (current.status === "uncertain" || current.state?.submissionStarted)) throw new JizuoError("transaction_recovery_required", "不能确认配音请求是否已计费，请先核对服务方记录，不能自动重复提交");
        if (!current.state?.output && (current.attempt ?? 0) >= 3) throw new JizuoError("quota_exceeded", "配音请求已达到三次尝试上限");
        current.status = current.state?.output ? "running" : "queued"; delete current.error;
      });
      this.enqueue(input.workId, job.id);
    }
    return this.options.repository.read(input.workId);
  }
  async recover(workId: string): Promise<void> {
    this.requireOpen(); const project = await this.options.repository.read(workId);
    for (const job of project.jobs.filter((item) => item.kind === "audio" && item.state?.service === "speech" && active(item))) {
      if (this.pending.has(job.id)) continue;
      if ((job.status === "running" || job.state?.submissionStarted) && !job.state?.output) await this.patch(workId, job.id, (current) => { current.status = "uncertain"; current.error = "应用中断时没有保存完整配音响应，请核对服务方记录后处理"; });
      else this.enqueue(workId, job.id);
    }
  }
  async idle(): Promise<void> { await Promise.all([...this.pending.values()]); }
  async close(): Promise<void> { this.closed = true; for (const abort of this.aborts.values()) abort.abort(); await this.idle(); }
}
