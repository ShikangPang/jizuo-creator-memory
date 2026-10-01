import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "./IconButton.tsx";
import { useEffect, useId, useRef, useState } from "react";
import "./inline-name-editor.css";

/** Keep the draft in place until saved or explicitly cancelled. */
export function InlineNameEditor({ value, label, disabled = false, onSave, onCancel }: {
  value: string; label: string; disabled?: boolean;
  onSave: (name: string) => Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState(value);
  const [base, setBase] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false), input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const conflict = value !== base;
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const save = async () => {
    if (pending.current || disabled || conflict || !name.trim()) return;
    if (name.trim() === base) { onCancel(); return; }
    pending.current = true; setBusy(true); setError("");
    try { await onSave(name.trim()); }
    catch (cause) { setError(userErrorMessage(cause, "修改失败，输入已保留", { operation: "InlineNameEditor" })); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="jz-inline-name-editor" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <form className="jz-inline-name-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <input ref={input} aria-label={label} aria-describedby={error || conflict ? errorId : undefined} aria-invalid={Boolean(error || conflict)}
        value={name} maxLength={120} disabled={busy || disabled} onChange={event => { setName(event.target.value); setError(""); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === "Enter") event.preventDefault(); return; }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!pending.current) onCancel(); }
          if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void save(); }
        }}/>
      <IconButton icon="apply" label={"保存名称"} type="submit" className="jz-row-action" aria-label="保存名称" title="保存名称（回车）" disabled={busy || disabled || conflict || !name.trim()} />
      <IconButton icon="close" label={"取消重命名"} type="button" className="jz-row-action" aria-label="取消重命名" title="取消（Esc）" disabled={busy} onClick={onCancel} />
    </form>
    {(error || conflict) && <div id={errorId} className="jz-inline-name-error" role="alert">
      {conflict ? <>名称已有更新，输入已保留。<IconButton icon="reset" label={"载入最新名称"} type="button" disabled={busy} onClick={() => { setName(value); setBase(value); setError(""); input.current?.focus(); }} /></> : error}
    </div>}
  </div>;
}
