import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Reparent one portal host so hovering never reloads thumbnails or their controls. */
export function ComposerReferenceStack({ count, add, children, pinned = false }: { count: number; add: ReactNode; children: ReactNode; pinned?: boolean }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [host] = useState(() => document.createElement("div"));
  const [expanded, setExpanded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const open = count > 0 && (expanded || pinned);
  const cancelClose = () => clearTimeout(timer.current);
  const closeLater = () => { cancelClose(); timer.current = setTimeout(() => {
    if (!host.contains(document.activeElement)) setExpanded(false);
  }, 150); };
  useLayoutEffect(() => {
    const target = open ? document.body : anchor.current;
    target?.appendChild(host);
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      host.className = `jz-reference-stack-surface${open ? " is-expanded" : ""}`;
      Object.assign(host.style, open ? { position: "fixed", left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 96))}px`, top: `${Math.max(8, Math.min(rect.top, window.innerHeight - 130))}px`, maxWidth: `${Math.max(88, window.innerWidth - Math.max(8, rect.left) - 12)}px` } : { position: "absolute", left: "0", top: "0", maxWidth: "" });
    };
    place();
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [host, open]);
  useEffect(() => () => { clearTimeout(timer.current); host.remove(); }, [host]);
  useEffect(() => { if (!count) setExpanded(false); }, [count]);
  return <div ref={anchor} className="jz-reference-stack" data-count={count} data-expanded={open} onMouseEnter={() => { cancelClose(); setExpanded(true); }} onMouseLeave={closeLater}>
    {createPortal(<div className="jz-reference-stack-content" onMouseEnter={cancelClose} onMouseLeave={closeLater}
      onFocusCapture={() => { cancelClose(); setExpanded(true); }} onBlurCapture={closeLater}
      onKeyDown={event => { if (event.key === "Escape") { setExpanded(false); (document.activeElement as HTMLElement)?.blur(); } }}>
      <div className={`jz-reference-stack-add${count ? " has-images" : ""}`}>{add}</div>
      {children}
    </div>, host)}
  </div>;
}
