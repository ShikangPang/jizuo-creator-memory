import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { JizuoWorkflowRemote } from "../content/remote.ts";
import {
  WorkflowRunsStore,
  type WorkflowRunsSnapshot,
  type WorkflowSessionSource,
} from "./workflowStore.ts";

export interface UseWorkflowRunsOptions {
  readonly remote: JizuoWorkflowRemote;
  readonly sessions: WorkflowSessionSource;
}

/**
 * Mounts the session-bound projection store for a conversation surface.
 * The store is deliberately created per mounted consumer and cancels its
 * long-poll before React discards that consumer.
 */
export function useWorkflowRuns(options: UseWorkflowRunsOptions): WorkflowRunsStore {
  const store = useMemo(
    () => new WorkflowRunsStore({ remote: options.remote, sessions: options.sessions }),
    [options.remote, options.sessions],
  );
  useEffect(() => {
    store.start();
    return () => { store.dispose(); };
  }, [store]);
  return store;
}

export function useWorkflowRunsSnapshot(store: WorkflowRunsStore): WorkflowRunsSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
