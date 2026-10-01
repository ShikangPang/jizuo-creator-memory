import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import "./update-notice.css";

export interface UpdateNotice {
  id: string;
  kind: "available" | "information" | "error" | "downloading" | "installing";
  title: string;
  message: string;
  version: string | null;
  notes: string | null;
}

export interface UpdateNoticeStore {
  getSnapshot(): UpdateNotice | null;
  subscribe(listener: () => void): () => void;
  respond(id: string, accept: boolean): Promise<void>;
}

export function UpdateNoticeDialog({ store }: { store: UpdateNoticeStore }) {
  const notice = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const [responding, setResponding] = useState(false);
  const [responseError, setResponseError] = useState<string>();

  useEffect(() => {
    const element = dialog.current;
    if (!element || !notice) return;
    if (typeof element.showModal === "function") element.showModal();
    else element.setAttribute("open", "");
    return () => { if (typeof element.close === "function") element.close(); };
  }, [notice?.id]);

  useEffect(() => {
    setResponding(false);
    setResponseError(undefined);
  }, [notice?.id]);

  if (!notice) return null;
  const busy = responding || notice.kind === "downloading" || notice.kind === "installing";
  const respond = async (accept: boolean) => {
    if (busy) return;
    setResponding(true);
    setResponseError(undefined);
    try { await store.respond(notice.id, accept); }
    catch { setResponseError("暂时无法处理更新操作，请重试。"); setResponding(false); }
  };

  return <dialog ref={dialog} className="jz-update-dialog" aria-labelledby="jz-update-title"
    aria-describedby="jz-update-description" onCancel={event => {
      event.preventDefault();
      if (!busy) void respond(false);
    }}>
    <div className="jz-update-dialog-inner">
      <div className="jz-update-eyebrow"><span className="jz-update-mark" aria-hidden="true">↗</span> 即作更新</div>
      <h2 id="jz-update-title">{notice.title}</h2>
      {notice.version && <p className="jz-update-version">版本 {notice.version}</p>}
      <p id="jz-update-description" className="jz-update-description">{notice.message}</p>
      {notice.notes && <section className="jz-update-notes" aria-label="更新说明"><h3>更新说明</h3><p>{notice.notes}</p></section>}
      {responseError && <p className="jz-update-error" role="alert">{responseError}</p>}
      <div className="jz-update-actions">
        {notice.kind === "available" ? <>
          <button type="button" className="jz-update-secondary" disabled={busy} onClick={() => { void respond(false); }}>稍后</button>
          <button type="button" className="jz-update-primary" disabled={busy} onClick={() => { void respond(true); }}>{responding ? "正在处理…" : "下载并安装"}</button>
        </> : notice.kind === "downloading" || notice.kind === "installing" ?
          <span className="jz-update-working" role="status"><span className="jz-update-spinner" aria-hidden="true" />请稍候</span> :
          <button type="button" className="jz-update-primary" disabled={busy} onClick={() => { void respond(false); }}>知道了</button>}
      </div>
    </div>
  </dialog>;
}
