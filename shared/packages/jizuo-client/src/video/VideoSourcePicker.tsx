import { userErrorMessage } from "@jizuo/contracts";
import "./video-source-picker.css";
import { useEffect, useRef, useState } from "react";
import type { ChapterSummary, VideoSourceChapter, WorkSummary } from "@jizuo/contracts";
import type { JizuoContentRemote } from "../content/remote.ts";

const sourceKey = (item: VideoSourceChapter, fallback: string) => JSON.stringify([item.sourceWorkId ?? fallback, item.volumeId, item.chapterId]);

export function VideoSourcePicker({ remote, workId, value, onChange, disabled, onSuggestedTitleChange }: {
  remote: JizuoContentRemote; workId: string; value: VideoSourceChapter[];
  onChange: (chapters: VideoSourceChapter[]) => void; disabled?: boolean;
  onSuggestedTitleChange?: (title: string) => void;
}) {
  const [works, setWorks] = useState<WorkSummary[]>([]);
  const [sourceWorkId, setSourceWorkId] = useState(value[0]?.sourceWorkId ?? "");
  const [groups, setGroups] = useState<Array<{ title: string; chapters: ChapterSummary[] }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const chapterTitles = useRef(new Map<string, string>());
  const loadedSourceWorkId = useRef("");
  useEffect(() => {
    if (loadedSourceWorkId.current === sourceWorkId) for (const group of groups) for (const chapter of group.chapters) {
      chapterTitles.current.set(sourceKey({sourceWorkId, volumeId: chapter.volumeId, chapterId: chapter.id}, workId), chapter.title);
    }
    const first = value[0];
    const firstTitle = first ? chapterTitles.current.get(sourceKey(first, workId)) : undefined;
    const suggestion = firstTitle ? (value.length > 1 ? `${firstTitle}（含${value.length}章）` : firstTitle) : "";
    onSuggestedTitleChange?.(Array.from(suggestion).slice(0, 120).join(""));
  }, [groups, sourceWorkId, value, workId, onSuggestedTitleChange]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => remote.listWorks()).then(items => {
      if (!active) return;
      const novels = items.filter(item => item.projectKind !== "video");
      setWorks(novels);
      setSourceWorkId(current => current || (value.length && novels.some(item => item.id === workId) ? workId : novels[0]?.id ?? ""));
      setLoading(false);
    }).catch((cause: unknown) => { if (active) { setError(userErrorMessage(cause, "小说项目加载失败")); setLoading(false); } });
    return () => { active = false; };
  }, [remote, workId]);
  useEffect(() => {
    let active = true;
    setGroups([]);
    if (!sourceWorkId) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    void remote.listVolumes({ workId: sourceWorkId }).then(async (volumes) => Promise.all(volumes.map(async (volume) => ({
      title: volume.title, chapters: await remote.listChapters({ workId: sourceWorkId, volumeId: volume.id }),
    })))).then((next) => { if (active) { loadedSourceWorkId.current = sourceWorkId; setGroups(next); } }).catch((cause: unknown) => {
      if (active) setError(userErrorMessage(cause, "原著章节加载失败，请重新选择小说项目", { operation: "VideoSourcePicker", effect: "read" }));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [remote, sourceWorkId]);
  return <fieldset className="jz-video-sources" disabled={disabled}><legend>原著章节（{value.length}）</legend>
    <select aria-label="来源小说项目" value={sourceWorkId} onChange={event => setSourceWorkId(event.target.value)}>
      <option value="">选择小说项目</option>
      {sourceWorkId && !works.some(item => item.id === sourceWorkId) && <option value={sourceWorkId}>来源项目不可用，请重新选择</option>}
      {works.map(work => <option key={work.id} value={work.id}>{work.title}</option>)}
    </select>
    {loading && <p role="status">正在加载原著章节…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !error && groups.every((group) => !group.chapters.length) && <p>暂无原著章节，可先手动编写制作稿。</p>}
    <div className="jz-video-source-items">
    <select aria-label="添加原著章节" value="" disabled={disabled || loading || Boolean(error) || !sourceWorkId} onChange={event => {
      const chapter = groups.flatMap(group => group.chapters).find(item => JSON.stringify([item.volumeId, item.id]) === event.target.value);
      if (chapter) {
        const next = { sourceWorkId, volumeId: chapter.volumeId, chapterId: chapter.id, ...(chapter.revisionToken ? { revisionToken: chapter.revisionToken } : {}) };
        if (!value.some(item => sourceKey(item, workId) === sourceKey(next, workId))) onChange([...value, next]);
      }
    }}>
      <option value="">选择章节添加，可多选</option>
      {groups.map((group, index) => <optgroup key={index} label={group.title}>
        {group.chapters.map(chapter => <option key={chapter.id} value={JSON.stringify([chapter.volumeId, chapter.id])} disabled={value.some(item => sourceKey(item, workId) === sourceKey({sourceWorkId, volumeId: chapter.volumeId, chapterId: chapter.id}, workId))}>{chapter.title}</option>)}
      </optgroup>)}
    </select>
    <div className="jz-video-source-tags" aria-label="已选择的原著章节">
      {value.map(item => {
        const origin = item.sourceWorkId ?? workId;
        const chapter = origin === sourceWorkId ? groups.flatMap(group => group.chapters).find(chapter => chapter.volumeId === item.volumeId && chapter.id === item.chapterId) : undefined;
        const title = chapter?.title ?? `章节 ${item.chapterId}`;
        const novel = works.find(work => work.id === origin);
        return <span className="jz-video-source-tag" key={sourceKey(item, workId)} title={`${novel?.title ?? "来源项目不可用"} · ${title}`}>
          <span>{novel?.title ?? "来源项目不可用"} · {title}</span><button type="button" aria-label={`移除原著章节：${title}`} disabled={disabled} onClick={() => onChange(value.filter(selected => sourceKey(selected, workId) !== sourceKey(item, workId)))}>×</button>
        </span>;
      })}
    </div>
    </div>
  </fieldset>;
}
