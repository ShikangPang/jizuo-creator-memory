import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChapterSummary, NovelFileFormat, SearchWorkResult, VolumeSummary } from "@jizuo/contracts";
import type { JizuoContentRemote } from "../content/remote.ts";
import { setSelection } from "../content/selection.ts";

export type PickExportFile = (input: { title: string; format: NovelFileFormat }) => Promise<string | null>;
type ChapterGroup = { volume: VolumeSummary; chapters: ChapterSummary[] };
function highlight(text: string, query: string): ReactNode {
  if (!query.trim()) return text;
  const pattern = new RegExp(`(${query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "giu");
  return text.split(pattern).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part);
}

export function WorkToolsDialog({ work, mode, remote, pickExportFile, close }: {
  work: { workId: string; title: string }; mode: "search" | "export";
  remote: JizuoContentRemote; pickExportFile?: PickExportFile; close(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchWorkResult | null>(null);
  const [groups, setGroups] = useState<ChapterGroup[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<NovelFileFormat>("text");
  const [loading, setLoading] = useState(mode === "export");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); searchInput.current?.focus(); return () => element?.close(); }, []);
  useEffect(() => {
    if (mode !== "export") return;
    let active = true;
    remote.listVolumes({ workId: work.workId }).then(async (volumes) => Promise.all(volumes.map(async (volume) => ({
      volume, chapters: await remote.listChapters({ workId: work.workId, volumeId: volume.id }),
    })))).then((next) => {
      if (!active) return;
      setGroups(next); setSelected(new Set(next.flatMap((group) => group.chapters.map((chapter) => chapter.id))));
    }).catch(() => { if (active) setError("章节加载失败，请关闭后重试"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [mode, remote, work.workId]);
  useEffect(() => {
    if (mode !== "search") return;
    let active = true;
    setResult(null); setError(null);
    if (!query.trim()) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      remote.searchWork?.({ workId: work.workId, query: query.trim(), limit: 100 }).then((next) => {
        if (active) setResult(next);
      }).catch(() => { if (active) setError("搜索失败，请重新输入关键词重试"); })
        .finally(() => { if (active) setLoading(false); });
    }, 220);
    return () => { active = false; clearTimeout(timer); };
  }, [mode, query, remote, work.workId]);
  const toggle = (ids: string[], checked: boolean) => setSelected((current) => {
    const next = new Set(current); for (const id of ids) { if (checked) next.add(id); else next.delete(id); } return next;
  });
  const allIds = groups.flatMap((group) => group.chapters.map((chapter) => chapter.id));
  const exportSelected = async () => {
    if (!pickExportFile || !remote.exportWork) { setError("请在桌面应用中选择导出位置"); return; }
    setBusy(true); setError(null); setSuccess(null);
    try {
      const destination = await pickExportFile({ title: work.title, format });
      if (destination === null) return;
      const exported = await remote.exportWork({ workId: work.workId, format, destination, chapterIds: [...selected] });
      setSuccess(`已导出 ${exported.chapterCount} 章至 ${exported.destination}`);
    } catch (cause) { setError(userErrorMessage(cause, "导出失败，请重试", { operation: "WorkToolsDialog" })); }
    finally { setBusy(false); }
  };
  const name = mode === "search" ? "全书搜索" : "导出作品";
  return <dialog ref={dialog} className="jz-session-dialog jz-work-tools-dialog" aria-label={name}
    onCancel={(event) => { event.preventDefault(); if (!busy) close(); }}>
    <header className="jz-session-dialog-header"><div><h3>{name}</h3><p>{work.title}</p></div>
      <IconButton icon="close" label={(`关闭${name}`)} type="button" className="jz-session-close" aria-label={`关闭${name}`} disabled={busy} onClick={close} />
    </header>
    {mode === "search" ? <>
      <input ref={searchInput} className="jz-work-search-input" autoFocus aria-label="搜索全书" placeholder="搜索章节标题或正文…" maxLength={120} value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="jz-work-search-results" aria-live="polite" aria-busy={loading}>
        {loading ? <p className="jz-work-tools-hint">正在搜索…</p> : result ? <>
          <p className="jz-work-tools-hint">{result.items.length ? `${result.truncated ? "前 " : "找到 "}${result.items.length} 个章节` : "没有找到相关内容"}{result.truncated ? " · 请使用更具体的关键词" : ""}</p>
          {result.items.map((hit) => <button type="button" key={hit.chapterId} className="jz-work-search-hit" onClick={() => {
            setSelection({ workId: hit.workId, volumeId: hit.volumeId, chapterId: hit.chapterId, chapterTitle: hit.chapterTitle, overlay: "chapter",
              searchMatch: hit.field === "content" ? { start: hit.matchStart, end: hit.matchEnd, revisionToken: hit.revisionToken, query: query.trim() } : undefined });
            close();
          }}><span>{hit.volumeTitle}</span><strong>{highlight(hit.chapterTitle, query)}</strong><p>{highlight(hit.excerpt, query)}</p></button>)}
        </> : <p className="jz-work-tools-hint">在整部作品已保存的标题和正文中查找。</p>}
      </div>
    </> : <>
      <fieldset className="jz-export-formats" disabled={busy}><legend>文件格式</legend>
        {([["text", "TXT", "纯文本"], ["markdown", "Markdown", "保留标题层级"], ["docx", "Word", "便于排版"]] as const).map(([value, label, description]) =>
          <label key={value} className={format === value ? "selected" : ""}><input type="radio" name="export-format" value={value} checked={format === value} onChange={() => setFormat(value)} /><strong>{label}</strong><span>{description}</span></label>)}
      </fieldset>
      <div className="jz-export-range-heading"><strong>导出范围</strong><span>已选 {selected.size} / {allIds.length} 章</span></div>
      <fieldset className="jz-export-chapters" disabled={busy || loading}><legend className="jz-visually-hidden">选择章节</legend>
        {loading ? <p>正在加载章节…</p> : allIds.length === 0 ? <p>还没有可导出的章节</p> : <>
          <label><input type="checkbox" checked={selected.size === allIds.length} onChange={(event) => toggle(allIds, event.target.checked)} />全部章节</label>
          {groups.filter((group) => group.chapters.length > 0).map(({ volume, chapters }) => <div key={volume.id}>
            <label className="jz-export-volume"><input type="checkbox" checked={chapters.every((chapter) => selected.has(chapter.id))}
              ref={(element) => { if (element) element.indeterminate = chapters.some((chapter) => selected.has(chapter.id)) && !chapters.every((chapter) => selected.has(chapter.id)); }}
              onChange={(event) => toggle(chapters.map((chapter) => chapter.id), event.target.checked)} />{volume.title}</label>
            {chapters.map((chapter) => <label key={chapter.id} className="jz-export-chapter"><input type="checkbox" checked={selected.has(chapter.id)} onChange={(event) => toggle([chapter.id], event.target.checked)} />{chapter.title}</label>)}
          </div>)}
        </>}
      </fieldset>
      <p className="jz-work-tools-hint">按章节顺序导出已保存的正文。</p>
      <div className="jz-create-content-actions"><IconButton icon="close" label={"关闭"} type="button" disabled={busy} onClick={close} /><IconButton icon="export" label={(busy ? "正在导出…" : "选择位置并导出")} type="button" className="jz-create-content-confirm" disabled={loading || busy || selected.size === 0} onClick={() => { void exportSelected(); }} /></div>
    </>}
    {error && <p className="jz-session-dialog-error" role="alert">{error}</p>}
    {success && <p className="jz-work-tools-success" role="status">{success}</p>}
  </dialog>;
}
