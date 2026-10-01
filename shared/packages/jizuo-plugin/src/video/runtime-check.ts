import type { VideoRuntimeStatus } from "@jizuo/contracts";
import { discoverMediaExecutable, runMediaProcess } from "./ffmpeg.ts";

/** Read-only preflight. No downloads, package-manager calls, or media writes. */
export async function checkVideoRuntime(signal?: AbortSignal, dependencies = { discover: discoverMediaExecutable, run: runMediaProcess }): Promise<VideoRuntimeStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const bounded = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const status: VideoRuntimeStatus = {
    platform: process.platform === "darwin" || process.platform === "win32" || process.platform === "linux" ? process.platform : "other",
    ffmpeg: { available: false }, ffprobe: { available: false }, h264: false, aac: false, styledSubtitles: false, unicodeWrapping: false,
  };
  try {
    await Promise.all([
      (async () => {
        try {
          // Match the renderer's preference for the complete subtitle-capable build.
          const path = await dependencies.discover("ffmpeg", { requireAss: true, signal: bounded })
            .catch(() => dependencies.discover("ffmpeg", { signal: bounded }));
          await dependencies.run(path, ["-version"], { signal: bounded });
          status.ffmpeg = { available: true, path };
          const filters = await dependencies.run(path, ["-hide_banner", "-filters"], { signal: bounded });
          const encoders = await dependencies.run(path, ["-hide_banner", "-encoders"], { signal: bounded });
          status.h264 = /\blibx264\b/.test(encoders);
          status.aac = /\baac\b/.test(encoders);
          status.styledSubtitles = /\bass\s+V->V/.test(filters);
          if (status.styledSubtitles) status.unicodeWrapping = /\bwrap_unicode\b/.test(await dependencies.run(path, ["-hide_banner", "-h", "filter=subtitles"], { signal: bounded }));
        } catch { signal?.throwIfAborted(); }
      })(),
      (async () => {
        try {
          const path = await dependencies.discover("ffprobe", { signal: bounded });
          await dependencies.run(path, ["-version"], { signal: bounded });
          status.ffprobe = { available: true, path };
        } catch { signal?.throwIfAborted(); }
      })(),
    ]);
    signal?.throwIfAborted();
    return status;
  } finally { clearTimeout(timeout); }
}
