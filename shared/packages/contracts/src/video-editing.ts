import { z } from "zod";
import { StableId } from "./work.ts";
import { VideoAspectRatio, VideoClip, VideoSubtitleCues, VideoTextOverlay, VideoTextStyle, VideoTextTrack, type VideoEpisode, type VideoProject, type VideoShot } from "./video.ts";

const Time = z.number().finite().nonnegative().max(86_400);
export const TimelineEdit = z.discriminatedUnion("op", [
  z.object({op:z.literal("moveVideoClips"), clipIds:z.array(StableId).min(1).max(2000), layer:z.number().int().min(-8).max(8), startSec:Time, newVideoTrack:z.boolean().optional()}).strict(),
  z.object({op:z.literal("addVideoTrack")}).strict(),
  z.object({op:z.literal("removeVideoTrack"), layer:z.number().int().min(-8).max(8).refine(layer => layer !== 0)}).strict(),
  z.object({op:z.literal("videoPlacement"), clipId:StableId, layer:z.number().int().min(-8).max(8), startSec:Time, transform:z.object({scale:z.number().finite().min(5).max(100),x:z.number().finite().min(0).max(100),y:z.number().finite().min(0).max(100)}).strict().optional()}).strict(),
  z.object({ op: z.literal("pasteTexts"), texts: z.array(VideoTextOverlay).min(1).max(500), atSec: Time }).strict(),
  z.object({ op: z.literal("pasteClips"), clips: z.array(VideoClip).min(1).max(2000), atSec: Time }).strict(),
  z.object({ op: z.literal("removeTextTrack"), trackId: StableId }).strict(),
  z.object({ op: z.literal("addTextTrack"), track: VideoTextTrack }).strict(),
  z.object({ op: z.literal("moveTextsToTrack"), textIds: z.array(StableId).min(1).max(500), deltaSec: z.number().finite().min(-86400).max(86400), target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("existing"), trackId: StableId.optional() }).strict(),
    z.object({ kind: z.literal("new"), track: VideoTextTrack, beforeTrackId: StableId.optional() }).strict(),
  ]) }).strict(),
  z.object({ op: z.literal("placeVisual"), source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("asset"), id: StableId, durationSec: Time }).strict(),
    z.object({ kind: z.literal("clip"), id: StableId }).strict(),
  ]), beforeClipId: StableId.optional(), newVideoTrack: z.boolean().optional(), videoLayer:z.number().int().min(-8).max(8).refine(layer => layer !== 0).optional(), atSec:Time.optional() }).strict(),
  z.object({ op: z.literal("batchClips"), clipIds: z.array(StableId).min(1).max(2000), included: z.boolean() }).strict(),
  z.object({ op: z.literal("batchText"), textIds: z.array(StableId).min(1).max(500), action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("remove") }).strict(),
    z.object({ kind: z.literal("move"), deltaSec: z.number().finite().min(-86400).max(86400) }).strict(),
    z.object({ kind: z.literal("font"), style: VideoTextStyle.pick({ fontFamily: true, fontSize: true }) }).strict(),
  ]) }).strict(),
  z.object({ op: z.literal("applyTextFont"), text: VideoTextOverlay }).strict(),
  z.object({ op: z.literal("splitText"), text: VideoTextOverlay, stripSpeaker: z.boolean().optional(), parts: z.array(z.string().trim().min(1).max(50000)).min(1).max(500).optional() }).strict(),
  z.object({ op: z.literal("saveText"), text: VideoTextOverlay }).strict(),
  z.object({ op: z.literal("removeText"), textId: StableId }).strict(),
  z.object({ op: z.literal("subtitleCues"), clipId: StableId, cues: VideoSubtitleCues }).strict(),
  z.object({ op: z.literal("reorder"), clipIds: z.array(StableId).max(2000) }).strict(),
  z.object({ op: z.literal("trim"), clipId: StableId, inSec: Time, outSec: Time }).strict(),
  z.object({ op: z.literal("split"), clipId: StableId, atSec: Time }).strict(),
  z.object({ op: z.literal("volume"), clipId: StableId, volume: z.number().finite().min(0).max(4) }).strict(),
  z.object({ op: z.literal("subtitle"), clipId: StableId, subtitle: z.string().max(50_000) }).strict(),
  z.object({ op: z.literal("transition"), clipId: StableId, transitionSec: Time.max(60) }).strict(),
  z.object({ op: z.literal("transitions"), transitionSec: Time.max(60) }).strict(),
  z.object({ op: z.literal("insertVisual"), assetId: StableId, inSec: Time, outSec: Time, afterClipId: StableId.optional(), beforeClipId: StableId.optional() }).strict(),
  z.object({ op: z.literal("insertAudio"), assetId: StableId, inSec: Time, outSec: Time, startSec: Time, volume: z.number().finite().min(0).max(4).default(1) }).strict(),
  z.object({ op: z.literal("moveAudio"), clipId: StableId, startSec: Time }).strict(),
  z.object({ op: z.literal("include"), clipId: StableId, included: z.boolean() }).strict(),
  z.object({ op: z.literal("remove"), clipId: StableId }).strict(),
]);
export type TimelineEdit = z.infer<typeof TimelineEdit>;

