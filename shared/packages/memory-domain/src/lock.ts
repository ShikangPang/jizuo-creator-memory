/** Serializes local writers across repository instances owned by the single desktop host. */
const locks = new Map<string, Promise<unknown>>();
export async function withMemoryLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  locks.set(key, next);
  try { return await next; }
  finally { if (locks.get(key) === next) locks.delete(key); }
}
