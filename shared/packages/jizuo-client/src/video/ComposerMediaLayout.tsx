import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Keep the host's text editor intact and mount reference controls beside it. */
export function ComposerMediaLayout({ references, children, label, draftPreviewUrls = [] }: {references?: ReactNode; children: ReactNode; label: string; draftPreviewUrls?: readonly string[] | undefined}) {
  const marker = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const enabled = Boolean(references);
  // Keep native drop/paste intake mounted; only hide duplicate thumbnails whose
  // native attachment URLs are also displayed in our reference stack.
  useLayoutEffect(() => {
    const card = marker.current?.closest<HTMLElement>("[data-composer-card]");
    if (!enabled || !card || !draftPreviewUrls.length) return;
    const hidden = new Set<HTMLElement>();
    const sync = () => {
      for (const img of card.querySelectorAll<HTMLImageElement>("img")) {
        if (!draftPreviewUrls.includes(img.src) || img.closest("[data-input-scroll]")) continue;
        let rail: HTMLElement = img;
        while (rail.parentElement && rail.parentElement !== card) rail = rail.parentElement;
        // References briefly render beside the marker before their portal mounts.
        // The footer attribute is set by a later layout effect, so identify our
        // own controls structurally as well as by that attribute.
        if (rail.parentElement === card && !rail.contains(marker.current) && !rail.hasAttribute("data-jz-media-footer") && !hidden.has(rail)) {
          hidden.add(rail); rail.setAttribute("data-jz-duplicate-attachments", "");
        }
      }
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(card, {childList: true, subtree: true});
    return () => {observer.disconnect(); for (const rail of hidden) rail.removeAttribute("data-jz-duplicate-attachments");};
  }, [enabled, draftPreviewUrls.join("\n")]);
  useLayoutEffect(() => {
    const card = marker.current?.closest<HTMLElement>("[data-composer-card]");
    const scroll = card?.querySelector<HTMLElement>("[data-input-scroll]");
    if (!card || !scroll) { setSlot(null); return; }
    const host = enabled ? document.createElement("div") : null;
    if (host) {
      host.className = "jz-composer-reference-slot";
      scroll.prepend(host);
      scroll.setAttribute("data-jz-media-input", "");
    }
    let footer: HTMLElement | null = marker.current;
    while (footer?.parentElement && footer.parentElement !== card) footer = footer.parentElement;
    if (footer?.parentElement === card) footer.setAttribute("data-jz-media-footer", "");
    const wheel = (event: WheelEvent) => {
      if (!footer || event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || footer.scrollWidth <= footer.clientWidth) return;
      const previous = footer.scrollLeft;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? footer.clientWidth : 1);
      footer.scrollLeft = Math.max(0, Math.min(footer.scrollWidth - footer.clientWidth, previous + delta));
      if (footer.scrollLeft !== previous) event.preventDefault();
    };
    footer?.addEventListener("wheel", wheel, { passive: false });
    setSlot(host);
    return () => {
      host?.remove();
      scroll.removeAttribute("data-jz-media-input");
      footer?.removeAttribute("data-jz-media-footer");
      footer?.removeEventListener("wheel", wheel);
    };
  }, [enabled]);
  return <div ref={marker} className="jz-main-video-mode" aria-label={label}>
    {references && (slot ? createPortal(references, slot) : <div className="jz-composer-reference-fallback">{references}</div>)}
    {children}
  </div>;
}
