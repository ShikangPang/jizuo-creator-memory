import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import type { WorkSummary } from "@jizuo/contracts";
import { WorksSidebarPanel } from "../../jizuo-client/src/sidebar/WorksSidebarPanel.tsx";
import { WorkSessions } from "../../jizuo-client/src/sidebar/WorkSessions.tsx";
import { MemoryPalaceEntry } from "../../jizuo-client/src/sidebar/MemoryPalaceEntry.tsx";
import { ActionIcon } from "../../jizuo-client/src/ui/ActionIcon.tsx";
import { clearSelection } from "../../jizuo-client/src/content/selection.ts";
import { setSidebarChromeWidth, clearSidebarChromeWidth } from "../../jizuo-client/src/overlay/shellChrome.ts";
import type { NativeShellHost } from "./shell-host.ts";
import "../../jizuo-client/src/sidebar/native-creation.css";

export function workspacePathKey(path: string): string {
  const value = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(value) || value.startsWith("//") ? value.toLowerCase() : value;
}

/** Register real project folders without creating conversations or changing files. */
export async function connectProjectWorkspaces(
  host: NativeShellHost, projects: readonly WorkSummary[],
  resolve: (id: string) => Promise<{ path: string }>,
  active: () => boolean = () => true,
): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  for (const project of projects) {
    if (!active()) break;
    const { path } = await resolve(project.id);
    if (!active()) break;
    paths.set(project.id, workspacePathKey(path));
    const exists = host.workspaces.list?.getSnapshot().items?.some(item => workspacePathKey(item.path) === workspacePathKey(path));
    if (!exists && host.workspaces.create) await host.workspaces.create({ path });
  }
  return paths;
}

