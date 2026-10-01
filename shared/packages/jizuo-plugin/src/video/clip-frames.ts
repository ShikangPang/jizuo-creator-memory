import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverMediaExecutable, runMediaProcess, throwIfAborted } from "./ffmpeg.ts";

/** Decode within the saved trim range; the last frame is before the exclusive out point. */
export async function extractClipFrames(path: string, inSec: number, outSec: number, image = false, signal?: AbortSignal) {
  const temp = await mkdtemp(join(tmpdir(), "jizuo-clip-frames-"));
  try {
    const ffmpeg = await discoverMediaExecutable("ffmpeg");
    const frame = async (last: boolean) => {
      const output = join(temp, last ? "last.jpg" : "first.jpg");
      // Decode the final second to its last frame, avoiding a full-clip reverse buffer.
      const start = last ? Math.max(inSec, outSec - 1) : inSec;
      const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        ...(!image ? ["-ss", String(start)] : []), "-i", path,
        ...(!image ? ["-t", String(outSec - start)] : []),
        "-an", "-vf", "scale=960:960:force_original_aspect_ratio=decrease", "-q:v", "2", "-threads", "1",
        ...(last && !image ? ["-update", "1"] : ["-frames:v", "1"]), output];
      await runMediaProcess(ffmpeg, args, { signal });
      throwIfAborted(signal);
      const bytes = await readFile(output);
      return `data:image/jpeg;base64,${bytes.toString("base64")}`;
    };
    const first = await frame(false);
    const last = image ? first : await frame(true);
    return { first, last };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
