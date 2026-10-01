import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function VideoTextPopover({ x, y, close, children, label = "文本格式" }: { x: number; y: number; close: () => void; children: ReactNode; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const dismiss = useRef(close); dismiss.current = close;
  useEffect(() => {
    ref.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); dismiss.current(); } };
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) dismiss.current(); };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", outside); };
  }, []);
  return createPortal(<div ref={ref} tabIndex={-1} role="dialog" aria-label={label} className="jz-video-editor jz-video-editing jz-text-popover" style={{ left: Math.max(8, Math.min(x, window.innerWidth - 728)), top: Math.max(8, Math.min(y, window.innerHeight - 540)) }}><div className="jz-editing-properties">{children}</div></div>, document.body);
}
