import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";

interface Entry<T> { value?: T; pending?: Promise<T>; expires: number; generation: number; watcher?: FSWatcher }

/** Read-only snapshots: watches invalidate, TTL reconciles missed external events. Never use for write authorization. */
export class WatchedReadCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  constructor(private readonly relevant: (filename: string) => boolean = () => true, private readonly ttlMs = 30_000, private readonly limit = 32) {}
  invalidate(root: string): void {
    const entry = this.entries.get(resolve(root));
    if (entry) { entry.generation++; delete entry.value; entry.expires = 0; }
  }
  clear(): void { for (const entry of this.entries.values()) entry.watcher?.close(); this.entries.clear(); }
  get(root: string, load: () => Promise<T>): Promise<T> {
    const key = resolve(root);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { expires: 0, generation: 0 };
      this.entries.set(key, entry);
      try {
        entry.watcher = watch(key, { recursive: true, persistent: false }, (_event, filename) => {
          if (filename === null || this.relevant(String(filename).replaceAll("\\", "/"))) this.invalidate(key);
        });
        entry.watcher.on("error", () => {
          entry!.watcher?.close(); delete entry!.watcher;
          // Losing the watcher is not a content change; shorten reconciliation instead.
          entry!.expires = Math.min(entry!.expires, Date.now() + 1000);
        });
      } catch { /* A missing/unwatchable root uses the short reconciliation TTL. */ }
      while (this.entries.size > this.limit) {
        const oldest = this.entries.keys().next().value!;
        this.entries.get(oldest)?.watcher?.close(); this.entries.delete(oldest);
      }
    }
    // An in-flight scan must not be duplicated just because a TTL expired.
    if (entry.pending) return entry.pending;
    if (entry.value !== undefined && Date.now() < entry.expires) return Promise.resolve(entry.value);
    const current = entry;
    const pending = (async () => {
      for (let attempt = 0; ; attempt++) {
        const generation = current.generation;
        const value = await load();
        if (generation === current.generation) {
          current.value = value; current.expires = Date.now() + (current.watcher ? this.ttlMs : Math.min(1000, this.ttlMs)); return value;
        }
        if (attempt >= 1) return value; // A continuously changing tree is not cached.
      }
    })();
    current.pending = pending;
    void pending.finally(() => { if (current.pending === pending) delete current.pending; }).catch(() => {});
    return pending;
  }
}
