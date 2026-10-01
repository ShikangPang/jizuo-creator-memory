import { IconButton } from "../ui/IconButton.tsx";
import type { ChapterChangeProposal } from "@jizuo/contracts";
import { diffLines } from "diff";

import { MarkdownDocument } from "./MarkdownDocument.tsx";

export function DiffReview({
  proposal,
  chapterTitle,
  originalContent,
  busy,
  onReject,
  onConfirm,
  readOnly = false,
}: {
  proposal: ChapterChangeProposal;
  chapterTitle: string;
  originalContent: string;
  busy: boolean;
  onReject: () => void;
  onConfirm: () => void;
  /** Workflow approval owns write authority; this preview cannot apply directly. */
  readOnly?: boolean;
}) {
  const changes = diffLines(originalContent, proposal.nextContent);

  return (
    <section className="jz-review-card" aria-label="章节改写提案">
      <header>
        <div>
          <strong>AI 修改预览</strong>
          <span>{chapterTitle} · 修改内容已标注在原文中</span>
        </div>
      </header>
      <article className="jz-review-document jz-inspector-markdown" aria-label="改稿正文预览">
        {changes.map((change, index) => (
          change.added ? (
            <ins className="jz-review-add" key={`add-${index}`}>
              <MarkdownDocument content={change.value} />
            </ins>
          ) : change.removed ? (
            <del className="jz-review-remove" key={`remove-${index}`}>
              <MarkdownDocument content={change.value} />
            </del>
          ) : (
            <MarkdownDocument key={`same-${index}`} content={change.value} />
          )
        ))}
      </article>
      <footer className="jz-review-actions">
        {readOnly ? <p>请在章节工作流进度中确认或拒绝提案。</p> : <>
          <p>确认后将写入当前章节，并保留历史版本。</p>
          <div className="jz-review-action-buttons">
            <IconButton icon="close" label={(busy ? "正在处理…" : "拒绝提案")} className="jz-review-reject" type="button" disabled={busy} onClick={onReject} />
            <IconButton icon="apply" label={(busy ? "正在处理…" : "确认并应用")} className="jz-review-apply" type="button" disabled={busy} onClick={onConfirm} />
          </div>
        </>}
      </footer>
    </section>
  );
}
