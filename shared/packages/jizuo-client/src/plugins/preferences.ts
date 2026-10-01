import { useSyncExternalStore } from "react";
import { WORKSPACE_PLUGINS, type WorkspacePluginId } from "./registry.ts";
const PREFIX = "jizuo:workspace-plugins:v1:";
const GLOBAL_SCOPE = "@global";
const listeners = new Set<() => void>();
let revision = 0;
let available: Set<WorkspacePluginId> | null = null;
let hostManaged = false;
function emit() { revision++; for (const listener of listeners) listener(); }
export function subscribeWorkspacePlugins(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
function onStorage(event: StorageEvent) {
  if (event.key === null || event.key.startsWith(PREFIX)) emit();
}
function read(workId: string): Partial<Record<WorkspacePluginId, boolean>> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(PREFIX + workId) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(WORKSPACE_PLUGINS.flatMap(({ id }) => {
      const enabled = (value as Record<string, unknown>)[id];
      return typeof enabled === "boolean" ? [[id, enabled]] : [];
    }));
  } catch { return {}; }
}
export function isWorkspacePluginAvailable(id: WorkspacePluginId): boolean {
  return available === null || available.has(id);
}

export function isWorkspacePluginEnabled(workId: string | null, id: WorkspacePluginId): boolean {
  return workId !== null && (available === null || available.has(id)) && isBuiltinPluginEnabled(id) && read(workId)[id] !== false;
}
export function setWorkspacePluginEnabled(workId: string, id: WorkspacePluginId, enabled: boolean) {
  // Persist before notifying: a failed write must never look like a saved preference.
  try { window.localStorage.setItem(PREFIX + workId, JSON.stringify({ ...read(workId), [id]: enabled })); }
  catch { throw new Error("项目功能设置未保存，请检查本地存储后重试。"); }
  emit();
}
export function useWorkspacePlugins() {
  useSyncExternalStore(subscribeWorkspacePlugins, () => revision, () => 0);
  return isWorkspacePluginEnabled;
}

export function isBuiltinPluginEnabled(id: WorkspacePluginId): boolean {
  // Native DSH already owns the master switch; legacy local flags must not veto it.
  return hostManaged || read(GLOBAL_SCOPE)[id] !== false;
}
export function setBuiltinPluginEnabled(id: WorkspacePluginId, enabled: boolean) {
  setWorkspacePluginEnabled(GLOBAL_SCOPE, id, enabled);
}

export function trackWorkspacePluginAvailability(options: { hostManaged?: boolean } = {}) { hostManaged = options.hostManaged === true; available = new Set(); emit(); }
export function setWorkspacePluginAvailable(id: WorkspacePluginId, enabled: boolean) {
  if (available === null) return;
  if (enabled) available.add(id); else available.delete(id);
  emit();
}
