import { reportClientError, type ClientDiagnostic, installDiagnosticSink } from "@jizuo/contracts";

/** Observe RPC failures without changing results, arguments or submission counts. */
export function observeClientRemote<T extends object>(remote: T): T {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(remote, {
    get(target, key) {
      const member: unknown = Reflect.get(target, key);
      if (typeof member !== "function") return member;
      if (!methods.has(key)) methods.set(key, async (...args: unknown[]) => {
        const context = { operation: String(key), effect: /^(get|read|list|query|search|describe|accountGet)/i.test(String(key)) ? "read" as const : "write" as const };
        try {
          const result = await Reflect.apply(member, target, args);
          if (result && typeof result === "object" && result.ok === false) reportClientError(result.error, context);
          return result;
        } catch (error) { reportClientError(error, context); throw error; }
      });
      return methods.get(key);
    },
  });
}
export function installClientErrors(write: (entry: ClientDiagnostic) => Promise<void>, target: Window): () => void {
  const stop = installDiagnosticSink(write);
  const onError = (event: ErrorEvent) => reportClientError(event.error ?? event.message, { operation: "window.error" });
  const onRejection = (event: PromiseRejectionEvent) => reportClientError(event.reason, { operation: "window.unhandledrejection" });
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
    stop();
  };
}
