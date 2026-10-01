import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { diffLines } from "diff";

import type {
  ChapterRevisionDocument,
  ChapterRevisionSource,
  ChapterRevisionSummary,
} from "@jizuo/contracts";

export type ChapterRevisionItem = ChapterRevisionSummary;

const SOURCE_LABELS: Record<ChapterRevisionSource, string> = {
  manual: "手动编辑",
  workflow: "工作流",
  proposal: "提案应用",
  restore: "版本恢复",
};

function readableTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function RevisionPanel({
  revisions,
  currentContent,
  busy,
  restoreBlockedReason,
  onRead,
  onRestore,
  onClose,
}: {
  revisions: ChapterRevisionSummary[];
  currentContent: string;
  busy: boolean;
  restoreBlockedReason?: string;
  onRead: (revision: string) => Promise<ChapterRevisionDocument>;
  onRestore: (revision: string) => void;
  onClose: () => void;
}) {
  const [selectedRevision, setSelectedRevision] = useState<string | null>(null);
  const [selected, setSelected] = useState<ChapterRevisionDocument | null>(null);
  const [loadingRevision, setLoadingRevision] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const requestId = useRef(0);
  const revisionKey = revisions.map((revision) => revision.revision).join(":");
  const changes = useMemo(
    () => selected === null ? [] : diffLines(selected.content, currentContent),
    [currentContent, selected],
  );

  const readRevision = async (revision: string): Promise<void> => {
    const currentRequest = ++requestId.current;
    setSelectedRevision(revision);
    setSelected(null);
    setLoadingRevision(revision);
    setReadError(null);
    try {
      const document = await onRead(revision);
      if (document === undefined || typeof document.content !== "string") {
        throw new Error("历史版本返回内容无效");
      }
      if (requestId.current === currentRequest) setSelected(document);
    } catch (error) {
      if (requestId.current === currentRequest) {
        setReadError(userErrorMessage(error, "历史版本读取失败", { operation: "RevisionPanel", effect: "read" }));
      }
    } finally {
      if (requestId.current === currentRequest) setLoadingRevision(null);
    }
  };

  useEffect(() => {
    const firstRevision = revisions[0]?.revision ?? null;
    if (firstRevision === null) {
      requestId.current += 1;
      setSelectedRevision(null);
      setSelected(null);
      setLoadingRevision(null);
      setReadError(null);
      return;
    }
    void readRevision(firstRevision);
    // The revision identity list is the reset boundary; onRead changes with the parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { requestId.current += 1; };
  }, [revisionKey]);

  const restorationBlocked = busy || restoreBlockedReason !== undefined || selectedRevision === null;

  return (
    <section id="jz-chapter-history" className="jz-revision-panel" role="region" aria-label="历史版本对比">
      <header className="jz-revision-panel-header">
        <div>
          <strong>历史版本对比</strong>
          <span>{revisions.length > 0 ? `${revisions.length} 个可用版本` : "尚无可用版本"}</span>
        </div>
        <IconButton icon="left" label={"返回正文"} type="button" onClick={onClose} />
      </header>

      {revisions.length === 0 ? (
        <p className="jz-revision-empty">暂无历史版本。保存或应用修改后，旧正文会显示在这里。</p>
      ) : (
        <>
          <div className="jz-revision-toolbar">
            <label>
              <span>对比版本</span>
              <select
                aria-label="对比版本"
                value={selectedRevision ?? ""}
                disabled={loadingRevision !== null}
                onChange={(event) => { void readRevision(event.currentTarget.value); }}
              >
                {revisions.map((revision) => (
                  <option key={revision.revision} value={revision.revision}>
                    {revision.label} · {SOURCE_LABELS[revision.source]} · {readableTime(revision.createdAt)}
                  </option>
                ))}
              </select>
            </label>
            <IconButton icon="undo" label={"恢复此版本"}
              type="button"
              disabled={restorationBlocked}
              onClick={() => {
                if (
                  selectedRevision !== null
                  && globalThis.confirm("恢复前会先保存当前正文为历史版本。确认恢复吗？")
                ) {
                  onRestore(selectedRevision);
                }
              }}
             />
          </div>
          {restoreBlockedReason !== undefined && (
            <p className="jz-revision-notice">{restoreBlockedReason}</p>
          )}
          {loadingRevision !== null && <p className="jz-revision-loading" role="status">正在读取历史版本…</p>}
          {readError !== null && <p className="jz-revision-error" role="alert">{readError}</p>}
          {selected !== null && (
            <div className="jz-revision-comparison">
              <article aria-label={`${selected.label}历史正文`}>
                <header>
                  <strong>{selected.label}</strong>
                  <span>历史正文 · {readableTime(selected.createdAt)}</span>
                </header>
                <div className="jz-revision-document">
                  {changes.map((change, index) => change.added ? (
                    <div className="jz-revision-diff-spacer" aria-hidden="true" key={`history-spacer-${index}`}>
                      <pre>{change.value}</pre>
                    </div>
                  ) : change.removed ? (
                    <del key={`history-remove-${index}`}><pre>{change.value}</pre></del>
                  ) : (
                    <div className="jz-revision-diff-same" key={`history-same-${index}`}><pre>{change.value}</pre></div>
                  ))}
                </div>
              </article>
              <article aria-label="当前正文">
                <header>
                  <strong>当前正文</strong>
                  <span>正在编辑或已保存的当前内容</span>
                </header>
                <div className="jz-revision-document">
                  {changes.map((change, index) => change.removed ? (
                    <div className="jz-revision-diff-spacer" aria-hidden="true" key={`current-spacer-${index}`}>
                      <pre>{change.value}</pre>
                    </div>
                  ) : change.added ? (
                    <ins key={`current-add-${index}`}><pre>{change.value}</pre></ins>
                  ) : (
                    <div className="jz-revision-diff-same" key={`current-same-${index}`}><pre>{change.value}</pre></div>
                  ))}
                </div>
              </article>
            </div>
          )}
        </>
      )}
    </section>
  );
}
