import { userErrorMessage } from "@jizuo/contracts";
import { ActionIcon } from "../ui/ActionIcon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useRef, useState } from "react";
import type { SessionNavigation, WorkSessionItem } from "./sessionNavigation.ts";

export function WorkSessions({ workId, navigation, showCreate = true, showHeading = true }: { workId?: string; navigation: SessionNavigation; showCreate?: boolean; showHeading?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<WorkSessionItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useEffect(() => { setExpanded(false); }, [workId]);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      (workId === undefined ? navigation.listGeneralSessions!() : navigation.listWorkSessions(workId)).then((next) => {
        if (active && request === generation) { setItems(next); setError(null); }
      }).catch(() => { if (active && request === generation) setError("无法加载会话"); });
    };
    refresh();
    const stop = navigation.subscribe(refresh);
    return () => { active = false; stop(); };
  }, [workId, navigation, revision]);
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
      setRenaming(null);
      setRevision((value) => value + 1);
    } catch (reason) { setError(userErrorMessage(reason, "会话操作失败，请重试", { operation: "WorkSessions" })); }
    finally { pending.current = false; setBusy(false); }
  };
  const create = () => run(() => workId === undefined ? navigation.newGeneralSession!() : navigation.newWorkSession(workId));
  return <div className="jz-work-sessions" role="group" aria-label={workId === undefined ? "最近对话" : "对话"}>
    {(showHeading || showCreate) && <div className="jz-work-section-heading">
      {showHeading && <span><ActionIcon name="chat" className="" />{workId === undefined ? "最近对话" : "对话"}</span>}
      {showCreate && <IconButton icon="add" label={workId === undefined ? "新建普通会话" : "在作品内新建会话"} type="button" className="jz-section-create" aria-label={workId === undefined ? "新建普通会话" : "在作品内新建会话"} title="新建会话" disabled={busy} onClick={() => { void create(); }} />}
    </div>}
    {error !== null && <p role="alert">{error}</p>}
    {workId === undefined && items.length === 0 && error === null && <p className="jz-session-empty">先聊聊想法，也可以引用文件开始创作</p>}
    {(expanded ? items : items.slice(0, 3)).map((item) => <div key={item.id} className="jz-work-session-row">
      {renaming === item.id ? <form className="jz-inline-rename" onSubmit={(event) => {
        event.preventDefault();
        if (title.trim() !== "") void run(() => navigation.renameSession!(item.id, title.trim()));
      }}>
        <input autoFocus aria-label="会话名称" disabled={busy} value={title} onChange={(event) => { setTitle(event.target.value); }}
          onKeyDown={(event) => { if (event.key === "Escape" && !busy) setRenaming(null); }} />
        <IconButton icon="apply" label={"保存会话名称"} type="submit" className="jz-row-action" aria-label="保存会话名称" disabled={busy || title.trim() === ""} />
        <IconButton icon="close" label={"取消重命名会话"} type="button" className="jz-row-action" aria-label="取消重命名会话" disabled={busy} onClick={() => { setRenaming(null); }} />
      </form> : <>
        <button type="button" className="jz-tree-main" aria-current={item.current ? "page" : undefined}
          onClick={() => { navigation.openSession(item.id, workId); }}>{item.title}</button>
        {navigation.renameSession !== undefined && <IconButton icon="edit" label={(`重命名会话“${item.title}”`)} type="button" className="jz-row-action" aria-label={`重命名会话“${item.title}”`} title="重命名会话" disabled={busy}
          onClick={() => { setRenaming(item.id); setTitle(item.title); }} />}
        {navigation.archiveSession !== undefined && <IconButton icon="archive" label={(`归档会话“${item.title}”`)} type="button" className="jz-row-action" aria-label={`归档会话“${item.title}”`} title="归档会话" disabled={busy}
          onClick={() => { void run(() => navigation.archiveSession!(item.id)); }} />}
      </>}
    </div>)}
    {items.length > 3 && <IconButton icon="down" label={(expanded ? "收起" : "展开显示")} type="button" className="jz-session-expand" aria-expanded={expanded} disabled={busy}
      onClick={() => { setExpanded((value) => !value); setRenaming(null); }} />}
  </div>;
}
