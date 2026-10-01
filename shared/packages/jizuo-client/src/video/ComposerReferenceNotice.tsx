import { IconButton } from "../ui/IconButton.tsx";
import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/** Keep reference validation out of the narrow thumbnail column. */
export function ComposerReferenceNotice({ message }: { message: string }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const [open, setOpen] = useState(true);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  useEffect(() => { setOpen(true); }, [message]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(300, window.innerWidth - 24);
      const height = panel.current?.offsetHeight ?? 80;
      const above = rect.top >= height + 16;
      setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: above ? rect.top - height - 8 : Math.min(rect.bottom + 8, Math.max(12, window.innerHeight - height - 12)),
        maxHeight: Math.max(40, window.innerHeight - 24) });
    };
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); anchor.current?.focus(); }
    };
    place();
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape);
    };
  }, [open, message]);
  return <>
    <IconButton icon="info" label={"查看参考素材提示"} ref={anchor} type="button" className="jz-reference-notice-trigger" aria-label="查看参考素材提示" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)} />
    {open && createPortal(<div ref={panel} id={id} className="jz-reference-notice-popover" style={position}>
      <p role="alert">{message}</p>
      <IconButton icon="close" label={"关闭参考素材提示"} type="button" aria-label="关闭参考素材提示" onClick={() => setOpen(false)} />
    </div>, document.body)}
  </>;
}
