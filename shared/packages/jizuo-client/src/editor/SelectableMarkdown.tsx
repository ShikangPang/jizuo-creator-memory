import { IconButton } from "../ui/IconButton.tsx";
import { useRef, useState } from "react";

import { MarkdownDocument } from "./MarkdownDocument.tsx";

interface QuoteAction {
  readonly text: string;
  readonly left: number;
  readonly top: number;
}

export function SelectableMarkdown({
  content,
  onQuoteSelection,
}: {
  content: string;
  onQuoteSelection?: ((text: string) => void) | undefined;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const [quoteAction, setQuoteAction] = useState<QuoteAction | null>(null);

  const captureSelection = (): void => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (root === null || selection === null || selection.isCollapsed || selection.rangeCount === 0) {
      setQuoteAction(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
      setQuoteAction(null);
      return;
    }
    const text = selection.toString().trim().slice(0, 6000);
    if (text === "") {
      setQuoteAction(null);
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const selectionRect = typeof range.getBoundingClientRect === "function"
      ? range.getBoundingClientRect()
      : rootRect;
    setQuoteAction({
      text,
      left: Math.max(12, Math.min(root.clientWidth - 116, selectionRect.left - rootRect.left)),
      top: Math.max(8, selectionRect.bottom - rootRect.top + root.scrollTop + 8),
    });
  };

  return (
    <article
      ref={rootRef}
      className="jz-inspector-markdown jz-selectable-markdown"
      aria-label="正文阅读区"
      onMouseUp={captureSelection}
    >
      <MarkdownDocument content={content} />
      {quoteAction !== null && onQuoteSelection !== undefined && (
        <IconButton icon="chat" label={"引用到对话"}
          className="jz-selection-quote"
          style={{ left: quoteAction.left, top: quoteAction.top }}
          type="button"
          onMouseDown={(event) => { event.preventDefault(); }}
          onClick={() => {
            onQuoteSelection(quoteAction.text);
            window.getSelection()?.removeAllRanges();
            setQuoteAction(null);
          }}
         />
      )}
    </article>
  );
}
