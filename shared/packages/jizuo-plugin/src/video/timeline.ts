import { rippleTextOverlays } from "../../../contracts/src/video-text-ripple.ts";
import { splitSubtitleText } from "../../../contracts/src/video-text-segmentation.ts";
import { randomUUID } from "node:crypto";
import { VideoClip, type VideoEpisode, type VideoProject } from "@jizuo/contracts";
import { TimelineEdit, timelineLayout, placeClipsOnMainTrack, reconcileVideoTransitions } from "../../../contracts/src/video-editing.ts";
export { timelineLayout } from "../../../contracts/src/video-editing.ts";

export function buildRoughCut(project: VideoProject, episodeId: string): VideoClip[] {
  const episode = project.episodes.find((item) => item.id === episodeId);
  if (!episode) throw new Error("视频集不存在");
  const timeline = episode.shots.filter((shot) => !shot.archived && shot.videoAssetId).map((shot) => {
    const asset = project.assets.find((item) => item.id === shot.videoAssetId);
    if (!asset || asset.deletedAt || asset.kind !== "video") throw new Error(`镜头 ${shot.title} 的选中视频素材不存在`);
    const previous = episode.timeline.find((clip) => clip.track !== "audio" && clip.shotId === shot.id && clip.assetId === asset.id);
    return VideoClip.parse({ id: previous?.id ?? randomUUID(), shotId: shot.id, assetId: asset.id, inSec: 0,
      outSec: Math.min(shot.durationSec, asset.durationSec ?? shot.durationSec), volume: 1, subtitle: shot.dialogue, track: "video" });
  });
  validateTimeline({ ...project, episodes: project.episodes.map((item) => item.id === episodeId ? { ...item, timeline } : item) }, episodeId);
  return timeline;
}

