import { VideoTextOverlay } from "./video.ts";

/** Script speaker labels occur at the start of a dialogue line, never inside its content. */
function dialogueOnly(text: string): string {
  return text.replace(/^[ \t]*(?:[\p{Script=Han}·]{1,8}|[A-Za-z][A-Za-z .'-]{0,29})[ \t]*[:：](?!\/\/)[ \t]*/gmu, "");
}

/** Remove speaker labels, then prefer punctuation over the length limit. */
export function subtitleSentences(text: string, stripSpeaker = true): string[] {
  const phrases = (stripSpeaker ? dialogueOnly(text) : text).match(/[^，,。！？!?；;\n]+[，,。！？!?；;]*|[，,。！？!?；;]+/gu) ?? [];
  return phrases.flatMap(phrase => {
    const chars = Array.from(phrase.trim());
    const chunks: string[] = [];
    while (chars.length > 26) {
      // Prefer a word boundary for Latin text; Chinese can wrap between characters.
      let end = 26;
      for (let index = 25; index >= 12; index--) if (/\s/u.test(chars[index]!)) { end = index + 1; break; }
      chunks.push(chars.splice(0, end).join("").trim());
    }
    if (chars.length) chunks.push(chars.join(""));
    return chunks;
  }).filter(Boolean);
}

export function splitSubtitleText(input: VideoTextOverlay, makeId: () => string, options?: { stripSpeaker?: boolean | undefined; parts?: string[] | undefined }): VideoTextOverlay[] {
  const text = VideoTextOverlay.parse(input), parts = options?.parts ?? subtitleSentences(text.text, options?.stripSpeaker ?? true);
  if (!parts.length) throw new Error("去掉说话人后没有对白内容");
  if (parts.length < 2 && parts[0] === text.text.trim()) throw new Error("这段文本无需断句");
  const duration = text.endSec - text.startSec;
  if (duration < parts.length * 0.5) throw new Error("显示时间太短，每段文本至少需要 0.5 秒，请先延长文本时间再断句");
  const weights = parts.map(part => Math.max(1, Array.from(part.replace(/[\s\p{P}]/gu, "")).length));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const remaining = duration - parts.length * 0.5;
  let cursor = text.startSec;
  return parts.map((part, index) => {
    const startSec = cursor;
    cursor = index === parts.length - 1 ? text.endSec : cursor + 0.5 + remaining * weights[index]! / total;
    return VideoTextOverlay.parse({ ...text, id: index === 0 ? text.id : makeId(), text: part, startSec, endSec: cursor });
  });
}
