import * as selection from "../../jizuo-client/src/content/selection.ts";
import * as shellChrome from "../../jizuo-client/src/overlay/shellChrome.ts";
import * as preferences from "../../jizuo-client/src/plugins/preferences.ts";
import * as videoProject from "../../jizuo-client/src/video/useVideoProject.ts";
import type { NativeShellHost } from "./shell-host.ts";
import type { JizuoContentRemote, MemoryPalaceOverlayRemote, SubscribeWorksChanges } from "@jizuo/client";
import { pluginForOverlay, type WorkspacePluginId } from "../../jizuo-client/src/plugins/registry.ts";
export type PanelFactory = (host: NativeShellHost,
  remote: JizuoContentRemote & MemoryPalaceOverlayRemote,
  changes: SubscribeWorksChanges | undefined,
  navigation: { openWork(workId: string): Promise<void> },
) => Partial<Record<Exclude<selection.JizuoOverlay, null>, () => () => void>>;
const contributions = new Map<WorkspacePluginId, PanelFactory>();
const listeners = new Set<() => void>();
function notify() { for (const listener of listeners) listener(); }
export function registerCreationPanels(id: WorkspacePluginId, factory: PanelFactory) {
  if (contributions.has(id)) throw new Error(`Duplicate creation client: ${id}`);
  contributions.set(id, factory);
  preferences.setWorkspacePluginAvailable(id, true);
  notify();
  return () => {
    if (contributions.get(id) !== factory) return;
    contributions.delete(id);
    if (pluginForOverlay(selection.getSelection().overlay)?.id === id) selection.setSelection({ overlay: null });
    preferences.setWorkspacePluginAvailable(id, false);
    notify();
  };
}
export function creationPanels(id: WorkspacePluginId) { return contributions.get(id); }
export function subscribeCreationPanels(listener: () => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
/** Explicit shared browser state: never rebundle these stores in feature factories. */
export const creationClientApi = { selection, shellChrome, preferences, videoProject, registerPanels: registerCreationPanels };
