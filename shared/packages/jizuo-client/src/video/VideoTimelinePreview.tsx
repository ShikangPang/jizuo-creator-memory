import { userErrorMessage } from "@jizuo/contracts";
import { VideoToolIcon } from "./VideoToolIcon.tsx";
import { textPaintOrder } from "../../../contracts/src/video-text-layers.ts";
import { MATERIAL_DRAG_TYPE } from "./VideoMaterialLibrary.tsx";
import { VideoCanvasText } from "./VideoCanvasText.tsx";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Dispatch, type SetStateAction, type ReactNode, type CSSProperties, type Ref } from "react";
import type { VideoTextOverlay, VideoAsset, VideoClip, VideoEpisode, VideoProject } from "@jizuo/contracts";
import { timelineLayout, episodeTextOverlays } from "../../../contracts/src/video-editing.ts";
import type { VideoAssetPreviewRemote } from "./assets-remote.ts";
import "./video-editing.css";

export interface VideoTimelinePlayer { pauseAtCurrentPosition(): number; togglePlayback(): void; loopClip(id: string): void; clearLoop(): void }
type MediaHandle = { element: HTMLMediaElement | null; mix: (gain: number, opacity: number) => void };

const mediaSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

export function timelinePreviewFrames(timeline: VideoClip[], time: number) {
  return framesAt(timelineLayout(timeline), time);
}

function framesAt(layout: ReturnType<typeof timelineLayout>, time: number) {
  return layout.clips.filter((item) => time >= item.startSec && time < item.startSec + item.durationSec).map((item) => {
    const index = layout.clips.indexOf(item), previous = layout.clips[index - 1];
    const incoming = item.clip.videoLayer ? 0 : previous?.transitionSec ?? 0;
    const fadeIn = incoming ? Math.min(1, (time - item.startSec) / incoming) : 1;
    const fadeOut = item.transitionSec ? Math.min(1, (item.startSec + item.durationSec - time) / item.transitionSec) : 1;
    return { ...item, sourceSec: item.clip.inSec + time - item.startSec, opacity: fadeIn, gain: Math.min(fadeIn, fadeOut) * item.clip.volume };
  }).sort((a,b) => (a.clip.videoLayer ?? 0) - (b.clip.videoLayer ?? 0));
}

function MediaLayer({ asset, url, clip, sourceSec, active, playing, gain, opacity, context, failed, readyState, register, seekRevision }: {
  asset: VideoAsset; url: string; clip: VideoClip; sourceSec: number; active: boolean; playing: boolean;
  gain: number; opacity: number; context: AudioContext | null; failed: (message: string) => void;
  readyState: (id: string, ready: boolean) => void;
  register: (id: string, handle: MediaHandle | undefined) => void; seekRevision: number;
}) {
  const ref = useRef<HTMLMediaElement | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const audioGain = useRef<GainNode | null>(null);
  const previousCommand = useRef({ active: false, seekRevision: -1, ready: -1 });
  const wantsPlayback = useRef(false);
  wantsPlayback.current = playing && active;
  const [ready, setReady] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!context || !element) return;
    // StrictMode can reconnect effects on the same element; a media source may only be created once.
    let source = mediaSources.get(element);
    if (!source) { source = context.createMediaElementSource(element); mediaSources.set(element, source); }
    const node = context.createGain();
    source.connect(node); node.connect(context.destination); audioGain.current = node;
    return () => { source.disconnect(); node.disconnect(); audioGain.current = null; };
  }, [context]);
  useEffect(() => {
    const element = ref.current;
    register(clip.id, { element, mix: (nextGain, nextOpacity) => {
      const layer = element ?? imageRef.current;
      if (layer) layer.style.opacity = String(nextOpacity);
      if (audioGain.current) audioGain.current.gain.value = nextGain;
      else if (element) element.volume = Math.max(0, Math.min(1, nextGain));
    } });
    return () => { register(clip.id, undefined); wantsPlayback.current = false; readyState(clip.id, false); if (element && !element.paused) element.pause(); };
  }, [clip.id, readyState, register]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (audioGain.current) audioGain.current.gain.value = active ? gain : 0;
    else element.volume = Math.max(0, Math.min(1, active ? gain : 0));
    const command = previousCommand.current;
    const needsSeek = !playing || !command.active || command.seekRevision !== seekRevision || command.ready !== ready;
    previousCommand.current = { active, seekRevision, ready };
    // Native decoding owns continuous playback. Seek only on an explicit seek or clip activation.
    if (active && needsSeek && Math.abs(element.currentTime - sourceSec) > 0.001) {
      try { element.currentTime = sourceSec; } catch { /* Metadata may still be loading. */ }
    }
    if (playing && active && element.paused) void element.play().catch((cause: unknown) => {
      if (!wantsPlayback.current || cause instanceof DOMException && cause.name === "AbortError") return;
      failed("浏览器未能播放素材，请等待加载后再次播放。");
    });
    if ((!playing || !active) && !element.paused) element.pause();
  }, [sourceSec, active, playing, gain, ready, failed, seekRevision]);
  const transform=clip.videoLayer ? clip.transform ?? {scale:100,x:50,y:50} : undefined;
  const style = { ...(transform ? {width:`${transform.scale}%`,height:`${transform.scale}%`,left:`${transform.x}%`,top:`${transform.y}%`,transform:"translate(-50%, -50%)"} : {backgroundColor:"black"}), zIndex:9+(clip.videoLayer ?? 0), opacity, visibility: active ? "visible" as const : "hidden" as const };
  if (asset.kind === "image") return <img ref={imageRef} className="jz-timeline-layer" src={url} alt={asset.label} style={style} onLoad={() => readyState(clip.id, true)} onError={() => failed(`无法加载图片：${asset.label}`)} />;
  const mediaEvents = { onLoadedMetadata: () => setReady(value => value + 1), onCanPlay: () => readyState(clip.id, true), onWaiting: () => readyState(clip.id, false) };
  if (clip.track === "audio") return <audio ref={ref as Ref<HTMLAudioElement>} src={url} crossOrigin="anonymous" preload="auto" {...mediaEvents} onError={() => failed(`无法加载音频：${asset.label}`)} />;
  return <video ref={ref as Ref<HTMLVideoElement>} className="jz-timeline-layer" src={url} crossOrigin="anonymous" playsInline preload="auto" style={style} {...mediaEvents} onError={() => failed(`无法加载视频：${asset.label}`)} />;
}

