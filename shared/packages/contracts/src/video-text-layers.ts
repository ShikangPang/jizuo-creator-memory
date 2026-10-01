import type { VideoTextOverlay } from "./video.ts";

/** Paint lower timeline rows first, matching the editor's overlap row packing. */
export function textPaintOrder(texts: VideoTextOverlay[], tracks: Array<{id: string}> = []): VideoTextOverlay[] {
  const rank = (text: VideoTextOverlay) => text.trackId ? Math.max(0, tracks.findIndex(track => track.id === text.trackId) + 1) : 0;
  const rows = new Map<string, number>();
  const ends = new Map<number, number[]>();
  for (const text of [...texts].sort((a,b) => a.startSec - b.startSec || a.id.localeCompare(b.id))) {
    const track = rank(text), occupied = ends.get(track) ?? [];
    let row = occupied.findIndex(end => end <= text.startSec);
    if (row < 0) row = occupied.length;
    occupied[row] = text.endSec;
    ends.set(track, occupied); rows.set(text.id, row);
  }
  return [...texts].sort((a,b) => rank(b) - rank(a) || rows.get(b.id)! - rows.get(a.id)! || b.startSec - a.startSec || b.id.localeCompare(a.id));
}
