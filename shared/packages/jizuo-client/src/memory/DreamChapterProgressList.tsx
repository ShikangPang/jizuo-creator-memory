import { ErrorText } from "../ui/ErrorText.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useMemo, useState } from "react";
import type { DreamChapterProgress, DreamChapterState } from "@jizuo/memory-domain";
import { DreamActivityDetails } from "./DreamActivityDetails.tsx";
import { DreamConversationDetails } from "./DreamConversationDetails.tsx";
import type { DreamWorkRemote } from "./dreamRemote.ts";

const PAGE_SIZE = 20;
const LABELS: Record<DreamChapterState, string> = {
  graphed: "已入图", graph_outdated: "已入图 · 正文有更新", pending: "待处理", running: "正在处理",
  partial: "待继续", awaiting_review: "待确认", rejected: "已拒绝", no_facts: "无可提取记忆",
  failed: "失败", empty: "空章节", editing: "编辑中", busy: "对话处理中",
  capacity_exceeded: "模型容量不足", capacity_unknown: "模型容量未知",
};

function chapterResult(chapter: DreamChapterProgress): string {
  if (chapter.state === "graphed") return "整章记忆已入图";
  if (chapter.state === "graph_outdated") return "已入图记忆对应旧正文";
  if (chapter.state === "awaiting_review") return "整章候选已保存，等待作者确认";
  if (chapter.state === "rejected") return "整章候选已拒绝，记录已保留";
  if (chapter.state === "no_facts") return "整章提取已完成，无可提取记忆";
  if ((chapter.state === "partial" || chapter.state === "failed") && chapter.totalChars > 0 && chapter.processedChars >= chapter.totalChars) return "整章结果已保存，等待最终入库";
  if (chapter.state === "running") return "正在整理整章，完成后更新入库结果";
  return `整章正文 ${chapter.totalChars.toLocaleString("zh-CN")} 字符`;
}

export function DreamChapterProgressList({ chapters, getConversations }: { chapters: DreamChapterProgress[]; getConversations?: DreamWorkRemote["getConversations"] }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<DreamChapterState | "all">("all");
  const [page, setPage] = useState(1);
  const filtered = useMemo(() => chapters.filter((chapter) =>
    (state === "all" || chapter.state === state)
    && `${chapter.volumeTitle} ${chapter.chapterTitle}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  ), [chapters, query, state]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  useEffect(() => { setPage(1); }, [query, state]);
  useEffect(() => { setPage((value) => Math.min(value, pages)); }, [pages]);
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return <section className="jz-dream-chapters" aria-label="章节处理明细">
    <header><h3>章节处理明细</h3><span>{filtered.length} 章</span></header>
    <div className="jz-dream-chapter-tools">
      <input aria-label="搜索章节" type="search" placeholder="搜索分卷或章节标题" value={query} onChange={(event) => { setQuery(event.target.value); }} />
      <select aria-label="筛选章节状态" value={state} onChange={(event) => { setState(event.target.value as DreamChapterState | "all"); }}>
        <option value="all">全部状态</option>
        {Object.entries(LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>
    {rows.length === 0 ? <p className="jz-dream-empty">没有符合条件的章节。</p> : <ol>
      {rows.map((chapter) => {
        const ratio = chapter.totalChars > 0 ? Math.min(100, Math.round(chapter.processedChars / chapter.totalChars * 100)) : 0;
        return <li key={chapter.chapterId}>
          <div><small>{chapter.volumeTitle} · 第 {chapter.chapterNumber} 章</small><strong>{chapter.chapterTitle}</strong>
            {chapter.waitingReason && <small className="jz-dream-chapter-wait">{chapter.waitingReason}</small>}
          </div>
          <div className="jz-dream-chapter-state"><span data-state={chapter.state}>{LABELS[chapter.state]}</span>
            {chapter.processingMode === "chapter" ? <small>{chapterResult(chapter)}</small> : (chapter.totalParts > 0 || chapter.processedChars > 0) && <small>历史分段 · 已保存 {chapter.completedParts}/{chapter.totalParts} 段 · {ratio}%</small>}
            {chapter.state === "capacity_exceeded" && <small>已跳过本章。请选择容量更大的梦境模型并保存，再点击立即整理。</small>}
            {chapter.state === "capacity_unknown" && <small>已跳过本章。请选择容量已知的梦境模型并保存，再点击立即整理。</small>}
            {chapter.updatedAt && <small>{new Date(chapter.updatedAt).toLocaleString()}</small>}
            {chapter.lastError && <small role="alert">{<ErrorText error={chapter.lastError} operation="DreamChapterProgressList" />}</small>}
            {chapter.state === "failed" && chapter.nextRetryAt && <small>下次重试：{new Date(chapter.nextRetryAt).toLocaleString()}，也可点击立即整理重试。</small>}
            {chapter.modelSegments && chapter.modelSegments.length > 0 && <details className="jz-dream-model-history"><summary>{chapter.processingMode === "chapter" ? "整章模型来源" : "历史分段模型来源"}</summary><ol>{chapter.modelSegments.map((segment, index) => <li key={`${segment.from}:${segment.to}:${index}`}><span>{chapter.processingMode === "chapter" ? "整章" : `${segment.from}–${segment.to}`}</span><strong>{segment.modelSelection ? `${segment.modelSelection.provider} / ${segment.modelSelection.model}` : "历史进度未记录模型"}</strong>{segment.completedAt && <small>{new Date(segment.completedAt).toLocaleString()}</small>}</li>)}</ol></details>}
          </div>
          {chapter.state === "running" && chapter.activity && <DreamActivityDetails activity={chapter.activity} totalParts={chapter.totalParts} />}
          {getConversations && <DreamConversationDetails load={getConversations} volumeId={chapter.volumeId} chapterId={chapter.chapterId} running={chapter.state === "running"} />}
        </li>;
      })}
    </ol>}
    {pages > 1 && <nav aria-label="章节分页">
      <IconButton icon="left" label={"上一页"} type="button" disabled={page === 1} onClick={() => { setPage((value) => value - 1); }} />
      <span>{page} / {pages}</span>
      <IconButton icon="right" label={"下一页"} type="button" disabled={page === pages} onClick={() => { setPage((value) => value + 1); }} />
    </nav>}
  </section>;
}
