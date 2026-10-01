import type { WorkflowRunsStore } from "./workflowStore.ts";

const runningStatuses = new Set(["queued", "running", "retrying", "memory_pending"]);

/** Session-addressed bridge to the pinned Harness composer's native stop action. */
export function bindWorkflowComposerStop(store: WorkflowRunsStore): () => void {
  let publishedSession: string | undefined;
  const running = () => store.getSnapshot().runs.filter((run) => runningStatuses.has(run.status));
  const publish = () => {
    const { sessionId } = store.getSnapshot();
    if (publishedSession !== undefined && publishedSession !== sessionId) {
      window.dispatchEvent(new CustomEvent("jizuo:workflow-state", { detail: { sessionId: publishedSession, active: false } }));
    }
    publishedSession = sessionId;
    if (sessionId !== undefined) window.dispatchEvent(new CustomEvent("jizuo:workflow-state", {
      detail: { sessionId, active: running().length > 0 },
    }));
  };
  const query = (event: Event) => {
    if ((event as CustomEvent).detail?.sessionId === store.getSnapshot().sessionId) publish();
  };
  const stop = (event: Event) => {
    const detail = (event as CustomEvent<{ sessionId?: string; completion?: Promise<void> }>).detail;
    if (!detail?.sessionId || detail.sessionId !== store.getSnapshot().sessionId || detail.completion) return;
    // Capture identities synchronously: switching sessions during the request
    // must not stop the newly selected conversation's workflow.
    const runs = running();
    detail.completion = (async () => {
      // A newly launched task may not have reached the progress long-poll yet.
      if (runs.length === 0) await store.refresh();
      if (store.getSnapshot().sessionId !== detail.sessionId) return;
      await Promise.all((runs.length > 0 ? runs : running()).map((run) => store.pause(run.runId)));
    })();
  };
  const unsubscribe = store.subscribe(publish);
  window.addEventListener("jizuo:workflow-query", query);
  window.addEventListener("jizuo:workflow-stop", stop);
  publish();
  return () => {
    unsubscribe();
    window.removeEventListener("jizuo:workflow-query", query);
    window.removeEventListener("jizuo:workflow-stop", stop);
    if (publishedSession !== undefined) window.dispatchEvent(new CustomEvent("jizuo:workflow-state", {
      detail: { sessionId: publishedSession, active: false },
    }));
  };
}
