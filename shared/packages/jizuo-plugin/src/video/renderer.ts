import { prepareVideoFonts } from "./fonts.ts";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { VideoProject } from "@jizuo/contracts";
import { videoOutputDimensions } from "../../../contracts/src/video-editing.ts";
import { discoverMediaExecutable, probeMedia, runMediaProcess, throwIfAborted } from "./ffmpeg.ts";
import { timelineLayout, validateTimeline } from "./timeline.ts";
import { subtitleDocuments } from "./subtitles.ts";

function dimensions(width: number, height: number): void {
  if (![width, height].every((value) => Number.isInteger(value) && value >= 16 && value <= 4096 && value % 2 === 0)) throw new Error("输出尺寸必须为 16 至 4096 的偶数像素");
}
const fit = (width: number, height: number, transparent = false) => `scale=${width}:${height}:force_original_aspect_ratio=decrease,${transparent ? "format=rgba," : ""}pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${transparent ? "black@0" : "black"},setsar=1`;

export async function normalizeImageReference(path: string, width: number, height: number, signal?: AbortSignal): Promise<Uint8Array> {
  dimensions(width, height);
  throwIfAborted(signal);
  const binary = await discoverMediaExecutable("ffmpeg");
  const temp = await mkdtemp(join(tmpdir(), "jizuo-reference-"));
  try {
    const output = join(temp, "reference.png");
    await runMediaProcess(binary, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", resolve(path), "-vf", fit(width, height), "-frames:v", "1", "-threads", "1", output], { signal });
    throwIfAborted(signal);
    return await readFile(output);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export type RenderVideoInput = {
  project: VideoProject; episodeId: string; outputPath: string;
  resolveAsset: (assetId: string) => Promise<string>;
  signal?: AbortSignal; onProgress?: (progress: number) => void;
  width?: number; height?: number;
};
export type RenderVideoResult = { durationSec: number; subtitleMode: "burned" | "embedded" | "none" };

export async function renderVideo(input: RenderVideoInput): Promise<RenderVideoResult> {
  const { project, episodeId, signal } = input;
  const defaults = videoOutputDimensions(project.episodes.find((item) => item.id === episodeId)?.aspectRatio ?? "9:16");
  const width = input.width ?? defaults.width, height = input.height ?? defaults.height;
  dimensions(width, height);
  throwIfAborted(signal);
  validateTimeline(project, episodeId);
  const episode = project.episodes.find((item) => item.id === episodeId)!;
  const layout = timelineLayout(episode.timeline);
  if (layout.clips.length === 0) throw new Error("时间线没有画面片段，请先生成粗剪");
  const [ffmpeg, ffprobe] = await Promise.all([discoverMediaExecutable("ffmpeg", { requireAss: Boolean(episode.texts?.length), signal }), discoverMediaExecutable("ffprobe")]);
  const outputPath = resolve(input.outputPath);
  const temp = await mkdtemp(join(dirname(outputPath), ".jizuo-render-"));
  try {
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-filter_complex_threads", "1"];
    const graph: string[] = [];
    const audioClips = episode.timeline.filter((clip) => clip.track === "audio" && !clip.excluded);
    const ordered = [...layout.clips.map(({ clip }) => clip), ...audioClips];
    for (let index = 0; index < ordered.length; index++) {
      throwIfAborted(signal);
      const clip = ordered[index]!;
      const asset = project.assets.find((item) => item.id === clip.assetId)!;
      const path = resolve(await input.resolveAsset(asset.id));
      const media = await probeMedia(ffprobe, path, signal);
      const duration = clip.outSec - clip.inSec;
      if (asset.kind !== "image" && (!Number.isFinite(media.durationSec) || clip.outSec > media.durationSec + 0.06)) throw new Error(`片段 ${clip.id} 的裁剪范围超过实际素材时长`);
      if (clip.track === "audio" ? !media.audio : !media.video) throw new Error(`素材 ${asset.label} 缺少所需的${clip.track === "audio" ? "音频" : "画面"}流`);
      if (asset.kind === "image") args.push("-loop", "1", "-framerate", "30");
      args.push("-i", path);
      if (clip.track !== "audio") {
        const trim = asset.kind === "image" ? `trim=duration=${duration}` : `trim=start=${clip.inSec}:end=${clip.outSec}`;
        graph.push(`[${index}:v]${trim},setpts=PTS-STARTPTS,${fit(width, height, Boolean(clip.videoLayer))},fps=30,format=${clip.videoLayer ? "yuva420p" : "yuv420p"},settb=AVTB[v${index}]`);
      }
      if (media.audio) graph.push(`[${index}:a]atrim=start=${clip.inSec}:end=${clip.outSec},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${clip.volume},apad,atrim=duration=${duration}[a${index}]`);
      else graph.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[a${index}]`);
    }
    const base=layout.mainClips;
    let video = "v0", audio = "a0", runningDuration = base[0]?.durationSec ?? 0;
    if (!base.length) {
      graph.push(`color=c=black:s=${width}x${height}:r=30:d=${layout.durationSec},settb=AVTB[basev]`);
      graph.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${layout.durationSec}[basea]`);
      video="basev"; audio="basea";
    }
    for (let index = 1; index < base.length; index++) {
      const transition = base[index - 1]!.transitionSec;
      const nextVideo = `joinedv${index}`, nextAudio = `joineda${index}`;
      if (transition > 0) {
        graph.push(`[${video}][v${index}]xfade=transition=fade:duration=${transition}:offset=${runningDuration - transition}[${nextVideo}]`);
        graph.push(`[${audio}][a${index}]acrossfade=d=${transition}:c1=tri:c2=tri[${nextAudio}]`);
      } else {
        graph.push(`[${video}][v${index}]concat=n=2:v=1:a=0,settb=AVTB[${nextVideo}]`);
        graph.push(`[${audio}][a${index}]concat=n=2:v=0:a=1[${nextAudio}]`);
      }
      video = nextVideo; audio = nextAudio;
      runningDuration += base[index]!.durationSec - transition;
    }
    const hasUnderlays = layout.overlays.some(item => item.clip.videoLayer! < 0);
    if (base.length && runningDuration < layout.durationSec) {
      if (!hasUnderlays) {
        graph.push(`[${video}]tpad=stop_mode=add:stop_duration=${layout.durationSec-runningDuration}:color=black[paddedv]`);
        video="paddedv";
      }
      graph.push(`[${audio}]apad,atrim=duration=${layout.durationSec}[paddeda]`);
      audio="paddeda";
    }
    const mix = [`[${audio}]`];
    const mainVideo = video;
    let mainComposed = false;
    if (hasUnderlays && base.length) {
      graph.push(`color=c=black:s=${width}x${height}:r=30:d=${layout.durationSec},settb=AVTB[underlaybase]`);
      video="underlaybase";
    }
    const composeMain = () => {
      if (!hasUnderlays || !base.length || mainComposed) return;
      graph.push(`[${video}][${mainVideo}]overlay=eof_action=pass:repeatlast=0:enable='lt(t,${runningDuration})'[maincomposed]`);
      video="maincomposed"; mainComposed=true;
    };
    layout.overlays.forEach((item, offset) => {
      const index=base.length+offset, {clip,startSec,durationSec}=item;
      if (clip.videoLayer! > 0) composeMain();
      const transform=clip.transform ?? {scale:100,x:50,y:50};
      const w=Math.max(2,Math.round(width*transform.scale/200)*2), h=Math.max(2,Math.round(height*transform.scale/200)*2);
      const x=Math.round(width*transform.x/100-w/2), y=Math.round(height*transform.y/100-h/2);
      graph.push(`[v${index}]scale=${w}:${h},setpts=PTS-STARTPTS+${startSec}/TB[overlay${index}]`);
      graph.push(`[${video}][overlay${index}]overlay=x=${x}:y=${y}:eof_action=pass:repeatlast=0:enable='gte(t,${startSec})*lt(t,${startSec+durationSec})'[composed${index}]`);
      video=`composed${index}`;
      graph.push(`[a${index}]adelay=${Math.round(startSec*1000)}:all=1[overlaya${index}]`);
      mix.push(`[overlaya${index}]`);
    });
    composeMain();
    audioClips.forEach((clip,index) => {
      const label=`music${index}`;
      graph.push(`[a${index+layout.clips.length}]adelay=${Math.round((clip.startSec ?? 0)*1000)}:all=1[${label}]`);
      mix.push(`[${label}]`);
    });
    if (mix.length>1) {
      graph.push(`${mix.join("")}amix=inputs=${mix.length}:duration=first:normalize=0,alimiter=limit=0.95:level=0:latency=1[mixed]`);
      audio="mixed";
    }
    const subtitles = subtitleDocuments(layout.clips, width, height, episode.texts, episode.textTracks);
    let subtitleMode: RenderVideoResult["subtitleMode"] = "none";
    if (subtitles.hasSubtitles) {
      const filters = await runMediaProcess(ffmpeg, ["-hide_banner", "-filters"], { signal });
      if (/\bass\s+V->V/.test(filters)) {
        await prepareVideoFonts(temp, (episode.texts ?? []).map(text => text.style.fontFamily ?? "Arial"));
        await writeFile(join(temp, "subtitles.ass"), subtitles.ass, "utf8");
        // Fixed basename + private working directory avoids all path/filter injection.
        const hasTextBox = (episode.texts ?? []).some(text => text.style.width !== undefined);
        let subtitleFilter = "ass=filename=subtitles.ass:fontsdir=fonts";
        if (hasTextBox) {
          const options = await runMediaProcess(ffmpeg, ["-hide_banner", "-h", "filter=subtitles"], { signal });
          if (!/\bwrap_unicode\b/.test(options)) throw new Error("当前视频组件不支持文本框自动换行，请更新支持 Unicode 换行的 FFmpeg 后重试导出。");
          // The ASS filter alone does not enable Unicode line breaking for Chinese.
          subtitleFilter = "subtitles=filename=subtitles.ass:fontsdir=fonts:wrap_unicode=1";
        }
        graph.push(`[${video}]${subtitleFilter}[subtitled]`);
        video = "subtitled"; subtitleMode = "burned";
      } else {
        if (subtitles.hasStyledText) throw new Error("当前视频组件不支持文字样式渲染，请使用支持 libass 的 FFmpeg 后重试导出。");
        await writeFile(join(temp, "subtitles.srt"), subtitles.srt, "utf8");
        args.push("-f", "srt", "-i", "subtitles.srt"); subtitleMode = "embedded";
      }
    }
    args.push("-filter_complex", graph.join(";"), "-map", `[${video}]`, "-map", `[${audio}]`);
    if (subtitleMode === "embedded") args.push("-map", `${ordered.length}:s:0`, "-c:s", "mov_text", "-metadata:s:s:0", "language=zho", "-disposition:s:0", "default");
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "192k", "-t", String(layout.durationSec), "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", "output.mp4");
    input.onProgress?.(0);
    let progressBuffer = "";
    await runMediaProcess(ffmpeg, args, { cwd: temp, signal, onOutput: (chunk) => {
      progressBuffer += chunk;
      const lines = progressBuffer.split("\n"); progressBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (match) input.onProgress?.(Math.min(0.99, Number(match[1]) / 1_000_000 / layout.durationSec));
      }
    } });
    throwIfAborted(signal);
    const rendered = await probeMedia(ffprobe, join(temp, "output.mp4"), signal);
    if (!rendered.video || !rendered.audio || Math.abs(rendered.durationSec - layout.durationSec) > 0.15) throw new Error("导出校验失败：音视频流或输出时长不匹配");
    throwIfAborted(signal);
    await rename(join(temp, "output.mp4"), outputPath);
    input.onProgress?.(1);
    return { durationSec: rendered.durationSec, subtitleMode };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