const EpisodeTarget = z.object({
  workId: StableId, episodeId: StableId,
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const RoughCutVideoInput = EpisodeTarget.extend({
  selections: z.array(z.object({ shotId: StableId, assetId: StableId }).strict()).max(2000).optional(),
}).strict();
export type RoughCutVideoInput = z.infer<typeof RoughCutVideoInput>;
export const EditVideoTimelineInput = EpisodeTarget.extend({ edit: TimelineEdit }).strict();
export type EditVideoTimelineInput = z.infer<typeof EditVideoTimelineInput>;
export const VideoTimelineHistoryInput = z.object({ workId: StableId, episodeId: StableId }).strict();
export type VideoTimelineHistoryInput = z.infer<typeof VideoTimelineHistoryInput>;
export const RestoreVideoTimelineInput = EpisodeTarget.extend({ revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
export type RestoreVideoTimelineInput = z.infer<typeof RestoreVideoTimelineInput>;
export const VideoTimelineHistory = z.object({ versions: z.array(z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), clipCount: z.number().int().nonnegative(), durationSec: z.number().finite().nonnegative(),
}).strict()).max(20) }).strict();
export type VideoTimelineHistory = z.infer<typeof VideoTimelineHistory>;
export const CopyVideoExportInput = z.object({ workId: StableId, assetId: StableId, destination: z.string().min(1).max(4096) }).strict();
export type CopyVideoExportInput = z.infer<typeof CopyVideoExportInput>;
export const ExportVideoInput = EpisodeTarget.extend({ aspectRatio: VideoAspectRatio.optional() }).strict();
export type ExportVideoInput = z.infer<typeof ExportVideoInput>;

/** Shared output geometry for previews and frozen render requests. */
export function videoOutputDimensions(aspectRatio: VideoAspectRatio = "9:16"): { width: number; height: number } {
  const sizes: Record<VideoAspectRatio, [number, number]> = {
    "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [720, 720],
    "4:3": [960, 720], "3:4": [720, 960], "21:9": [1680, 720],
  };
  const [width, height] = sizes[aspectRatio]; return { width, height };
}
export const VideoOutputSettings = z.object({
  aspectRatio: VideoAspectRatio, width: z.number().int().min(16).max(4096), height: z.number().int().min(16).max(4096),
}).strict().refine((value) => value.width % 2 === 0 && value.height % 2 === 0, "输出宽高必须为偶数像素");

/** Shared preview/export timing. A transition overlaps this visual clip with the next. */
export function timelineLayout(timeline: VideoClip[]) {
  const visual = timeline.filter((clip) => clip.track !== "audio" && !clip.videoLayer && !clip.excluded);
  let cursor = 0;
  const clips = visual.map((clip, index) => {
    VideoClip.parse(clip);
    const durationSec = clip.outSec - clip.inSec;
    const transitionSec = clip.transitionSec ?? 0;
    const next = visual[index + 1];
    if (transitionSec > 0 && (!next || transitionSec > Math.min(durationSec, next.outSec - next.inSec) / 2)) {
      throw new Error("转场时长不能超过相邻片段较短时长的一半，末尾片段不能设置转场");
    }
    const result = { clip, startSec: cursor, durationSec, transitionSec };
    cursor += durationSec - transitionSec;
    return result;
  });
  const overlays = timeline.filter(clip => clip.track !== "audio" && clip.videoLayer && !clip.excluded).map(clip => {
    VideoClip.parse(clip);
    if (clip.transitionSec) throw new Error("叠加视频轨暂不支持片段转场");
    return {clip,startSec:clip.startSec ?? 0,durationSec:clip.outSec-clip.inSec,transitionSec:0};
  }).sort((a,b)=>(a.clip.videoLayer ?? 0)-(b.clip.videoLayer ?? 0) || a.startSec-b.startSec);
  return { clips:[...clips,...overlays], mainClips:clips, overlays, durationSec:Math.max(cursor,0,...overlays.map(item=>item.startSec+item.durationSec)) };
}

/** Keep a transition only while its original pair of neighbours remains together. */
export function reconcileVideoTransitions(previous:VideoClip[], timeline:VideoClip[]):VideoClip[] {
  const before=previous.filter(clip=>clip.track!=="audio" && !clip.videoLayer && !clip.excluded);
  const neighbours=new Map(before.map((clip,index)=>[clip.id,before[index+1]?.id]));
  const visual=timeline.filter(clip=>clip.track!=="audio" && !clip.videoLayer && !clip.excluded);
  const transitions=new Map(visual.map((clip,index)=>{
    const next=visual[index+1];
    return [clip.id,next && neighbours.get(clip.id)===next.id ? Math.min(clip.transitionSec ?? 0,(clip.outSec-clip.inSec)/2,(next.outSec-next.inSec)/2) : 0];
  }));
  return timeline.map(clip=>clip.transitionSec && transitions.has(clip.id) ? {...clip,transitionSec:transitions.get(clip.id)!} : clip);
}

/** Insert a dragged group into the main sequence; preview and persistence share the same slot. */
export function placeClipsOnMainTrack(timeline:VideoClip[], clipIds:string[], atSec:number):VideoClip[] {
  const selected=new Set(clipIds);
  const rest=timelineLayout(timeline).mainClips.filter(item=>!selected.has(item.clip.id));
  const before=rest.find(item=>atSec<item.startSec+item.durationSec/2);
  const clips=timeline.filter(clip=>!selected.has(clip.id));
  const moved=timeline.filter(clip=>selected.has(clip.id)).map(clip=>{
    const next={...clip,transitionSec:0};delete next.videoLayer;delete next.startSec;delete next.transform;return next;
  });
  const index=before ? clips.findIndex(clip=>clip.id===before.clip.id) : rest.length ? clips.findIndex(clip=>clip.id===rest.at(-1)!.clip.id)+1 : 0;
  clips.splice(index,0,...moved);
  return reconcileVideoTransitions(timeline,clips);
}

export const GetVideoClipFramesInput = EpisodeTarget.extend({ clipId: StableId }).strict();
export type GetVideoClipFramesInput = z.infer<typeof GetVideoClipFramesInput>;
export const VideoClipFrames = z.object({
  clipId: StableId, inSec: Time, outSec: Time,
  first: z.string().startsWith("data:image/jpeg;base64,").max(4_000_000),
  last: z.string().startsWith("data:image/jpeg;base64,").max(4_000_000),
}).strict();
export type VideoClipFrames = z.infer<typeof VideoClipFrames>;

/** Match generated candidates by saved ownership, never by file name or list order. */
export function shotVideoCandidates(project: VideoProject, episodeId: string, shot: VideoShot) {
  const resultIds = new Set(project.jobs.filter(job => job.kind === "video" && job.status === "succeeded" && job.episodeId === episodeId && job.shotId === shot.id).flatMap(job => job.resultAssetIds ?? []));
  return project.assets.filter(asset => !asset.deletedAt && asset.kind === "video" && (
    asset.id === shot.videoAssetId || asset.episodeId === episodeId && asset.shotId === shot.id || resultIds.has(asset.id)
  ));
}

/** Visible cues relative to the trimmed clip; legacy subtitles cover the whole clip. */
export function clipSubtitleCues(clip: VideoClip) {
  if (clip.track === "audio") return [];
  const cues = clip.subtitleCues ?? (clip.subtitle.trim() ? [{ startSec: clip.inSec, endSec: clip.outSec, text: clip.subtitle }] : []);
  return cues.map(cue => ({ ...cue, startSec: Math.max(cue.startSec, clip.inSec) - clip.inSec,
    endSec: Math.min(cue.endSec, clip.outSec) - clip.inSec })).filter(cue => cue.endSec > cue.startSec);
}

/** Read-only projection: old clip subtitles appear on the same editable text track. */
export function legacySubtitleTexts(episode: VideoEpisode) {
  const used = new Set((episode.texts ?? []).map(text => text.id));
  return timelineLayout(episode.timeline).clips.flatMap(({ clip, startSec }) => {
    const clipIndex = episode.timeline.findIndex(item => item.id === clip.id);
    const cues = clip.subtitleCues ?? (clip.subtitle.trim() ? [{ startSec: clip.inSec, endSec: clip.outSec, text: clip.subtitle }] : []);
    return cues.flatMap((cue, cueIndex) => {
      const start = Math.max(clip.inSec, cue.startSec), end = Math.min(clip.outSec, cue.endSec);
      if (end <= start) return [];
      let id = `subtitle_${clipIndex}_${cueIndex}`, suffix = 0;
      while (used.has(id)) id = `subtitle_${clipIndex}_${cueIndex}_${++suffix}`;
      used.add(id);
      return [{ clipId: clip.id, cueIndex, text: { id, text: cue.text,
        startSec: startSec + start - clip.inSec, endSec: startSec + end - clip.inSec,
        style: VideoTextStyle.parse({ y: 94 }),
      } }];
    });
  });
}
export function episodeTextOverlays(episode: VideoEpisode): VideoTextOverlay[] {
  return [...(episode.texts ?? []), ...legacySubtitleTexts(episode).map(item => item.text)];
}
