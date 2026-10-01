import { wrapPromptReference } from "./prompt-reference-envelope.ts";
import type { VideoProject } from "@jizuo/contracts";
import { timelineLayout } from "../../../contracts/src/video-editing.ts";
import type { EditingComposerTarget } from "./main-video-composer.ts";

export const EDITING_CHAT_SOURCE = "剪辑上下文";
export type EditingChatReference = EditingComposerTarget;

export function decodeEditingChatReference(ref: string): EditingChatReference {
  const value = JSON.parse(decodeURIComponent(ref));
  if (!value || value.editing !== true || ![value.workId, value.episodeId].every(item => typeof item === "string" && item.length > 0)
    || value.clipId !== undefined && (typeof value.clipId !== "string" || !value.clipId.length)
    || value.shotId !== undefined || value.designId !== undefined) throw new Error("剪辑引用无效，请在工作区重新选择");
  return { workId: value.workId, episodeId: value.episodeId, editing: true, ...(value.clipId ? { clipId: value.clipId } : {}) };
}

function readEditingReference(project: VideoProject, ref: EditingChatReference) {
  const episode = project.episodes.find(item => item.id === ref.episodeId);
  if (project.workId !== ref.workId || !episode) throw new Error("视频集已不可用，请重新选择剪辑");
  const clip = ref.clipId ? episode.timeline.find(item => item.id === ref.clipId) : undefined;
  if (ref.clipId && !clip) throw new Error("剪辑片段已移除，请在时间线重新选择");
  const layout = timelineLayout(episode.timeline);
  const describeClip = (item: typeof episode.timeline[number]) => {
    const asset = project.assets.find(asset => asset.id === item.assetId);
    const shot = item.shotId ? episode.shots.find(shot => shot.id === item.shotId && !shot.archived) : undefined;
    return { ...item, startSec: item.track === "audio" ? item.startSec ?? 0 : layout.clips.find(entry => entry.clip.id === item.id)?.startSec ?? 0,
      label: asset?.label ?? "素材不可用", asset: asset ? { id: asset.id, kind: asset.kind, label: asset.label, durationSec: asset.durationSec } : null,
      shot: shot ? { id: shot.id, title: shot.title, description: shot.description, dialogue: shot.dialogue, prompt: shot.prompt, videoPrompt: shot.videoPrompt, locked: shot.locked, promptLocked: shot.promptLocked } : null };
  };
  return { episode, clip, durationSec: layout.durationSec, timeline: episode.timeline.map(describeClip), selectedClip: clip ? describeClip(clip) : null };
}

/** Human-readable saved state for a reference tooltip; no tool instructions or internal paths. */
export function editingReferencePreview(project: VideoProject, ref: EditingChatReference): { title: string; prompt: string } {
  const { episode, clip, durationSec, timeline, selectedClip } = readEditingReference(project, ref);
  const selected = selectedClip ? [selectedClip] : timeline;
  return {
    title: clip ? `${selectedClip!.label} · 剪辑片段` : `${episode.title} · 剪辑`,
    prompt: [!clip ? `${episode.title} · ${timeline.length} 个片段 · ${durationSec.toFixed(1)} 秒` : "",
      ...selected.map(item => [
        `${item.track === "audio" ? "音频" : "画面"}：${item.label}${item.excluded ? "（暂不参与成片）" : ""}`,
        `${item.excluded ? "不占用成片时间" : `时间线 ${item.startSec.toFixed(1)}–${(item.startSec + item.outSec - item.inSec).toFixed(1)} 秒`}；素材 ${item.inSec.toFixed(1)}–${item.outSec.toFixed(1)} 秒`,
        `音量 ${Math.round(item.volume * 100)}%${item.transitionSec ? `；转场 ${item.transitionSec} 秒` : ""}`,
        item.subtitle ? `字幕：${item.subtitle}` : "",
        item.shot ? `镜头：${item.shot.title}` : "",
      ].filter(Boolean).join("\n")), !timeline.length ? "时间线尚无片段。" : ""].filter(Boolean).join("\n\n"),
  };
}

export function serializeEditingChatReference(project: VideoProject, ref: EditingChatReference): string {
  const { episode, durationSec, timeline, selectedClip } = readEditingReference(project, ref);
  const content = JSON.stringify({ visualStyle: project.visualStyle, target: { workId: project.workId, episodeId: episode.id, ...(ref.clipId ? { clipId: ref.clipId } : {}), revision: project.revision },
    title: episode.title, aspectRatio: episode.aspectRatio, durationSec, selectedClip, timeline });
  if (content.length > 250_000) throw new Error("剪辑上下文过长，请选择具体片段后重试");
  return wrapPromptReference(EDITING_CHAT_SOURCE, editingReferencePreview(project, ref).title, content);
}
