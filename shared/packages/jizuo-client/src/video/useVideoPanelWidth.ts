import { useEffect, useState, type RefObject, type PointerEvent, type KeyboardEvent } from "react";

const KEY = "jizuo/ui/video-panel-width";
const DEFAULT = 620;
const MIN = 320;
const CHAT_MIN = 320;

function readWidth(): number {
  try {
    const value = Number(localStorage.getItem(KEY));
    return Number.isFinite(value) && value >= MIN ? value : DEFAULT;
  } catch { return DEFAULT; }
}

/** Remember the preferred width while fitting the actual space beside the sidebar. */
export function useVideoPanelWidth(surface: RefObject<HTMLElement>) {
  const [preferred, setPreferred] = useState(readWidth);
  const [available, setAvailable] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ x: number; width: number } | null>(null);
  const max = available === null ? 1040 : Math.max(0, available - Math.min(CHAT_MIN, available / 2));
  const min = Math.min(MIN, max);
  const width = Math.min(max, Math.max(min, preferred));
  const save = (value: number) => {
    const next = Math.min(max, Math.max(min, value));
    setPreferred(next);
    try { localStorage.setItem(KEY, String(next)); } catch { /* Storage can be unavailable. */ }
  };
  useEffect(() => {
    const element = surface.current;
    const parent = element?.parentElement;
    const measure = () => {
      if (!element || !parent) return;
      const right = parent.getBoundingClientRect().right;
      const left = element.getBoundingClientRect().left;
      if (right > left) setAvailable(right - left);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (parent) observer?.observe(parent);
    if (element) observer?.observe(element);
    // Sidebar width is shared through a root style variable.
    const sidebar = new MutationObserver(measure);
    sidebar.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); sidebar.disconnect(); window.removeEventListener("resize", measure); };
  }, [surface]);
  useEffect(() => {
    if (!drag) return;
    const move = (event: globalThis.PointerEvent) => {
      if (Number.isFinite(event.clientX)) save(drag.width + event.clientX - drag.x);
    };
    const stop = () => setDrag(null);
    const cursor = document.body.style.cursor;
    const select = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = select;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
    };
  }, [drag, min, max]);
  return {
    width, min, max,
    startDrag(event: PointerEvent) {
      if (event.button !== 0 || !Number.isFinite(event.clientX)) return;
      event.preventDefault();
      setDrag({ x: event.clientX, width });
    },
    onKeyDown(event: KeyboardEvent) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      save(width + (event.key === "ArrowRight" ? 24 : -24));
    },
    reset() { save(DEFAULT); },
  };
}