/** Reuse the most recent visible conversation when entering an ordinary workspace. */
export function openWorkspaceConversation(host: NativeShellHost, workspaceId: Parameters<NativeShellHost["uiWorkspace"]["startSession"]>[0]): void {
  clearSelection();
  const workspaces = host.workspaces.list?.getSnapshot();
  const sessions = host.sessions?.list.getSnapshot();
  const members = workspaceId === undefined ? sessions?.ids ?? [] : workspaces?.items?.find(item => item.workspaceId === workspaceId)?.sessionIds ?? [];
  const candidates = members.flatMap(id => sessions?.byId[id] && !workspaces?.archivedSessionIds.includes(id) ? [sessions.byId[id]] : []);
  const recent = candidates.find(item => item.id === sessions?.current) ?? candidates.sort((a,b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  if (recent) host.sessions?.open(recent.id);
  else host.uiWorkspace.startSession(workspaceId);
}

/** Replaces only the workspace region; the host still owns navigation and sessions. */
export function NativeWorkspaces({ host, ...props }: ComponentProps<typeof WorksSidebarPanel> & { host: NativeShellHost }) {
  const [projects, setProjects] = useState<WorkSummary[]>([]);
  const [paths, setPaths] = useState(new Map<string, string>());
  const [error, setError] = useState<string | null>(null);
  const [, refresh] = useState(0);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [retry, setRetry] = useState(0);
  const region = useRef<HTMLDivElement>(null);
  const projectsChanged = useCallback((items: WorkSummary[]) => setProjects(old =>
    JSON.stringify(old.map(x => [x.id, x.folderName])) === JSON.stringify(items.map(x => [x.id, x.folderName])) ? old : items), []);
  useEffect(() => {
    const stops = [host.workspaces.list?.subscribe?.(() => refresh(x => x + 1)), host.sessions?.list.subscribe?.(() => refresh(x => x + 1))];
    const measure = () => { if (region.current) setSidebarChromeWidth(region.current.getBoundingClientRect().right); };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (region.current) observer?.observe(region.current);
    measure();
    return () => { stops.forEach(stop => stop?.()); observer?.disconnect(); clearSidebarChromeWidth(); };
  }, [host]);
  useEffect(() => {
    if (!props.remote.resolveWorkPath) return;
    let active = true;
    setError(null);
    void connectProjectWorkspaces(host, projects, props.remote.resolveWorkPath, () => active).then(result => {
      if (active) setPaths(result);
    }).catch(() => { if (active) setError("项目已保留，工作区关联失败，请重试。"); });
    return () => { active = false; };
  }, [host, projects, props.remote, retry]);
  const run = (action: () => Promise<unknown> | void) => {
    setError(null);
    void Promise.resolve().then(action).catch(() => setError("工作区操作未完成，请重试。"));
  };
  return <div ref={region} data-plugin="jizuo" data-surface="native-workspaces">
    <MemoryPalaceEntry />
    {error && <p role="alert">{error}<button onClick={() => setRetry(x => x + 1)}>重试</button></p>}
    <WorksSidebarPanel {...props} workspaceMode onWorksChanged={projectsChanged} extraWorkspaces={(query) => {
      const snapshot = host.workspaces.list?.getSnapshot();
      const sessions = host.sessions?.list.getSnapshot();
      const known = new Set(paths.values());
      const items = (snapshot?.items ?? []).filter(item => !known.has(workspacePathKey(item.path)));
      const ungrouped = sessions?.ids.filter(id => !(snapshot?.items ?? []).some(item => item.sessionIds.includes(id))) ?? [];
      const groups = [...items, ...(ungrouped.length ? [{ workspaceId: undefined, title: "未分组会话", path: "", sessionIds: ungrouped }] : [])];
      return <>{groups.filter(item => (item.title || item.path || "默认工作区").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(item => {
        const key = item.workspaceId ?? "ungrouped";
        const baseTitle = item.title || item.path.split(/[\\/]/).at(-1);
        const title = !baseTitle || baseTitle === "default-workspace" ? "默认工作区" : baseTitle;
        const isExpanded = expanded.has(key);
        return <section key={key} role="treeitem" aria-expanded={isExpanded} className="jz-work-node">
          <div className="jz-tree-row"><button className="jz-row-action" aria-label={`${isExpanded ? "折叠" : "展开"}${title}`} onClick={() => setExpanded(old => { const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next; })}><ActionIcon name={isExpanded ? "down" : "right"} /></button>
            <button className="jz-tree-main" onClick={() => run(() => openWorkspaceConversation(host, item.workspaceId))}><ActionIcon name="folder" />{title}</button>
            <button aria-label={`在${title}新建会话`} onClick={() => { clearSelection(); host.uiWorkspace.startSession(item.workspaceId); }}>＋</button>
          </div>
          {isExpanded && <WorkSessions showCreate={false} navigation={{
            listWorkSessions: async () => [],
            listGeneralSessions: async () => item.sessionIds.filter(id => !snapshot?.archivedSessionIds.includes(id)).map(id => ({
              id, title: sessions?.byId[id]?.title || sessions?.byId[id]?.displayTitle || "新会话", current: sessions?.current === id,
            })),
            subscribe: listener => { const a = host.sessions?.list.subscribe?.(listener); const b = host.workspaces.list?.subscribe?.(listener); return () => { a?.(); b?.(); }; },
            openSession: id => { clearSelection(); host.sessions?.open(id); },
            newWorkSession: async () => {},
            newGeneralSession: async () => { clearSelection(); host.uiWorkspace.startSession(item.workspaceId); },
            ...(props.sessionNavigation?.renameSession ? { renameSession: props.sessionNavigation.renameSession } : {}),
            ...(props.sessionNavigation?.archiveSession ? { archiveSession: props.sessionNavigation.archiveSession } : {}),
          }} /> }
        </section>;
      })}</>;
    }} />
    <button className="jz-add-workspace" onClick={() => run(async () => {
      const path = await host.uiWorkspace.pickDirectory?.();
      if (path) await host.workspaces.create?.({ path });
    })}>添加已有目录</button>
  </div>;
}
