import { clearSelection, getSelection, restoreWorkSelection, type JizuoContentRemote, type SessionNavigation } from "../../jizuo-client/src/shell.tsx";
import type { NativeShellHost } from "./client.tsx";

function pathKey(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

export function createSessionNavigation(host: NativeShellHost, remote: JizuoContentRemote): SessionNavigation & {
  openWork(workId: string): Promise<void>;
  dispose(): void;
} {
  const pending = new Map<string, Promise<void>>();
  const recent = new Map<string, string>();
  const recentKey = (workspaceId: string) => `jizuo.work.last-session:${workspaceId}`;
  const rememberCurrent = () => {
    const current = host.sessions?.list.getSnapshot().current;
    if (current === undefined) return;
    const workspace = host.workspaces.list?.getSnapshot().items?.find((item) => item.sessionIds.includes(current));
    if (workspace === undefined) return;
    recent.set(workspace.workspaceId, current);
    try { localStorage.setItem(recentKey(workspace.workspaceId), current); } catch { /* storage may be unavailable */ }
  };
  const stopRecent = host.sessions?.list.subscribe?.(rememberCurrent);
  rememberCurrent();
  const sessionItems = (sessionIds: readonly string[]) => {
    const snapshot = host.sessions?.list.getSnapshot();
    const archived = host.workspaces.list?.getSnapshot().archivedSessionIds ?? [];
    return sessionIds.flatMap((id) => {
      const item = snapshot?.byId[id];
      return item === undefined || archived.includes(id) ? [] : [item];
    }).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  };
  const summaries = (sessionIds: readonly string[]) => sessionItems(sessionIds).map((item) => ({
    id: item.id, title: item.title?.trim() || item.displayTitle?.trim() || "新会话", current: host.sessions?.list.getSnapshot().current === item.id,
  }));
  const open = (sessionId: string, workId?: string) => {
    if (host.sessions === undefined) throw new Error("当前运行时无法打开会话，请重新启动即作");
    host.sessions.open(sessionId);
    if (workId === undefined) clearSelection();
    else if (getSelection().workId !== workId) restoreWorkSelection(workId);
    rememberCurrent();
  };
  // Legacy work renames preserved the full stable ID suffix, but changed the title prefix.
  // Require the same storage root as well: an unrelated copied folder must not be adopted.
  const workspacesFor = (workId: string, path: string) => {
    const current = pathKey(path);
    const parent = current.slice(0, current.lastIndexOf("/"));
    const suffix = `--${workId.replace(/^work_/, "")}`;
    return (host.workspaces.list?.getSnapshot().items ?? []).filter((item) => {
      const candidate = pathKey(item.path);
      return candidate === current || (candidate.slice(0, candidate.lastIndexOf("/")) === parent
        && candidate.slice(candidate.lastIndexOf("/") + 1).endsWith(suffix));
    });
  };
  const workSession = (workId: string, fresh: boolean): Promise<void> => {
    const key = `${fresh ? "new" : "open"}:${workId}`;
    const existing = pending.get(key);
    if (existing !== undefined) return existing;
    const attempt = (async () => {
      if (remote.resolveWorkPath === undefined || host.workspaces.create === undefined || host.sessions === undefined) {
        throw new Error("当前运行时不支持作品会话，请重新启动即作");
      }
      const { path } = await remote.resolveWorkPath(workId);
      const related = workspacesFor(workId, path);
      const workspace = related.find((item) => pathKey(item.path) === pathKey(path)) ?? await host.workspaces.create({ path });
      const candidates = sessionItems([...new Set([...related.flatMap((item) => item.sessionIds), ...workspace.sessionIds])]);
      let last: string | undefined;
      for (const owner of [workspace, ...related]) {
        let saved = recent.get(owner.workspaceId);
        try { saved ??= localStorage.getItem(recentKey(owner.workspaceId)) ?? undefined; } catch { /* optional preference */ }
        if (candidates.some((item) => item.id === saved)) { last = saved; break; }
      }
      const current = host.sessions.list.getSnapshot().current;
      const reusable = fresh ? undefined : candidates.find((item) => item.id === current)
        ?? candidates.find((item) => item.id === last) ?? candidates[0];
      const sessionId = reusable?.id ?? await host.sessions.create({ workspaceId: workspace.workspaceId });
      if (!sessionId) throw new Error("会话创建未返回有效标识，请重试");
      recent.set(workspace.workspaceId, sessionId);
      try { localStorage.setItem(recentKey(workspace.workspaceId), sessionId); } catch { /* optional preference */ }
      open(sessionId, workId);
    })().finally(() => { pending.delete(key); });
    pending.set(key, attempt);
    return attempt;
  };
  return {
    newGeneralSession() {
      const existing = pending.get("general");
      if (existing !== undefined) return existing;
      const attempt = (async () => {
        if (host.sessions === undefined) throw new Error("当前运行时不支持普通会话，请重新启动即作");
        const sessionId = await host.sessions.create({});
        if (!sessionId) throw new Error("会话创建失败，请重试");
        open(sessionId);
      })().finally(() => { pending.delete("general"); });
      pending.set("general", attempt);
      return attempt;
    },
    async listGeneralSessions() {
      const works = await remote.listWorks();
      if (works.length > 0 && remote.resolveWorkPath === undefined) throw new Error("无法解析作品目录");
      const paths = await Promise.all(works.map(async (work) => ({ workId: work.id, path: (await remote.resolveWorkPath!(work.id)).path })));
      const workSessions = new Set(paths.flatMap(({ workId, path }) => workspacesFor(workId, path).flatMap((item) => item.sessionIds)));
      return summaries((host.sessions?.list.getSnapshot().ids ?? []).filter((id) => !workSessions.has(id)));
    },
    openWork: (workId) => workSession(workId, false),
    newWorkSession: (workId) => workSession(workId, true),
    openSession: open,
    async listWorkSessions(workId) {
      if (remote.resolveWorkPath === undefined) throw new Error("无法解析作品目录");
      const { path } = await remote.resolveWorkPath(workId);
      return summaries([...new Set(workspacesFor(workId, path).flatMap((item) => item.sessionIds))]);
    },
    subscribe(listener) {
      const stopSessions = host.sessions?.list.subscribe?.(listener);
      const stopWorkspaces = host.workspaces.list?.subscribe?.(listener);
      return () => { stopSessions?.(); stopWorkspaces?.(); };
    },
    async pickWorkspace() {
      if (host.uiWorkspace.pickDirectory === undefined || host.workspaces.create === undefined || host.sessions === undefined) {
        throw new Error("当前运行时不支持选择文件夹，请重新启动即作");
      }
      const path = await host.uiWorkspace.pickDirectory();
      if (path === null) return false;
      // Resolve works by their actual directory, never by a mutable display title.
      for (const work of await remote.listWorks()) {
        if (remote.resolveWorkPath === undefined) throw new Error("无法解析作品目录");
        const workPath = (await remote.resolveWorkPath(work.id)).path;
        if (pathKey(workPath) === pathKey(path)
          || workspacesFor(work.id, workPath).some((item) => pathKey(item.path) === pathKey(path))) {
          await workSession(work.id, true);
          return true;
        }
      }
      const workspace = await host.workspaces.create({ path });
      const sessionId = await host.sessions.create({ workspaceId: workspace.workspaceId });
      if (!sessionId) throw new Error("会话创建失败，请重试");
      open(sessionId);
      return true;
    },
    async renameSession(sessionId, title) {
      const session = host.sessions?.binding?.(sessionId)?.session;
      if (session === undefined) throw new Error("当前运行时不支持重命名会话");
      const result = await session.rename(title);
      if (!result.ok) throw new Error(result.error.message);
    },
    async archiveSession(sessionId) {
      if (host.workspaces.archiveSession === undefined) throw new Error("当前运行时不支持归档会话");
      await host.workspaces.archiveSession(sessionId);
    },
    dispose() { stopRecent?.(); },
  };
}
