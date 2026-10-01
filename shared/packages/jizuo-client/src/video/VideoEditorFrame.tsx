import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Move the same portal host rather than remounting the player and draft forms.
export function VideoEditorFrame({ fullscreen, exit, children }: { fullscreen: boolean; exit: () => void; children: ReactNode }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [host] = useState(() => document.createElement("div"));
  useLayoutEffect(() => {
    host.className = "jz-video-editor-frame";
    host.dataset.plugin = "jizuo";
    host.dataset.fullscreen = String(fullscreen);
    (fullscreen ? document.body : anchor.current)?.appendChild(host);
    if (!fullscreen) return () => { host.remove(); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => {
      // Let an open menu/dialog consume Escape first.
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      event.preventDefault(); exit();
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      document.body.style.overflow = previousOverflow;
      host.remove();
    };
  }, [host, fullscreen, exit]);
  return <div ref={anchor} className="jz-video-editor-anchor">{createPortal(children, host)}</div>;
}
