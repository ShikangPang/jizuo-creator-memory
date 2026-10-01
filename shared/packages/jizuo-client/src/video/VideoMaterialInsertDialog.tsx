import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useRef } from "react";
export function VideoMaterialInsertDialog({ target, busy, error, insert, close }: { target: string | undefined; busy: boolean; error: string | null; insert: (side: "before" | "after") => void; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; if (dialog && !dialog.open) { if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", ""); } }, []);
  return <dialog ref={ref} className="jz-material-insert-dialog" aria-label="插入素材位置" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <strong>插入素材</strong><p>{target ? `放在「${target}」之前还是之后？` : "当前时间线为空，将作为第一个片段加入。"}</p>
    <div className="jz-video-tools">{target ? <><IconButton icon="left" label={"放在片段之前"} type="button" disabled={busy} onClick={() => insert("before")} /><IconButton icon="right" label={"放在片段之后"} type="button" disabled={busy} onClick={() => insert("after")} /></> : <IconButton icon="add" label={"加入时间线"} type="button" disabled={busy} onClick={() => insert("after")} />}<IconButton icon="close" label={"取消"} type="button" disabled={busy} onClick={close} /></div>
    {error && <p role="alert">{error}</p>}
  </dialog>;
}
