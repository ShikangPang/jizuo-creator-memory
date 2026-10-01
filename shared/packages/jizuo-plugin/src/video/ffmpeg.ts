import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("视频渲染已取消", "AbortError");
}

export async function discoverMediaExecutable(name: "ffmpeg" | "ffprobe", options: { requireAss?: boolean; signal?: AbortSignal | undefined } = {}): Promise<string> {
  const override = process.env[name === "ffmpeg" ? "JIZUO_FFMPEG_PATH" : "JIZUO_FFPROBE_PATH"] ?? process.env[name.toUpperCase() + "_PATH"];
  const filename = process.platform === "win32" ? name + ".exe" : name;
  const candidates = override ? [override] : [
    ...(name === "ffprobe" && (process.env.JIZUO_FFMPEG_PATH ?? process.env.FFMPEG_PATH) ? [join(dirname((process.env.JIZUO_FFMPEG_PATH ?? process.env.FFMPEG_PATH)!), filename)] : []),
    join(dirname(process.execPath), filename),
    join(dirname(process.execPath), "resources", "bin", filename),
    join(dirname(process.execPath), "..", "Resources", "bin", filename),
    join(dirname(fileURLToPath(import.meta.url)), "bin", filename),
    ...(process.platform === "darwin" ? [join("/opt/homebrew/opt/ffmpeg-full/bin", filename), join("/usr/local/opt/ffmpeg-full/bin", filename)] : []),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((path) => join(path, filename)),
    ...(["darwin", "linux"].includes(process.platform) ? [join("/opt/homebrew/bin", filename), join("/usr/local/bin", filename), join("/usr/bin", filename)] : []),
  ];
  for (const candidate of new Set(candidates)) {
    throwIfAborted(options.signal);
    try {
      await access(candidate, constants.X_OK);
      if (options.requireAss && name === "ffmpeg") {
        const filters = await runMediaProcess(candidate, ["-hide_banner", "-filters"], {signal:options.signal});
        if (!/\bass\s+V->V/.test(filters)) continue;
      }
      return candidate;
    } catch { throwIfAborted(options.signal); /* Try next packaged/PATH location. */ }
  }
  if (options.requireAss) throw new Error("未找到支持文字样式的 FFmpeg（缺少 libass）。请安装 FFmpeg 完整版；macOS 可安装 ffmpeg-full，或通过 JIZUO_FFMPEG_PATH 指定完整版路径。");
  throw new Error(`未找到 ${name}，请安装 FFmpeg（含 ffprobe），或设置 JIZUO_${name.toUpperCase()}_PATH 为可执行文件路径`);
}

/** Spawn only argument arrays. Output is bounded; abort waits for process death before cleanup. */
export function runMediaProcess(binary: string, args: string[], options: { signal?: AbortSignal | undefined; cwd?: string; onOutput?: (chunk: string) => void } = {}): Promise<string> {
  throwIfAborted(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], ...(options.cwd ? { cwd: options.cwd } : {}) });
    let stdout = "", stderr = "", killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 1500); killTimer.unref(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const clean = () => { options.signal?.removeEventListener("abort", abort); if (killTimer) clearTimeout(killTimer); };
    child.stdout.on("data", (data: Buffer) => { const chunk = data.toString(); stdout = (stdout + chunk).slice(-1_000_000); options.onOutput?.(chunk); });
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-12_000); });
    child.once("error", (error) => { clean(); reject(error); });
    child.once("close", (code) => {
      clean();
      if (options.signal?.aborted) reject(new DOMException("视频渲染已取消", "AbortError"));
      else if (code !== 0) reject(new Error(`FFmpeg 执行失败 (${code}): ${stderr}`));
      else resolve(stdout);
    });
  });
}

export async function probeMedia(binary: string, path: string, signal?: AbortSignal) {
  const info = JSON.parse(await runMediaProcess(binary, ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { signal })) as {
    streams?: Array<{ codec_type: string; duration?: string; width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const durationSec = Number(info.format?.duration ?? Math.max(...(info.streams ?? []).map((stream) => Number(stream.duration) || 0)));
  return { durationSec, video: info.streams?.some((stream) => stream.codec_type === "video") ?? false,
    audio: info.streams?.some((stream) => stream.codec_type === "audio") ?? false };
}
