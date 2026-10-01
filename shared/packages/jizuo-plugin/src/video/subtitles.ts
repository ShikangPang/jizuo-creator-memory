import { textPaintOrder } from "../../../contracts/src/video-text-layers.ts";
import { clipSubtitleCues } from "../../../contracts/src/video-editing.ts";
import { VideoTextFont, type VideoClip, type VideoTextOverlay } from "@jizuo/contracts";

type TimedClip = { clip: VideoClip; startSec: number; durationSec: number };
function timestamp(seconds: number, ass: boolean): string {
  const scale = ass ? 100 : 1000;
  const ticks = Math.round(seconds * scale);
  const hours = Math.floor(ticks / (3600 * scale));
  const minutes = Math.floor(ticks / (60 * scale)) % 60;
  const wholeSeconds = Math.floor(ticks / scale) % 60;
  return `${String(hours).padStart(ass ? 1 : 2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}${ass ? "." : ","}${String(ticks % scale).padStart(ass ? 2 : 3, "0")}`;
}
/** No subtitle text ever appears inside a filter expression or command argument. */
export function subtitleDocuments(clips: TimedClip[], width: number, height: number, texts: VideoTextOverlay[] = [], tracks: Array<{id:string}> = []) {
  const cues = clips.flatMap(({ clip, startSec }) => clipSubtitleCues(clip).map(cue => ({ text: cue.text, startSec: startSec + cue.startSec, durationSec: cue.endSec - cue.startSec }))).sort((a, b) => a.startSec - b.startSec);
  let ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,${Math.round(width / 22)},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,24,24,${Math.round(height * 0.025)},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` + cues.map(({ text: content, startSec, durationSec }) => {
    // Neutralize ASS override syntax, backslash commands and control characters.
    const text = content.replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\r\n?|\n/g, "\\N");
    return `Dialogue: 0,${timestamp(startSec, true)},${timestamp(startSec + durationSec, true)},Default,,0,0,0,,${text}`;
  }).join("\n");
  const srt = cues.map(({ text: content, startSec, durationSec }, index) => `${index + 1}\n${timestamp(startSec, false)} --> ${timestamp(startSec + durationSec, false)}\n${content.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f]/g, " ").split("\n").map(line => line.trim()).filter(Boolean).join("\n").replace(/-->/g, "→").replace(/</g, "＜").replace(/>/g, "＞")}\n`).join("\n");
  const duration = Math.max(0, ...clips.map(clip => clip.startSec + clip.durationSec));
  const visibleTexts = textPaintOrder(texts, tracks).filter(text => text.startSec < duration);
  ass += "\n" + visibleTexts.map((text, index) => {
    const style = text.style;
    const color = style.color.slice(1).match(/../g)!.reverse().join("");
    const boxed = style.width !== undefined;
    const anchor = (style.align === "left" ? 4 : style.align === "right" ? 6 : 5) + (boxed ? 3 : 0);
    const rotation = style.direction === "rotate90" ? -90 : style.direction === "rotate270" ? 90 : 0;
    // ASS wraps within PlayResX minus the dialogue margins, even with an explicit position.
    const margin = Math.max(1, Math.round(width * (100 - (style.width ?? 90)) / 200));
    const overrides = `{\\fn${VideoTextFont.parse(style.fontFamily ?? "Arial")}\\an${anchor}\\pos(${(style.x / 100 * width).toFixed(2)},${(style.y / 100 * height).toFixed(2)})\\fs${(style.fontSize / 100 * height).toFixed(2)}\\c&H${color}&\\b${style.bold ? 1 : 0}\\bord${style.outline ? (height * 0.0015).toFixed(2) : 0}\\shad0\\q1\\frz${rotation}}`;
    const content = text.text.replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\r\n?|\n/g, "\\N");
    return `Dialogue: ${index + 1},${timestamp(text.startSec, true)},${timestamp(Math.min(text.endSec, duration), true)},Default,,${margin},${margin},0,,${overrides}${content}`;
  }).join("\n");
  return { ass, srt, hasSubtitles: cues.length > 0 || visibleTexts.length > 0, hasStyledText: visibleTexts.length > 0 };
}
