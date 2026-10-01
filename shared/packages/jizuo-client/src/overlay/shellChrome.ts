interface InlineStyleSnapshot {
  paddingLeft: string;
  paddingLeftPriority: string;
  transition: string;
  transitionPriority: string;
}

let insetHost: HTMLElement | null = null;
let snapshot: InlineStyleSnapshot | null = null;
let conversationObserver: MutationObserver | null = null;
let requestedInset: { width: number; animate: boolean } | null = null;
let sidebarCaptured = false;
let sidebarPrevious = "";
let sidebarPreviousPriority = "";

export const INSPECTOR_MIN = 440;
export const INSPECTOR_MAX = 900;
export const INSPECTOR_DEFAULT = 680;
const INSPECTOR_WIDTH_KEY = "jizuo/ui/memory-inspector-width";
let inspectorWidth = loadInspectorWidth();

function clampInspectorWidth(width: number): number {
  return Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, Math.round(width)));
}

function loadInspectorWidth(): number {
  try {
    const value = Number(globalThis.localStorage?.getItem(INSPECTOR_WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? clampInspectorWidth(value) : INSPECTOR_DEFAULT;
  } catch {
    return INSPECTOR_DEFAULT;
  }
}

export function getInspectorWidth(): number {
  return inspectorWidth;
}

export function setInspectorWidth(width: number): number {
  inspectorWidth = clampInspectorWidth(width);
  try {
    globalThis.localStorage?.setItem(INSPECTOR_WIDTH_KEY, String(inspectorWidth));
  } catch {
    // Storage is optional in embedded and test runtimes.
  }
  return inspectorWidth;
}

export function setSidebarChromeWidth(width: number): void {
  if (typeof document === "undefined") return;
  if (!sidebarCaptured) {
    sidebarPrevious = document.documentElement.style.getPropertyValue("--jizuo-sidebar-width");
    sidebarPreviousPriority = document.documentElement.style.getPropertyPriority("--jizuo-sidebar-width");
    sidebarCaptured = true;
  }
  document.documentElement.style.setProperty("--jizuo-sidebar-width", `${Math.round(width)}px`);
}

export function clearSidebarChromeWidth(): void {
  if (typeof document === "undefined" || !sidebarCaptured) return;
  if (sidebarPrevious === "") document.documentElement.style.removeProperty("--jizuo-sidebar-width");
  else document.documentElement.style.setProperty("--jizuo-sidebar-width", sidebarPrevious, sidebarPreviousPriority);
  sidebarCaptured = false;
  sidebarPrevious = "";
  sidebarPreviousPriority = "";
}

function conversationHost(): HTMLElement | null {
  if (typeof document === "undefined" || typeof HTMLElement === "undefined") return null;
  const scrollport = document.querySelector("[data-conversation-scroll]");
  return scrollport?.parentElement instanceof HTMLElement ? scrollport.parentElement : null;
}

function restoreConversationHost(): void {
  if (insetHost === null || snapshot === null) return;
  if (snapshot.paddingLeft === "") insetHost.style.removeProperty("padding-left");
  else insetHost.style.setProperty("padding-left", snapshot.paddingLeft, snapshot.paddingLeftPriority);
  if (snapshot.transition === "") insetHost.style.removeProperty("transition");
  else insetHost.style.setProperty("transition", snapshot.transition, snapshot.transitionPriority);
  insetHost = null;
  snapshot = null;
}

export function clearConversationInset(): void {
  conversationObserver?.disconnect();
  conversationObserver = null;
  requestedInset = null;
  restoreConversationHost();
}

function syncConversationInset(): HTMLElement | null {
  const host = conversationHost();
  if (host === null || requestedInset === null) {
    restoreConversationHost();
    return null;
  }
  const { width, animate } = requestedInset;
  if (insetHost !== host || snapshot === null) {
    restoreConversationHost();
    insetHost = host;
    snapshot = {
      paddingLeft: host.style.getPropertyValue("padding-left"),
      paddingLeftPriority: host.style.getPropertyPriority("padding-left"),
      transition: host.style.getPropertyValue("transition"),
      transitionPriority: host.style.getPropertyPriority("transition"),
    };
  }
  host.style.setProperty("transition", animate ? "padding-left 180ms var(--ds-ease-in-out, ease)" : "none");
  host.style.setProperty("padding-left", `${Math.max(0, Math.round(width))}px`);
  return host;
}

export function applyConversationInset(width: number, animate = true): HTMLElement | null {
  requestedInset = { width, animate };
  // Panels survive session navigation, while the conversation host is replaced.
  // Observe only child changes; our inline styles must not trigger this observer.
  if (!conversationObserver && typeof MutationObserver !== "undefined" && typeof document !== "undefined" && document.body) {
    conversationObserver = new MutationObserver(() => {
      if (conversationHost() !== insetHost) syncConversationInset();
    });
    conversationObserver.observe(document.body, { childList: true, subtree: true });
  }
  return syncConversationInset();
}
