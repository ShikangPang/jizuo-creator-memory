import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ChapterChangeProposal, ChapterDocument, ChapterTarget } from "@jizuo/contracts";

import type { JizuoContentRemote } from "../content/remote.ts";
import type { SubscribeWorksChanges } from "../sidebar/WorksSidebarPanel.tsx";
import { setSelection, useSelection } from "../content/selection.ts";
import { createDraftPersistence, type DraftPersistence } from "../persistence.ts";
import { DiffReview } from "../editor/DiffReview.tsx";
import { RevisionPanel, type ChapterRevisionItem } from "../editor/RevisionPanel.tsx";
import { WorkflowRecordPanel } from "../editor/WorkflowRecordPanel.tsx";
import { useAutosave } from "../editor/useAutosave.ts";
import {
  applyConversationInset,
  clearConversationInset,
  getInspectorWidth,
  INSPECTOR_MAX,
  INSPECTOR_MIN,
  setInspectorWidth,
} from "./shellChrome.ts";
import "./overlay.css";

function messageOf(error: unknown): string {
  return userErrorMessage(error, "操作失败，请重试", { operation: "ChapterInspector" });
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

type ChapterTab = "content" | "outline" | "detailed-outline" | "workflow";
type OutlineSaveState = "idle" | "saving" | "saved" | "error";
const BACKGROUND_REFRESH_INTERVAL_MS = 1_500;
const HISTORY_READ_TIMEOUT_MS = 15_000;

function createEditSessionId(): string {
  const random = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().replaceAll("-", "")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `edit_${random}`;
}

export interface ChapterExcerptQuote {
  readonly target: ChapterTarget;
  readonly chapterTitle: string;
  readonly text: string;
}

export function ChapterInspector({
  remote,
  persistence,
  close,
  onQuoteExcerpt,
  subscribeWorksChanges,
}: {
  remote: JizuoContentRemote;
  persistence?: DraftPersistence;
  close?: () => void;
  onQuoteExcerpt?: (quote: ChapterExcerptQuote) => boolean;
  subscribeWorksChanges?: SubscribeWorksChanges;
}) {
  const selection = useSelection();
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const draftPersistence = useMemo(
    () => persistence ?? createDraftPersistence(),
    [persistence],
  );
  const target = useMemo<ChapterTarget | null>(() => {
    if (selection.workId === null || selection.volumeId === null || selection.chapterId === null) return null;
    return {
      workId: selection.workId,
      volumeId: selection.volumeId,
      chapterId: selection.chapterId,
    };
  }, [selection.chapterId, selection.volumeId, selection.workId]);
  const [chapter, setChapter] = useState<ChapterDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [outlineDraft, setOutlineDraft] = useState("");
  const [detailedOutlineDraft, setDetailedOutlineDraft] = useState("");
  const [activeTab, setActiveTab] = useState<ChapterTab>("content");
  const [selectedExcerpt, setSelectedExcerpt] = useState("");
  const [outlineSaveState, setOutlineSaveState] = useState<OutlineSaveState>("idle");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [reloadEpoch, setReloadEpoch] = useState(0);
  const [proposals, setProposals] = useState<ChapterChangeProposal[]>([]);
  const [revisions, setRevisions] = useState<ChapterRevisionItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(getInspectorWidth);
  const [dragging, setDragging] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [workflowRecordsEpoch, setWorkflowRecordsEpoch] = useState(0);
  const editSessionRef = useRef<{ id: string; lastChangedAt: number } | null>(null);
  const resizeDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const visibleDraft = chapter?.liveDraft ?? draft;
  const targetKey = target === null
    ? null
    : `${target.workId}:${target.volumeId}:${target.chapterId}`;
  const revisionReader = useMemo(() => {
    let active = false;
    let pending: Promise<void> | undefined;
    let controller: AbortController | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let refreshQueued = false;
    const refresh = (immediate = false): Promise<void> => {
      if (!active || target === null) return Promise.resolve();
      if (pending !== undefined) {
        refreshQueued = true;
        return pending;
      }
      if (retryTimer !== undefined && !immediate) return Promise.resolve();
      clearTimeout(retryTimer);
      retryTimer = undefined;
      const current = new AbortController();
      controller = current;
      let onAbort!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(current.signal.reason);
        current.signal.addEventListener("abort", onAbort, { once: true });
      });
      const timeout = setTimeout(() => {
        current.abort(new Error("章节历史加载超时"));
      }, HISTORY_READ_TIMEOUT_MS);
      pending = Promise.race([
        Promise.resolve().then(() => {
          current.signal.throwIfAborted();
          return remote.listChapterRevisions(target, current.signal);
        }),
        cancelled,
      ]).then((items) => {
        if (!active || controller !== current) return;
        setRevisions(items);
        setHistoryError(null);
        failures = 0;
      }).catch((cause: unknown) => {
        if (!active || controller !== current) return;
        setHistoryError(`${userErrorMessage(cause, "章节历史加载失败", { operation: "listChapterRevisions", effect: "read" })}，将自动重试。`);
        refreshQueued = false;
        failures += 1;
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void refresh();
        }, Math.min(3_000 * 2 ** Math.min(failures - 1, 4), 30_000));
      }).finally(() => {
        clearTimeout(timeout);
        current.signal.removeEventListener("abort", onAbort);
        if (controller !== current) return;
        pending = undefined;
        if (refreshQueued) {
          refreshQueued = false;
          void refresh();
        }
      });
      return pending;
    };
    return {
      refresh,
      start: () => {
        active = true;
        setRevisions([]);
        setHistoryError(null);
        void refresh();
      },
      stop: () => {
        active = false;
        clearTimeout(retryTimer);
        retryTimer = undefined;
        refreshQueued = false;
        controller?.abort();
        controller = undefined;
        pending = undefined;
      },
    };
  }, [remote, target]);
  const refreshRevisions = revisionReader.refresh;

  useEffect(() => {
    revisionReader.start();
    return revisionReader.stop;
  }, [revisionReader]);

  useEffect(() => {
    if (!selection.searchMatch || !chapter || chapter.id !== selection.chapterId || loading) return;
    setActiveTab("content"); setHistoryOpen(false);
    const frame = requestAnimationFrame(() => {
      const editor = editorRef.current;
      const match = selection.searchMatch;
      if (!editor || !match) return;
      const start = chapter.revisionToken === match.revisionToken && visibleDraft === chapter.content
        ? match.start : visibleDraft.toLocaleLowerCase().indexOf(match.query.toLocaleLowerCase());
      if (start >= 0) {
        editor.focus(); editor.setSelectionRange(start, start + match.query.length);
        const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 24;
        const charsPerLine = Math.max(1, Math.floor(editor.clientWidth / (parseFloat(getComputedStyle(editor).fontSize) || 16)));
        const lines = visibleDraft.slice(0, start).split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
        editor.scrollTop = Math.max(0, lines * lineHeight - editor.clientHeight / 2);
      } else setActionNotice("正文已变化，搜索结果中的关键词已不存在。");
      setSelection({ searchMatch: undefined });
    });
    return () => cancelAnimationFrame(frame);
  }, [selection.searchMatch, selection.chapterId, chapter, loading, visibleDraft]);

  useEffect(() => {
    if (!target || !remote.touchDreamActivity) return;
    const touch = () => { void remote.touchDreamActivity?.(target.workId, target.chapterId).catch(() => {}); };
    touch();
    const timer = setInterval(touch, 15_000);
    return () => clearInterval(timer);
  }, [remote, target]);

  useEffect(() => {
    applyConversationInset(panelWidth, !dragging);
    return clearConversationInset;
  }, [dragging, panelWidth]);

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      if (resizeDragRef.current === null || !Number.isFinite(event.clientX)) return;
      setPanelWidth(setInspectorWidth(
        resizeDragRef.current.startWidth + event.clientX - resizeDragRef.current.startX,
      ));
    };
    const up = (): void => {
      if (resizeDragRef.current === null) return;
      resizeDragRef.current = null;
      setDragging(false);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
  }, []);

  useEffect(() => {
    editSessionRef.current = null;
    setHistoryOpen(false);
  }, [targetKey]);

  useEffect(() => {
    if (target === null) {
      setChapter(null);
      setDraft("");
      setOutlineDraft("");
      setDetailedOutlineDraft("");
      setSelectedExcerpt("");
      setLoadError(null);
      setActionNotice(null);
      return;
    }
    let active = true;
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    setActionNotice(null);
    remote.readChapter(target).then((next) => {
      if (!active) return;
      const persisted = draftPersistence.load(target);
      const matchingDraft = persisted?.revisionToken === next.revisionToken ? persisted : null;
      if (persisted !== null && matchingDraft === null) draftPersistence.clear(target);
      setChapter(next);
      setDraft(matchingDraft?.content ?? next.content);
      setOutlineDraft(next.outline);
      setDetailedOutlineDraft(next.detailedOutline);
      setSelectedExcerpt("");
      setOutlineSaveState("idle");
    }).catch((cause: unknown) => {
      if (active) setLoadError(messageOf(cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [draftPersistence, reloadEpoch, remote, target]);

  useEffect(() => {
    const listProposals = remote.listProposals;
    if (target === null || listProposals === undefined) {
      setProposals([]);
      return;
    }
    let active = true;
    let refreshing = false;
    const refresh = async (): Promise<void> => {
      if (refreshing) return;
      refreshing = true;
      try {
        const items = await listProposals(target);
        if (active) setProposals(items.filter((item) => item.status === "pending"));
      } catch (cause) {
        if (active) setActionError(messageOf(cause));
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, BACKGROUND_REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [remote, target]);

  useEffect(() => {
    if (
      target === null
      || chapter === null
      || activeTab !== "content"
      || draft !== chapter.content
    ) return;
    let active = true;
    let refreshing = false;
    const refresh = async (): Promise<void> => {
      if (refreshing) return;
      refreshing = true;
      try {
        const next = await remote.readChapter(target);
        if (!active) return;
        const revisionChanged = next.revisionToken !== chapter.revisionToken;
        const liveDraftChanged = next.liveDraft !== chapter.liveDraft;
        if (!revisionChanged && !liveDraftChanged) return;
        setChapter(next);
        if (revisionChanged) {
          setDraft(next.content);
          setOutlineDraft((current) => current === chapter.outline ? next.outline : current);
          setDetailedOutlineDraft((current) => current === chapter.detailedOutline ? next.detailedOutline : current);
          draftPersistence.save(target, {
            content: next.content,
            revisionToken: next.revisionToken,
          });
          void refreshRevisions();
        }
      } catch {
        // Initial load and explicit saves surface actionable errors; background refresh retries quietly.
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(() => { void refresh(); }, BACKGROUND_REFRESH_INTERVAL_MS);
    let unlisten = (): void => undefined;
    if (subscribeWorksChanges !== undefined) {
      Promise.resolve(subscribeWorksChanges(() => {
        void refresh();
        void refreshRevisions();
      })).then((dispose) => {
        if (active) unlisten = dispose;
        else dispose();
      }).catch(() => {
        // The timer remains the fallback outside Tauri or after a watcher error.
      });
    }
    return () => {
      active = false;
      window.clearInterval(timer);
      unlisten();
    };
  }, [activeTab, chapter, draft, draftPersistence, refreshRevisions, remote, subscribeWorksChanges, target]);

  useEffect(() => {
    if (activeTab !== "workflow" || target === null) return;
    let active = true;
    const refresh = (): void => {
      if (!active) return;
      setWorkflowRecordsEpoch((value) => value + 1);
      void refreshRevisions();
    };
    const timer = window.setInterval(refresh, BACKGROUND_REFRESH_INTERVAL_MS);
    let unlisten = (): void => undefined;
    if (subscribeWorksChanges !== undefined) {
      Promise.resolve(subscribeWorksChanges(refresh)).then((dispose) => {
        if (active) unlisten = dispose;
        else dispose();
      }).catch(() => {
        // Low-frequency refresh remains available after a watcher error.
      });
    }
    return () => {
      active = false;
      window.clearInterval(timer);
      unlisten();
    };
  }, [activeTab, refreshRevisions, subscribeWorksChanges, target]);

  const acceptDocument = useCallback((next: ChapterDocument) => {
    setChapter(next);
    setDraft(next.content);
    if (target !== null) {
      draftPersistence.save(target, {
        content: next.content,
        revisionToken: next.revisionToken,
      });
    }
  }, [draftPersistence, target]);

  const autosave = useAutosave({
    resetKey: target === null || chapter === null
      ? null
      : `${target.workId}:${target.volumeId}:${target.chapterId}:${chapter.revisionToken}`,
    content: draft,
    savedContent: chapter?.content ?? "",
    enabled: target !== null && chapter !== null && chapter.liveDraft === undefined,
    delay: 800,
    save: async (content) => {
      if (target === null || chapter === null) throw new Error("没有选中的章节");
      const editSessionId = editSessionRef.current?.id ?? createEditSessionId();
      if (editSessionRef.current === null) {
        editSessionRef.current = { id: editSessionId, lastChangedAt: Date.now() };
      }
      return remote.replaceChapter({
        ...target,
        content,
        expectedRevision: chapter.revisionToken,
        editSessionId,
      });
    },
    isConflict: (cause) => hasCode(cause, "revision_conflict"),
    onSaved: (next) => {
      acceptDocument(next);
      void refreshRevisions();
    },
    onConflict: () => { setActionError("发现版本冲突：服务端正文已经更新，本地草稿仍然保留。"); },
    onError: (cause) => { setActionError(messageOf(cause)); },
  });

  const updateDraft = (content: string): void => {
    const now = Date.now();
    if (editSessionRef.current === null || now - editSessionRef.current.lastChangedAt > 5 * 60_000) {
      editSessionRef.current = { id: createEditSessionId(), lastChangedAt: now };
    } else {
      editSessionRef.current.lastChangedAt = now;
    }
    setDraft(content);
    setSelectedExcerpt("");
    setActionNotice(null);
    if (target !== null && chapter !== null) {
      draftPersistence.save(target, { content, revisionToken: chapter.revisionToken });
    }
  };

  const captureExcerpt = (editor: HTMLTextAreaElement): void => {
    const text = editor.value.slice(editor.selectionStart, editor.selectionEnd).trim();
    setSelectedExcerpt(text.slice(0, 6_000));
  };

  const quoteSelectedExcerpt = (): void => {
    if (target === null || chapter === null || onQuoteExcerpt === undefined) return;
    const quoteText = selectedExcerpt === "" ? visibleDraft.trim() : selectedExcerpt;
    if (quoteText === "") return;
    setActionError(null);
    setActionNotice(null);
    let inserted = false;
    try {
      inserted = onQuoteExcerpt({ target, chapterTitle: chapter.title, text: quoteText });
    } catch (cause) {
      setActionError(`引用失败：${messageOf(cause)}`);
      return;
    }
    if (!inserted) {
      setActionError("当前对话不可用，请先打开该作品的对话后重试。");
      return;
    }
    setActionNotice(selectedExcerpt === ""
      ? "已将整章引用到当前对话"
      : "已将选段引用到当前对话");
    setSelectedExcerpt("");
  };

  const applyProposal = async (proposal: ChapterChangeProposal): Promise<void> => {
    if (remote.authorizeProposal === undefined || remote.applyProposal === undefined) return;
    setReviewBusy(true);
    setActionError(null);
    try {
      const token = await remote.authorizeProposal(proposal.id);
      const next = await remote.applyProposal({ proposalId: proposal.id, token });
      acceptDocument(next);
      editSessionRef.current = null;
      void refreshRevisions();
      setProposals((items) => items.filter((item) => item.id !== proposal.id));
    } catch (cause) {
      setActionError(messageOf(cause));
    } finally {
      setReviewBusy(false);
    }
  };

  const rejectProposal = async (proposal: ChapterChangeProposal): Promise<void> => {
    if (remote.rejectProposal === undefined) return;
    setReviewBusy(true);
    setActionError(null);
    try {
      await remote.rejectProposal(proposal.id);
      setProposals((items) => items.filter((item) => item.id !== proposal.id));
    } catch (cause) {
      setActionError(messageOf(cause));
    } finally {
      setReviewBusy(false);
    }
  };

  const restoreRevision = async (revision: string): Promise<void> => {
    if (target === null || chapter === null) return;
    setReviewBusy(true);
    setActionError(null);
    try {
      acceptDocument(await remote.restoreChapterRevision({
        ...target,
        revision,
        expectedRevision: chapter.revisionToken,
      }));
      editSessionRef.current = null;
      setHistoryOpen(false);
      void refreshRevisions();
    } catch (cause) {
      setActionError(messageOf(cause));
    } finally {
      setReviewBusy(false);
    }
  };

  const saveOutlines = async (): Promise<void> => {
    if (target === null || chapter === null) return;
    setOutlineSaveState("saving");
    setActionError(null);
    try {
      const next = await remote.saveChapterOutline({
        ...target,
        outline: outlineDraft,
        detailedOutline: detailedOutlineDraft,
        expectedRevision: chapter.revisionToken,
      });
      setChapter(next);
      setOutlineDraft(next.outline);
      setDetailedOutlineDraft(next.detailedOutline);
      setOutlineSaveState("saved");
    } catch (cause) {
      setOutlineSaveState("error");
      setActionError(messageOf(cause));
    }
  };

  const closeInspector = (): void => {
    setSelection({ overlay: null });
    close?.();
  };

  return (
    <section
      data-plugin="jizuo"
      data-surface="chapter-inspector"
      className={dragging ? "dragging" : ""}
      aria-label="章节编辑器"
      style={{ width: panelWidth }}
    >
      <header className="jz-inspector-header">
        <div>
          <p>{activeTab === "content" ? "章节正文" : activeTab === "outline" ? "章节大纲" : activeTab === "detailed-outline" ? "章节细纲" : "章节流程记录"}</p>
          <h2>{chapter?.title ?? selection.chapterTitle ?? (loadError === null ? "正在读取章节" : "章节读取失败")}</h2>
        </div>
        <IconButton icon="close" label={"关闭章节"} type="button" aria-label="关闭章节" onClick={closeInspector} />
      </header>

      <div className="jz-outline-tabs" role="tablist" aria-label="章节内容类型">
        <IconButton icon="book" label={"正文"} type="button" role="tab" aria-selected={activeTab === "content"} onClick={() => { setActiveTab("content"); }} />
        <IconButton icon="outline" label={"大纲"} type="button" role="tab" aria-selected={activeTab === "outline"} onClick={() => { setHistoryOpen(false); setActiveTab("outline"); }} />
        <IconButton icon="list" label={"细纲"} type="button" role="tab" aria-selected={activeTab === "detailed-outline"} onClick={() => { setHistoryOpen(false); setActiveTab("detailed-outline"); }} />
        <IconButton icon="history" label={"流程记录"} type="button" role="tab" aria-selected={activeTab === "workflow"} onClick={() => { setHistoryOpen(false); setActiveTab("workflow"); }} />
      </div>

      {target === null && <div className="jz-inspector-empty">请先选择一个章节。</div>}
      {target !== null && loading && <div className="jz-inspector-empty">正在加载正文…</div>}
      {target !== null && !loading && loadError !== null && (
        <div className="jz-inspector-error" role="alert">
          <p>{loadError}</p>
          <IconButton icon="reset" label={"重新加载"} type="button" onClick={() => { setReloadEpoch((value) => value + 1); }} />
        </div>
      )}

      {chapter !== null && loadError === null && (
        <div className="jz-inspector-body">
          <div className="jz-inspector-save-row">
            <span aria-live="polite">
              {activeTab === "content" && autosave.state === "pending" && "等待自动保存"}
              {activeTab === "content" && autosave.state === "saving" && "正在保存"}
              {activeTab === "content" && autosave.state === "saved" && "已保存"}
              {activeTab === "content" && autosave.state === "conflict" && "发现版本冲突"}
              {activeTab === "content" && autosave.state === "error" && "保存失败"}
              {activeTab === "content" && chapter.liveDraft !== undefined && "AI 实时草稿（尚未提交）"}
              {activeTab === "content" && chapter.liveDraft === undefined && autosave.state === "idle" && (draft === chapter.content ? "已同步" : "本地草稿")}
              {activeTab !== "content" && outlineSaveState === "saving" && "正在保存大纲"}
              {activeTab !== "content" && outlineSaveState === "saved" && "大纲已保存"}
              {activeTab !== "content" && outlineSaveState === "error" && "大纲保存失败"}
              {activeTab !== "content" && outlineSaveState === "idle" && (
                activeTab === "workflow" ? "只读流程记录" :
                outlineDraft === chapter.outline && detailedOutlineDraft === chapter.detailedOutline
                  ? "大纲已同步"
                  : "大纲尚未保存"
              )}
            </span>
            {activeTab === "content" ? (
              <div className="jz-inspector-save-actions">
                <IconButton icon="history" label={(revisions.length > 0 ? `历史版本（${revisions.length}）` : "历史版本")}
                  type="button"
                  aria-controls="jz-chapter-history"
                  aria-expanded={historyOpen}
                  onClick={() => {
                    setHistoryOpen((open) => {
                      if (!open) void refreshRevisions(true);
                      return !open;
                    });
                  }}
                 />
                {proposals[0] === undefined && onQuoteExcerpt !== undefined && (
                  <IconButton icon="chat" label={"引用到对话"}
                    type="button"
                    title="有选中文本时引用选段，否则引用整章"
                    disabled={visibleDraft.trim() === ""}
                    onClick={quoteSelectedExcerpt}
                   />
                )}
                {proposals[0] === undefined && <IconButton icon="save" label={"保存正文"}
                  type="button"
                  disabled={chapter.liveDraft !== undefined || autosave.state === "saving" || autosave.state === "conflict"}
                  onClick={() => {
                    setActionError(null);
                    if (draft === chapter.content) {
                      setActionNotice("正文已经保存");
                      return;
                    }
                    setActionNotice(null);
                    void autosave.saveNow();
                  }}
                 />}
              </div>
            ) : activeTab === "workflow" ? null : (
              <IconButton icon="save" label={(activeTab === "outline" ? "保存大纲" : "保存细纲")}
                type="button"
                disabled={outlineSaveState === "saving" || (
                  outlineDraft === chapter.outline && detailedOutlineDraft === chapter.detailedOutline
                )}
                onClick={() => { void saveOutlines(); }}
               />
            )}
          </div>

          {actionError !== null && <p className="jz-inspector-error" role="alert">{actionError}</p>}
          {historyError !== null && <p className="jz-inspector-error" role="alert">{historyError}</p>}
          {actionNotice !== null && <p className="jz-inspector-notice" role="status">{actionNotice}</p>}
          {activeTab === "content" && chapter.draftStatus === "pending" && visibleDraft.trim() === "" && (
            <p className="jz-inspector-pending" role="status">章节已创建，正文尚未生成。可在对话中查看工作流进度。</p>
          )}

          {activeTab === "content" && !historyOpen && proposals[0] !== undefined && (
            <DiffReview
              proposal={proposals[0]}
              chapterTitle={chapter.title}
              originalContent={chapter.content}
              busy={reviewBusy}
              onReject={() => { void rejectProposal(proposals[0]!); }}
              onConfirm={() => { void applyProposal(proposals[0]!); }}
            />
          )}
          {activeTab === "content" && historyOpen && (
            <RevisionPanel
              revisions={revisions}
              currentContent={visibleDraft}
              busy={reviewBusy}
              {...(chapter.liveDraft !== undefined
                ? { restoreBlockedReason: "AI 正在生成实时草稿，暂时不能恢复历史版本。" }
                : draft !== chapter.content || autosave.state === "saving"
                  ? { restoreBlockedReason: "请先保存当前正文，再恢复历史版本。" }
                  : {})}
              onRead={async (revision) => {
                if (target === null) throw new Error("没有选中的章节");
                return remote.readChapterRevision({ ...target, revision });
              }}
              onRestore={(revision) => { void restoreRevision(revision); }}
              onClose={() => { setHistoryOpen(false); }}
            />
          )}

          {activeTab === "content" && !historyOpen && proposals[0] === undefined && (
            <label className="jz-inspector-editor">
              <span>正文</span>
              <textarea
                ref={editorRef}
                aria-label="正文"
                value={visibleDraft}
                readOnly={chapter.liveDraft !== undefined}
                spellCheck={false}
                onChange={(event) => { updateDraft(event.target.value); }}
                onSelect={(event) => { captureExcerpt(event.currentTarget); }}
              />
            </label>
          )}
          {activeTab === "outline" && (
            <label className="jz-inspector-editor jz-outline-editor">
              <span>章节大纲</span>
              <textarea
                aria-label="章节大纲"
                value={outlineDraft}
                spellCheck={false}
                placeholder="概括本章目标、冲突和结果"
                onChange={(event) => { setOutlineDraft(event.target.value); setOutlineSaveState("idle"); }}
              />
            </label>
          )}
          {activeTab === "detailed-outline" && (
            <label className="jz-inspector-editor jz-outline-editor">
              <span>章节细纲</span>
              <textarea
                aria-label="章节细纲"
                value={detailedOutlineDraft}
                spellCheck={false}
                placeholder="按场景或节拍拆分本章推进过程"
                onChange={(event) => { setDetailedOutlineDraft(event.target.value); setOutlineSaveState("idle"); }}
              />
            </label>
          )}
          {activeTab === "workflow" && target !== null && (
            <WorkflowRecordPanel remote={remote} target={target} refreshToken={workflowRecordsEpoch} />
          )}
        </div>
      )}

      <div
        className="jz-inspector-resize"
        role="separator"
        aria-label="调整章节面板宽度"
        aria-orientation="vertical"
        aria-valuemin={INSPECTOR_MIN}
        aria-valuemax={INSPECTOR_MAX}
        aria-valuenow={panelWidth}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setPanelWidth(setInspectorWidth(panelWidth + (event.key === "ArrowRight" ? 24 : -24)));
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          if (!Number.isFinite(event.clientX)) return;
          resizeDragRef.current = { startX: event.clientX, startWidth: panelWidth };
          setDragging(true);
        }}
      />
    </section>
  );
}
