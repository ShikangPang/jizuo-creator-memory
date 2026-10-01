import { useEffect, useState } from "react";
import { bundledVideoFonts } from "../../../contracts/src/video-fonts/index.ts";
const loaded = new Map<string, Promise<void>>();
export function loadVideoFont(family: string): Promise<void> {
  const font = bundledVideoFonts.find(font => font.family === family);
  if (!font) return Promise.resolve();
  const existing = loaded.get(family);
  if (existing) return existing;
  const promise = (async () => {
    const bytes = Uint8Array.from(atob(font.gzipBase64), char => char.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const face = new FontFace(family, await new Response(stream).arrayBuffer());
    await face.load(); document.fonts.add(face);
  })();
  loaded.set(family, promise);
  void promise.catch(() => loaded.delete(family));
  return promise;
}
export function useVideoFont(family = "Arial") {
  const [state, setState] = useState("");
  useEffect(() => {
    let active = true;
    if (!bundledVideoFonts.some(font => font.family === family)) { setState(""); return; }
    setState("字体加载中…");
    void loadVideoFont(family).then(() => { if (active) setState(""); }, () => { if (active) setState("字体加载失败，请重新选择后重试。"); });
    return () => { active = false; };
  }, [family]);
  return state;
}
