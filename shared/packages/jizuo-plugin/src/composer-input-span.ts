interface Span { start: number; end: number; draftRev: number }
interface InputSnapshot {
  draft: string;
  draftRev: number;
  occurrences: readonly { offset: number; length: number }[];
}

/** Native edits count each reference chip as one character; draft text uses its label. */
export function composerDetectSpan(snapshot: InputSnapshot, span: Span): Span | undefined {
  if (snapshot.draftRev !== span.draftRev || !Number.isInteger(span.start) || !Number.isInteger(span.end)
    || span.start < 0 || span.end < span.start || span.end > snapshot.draft.length) return undefined;
  const convert = (offset: number) => {
    let removed = 0;
    for (const item of snapshot.occurrences) {
      if (item.offset < offset && offset < item.offset + item.length) return undefined;
      if (item.offset + item.length <= offset) removed += item.length - 1;
    }
    return offset - removed;
  };
  const start = convert(span.start), end = convert(span.end);
  return start === undefined || end === undefined ? undefined : { start, end, draftRev: span.draftRev };
}