/** Edits never mutate snapshots; the caller validates asset references before persisting. */
export function applyTimelineEdit(episode: VideoEpisode, input: TimelineEdit): VideoClip[] {
  const edit = TimelineEdit.parse(input);
  if (edit.op === "addVideoTrack" || edit.op === "removeVideoTrack" || edit.op === "pasteTexts" || edit.op === "removeTextTrack" || edit.op === "addTextTrack" || edit.op === "moveTextsToTrack" || edit.op === "saveText" || edit.op === "removeText" || edit.op === "splitText" || edit.op === "applyTextFont" || edit.op === "batchText") throw new Error("文本编辑须通过文本轨道处理");
  let clips = episode.timeline.map((clip) => ({ ...clip }));
  if (edit.op === "moveVideoClips") {
    if (edit.layer > (episode.videoTrackCount ?? 0) || edit.layer < -(episode.videoTrackBelowCount ?? 0)) throw new Error("视频轨道不存在");
    const frames=timelineLayout(clips).clips.filter(item=>edit.clipIds.includes(item.clip.id));
    if (frames.length!==edit.clipIds.length || new Set(edit.clipIds).size!==edit.clipIds.length) throw new Error("选择的画面片段已变化");
    const start=Math.min(...frames.map(item=>item.startSec));
    clips=edit.layer===0 ? placeClipsOnMainTrack(clips,edit.clipIds,edit.startSec) : clips.map(clip=> {
      const frame=frames.find(item=>item.clip.id===clip.id); if (!frame) return clip;
      const placed={...clip,transitionSec:0};
      if (edit.layer) {placed.videoLayer=edit.layer;placed.startSec=edit.startSec+frame.startSec-start;}
      else {delete placed.videoLayer;delete placed.startSec;delete placed.transform;}
      return placed;
    });
  } else if (edit.op === "pasteClips" && edit.clips.some(clip=>clip.videoLayer)) {
    if (edit.clips.some(clip=>!clip.videoLayer || clip.track==="audio")) throw new Error("请分开复制主轨与叠加轨片段");
    if (clips.length+edit.clips.length>2000) throw new Error("最多添加 2000 个片段");
    const start=Math.min(...edit.clips.map(clip=>clip.startSec ?? 0));
    clips.push(...edit.clips.map(clip=>({...clip,id:randomUUID(),startSec:edit.atSec+(clip.startSec ?? 0)-start,excluded:false,transitionSec:0})));
  } else if (edit.op === "pasteClips") {
    if (clips.length + edit.clips.length + 1 > 2000) throw new Error("最多添加 2000 个片段");
    if (edit.clips.some(clip => clip.track === "audio")) throw new Error("请复制画面轨道片段");
    const layout = timelineLayout(clips);
    if (edit.atSec > layout.durationSec + 1e-8) throw new Error("粘贴位置超出成片");
    const frame = [...layout.mainClips].reverse().find(item => item.startSec <= edit.atSec && edit.atSec < item.startSec + item.durationSec);
    let index = clips.length;
    if (frame) {
      const previousFrame = layout.mainClips[layout.mainClips.indexOf(frame) - 1];
      if ((previousFrame?.clip.transitionSec ?? 0) > 0 && edit.atSec - frame.startSec < 2 * (previousFrame!.clip.transitionSec ?? 0)) throw new Error("播放头靠近转场，请移到转场之外再粘贴");
      index = clips.findIndex(clip => clip.id === frame.clip.id);
      const source = frame.clip.inSec + edit.atSec - frame.startSec;
      if (source > frame.clip.inSec + 1e-8) {
        clips.splice(index, 1, {...frame.clip, outSec:source, transitionSec:0}, {...frame.clip, id:randomUUID(), inSec:source, transitionSec:0});
        index++;
      }
    }
    const added = edit.clips.map(clip => ({...clip, id:randomUUID(), excluded:false, transitionSec:0}));
    clips.splice(index, 0, ...added);
  } else if (edit.op === "batchClips") {
    const ids = new Set(edit.clipIds);
    if (ids.size !== edit.clipIds.length || [...ids].some(id => !clips.some(clip => clip.id === id))) throw new Error("选择的片段已变化，请重新选择");
    clips = clips.map(clip => ids.has(clip.id) ? { ...clip, excluded: !edit.included } : clip);
  } else if (edit.op === "placeVisual") {
    const source = edit.source;
    const placed = source.kind === "clip" ? clips.find(clip => clip.id === source.id && clip.track !== "audio" && clip.excluded)
      : VideoClip.parse({ id: randomUUID(), assetId: source.id, inSec: 0, outSec: source.durationSec, volume: 1, subtitle: "", track: "video" });
    if (!placed) throw new Error("待用片段已变化，请刷新后重试");
    clips = clips.filter(clip => clip.id !== placed.id);
    const index = edit.beforeClipId ? clips.findIndex(clip => clip.id === edit.beforeClipId && clip.track !== "audio" && !clip.excluded) : clips.length;
    if (index < 0) throw new Error("插入位置已变化，请重新拖入");
    placed.excluded = false;
    if (edit.videoLayer) { placed.videoLayer=edit.videoLayer; placed.startSec=edit.atSec ?? 0; placed.transitionSec=0; }
    else { delete placed.videoLayer; delete placed.startSec; delete placed.transform; }
    clips.splice(index, 0, placed);
  } else if (edit.op === "reorder") {
    if (edit.clipIds.length !== clips.length || new Set(edit.clipIds).size !== clips.length || edit.clipIds.some((id) => !clips.some((clip) => clip.id === id))) throw new Error("排序必须恰好包含全部片段且不能重复");
    clips = edit.clipIds.map((id) => clips.find((clip) => clip.id === id)!);
  } else if (edit.op === "transitions") {
    const visual = clips.filter(clip => clip.track !== "audio" && !clip.videoLayer && !clip.excluded);
    visual.forEach((clip, index) => {
      const next = visual[index + 1];
      clip.transitionSec = next ? Math.min(edit.transitionSec, (clip.outSec - clip.inSec) / 2, (next.outSec - next.inSec) / 2) : 0;
    });
  } else if (edit.op === "insertVisual") {
    const added = { id: randomUUID(), assetId: edit.assetId, inSec: edit.inSec, outSec: edit.outSec, volume: 1, subtitle: "", track: "video" as const };
    if (edit.afterClipId || edit.beforeClipId) {
      const visual = clips.filter(clip => clip.track !== "audio" && !clip.videoLayer && !clip.excluded);
      const index = visual.findIndex(clip => clip.id === edit.afterClipId);
      if (index < 0 || !edit.beforeClipId || visual[index + 1]?.id !== edit.beforeClipId) throw new Error("衔接位置已变化，请重新选择相邻片段");
      clips.splice(clips.findIndex(clip => clip.id === edit.beforeClipId), 0, added);
    } else clips.push(added);
  } else if (edit.op === "insertAudio") {
    clips.push({ id: randomUUID(), assetId: edit.assetId, inSec: edit.inSec, outSec: edit.outSec, startSec: edit.startSec, volume: edit.volume, subtitle: "", track: "audio" });
  } else {
    const index = clips.findIndex((clip) => clip.id === edit.clipId);
    const clip = clips[index];
    if (!clip) throw new Error("片段不存在");
    switch (edit.op) {
      case "videoPlacement":
        if (clip.track === "audio") throw new Error("音频不能移入视频轨道");
        if (edit.layer > (episode.videoTrackCount ?? 0) || edit.layer < -(episode.videoTrackBelowCount ?? 0)) throw new Error("视频轨道不存在");
        if (edit.layer) { clip.videoLayer=edit.layer; clip.startSec=edit.startSec; clip.transitionSec=0; }
        else { delete clip.videoLayer; delete clip.startSec; delete clip.transform; }
        if (edit.transform && edit.layer) clip.transform=edit.transform;
        break;
      case "trim": if (clip.videoLayer) clip.startSec = Math.max(0,(clip.startSec ?? 0)+edit.inSec-clip.inSec); clip.inSec = edit.inSec; clip.outSec = edit.outSec; break;
      case "volume": clip.volume = edit.volume; break;
      case "subtitle": if (clip.track === "audio") throw new Error("音频片段不支持字幕"); clip.subtitle = edit.subtitle; delete clip.subtitleCues; break;
      case "subtitleCues":
        if (clip.track === "audio") throw new Error("音频片段不支持字幕");
        if (edit.cues.some(cue => cue.startSec < clip.inSec || cue.endSec > clip.outSec)) throw new Error("字幕时间不能超出当前片段范围");
        clip.subtitleCues = edit.cues;
        clip.subtitle = edit.cues.map(cue => cue.text).join("\n");
        break;
      case "transition": if (clip.track === "audio") throw new Error("音频片段不支持画面转场"); clip.transitionSec = edit.transitionSec; break;
      case "moveAudio": if (clip.track !== "audio") throw new Error("只有音频片段支持起点定位"); clip.startSec = edit.startSec; break;
      case "include": clip.excluded = !edit.included; break;
      case "remove": clips.splice(index, 1); break;
      case "split": {
        if (edit.atSec <= clip.inSec || edit.atSec >= clip.outSec) throw new Error("拆分点必须位于片段内部");
        const first = { ...clip, id: randomUUID(), outSec: edit.atSec, transitionSec: 0 };
        const second = { ...clip, id: randomUUID(), inSec: edit.atSec };
        if (clip.track === "audio" || clip.videoLayer) second.startSec = (clip.startSec ?? 0) + edit.atSec - clip.inSec;
        clips.splice(index, 1, first, second); break;
      }
    }
  }
  if (["videoPlacement", "moveVideoClips", "placeVisual", "pasteClips", "batchClips", "include", "reorder", "remove", "insertVisual", "split", "trim"].includes(edit.op)) {
    clips=reconcileVideoTransitions(episode.timeline,clips);
  }
  clips.forEach((clip) => VideoClip.parse(clip));
  timelineLayout(clips);
  return clips;
}

