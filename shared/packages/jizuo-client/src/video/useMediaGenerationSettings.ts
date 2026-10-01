import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ManageMediaConnectionInput, MediaSettingsView } from "../../../contracts/src/media-settings.ts";

export interface MediaGenerationSettingsRemote { getMediaSettings?(): Promise<MediaSettingsView>; manageMediaConnection?(input: ManageMediaConnectionInput): Promise<MediaSettingsView> }
type Snapshot = { view?: MediaSettingsView; loading: boolean; error?: string; switching?: boolean };
export interface MediaGenerationSettingsState extends Snapshot { supported: boolean; refresh: () => void; selectModel?: (id: string) => Promise<boolean> }
type Store = { snapshot: Snapshot; started: boolean; pending?: Promise<void>; listeners: Set<() => void>; load: (force?: boolean) => void; selectModel: (id: string) => Promise<boolean> };
const stores = new WeakMap<MediaGenerationSettingsRemote, Store>();

function storeFor(remote: MediaGenerationSettingsRemote): Store {
  let existing = stores.get(remote);
  if (existing) return existing;
  const store: Store = { snapshot: { loading: Boolean(remote.getMediaSettings) }, started: false, listeners: new Set(), load: () => {}, selectModel: async () => false };
  const publish = (snapshot: Snapshot) => { store.snapshot = snapshot; store.listeners.forEach((listener) => listener()); };
  store.load = (force = false) => {
    if (!remote.getMediaSettings || store.pending || store.started && !force) return;
    store.started = true;
    publish({ ...(store.snapshot.view ? { view: store.snapshot.view } : {}), loading: true, switching: store.snapshot.switching ?? false });
    // Remote facades can throw before returning a promise (for example after disconnect).
    // Keep that failure inside the shared request so it cannot unmount a composer control.
    store.pending = Promise.resolve().then(() => remote.getMediaSettings!()).then((view) => publish({ view, loading: false }), () => publish({ ...(store.snapshot.view ? { view: store.snapshot.view } : {}), switching: store.snapshot.switching ?? false, loading: false, error: "模型与余额暂时无法读取，请刷新后查看。" })).finally(() => { delete store.pending; });
  };
  store.selectModel = async (id) => {
    const view = store.snapshot.view;
    const entry = view?.connections?.find(item => item.id === id);
    if (!view || !entry?.keyConfigured || !remote.manageMediaConnection || store.pending) return false;
    if (entry.isDefault) return true;
    publish({ view, loading: true, switching: true });
    let success = false;
    store.pending = Promise.resolve().then(async () => {
      try {
        const next = await remote.manageMediaConnection!({ expectedRevision: view.settings.revision, id, action: "set-default" });
        publish({ view: next, loading: false }); success = true;
      } catch {
        let latest = view, unconfirmed = true;
        try { latest = await remote.getMediaSettings!(); unconfirmed = false; } catch { /* Block generation until the current default is confirmed. */ }
        publish({ view: latest, loading: false, switching: unconfirmed, error: "模型切换未确认，请核对当前模型后重试。" });
      }
    }).finally(() => { delete store.pending; });
    await store.pending;
    return success;
  };
  stores.set(remote, store);
  return store;
}

/** One catalog request shared by shot cards and the design library; refresh is explicit. */
export function useMediaGenerationSettings(remote: MediaGenerationSettingsRemote): MediaGenerationSettingsState {
  const store = useMemo(() => storeFor(remote), [remote]);
  const snapshot = useSyncExternalStore((listener) => { store.listeners.add(listener); return () => { store.listeners.delete(listener); }; }, () => store.snapshot);
  useEffect(() => { store.load(); }, [store]);
  return { ...snapshot, supported: Boolean(remote.getMediaSettings), refresh: () => { store.load(true); }, ...(remote.manageMediaConnection ? { selectModel: store.selectModel } : {}) };
}
