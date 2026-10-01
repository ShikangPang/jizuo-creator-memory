import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useState } from "react";
import type { MemorySuggestionDetail } from "@jizuo/memory-domain";

const KIND_LABELS: Record<string, string> = { character: "人物", rule: "规则", organization: "组织", worldbuilding: "世界设定", clue: "线索", location: "地点", object: "事物", event: "事件", style: "文风" };

export function DreamSuggestionDetails({ load, onSourceState }: {
  load(): Promise<MemorySuggestionDetail>;
  onSourceState?(state: MemorySuggestionDetail["sourceState"]): void;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<MemorySuggestionDetail>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const expand = () => {
    const next = !open; setOpen(next);
    if (!next || detail || loading) return;
    setLoading(true); setError(undefined);
    load().then((value) => { setDetail(value); onSourceState?.(value.sourceState); }, (reason: unknown) => {
      setError(userErrorMessage(reason, "候选详情加载失败", { operation: "DreamSuggestionDetails", effect: "read" }));
    }).finally(() => { setLoading(false); });
  };
  const identityNames = new Map(detail?.candidate.identities.map((item) => [item.id, item.name]) ?? []);
  const evidence = new Map(detail?.candidate.evidence.map((item) => [item.id, item]) ?? []);
  const evidenceList = (ids: string[]) => ids.map((id) => evidence.get(id)).filter((item) => item !== undefined);
  return <div className="jz-dream-suggestion-detail">
    <IconButton icon="text" label={(open ? "收起完整候选" : "查看完整候选与原文")} type="button" className="jz-dream-detail-toggle" aria-expanded={open} onClick={expand} />
    {open && <div className="jz-dream-detail-body">
      {loading && <p>正在加载候选详情…</p>}{error && <p role="alert">{error}</p>}
      {detail && <>
        <p className={`jz-dream-source ${detail.sourceState}`}>{detail.sourceState === "current" ? "来源正文为当前版本" : detail.sourceState === "changed" ? "来源正文已改变，不能接受" : "来源章节已删除，不能接受"}{detail.volumeTitle || detail.chapterTitle ? ` · ${[detail.volumeTitle, detail.chapterTitle].filter(Boolean).join(" / ")}` : ""}</p>
        <section><h4>人物与事物</h4>{detail.candidate.identities.length ? <ul>{detail.candidate.identities.map((item) => <li key={item.id}><strong>{item.name}</strong><span>{KIND_LABELS[item.kind] ?? item.kind}</span><p>{item.aliases.length ? `别名：${item.aliases.join("、")}` : "未保存别名"}</p>{evidenceList(item.evidenceIds).map((entry) => <blockquote key={entry.id}>{entry.excerpt}<small>第 {entry.chapterNumber} 章</small></blockquote>)}</li>)}</ul> : <p>原记录未保存人物或事物。</p>}</section>
        <section><h4>状态</h4>{detail.candidate.states.length ? <ul>{detail.candidate.states.map((item) => <li key={item.id}><p><strong>{identityNames.get(item.identityId) ?? item.identityId}</strong> · {item.key}：{item.value}</p>{evidenceList(item.evidenceIds).map((entry) => <blockquote key={entry.id}>{entry.excerpt}<small>第 {entry.chapterNumber} 章</small></blockquote>)}</li>)}</ul> : <p>原记录未保存状态。</p>}</section>
        <section><h4>关系</h4>{detail.candidate.edges.length ? <ul>{detail.candidate.edges.map((item) => <li key={item.id}><p><strong>{identityNames.get(item.from) ?? item.from}</strong> · {item.type} · <strong>{identityNames.get(item.to) ?? item.to}</strong></p>{evidence.get(item.evidenceId) && <blockquote>{evidence.get(item.evidenceId)!.excerpt}<small>第 {evidence.get(item.evidenceId)!.chapterNumber} 章</small></blockquote>}</li>)}</ul> : <p>原记录未保存关系。</p>}</section>
        <section><h4>全部原文证据</h4>{detail.candidate.evidence.length ? <ol>{detail.candidate.evidence.map((entry) => <li key={entry.id}><blockquote>{entry.excerpt}<small>{detail.volumeTitle || detail.chapterTitle ? `${[detail.volumeTitle, detail.chapterTitle].filter(Boolean).join(" / ")} · ` : ""}第 {entry.chapterNumber} 章</small></blockquote></li>)}</ol> : <p>原记录未保存原文证据。</p>}</section>
      </>}
    </div>}
  </div>;
}