export function validateTimeline(project: VideoProject, episodeId: string): void {
  const episode = project.episodes.find((item) => item.id === episodeId);
  if (!episode) throw new Error("视频集不存在");
  if ((episode.videoTrackCount ?? 0) + (episode.videoTrackBelowCount ?? 0) > 8) throw new Error("最多添加 8 条独立视频轨道");
  const ids = new Set<string>();
  for (const clip of episode.timeline) {
    VideoClip.parse(clip);
    if (ids.has(clip.id)) throw new Error("时间线片段 ID 重复");
    ids.add(clip.id);
    const asset = project.assets.find((item) => item.id === clip.assetId);
    if (!asset) throw new Error("时间线引用了当前作品中不存在的素材");
    if (clip.shotId && !episode.shots.some((shot) => shot.id === clip.shotId)) throw new Error("时间线引用了不存在的镜头");
    if (clip.track === "audio" ? asset.kind !== "audio" : !["image", "video", "export"].includes(asset.kind)) throw new Error("片段轨道和素材类型不匹配");
    if (asset.kind !== "image" && asset.durationSec !== undefined && clip.outSec > asset.durationSec + 0.001) throw new Error("裁剪范围超出素材时长");
    if (clip.videoLayer && (clip.track === "audio" || clip.videoLayer > (episode.videoTrackCount ?? 0) || clip.videoLayer < -(episode.videoTrackBelowCount ?? 0))) throw new Error("视频轨道不存在");
    if (clip.track !== "audio" && !clip.videoLayer && clip.startSec !== undefined) throw new Error("画面片段起点由时间线排序决定");
    if (clip.track === "audio" && (clip.subtitle || clip.subtitleCues?.length || clip.transitionSec)) throw new Error("音频片段不支持字幕和画面转场");
  }
  const { durationSec } = timelineLayout(episode.timeline);
  if (durationSec > 86_400) throw new Error("时间线时长超过 24 小时");
  // Excluding footage must not force destructive edits to the saved music/voice range.
  // The renderer mixes to the active video duration; retain the original assembly budget.
  const audioBudget = episode.timeline.some(clip => clip.track !== "audio" && clip.excluded)
    ? episode.timeline.filter(clip => clip.track !== "audio").reduce((sum, clip) => sum + clip.outSec - clip.inSec, 0)
    : durationSec;
  for (const clip of episode.timeline.filter((item) => item.track === "audio" && !item.excluded)) {
    if ((clip.startSec ?? 0) >= audioBudget || (clip.startSec ?? 0) + clip.outSec - clip.inSec > audioBudget + 0.001) throw new Error("音频范围超出画面时间线，请先裁剪音频");
  }
}

