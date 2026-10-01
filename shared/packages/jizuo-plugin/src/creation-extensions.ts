export type CreationExtensionId = "account" | "media-models";
const enabled = new Set<CreationExtensionId>();
const listeners = new Set<() => void>();
export function creationExtensionEnabled(id: CreationExtensionId) { return enabled.has(id); }
export function subscribeCreationExtensions(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function registerCreationExtension(id: CreationExtensionId) {
  if (enabled.has(id)) throw new Error(`Duplicate Jizuo extension: ${id}`);
  enabled.add(id);
  for (const listener of listeners) listener();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    enabled.delete(id);
    for (const listener of listeners) listener();
  };
}
export function registerForCreationExtension(id: CreationExtensionId, install: () => () => void) {
  let dispose: (() => void) | undefined;
  const sync = () => {
    if (enabled.has(id) && !dispose) dispose = install();
    else if (!enabled.has(id) && dispose) { dispose(); dispose = undefined; }
  };
  const stop = subscribeCreationExtensions(sync);
  sync();
  return () => { stop(); dispose?.(); };
}
