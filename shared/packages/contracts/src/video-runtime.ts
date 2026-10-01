import { z } from "zod";

export const VideoRuntimeStatus = z.object({
  platform: z.enum(["darwin", "win32", "linux", "other"]),
  ffmpeg: z.object({ available: z.boolean(), path: z.string().optional() }),
  ffprobe: z.object({ available: z.boolean(), path: z.string().optional() }),
  h264: z.boolean(),
  aac: z.boolean(),
  styledSubtitles: z.boolean(),
  unicodeWrapping: z.boolean(),
});
export type VideoRuntimeStatus = z.infer<typeof VideoRuntimeStatus>;
