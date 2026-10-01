import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function RowMenu({ anchor, label, close, children }: { anchor: HTMLElement; label: string; close(): void; children: ReactNode }) {
  const menu = useRef<HTMLDivElement>(null);
  const dismiss = useRef(close); dismiss.current = close;
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const element = menu.current!;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const { width, height } = element.getBoundingClientRect();
      const top = rect.bottom + 4 + height <= window.innerHeight - 8 ? rect.bottom + 4 : rect.top - height - 4;
      setPosition({ left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), top: Math.max(8, Math.min(top, window.innerHeight - height - 8)) });
    };
    place();
    element.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!element.contains(event.target as Node) && !anchor.contains(event.target as Node)) dismiss.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss.current(); anchor.focus(); }
      if (event.key === "Tab") dismiss.current();
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const items = [...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[index]?.focus();
      }
    };
    const scroll = (event: Event) => { if (!element.contains(event.target as Node)) dismiss.current(); };
    window.addEventListener("resize", place);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("pointerdown", outside);
    element.addEventListener("keydown", key);
    return () => { window.removeEventListener("resize", place); document.removeEventListener("scroll", scroll, true); document.removeEventListener("pointerdown", outside); element.removeEventListener("keydown", key); };
  }, [anchor]);
  return createPortal(<div ref={menu} className="jz-row-menu" style={position} role="menu" aria-label={label}>{children}</div>, document.body);
}