export function VideoTimelinePreview({ project, episode, remote, onSelectClip, position, onPositionChange, active = true, toolbar, controllerRef, textDraft, onSelectText, onChangeText, textBusy = false, onMaterialDrop }: {
  onSelectText?: ((text: VideoTextOverlay) => void) | undefined; onChangeText?: ((text: VideoTextOverlay) => void) | undefined; textBusy?: boolean;
  textDraft?: VideoTextOverlay | undefined;
  project: VideoProject; episode: VideoEpisode; remote: VideoAssetPreviewRemote; onSelectClip?: (clipId: string | undefined) => void;
  onMaterialDrop?: (payload: string) => void;
  position?: number; onPositionChange?: Dispatch<SetStateAction<number>>; active?: boolean; toolbar?: ReactNode; controllerRef?: Ref<VideoTimelinePlayer>;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [time, setTime] = useState(position ?? 0);
  const clock = useRef(position ?? 0), published = useRef(position ?? 0);
  const notifyPosition = useRef(onPositionChange); notifyPosition.current = onPositionChange;
  const [seekRevision, setSeekRevision] = useState(0);
  const media = useRef(new Map<string, MediaHandle>());
  const register = useCallback((id: string, handle: MediaHandle | undefined) => { if (handle) media.current.set(id, handle); else media.current.delete(id); }, []);
  const publish = useCallback((next: number) => { clock.current = next; published.current = next; setTime(next); notifyPosition.current?.(next); }, []);
  const [playing, setPlaying] = useState(false);
  const [loopId, setLoopId] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<AudioContext | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const readiness = useRef(new Map<string, boolean>());
  const readyState = useCallback((id: string, ready: boolean) => { readiness.current.set(id, ready); }, []);
  const timelineKey = JSON.stringify(episode.timeline);
  const assetKey = [...new Set(episode.timeline.filter(clip => !clip.excluded).map((clip) => clip.assetId))].sort().join("|");
  const layout = useMemo(() => { try { return timelineLayout(episode.timeline); } catch { return null; } }, [timelineKey]);
  const duration = layout?.durationSec ?? 0;
  const loop = layout?.clips.find(item => item.clip.id === loopId);
  const allTexts = useMemo(() => layout ? episodeTextOverlays(episode) : episode.texts ?? [], [layout, episode.timeline, episode.texts]);
  const texts = textDraft ? allTexts.some(text => text.id === textDraft.id) ? allTexts.map(text => text.id === textDraft.id ? textDraft : text) : [...allTexts, textDraft] : allTexts;
  const assets = useMemo(() => new Map(project.assets.map(asset => [asset.id, asset])), [project.assets]);
  const readPosition = useCallback((current: number, delta = 0) => {
    if (!layout) return 0;
    const leader = framesAt(layout, current).find(frame => assets.get(frame.clip.assetId)?.kind !== "image");
    const element = leader && media.current.get(leader.clip.id)?.element;
    if (leader && element) return Math.max(current, Math.min(leader.startSec + leader.durationSec, leader.startSec + element.currentTime - leader.clip.inSec));
    return Math.min(duration, current + delta);
  }, [layout, assets, duration]);
  const pause = useCallback(() => { const next = playing ? readPosition(clock.current) : clock.current; setPlaying(false); publish(next); return next; }, [playing, readPosition, publish]);
  const preparePlayback = useCallback(() => {
    setError(null);
    if (!contextRef.current && typeof AudioContext !== "undefined") { contextRef.current = new AudioContext(); setContext(contextRef.current); }
    void contextRef.current?.resume();
  }, []);
  const togglePlayback = useCallback(() => {
    if (!active || !duration) return;
    if (playing) { pause(); return; }
    if (!Object.keys(urls).length) return;
    preparePlayback();
    const restart = loop && (clock.current < loop.startSec || clock.current >= loop.startSec + loop.durationSec)
      ? loop.startSec : clock.current >= duration ? 0 : undefined;
    if (restart !== undefined) { publish(restart); setSeekRevision(value => value + 1); }
    setPlaying(true);
  }, [active, duration, playing, pause, urls, preparePlayback, loop, publish]);
  useImperativeHandle(controllerRef, () => ({
    pauseAtCurrentPosition: pause, togglePlayback,
    clearLoop: () => setLoopId(undefined),
    loopClip: (id: string) => {
      const item = layout?.clips.find(item => item.clip.id === id);
      if (!item || !active) return;
      preparePlayback(); setLoopId(id); publish(item.startSec); setSeekRevision(value => value + 1); setPlaying(true);
    },
  }), [pause, togglePlayback, layout, active, preparePlayback, publish]);
  useEffect(() => { publish(Math.min(clock.current, duration)); setPlaying(false); }, [timelineKey, duration, publish]);
  useEffect(() => {
    if (position !== undefined && position !== published.current) {
      publish(Math.max(0, Math.min(position, duration))); setSeekRevision(value => value + 1);
    }
  }, [position, duration, publish]);
  useEffect(() => { if (!active) { setPlaying(false); publish(clock.current); } }, [active, publish]);
  useEffect(() => {
    let active = true; setUrls({}); setError(null);
    if (!remote.getVideoAssetUrl) return;
    void Promise.all(assetKey.split("|").filter(Boolean).map(async (assetId) => [assetId, (await remote.getVideoAssetUrl!({ workId: project.workId, assetId })).url] as const))
      .then((entries) => { if (active) setUrls(Object.fromEntries(entries)); }).catch((cause: unknown) => { if (active) setError(userErrorMessage(cause, "时间线素材加载失败", { operation: "VideoTimelinePreview", effect: "read" })); });
    return () => { active = false; };
  }, [assetKey, project.workId, remote]);
  useEffect(() => () => { void contextRef.current?.close(); }, []);
  useEffect(() => {
    if (!playing || !layout) return;
    let frame = 0, previous = performance.now(), lastRender = previous;
    const tick = (now: number) => {
      const delta = Math.min((now - previous) / 1000, 0.1); previous = now;
      const current = clock.current, before = framesAt(layout, current);
      const required = before.map(item => item.clip.id);
      const audio = episode.timeline.filter(clip => clip.track === "audio" && !clip.excluded && current >= (clip.startSec ?? 0) && current < (clip.startSec ?? 0) + clip.outSec - clip.inSec);
      required.push(...audio.map(clip => clip.id));
      if (required.every(id => readiness.current.get(id))) {
        const next = readPosition(current, delta);
        if (loop && next >= loop.startSec + loop.durationSec - 0.001) {
          publish(loop.startSec); setSeekRevision(value => value + 1); lastRender = now;
          frame = requestAnimationFrame(tick); return;
        }
        const after = framesAt(layout, next);
        clock.current = next;
        // Crossfades update only the media layers; editing forms do not render at video frame rate.
        for (const item of after) media.current.get(item.clip.id)?.mix(item.gain, item.opacity);
        const boundary = before.map(item => item.clip.id).join("|") !== after.map(item => item.clip.id).join("|");
        if (boundary || now - lastRender >= 100 - 0.01 || next >= duration) { lastRender = now; publish(next); }
        if (next >= duration) { setPlaying(false); return; }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration, timelineKey, layout, loop, readPosition, publish]);
  const fail = useCallback((message: string) => { setError(message); setPlaying(false); }, []);
  if (!layout) return <p role="alert">时间线包含无效转场，请先修正后预览。</p>;
  const frames = framesAt(layout, Math.min(time, Math.max(0, duration - 0.001)));
  const visible = new Set(frames.map(frame => frame.clip.id));
  const nextClip = layout.clips[layout.clips.findIndex(item => item.clip.id === frames.at(-1)?.clip.id) + 1]?.clip;
  if (nextClip) visible.add(nextClip.id);
  const seek = (next: number) => {
    if (loop && (next < loop.startSec || next >= loop.startSec + loop.durationSec)) setLoopId(undefined);
    publish(Math.max(0, Math.min(duration, next))); setSeekRevision(value => value + 1);
    onSelectClip?.(framesAt(layout, Math.min(next, Math.max(0, duration - 0.001))).at(-1)?.clip.id);
  };
  const [ratioWidth, ratioHeight] = (episode.aspectRatio ?? "9:16").split(":").map(Number);
  return <section onDragOver={event => {
    if (onMaterialDrop && !textBusy && Array.from(event.dataTransfer.types).includes(MATERIAL_DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }
  }} onDrop={event => {
    if (!onMaterialDrop || textBusy || !Array.from(event.dataTransfer.types).includes(MATERIAL_DRAG_TYPE)) return;
    event.preventDefault(); event.stopPropagation(); onMaterialDrop(event.dataTransfer.getData(MATERIAL_DRAG_TYPE));
  }} className="jz-timeline-preview" aria-label="剪辑预览"><div className="jz-player-heading"><small>成片播放器 · {frames.at(-1) ? project.assets.find(asset => asset.id === frames.at(-1)?.clip.assetId)?.label : "等待加入片段"}</small></div>
    {error && <p role="alert">{error}</p>}
    <div className="jz-timeline-stage" style={{ "--jz-preview-ratio": ratioWidth! / ratioHeight! } as CSSProperties}><div className="jz-timeline-screen">{episode.timeline.map((clip) => {
      const asset = assets.get(clip.assetId), url = urls[clip.assetId];
      if (!asset || !url || clip.excluded || clip.track !== "audio" && !visible.has(clip.id)) return null;
      const frame = frames.find((item) => item.clip.id === clip.id), start = clip.startSec ?? 0;
      const audioActive = clip.track === "audio" && time >= start && time < start + clip.outSec - clip.inSec;
      return <MediaLayer key={clip.id} asset={asset} url={url} clip={clip} sourceSec={frame?.sourceSec ?? clip.inSec + Math.max(0, time - start)} active={Boolean(frame) || audioActive} playing={playing}
        gain={frame?.gain ?? clip.volume} opacity={frame?.opacity ?? 0} context={context} failed={fail} readyState={readyState} register={register} seekRevision={seekRevision} />;
    })}{!duration && <span className="jz-player-empty">将镜头加入时间线后，在这里连续预览和剪辑</span>}{textPaintOrder(texts, episode.textTracks).filter(text => time >= text.startSec && time < text.endSec && time < duration).map(text => <VideoCanvasText key={text.id} text={text} selected={textDraft?.id === text.id} disabled={textBusy}
      onSelect={onSelectText ? selected => { pause(); onSelectText(selected); } : undefined} onChange={onChangeText} />)}</div></div>
    <div className="jz-player-transport"><button type="button" disabled={!duration} onClick={() => { seek(pause() - 1 / 30); }} title="后退一帧" aria-label="后退一帧"><VideoToolIcon name="left"/></button><button type="button" disabled={!duration || !Object.keys(urls).length || !active} aria-label={playing ? "暂停预览" : "播放剪辑"} title="空格：播放／暂停" aria-keyshortcuts="Space" onClick={togglePlayback}><VideoToolIcon name={playing ? "pause" : "play"}/></button><button type="button" disabled={!duration} onClick={() => { seek(pause() + 1 / 30); }} title="前进一帧" aria-label="前进一帧"><VideoToolIcon name="right"/></button><output aria-label="播放时间">{time.toFixed(2)} / {duration.toFixed(2)} 秒</output>{loop && <><button type="button" aria-label="退出片段循环" title="退出片段循环" onClick={() => setLoopId(undefined)}><VideoToolIcon name="reset"/></button></>}{toolbar}</div>
    <input aria-label="预览位置" type="range" min={0} max={duration} step={0.001} value={time} onChange={(event) => {
      seek(event.target.valueAsNumber);
    }} />
  </section>;
}
