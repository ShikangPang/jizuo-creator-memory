import type { VideoTextOverlay } from "./video.ts";

/** Edited blocks keep their requested times; collisions push other blocks forward. */
export function rippleTextOverlays(texts: VideoTextOverlay[], editedIds: ReadonlySet<string>, duration: number): VideoTextOverlay[] {
  const tracks = new Set(texts.map(text => text.trackId));
  if (tracks.size > 1) {
    const updated = new Map<string, VideoTextOverlay>();
    for (const trackId of tracks) for (const text of rippleTextOverlays(texts.filter(text => text.trackId === trackId), editedIds, duration)) updated.set(text.id, text);
    return texts.map(text => updated.get(text.id)!);
  }
  const anchors = texts.filter(text => editedIds.has(text.id)).sort((a, b) => a.startSec - b.startSec);
  const shifted = new Map<string, VideoTextOverlay>();
  let cursor = 0, active = false;
  for (const text of texts.filter(text => !editedIds.has(text.id)).sort((a, b) => a.startSec - b.startSec)) {
    const length = text.endSec - text.startSec;
    let start = active ? Math.max(text.startSec, cursor) : text.startSec;
    for (const anchor of anchors) {
      if (start < anchor.endSec - 1e-8 && start + length > anchor.startSec + 1e-8) {
        start = anchor.endSec; active = true;
      }
    }
    if (start > text.startSec + 1e-8) {
      if (start + length > duration + 1e-8) throw new Error("后方空间不足，顺延会超出成片时长；请减少移动距离或延长成片");
      shifted.set(text.id, { ...text, startSec: start, endSec: start + length });
    }
    if (active) cursor = start + length;
  }
  return texts.map(text => shifted.get(text.id) ?? text);
}
