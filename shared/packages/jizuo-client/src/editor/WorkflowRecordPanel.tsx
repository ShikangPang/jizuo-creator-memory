import { userErrorMessage } from "@jizuo/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ChapterTarget, ChapterWorkflowRecord, ChapterWorkflowRecordSummary } from "@jizuo/contracts";

import type { JizuoContentRemote } from "../content/remote.ts";
import { MarkdownDocument } from "./MarkdownDocument.tsx";

const GROUP_LABELS: Record<string, string> = {
  "memory-context": "查询记忆",
  plan: "章节策划",
  continuity: "连续性审查",
  style: "文风审查",
  "ai-trace": "AI 痕迹审查",
  summary: "最终摘要",
  "memory-extraction": "记忆提取",
};

function groupKey(record: ChapterWorkflowRecordSummary): string {
  return record.kind === "review" ? record.stage! : record.kind;
}

function messageOf(error: unknown): string {
  return userErrorMessage(error, "流程记录读取失败", { operation: "WorkflowRecordPanel", effect: "read" });
}

export function WorkflowRecordPanel({ remote, target, refreshToken }: {
  remote: JizuoContentRemote;
  target: ChapterTarget;
  refreshToken: number;
}) {
  const [records, setRecords] = useState<ChapterWorkflowRecordSummary[]>([]);
  const [selected, setSelected] = useState<ChapterWorkflowRecordSummary | null>(null);
  const [document, setDocument] = useState<ChapterWorkflowRecord | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [recordLoading, setRecordLoading] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const readRequest = useRef(0);
  const targetKey = `${target.workId}:${target.volumeId}:${target.chapterId}`;

  useEffect(() => {
    let active = true;
    setListLoading(true);
    setListError(null);
    void remote.listChapterWorkflowRecords(target).then((items) => {
      if (!active) return;
      setRecords(items);
      setSelected((current) => current === null
        ? null
        : items.find((item) => item.runId === current.runId && item.recordId === current.recordId) ?? null);
    }).catch((error: unknown) => {
      if (active) setListError(messageOf(error));
    }).finally(() => {
      if (active) setListLoading(false);
    });
    return () => { active = false; };
  }, [refreshToken, remote, targetKey]);

  useEffect(() => () => { readRequest.current += 1; }, []);

  const runs = useMemo(() => {
    const grouped = new Map<string, ChapterWorkflowRecordSummary[]>();
    for (const record of records) {
      const existing = grouped.get(record.runId) ?? [];
      existing.push(record);
      grouped.set(record.runId, existing);
    }
    return [...grouped.values()].sort((left, right) => (
      right.reduce((latest, record) => record.updatedAt > latest ? record.updatedAt : latest, "")
        .localeCompare(left.reduce((latest, record) => record.updatedAt > latest ? record.updatedAt : latest, ""))
    ));
  }, [records]);

  const openRecord = async (summary: ChapterWorkflowRecordSummary): Promise<void> => {
    const request = ++readRequest.current;
    setSelected(summary);
    setDocument(null);
    setRecordLoading(true);
    setRecordError(null);
    try {
      const next = await remote.readChapterWorkflowRecord({
        ...target,
        runId: summary.runId,
        recordId: summary.recordId,
      });
      if (readRequest.current === request) setDocument(next);
    } catch (error) {
      if (readRequest.current === request) setRecordError(messageOf(error));
    } finally {
      if (readRequest.current === request) setRecordLoading(false);
    }
  };

  return (
    <section className="jz-workflow-record-panel" aria-label="章节流程记录">
      <nav className="jz-workflow-record-list" aria-label="流程记录列表">
        {listLoading && records.length === 0 && <p role="status">正在读取流程记录列表…</p>}
        {listError !== null && <p role="alert">{listError}</p>}
        {!listLoading && listError === null && records.length === 0 && <p>本章暂无流程记录。</p>}
        {runs.map((run, runIndex) => {
          const groups = new Map<string, ChapterWorkflowRecordSummary[]>();
          for (const record of run) {
            const key = groupKey(record);
            groups.set(key, [...(groups.get(key) ?? []), record]);
          }
          return (
            <section key={run[0]!.runId} className="jz-workflow-record-run">
              <h3>{runIndex === 0 ? "最近一次工作流" : `较早工作流 ${runIndex}`}</h3>
              {[...groups].map(([key, items]) => (
                <div className="jz-workflow-record-group" key={key}>
                  <strong>{GROUP_LABELS[key] ?? "流程记录"}</strong>
                  {items.map((record) => (
                    <button
                      type="button"
                      key={record.recordId}
                      className={selected?.runId === record.runId && selected.recordId === record.recordId ? "active" : ""}
                      aria-pressed={selected?.runId === record.runId && selected.recordId === record.recordId}
                      onClick={() => { void openRecord(record); }}
                    >
                      {record.label}
                    </button>
                  ))}
                </div>
              ))}
            </section>
          );
        })}
      </nav>
      <div className="jz-workflow-record-content">
        {selected === null && <p className="jz-workflow-record-empty">选择一条记录查看完整内容。</p>}
        {recordLoading && <p role="status">正在读取流程记录…</p>}
        {recordError !== null && <p role="alert">{recordError}</p>}
        {document !== null && (
          <article
            className="jz-inspector-markdown"
            aria-label={`流程记录：${document.label}`}
            data-readonly="true"
          >
            <MarkdownDocument content={document.content} />
          </article>
        )}
      </div>
    </section>
  );
}
