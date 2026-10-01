import { userErrorMessage } from "@jizuo/contracts";
import { ActionIcon } from "../ui/ActionIcon.tsx";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "../ui/IconButton.tsx";
import type { SessionNavigation } from "./sessionNavigation.ts";

export function NewSessionDialog({ navigation, close, createWork }: {
  navigation?: SessionNavigation; close(created?: boolean): void; createWork(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    heading.current?.focus();
    return () => { element?.close(); };
  }, []);
  const run = async (operation: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try { if (await operation() !== false) close(true); }
    catch (reason) { setError(userErrorMessage(reason, "无法新建会话，请重试", { operation: "NewSessionDialog" })); }
    finally { pending.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className="jz-session-dialog" aria-label="新建会话" onCancel={(event) => {
    event.preventDefault(); if (!pending.current) close();
  }}>
    <header className="jz-session-dialog-header">
      <h3 ref={heading} tabIndex={-1}>新建会话</h3>
      <button type="button" className="jz-session-close" aria-label="取消" title="关闭" disabled={busy} onClick={() => { close(); }}>
        <ActionIcon name="close" className="" />
      </button>
    </header>
    {error !== null && <p className="jz-session-dialog-error" role="alert">{error}</p>}
    <div className="jz-session-choices">
      <IconButton icon="book" label="＋ 新建作品并开始会话" title="新建作品，开始创作" disabled={busy} onClick={createWork} />
      {navigation?.pickWorkspace !== undefined && <IconButton icon="library" label="从计算机选择文件夹…" title="选择文件夹，在本机文件夹中开始会话" disabled={busy}
        onClick={() => { void run(() => navigation.pickWorkspace!()); }} />}
    </div>
  </dialog>;
}
