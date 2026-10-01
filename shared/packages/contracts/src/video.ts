import { WorkVisualStyle, StyledPromptHistory } from "./visual-style.ts";
import { z } from "zod";
import { StableId, RevisionToken } from "./work.ts";

const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Title = z.string().trim().min(1).max(120);
export const VideoRelativePath = z.string().min(1).max(1024).refine((value) =>
  !/[\\:\u0000-\u001f]/.test(value) && !value.startsWith("/") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
"素材路径必须为作品内的安全相对路径");
export const VideoSourceChapter = z.object({ sourceWorkId: StableId.optional(), volumeId: StableId, chapterId: StableId, revisionToken: RevisionToken.optional() }).strict();
export type VideoSourceChapter = z.infer<typeof VideoSourceChapter>;
export const VideoPromptTurn = z.object({
  id: StableId, createdAt: z.string().datetime(), shotRevision: Revision,
  referenceAssetIds: z.array(StableId).max(14).optional(),
  message: z.string().max(10000), reply: z.string().min(1).max(10000),
  prompt: z.string().min(1).max(32000), basePrompt: z.string().max(50000),
}).strict();
export const VideoShot = z.object({
  id: StableId, title: Title, description: z.string().max(50_000), dialogue: z.string().max(50_000),
  prompt: z.string().max(50_000), durationSec: z.number().positive().max(3600),
  referenceAssetIds: z.array(StableId), locked: z.boolean(), promptLocked: z.boolean(), revision: Revision,
  videoPrompt: z.string().max(32000).optional(),
  promptDiscussion: z.array(VideoPromptTurn).max(100).optional(),
  imageAssetId: StableId.optional(), videoAssetId: StableId.optional(),
  /** Retain historical asset/job references when removing a shot from production. */
  archived: z.boolean().optional(),
}).strict();
export type VideoShot = z.infer<typeof VideoShot>;
export const VideoDesign = z.object({
  deletedAt: z.string().datetime().optional(),
  id: StableId, kind: z.enum(["character", "scene"]), name: Title,
  description: z.string().max(10000), version: Title, locked: z.boolean(),
  referenceAssetIds: z.array(StableId).max(14),
}).strict();
export type VideoDesign = z.infer<typeof VideoDesign>;
export const VideoAssetView = z.enum(["character-sheet", "turnaround", "front", "side", "back", "expression", "outfit", "panorama", "detail"]);
export type VideoAssetView = z.infer<typeof VideoAssetView>;
export const PanoramaMetadata = z.object({ projection: z.literal("equirectangular") }).strict();
export const PanoramaSource = z.object({ assetId: StableId, yaw: z.number().finite().min(-360).max(360), pitch: z.number().finite().min(-90).max(90), hfov: z.number().finite().min(20).max(120) }).strict();
export const VideoAsset = z.object({
  deletedAt: z.string().datetime().optional(),
  id: StableId, kind: z.enum(["image", "video", "audio", "export"]), label: Title,
  sourceUrl: z.string().url().max(8192).refine(value => { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; } }).optional(),
  designId: StableId.optional(), view: VideoAssetView.optional(), panorama: PanoramaMetadata.optional(), panoramaSource: PanoramaSource.optional(),
  path: VideoRelativePath, mimeType: z.string().min(1).max(200),
  episodeId: StableId.optional(), shotId: StableId.optional(), durationSec: z.number().positive().optional(), sourceJobId: StableId.optional(),
}).strict();
export type VideoAsset = z.infer<typeof VideoAsset>;
export const VideoSubtitleCue = z.object({
  startSec: z.number().finite().nonnegative().max(86_400),
  endSec: z.number().finite().positive().max(86_400),
  text: z.string().trim().min(1).max(5000),
}).strict().refine(cue => cue.endSec > cue.startSec, "字幕结束时间必须晚于开始时间");
export type VideoSubtitleCue = z.infer<typeof VideoSubtitleCue>;
export const VideoSubtitleCues = z.array(VideoSubtitleCue).max(500).refine(
  cues => cues.every((cue, index) => index === 0 || cue.startSec >= cues[index - 1]!.endSec),
  "字幕须按时间排序且不能重叠",
);
export const VideoClip = z.object({
  id: StableId, shotId: StableId.optional(), assetId: StableId,
  excluded: z.boolean().optional(),
  /** Positive layers are above the main track; negative layers are below it. */
  videoLayer: z.number().int().min(-8).max(8).refine(layer => layer !== 0).optional(),
  transform: z.object({ scale: z.number().finite().min(5).max(100), x: z.number().finite().min(0).max(100), y: z.number().finite().min(0).max(100) }).strict().optional(),
  inSec: z.number().nonnegative(), outSec: z.number().positive(), volume: z.number().min(0).max(4),
  /** Cue timestamps refer to source media, so trimming and splitting preserve synchronization. */
  subtitleCues: VideoSubtitleCues.optional(),
  subtitle: z.string().max(50_000), transitionSec: z.number().nonnegative().max(60).optional(),
  track: z.enum(["video", "audio"]).optional(), startSec: z.number().nonnegative().optional(),
}).strict().refine((clip) => clip.outSec > clip.inSec, "片段结束时间必须晚于开始时间");
export type VideoClip = z.infer<typeof VideoClip>;
export const VideoEpisodeStatus = z.enum(["draft", "storyboard", "generating", "editing", "complete"]);
export const VideoAspectRatio = z.enum(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);
export type VideoAspectRatio = z.infer<typeof VideoAspectRatio>;
export const VideoTextFont = z.enum(["ZCOOL KuaiLe", "ZCOOL QingKe HuangYou", "Ma Shan Zheng", "Arial", "PingFang SC", "Heiti SC", "Songti SC", "Kaiti SC", "Microsoft YaHei", "SimHei", "SimSun", "KaiTi", "FangSong", "Noto Sans CJK SC", "Noto Serif CJK SC", "Times New Roman", "Courier New"]);
export const videoTextFontLabels: Record<z.infer<typeof VideoTextFont>, string> = {
  "ZCOOL KuaiLe": "站酷快乐体 · 活泼", "ZCOOL QingKe HuangYou": "站酷庆科黄油体 · 标题", "Ma Shan Zheng": "马善政楷书 · 古风",
  Arial: "Arial · 默认", "PingFang SC": "苹方", "Heiti SC": "黑体（Mac）", "Songti SC": "宋体（Mac）", "Kaiti SC": "楷体（Mac）",
  "Microsoft YaHei": "微软雅黑", SimHei: "黑体（Windows）", SimSun: "宋体（Windows）", KaiTi: "楷体（Windows）", FangSong: "仿宋",
  "Noto Sans CJK SC": "思源黑体 Noto", "Noto Serif CJK SC": "思源宋体 Noto", "Times New Roman": "Times New Roman · 衬线", "Courier New": "Courier New · 等宽",
};
export const VideoTextStyle = z.object({
  fontFamily: VideoTextFont.optional(),
  width: z.number().finite().min(5).max(100).optional(),
  direction: z.enum(["horizontal", "rotate90", "rotate270"]).optional(),
  fontSize: z.number().finite().min(1).max(20).default(4),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#ffffff"),
  bold: z.boolean().default(false), outline: z.boolean().default(true),
  x: z.number().finite().min(0).max(100).default(50),
  y: z.number().finite().min(0).max(100).default(90),
  align: z.enum(["left", "center", "right"]).default("center"),
}).strict();
export const VideoTextOverlay = z.object({
  trackId: StableId.optional(),
  id: StableId, text: z.string().trim().min(1).max(50_000),
  startSec: z.number().finite().nonnegative().max(86_400),
  endSec: z.number().finite().positive().max(86_400),
  style: VideoTextStyle,
}).strict().refine(text => text.endSec > text.startSec, "文本结束时间必须晚于开始时间");
export type VideoTextOverlay = z.infer<typeof VideoTextOverlay>;
export const VideoTextTrack = z.object({ id: StableId, name: z.string().trim().min(1).max(40) }).strict();
export type VideoTextTrack = z.infer<typeof VideoTextTrack>;
export const VideoEpisode = z.object({
  id: StableId, title: Title, sourceChapters: z.array(VideoSourceChapter), shots: z.array(VideoShot),
  texts: z.array(VideoTextOverlay).max(500).optional(),
  textTracks: z.array(VideoTextTrack).max(16).optional(),
  videoTrackCount: z.number().int().min(0).max(8).optional(),
  videoTrackBelowCount: z.number().int().min(0).max(8).optional(),
  timeline: z.array(VideoClip), status: VideoEpisodeStatus, script: z.string().max(500_000).default(""),
  aspectRatio: VideoAspectRatio.optional(),
  deletedAt: z.string().datetime().optional(),
}).strict();
export type VideoEpisode = z.infer<typeof VideoEpisode>;
export type VideoJsonValue = string | number | boolean | null | VideoJsonValue[] | { [key: string]: VideoJsonValue };
const JsonValue: z.ZodType<VideoJsonValue> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValue), z.record(z.string(), JsonValue)]));
export const VideoJob = z.object({
  id: StableId, kind: z.enum(["image", "video", "audio", "export", "pipeline"]),
  status: z.enum(["queued", "running", "succeeded", "failed", "uncertain", "cancelled"]),
  episodeId: StableId.optional(), shotId: StableId.optional(), shotRevision: Revision.optional(),
  remoteId: z.string().min(1).max(2048).optional(), snapshot: z.record(z.string(), JsonValue),
  /** Mutable execution progress; generation inputs remain in the frozen snapshot. */
  state: z.record(z.string(), JsonValue).optional(),
  error: z.string().max(10_000).optional(), resultAssetIds: z.array(StableId).optional(),
  attempt: Revision.optional(), createdAt: z.string().datetime().optional(), updatedAt: z.string().datetime().optional(),
}).strict();
export type VideoJob = z.infer<typeof VideoJob>;
export const VideoProject = z.object({
  schemaVersion: z.literal(1), workId: StableId, revision: Revision,
  visualStyle: WorkVisualStyle.optional(),
  stylePromptHistory: z.array(StyledPromptHistory).max(20).optional(),
  designs: z.array(VideoDesign).max(500).optional(),
  episodes: z.array(VideoEpisode), assets: z.array(VideoAsset), jobs: z.array(VideoJob),
}).strict();
export type VideoProject = z.infer<typeof VideoProject>;
export const GetVideoProjectInput = z.object({ workId: StableId }).strict();
export type GetVideoProjectInput = z.infer<typeof GetVideoProjectInput>;
export const CreateVideoEpisodeInput = z.object({ workId: StableId, title: Title, sourceChapters: z.array(VideoSourceChapter), expectedRevision: Revision.optional() }).strict();
export type CreateVideoEpisodeInput = z.infer<typeof CreateVideoEpisodeInput>;
export const UpdateVideoEpisodeInput = z.object({
  workId: StableId, episodeId: StableId, expectedRevision: Revision,
  patch: VideoEpisode.omit({ id: true, deletedAt: true }).extend({ script: z.string().max(500_000) }).partial().strict(),
}).strict();
export type UpdateVideoEpisodeInput = z.infer<typeof UpdateVideoEpisodeInput>;

export const DeleteVideoEpisodeInput = z.object({ workId: StableId, episodeId: StableId, expectedRevision: Revision }).strict();
export type DeleteVideoEpisodeInput = z.infer<typeof DeleteVideoEpisodeInput>;

export const DeleteVideoItemInput = z.object({ workId: StableId, expectedRevision: Revision, kind: z.enum(["asset", "design", "shot"]), id: StableId, detachReferences: z.boolean().optional() }).strict().refine(input => !input.detachReferences || input.kind === "asset", "只有素材支持取消引用并删除");
export type DeleteVideoItemInput = z.infer<typeof DeleteVideoItemInput>;
