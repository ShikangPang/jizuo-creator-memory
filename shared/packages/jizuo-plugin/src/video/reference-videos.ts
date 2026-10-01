import { open, stat } from "node:fs/promises";
import { JizuoError, type VideoProject } from "@jizuo/contracts";
import type { MediaReferenceVideo } from "../../../contracts/src/media.ts";
import type { LocalVideoAssets } from "./assets.ts";
import { discoverMediaExecutable, probeMedia } from "./ffmpeg.ts";

export type ProbeReferenceVideo = (path: string) => Promise<{ video: boolean; durationSec: number }>;
function invalid(message: string): never { throw new JizuoError("validation_error", message); }

/** Resolve immutable work assets. Seedance video URLs must stay reachable during execution.
 * https://docs.byteplus.com/en/docs/Byteplus_LAS/video_gen_enhanced
 * Keep the application limit at 3 videos / 15 seconds / 50 MB for existing Ark adapters.
 */
export async function loadReferenceVideos(project: VideoProject, ids: readonly string[], assets: LocalVideoAssets, probe?: ProbeReferenceVideo): Promise<MediaReferenceVideo[]> {
  const references: MediaReferenceVideo[] = [];
  let totalDuration = 0;
  for (const id of ids) {
    const entry = project.assets.find(asset => asset.id === id);
    if (!entry) invalid("参考视频不属于当前作品或已经删除");
    if (entry.kind !== "video" || entry.mimeType !== "video/mp4") invalid("参考视频需要 MP4 格式的视频素材");
    if (!entry.sourceUrl) invalid("该视频只有本地文件，当前接口需要可访问的远程链接；请选用作品中已生成的视频");
    const url = new URL(entry.sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) invalid("参考视频需要不含账号密码的 HTTPS 素材链接");
    const { path } = await assets.pathFor(project.workId, id);
    const size = (await stat(path)).size;
    if (!size || size > 50 * 1024 * 1024) invalid("参考视频为空或超过 50 MB，请缩小后重新导入");
    const header = Buffer.alloc(12);
    const file = await open(path, "r");
    try { await file.read(header, 0, 12, 0); } finally { await file.close(); }
    if (header.toString("ascii", 4, 8) !== "ftyp") invalid("参考视频文件与 MP4 格式不符");
    let info: Awaited<ReturnType<ProbeReferenceVideo>>;
    try { info = await (probe ? probe(path) : probeMedia(await discoverMediaExecutable("ffprobe"), path)); }
    catch { return invalid("参考视频无法读取，请确认视频完整且已安装 FFmpeg 后重试"); }
    if (!info.video || !Number.isFinite(info.durationSec) || info.durationSec < 2 || info.durationSec > 15) invalid("每段参考视频需要包含画面，时长为 2–15 秒");
    totalDuration += info.durationSec;
    if (totalDuration > 15) invalid("参考视频总时长不能超过 15 秒");
    references.push({ url: entry.sourceUrl });
  }
  return references;
}