export function applyTextEdit(episode: VideoEpisode, input: TimelineEdit) {
  const edit = TimelineEdit.parse(input);
  const texts = [...(episode.texts ?? [])];
  if ((edit.op === "saveText" || edit.op === "splitText" || edit.op === "applyTextFont") && edit.text.trackId && !episode.textTracks?.some(track => track.id === edit.text.trackId)) throw new Error("文本轨道不存在，请重新选择");
  if ((edit.op === "saveText" || edit.op === "splitText" || edit.op === "applyTextFont") && edit.text.endSec - edit.text.startSec < 0.5 - 1e-8) throw new Error("文本显示时间太短，至少为 0.5 秒");
  if (edit.op === "pasteTexts") {
    if (texts.length + edit.texts.length > 500) throw new Error("最多添加 500 条文本");
    const origin = Math.min(...edit.texts.map(text => text.startSec));
    const duration = timelineLayout(episode.timeline).durationSec;
    const added = edit.texts.map(text => {
      const startSec = edit.atSec + text.startSec - origin;
      const endSec = startSec + text.endSec - text.startSec;
      if (endSec - startSec < 0.5 - 1e-8 || endSec > duration + 1e-8) throw new Error("粘贴文本需至少 0.5 秒且不能超出成片");
      if (text.trackId && !episode.textTracks?.some(track => track.id === text.trackId)) throw new Error("文本轨道已删除，请重新复制");
      return {...text, id:randomUUID(), startSec, endSec};
    });
    return [...texts, ...added];
  }
  if (edit.op === "moveTextsToTrack") {
    const ids = new Set(edit.textIds);
    if (ids.size !== edit.textIds.length || [...ids].some(id => !texts.some(text => text.id === id))) throw new Error("选择的文本已变化，请重新选择");
    const trackId = edit.target.kind === "new" ? edit.target.track.id : edit.target.trackId;
    if (trackId && !episode.textTracks?.some(track => track.id === trackId)) throw new Error("文本轨道已删除，请重新拖动");
    const duration = timelineLayout(episode.timeline).durationSec;
    const updated = texts.map(text => {
      if (!ids.has(text.id)) return text;
      const startSec = text.startSec + edit.deltaSec, endSec = text.endSec + edit.deltaSec;
      if (startSec < 0 || endSec > duration + 1e-8) throw new Error("移动文本不能超出成片范围");
      const placed = { ...text, startSec, endSec };
      if (trackId) placed.trackId = trackId; else delete placed.trackId;
      return placed;
    });
    return rippleTextOverlays(updated, ids, duration);
  }
  if (edit.op === "batchText") {
    const ids = new Set(edit.textIds);
    if (ids.size !== edit.textIds.length || [...ids].some(id => !texts.some(text => text.id === id))) throw new Error("选择的文本已变化，请重新选择");
    if (texts.length > 500) throw new Error("最多添加 500 条文本");
    if (edit.action.kind === "remove") return texts.filter(text => !ids.has(text.id));
    const duration = timelineLayout(episode.timeline).durationSec;
    const updated = texts.map(text => {
      if (!ids.has(text.id)) return text;
      if (edit.action.kind === "font") return { ...text, style: { ...text.style, ...edit.action.style } };
      if (edit.action.kind !== "move") return text;
      const startSec = text.startSec + edit.action.deltaSec, endSec = text.endSec + edit.action.deltaSec;
      if (startSec < 0 || endSec > duration) throw new Error("批量移动不能超出成片范围");
      return { ...text, startSec, endSec };
    });
    return edit.action.kind === "move" && edit.action.deltaSec !== 0 ? rippleTextOverlays(updated, ids, duration) : updated;
  } else if (edit.op === "applyTextFont") {
    if (edit.text.endSec > timelineLayout(episode.timeline).durationSec) throw new Error("文本时间不能超出成片时长");
    if (!texts.some(text => text.id === edit.text.id)) throw new Error("文本不存在");
    if (texts.length > 500) throw new Error("最多添加 500 条文本");
    return texts.map(saved => {
      const text = saved.id === edit.text.id ? edit.text : saved;
      return { ...text, style: { ...text.style, fontFamily: edit.text.style.fontFamily ?? "Arial", fontSize: edit.text.style.fontSize } };
    });
  } else if (edit.op === "splitText") {
    if (edit.text.endSec > timelineLayout(episode.timeline).durationSec) throw new Error("文本时间不能超出成片时长");
    const index = texts.findIndex(text => text.id === edit.text.id);
    if (index < 0) throw new Error("文本不存在");
    const parts = splitSubtitleText(edit.text, randomUUID, edit);
    if (texts.length - 1 + parts.length > 500) throw new Error("最多添加 500 条文本");
    texts.splice(index, 1, ...parts);
  } else if (edit.op === "saveText") {
    if (edit.text.endSec > timelineLayout(episode.timeline).durationSec) throw new Error("文本时间不能超出成片时长");
    const index = texts.findIndex(text => text.id === edit.text.id);
    const previous = texts[index];
    if (index >= 0) texts[index] = edit.text;
    else { if (texts.length >= 500) throw new Error("最多添加 500 条文本"); texts.push(edit.text); }
    if (previous && (previous.startSec !== edit.text.startSec || previous.endSec !== edit.text.endSec)) return rippleTextOverlays(texts, new Set([edit.text.id]), timelineLayout(episode.timeline).durationSec);
  } else if (edit.op === "removeText") {
    const index = texts.findIndex(text => text.id === edit.textId);
    if (index < 0) throw new Error("文本不存在");
    texts.splice(index, 1);
  } else throw new Error("未知文本编辑");
  return texts;
}
