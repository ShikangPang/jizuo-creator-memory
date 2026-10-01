import { ActionIcon } from "../ui/ActionIcon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useId, useRef, type FormEvent } from "react";

export function CreateContentDialog({ kind, projectKind, onProjectKindChange, availableKinds, context, title, busy, error, onTitleChange, onSubmit, close }: {
  kind: "work" | "volume" | "chapter";
  projectKind?: "novel" | "video";
  onProjectKindChange?: (kind: "novel" | "video") => void;
  availableKinds?: readonly ("novel" | "video")[];
  context?: string | undefined;
  title: string;
  busy: boolean;
  error: string | null;
  onTitleChange(title: string): void;
  onSubmit(event: FormEvent): void;
  close(): void;
}) {
  const name = kind === "work" ? (projectKind === "video" ? "视频项目" : "小说项目") : kind === "volume" ? "分卷" : "章节";
  const contextId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    return () => { element?.close(); };
  }, []);
  return <dialog ref={dialog} className="jz-session-dialog jz-create-content-dialog" aria-label={`新建${name}`}
    aria-describedby={context ? contextId : undefined}
    onCancel={(event) => { event.preventDefault(); if (!busy) close(); }}>
    <header className="jz-session-dialog-header">
      <h3>新建{name}</h3>
      <button type="button" className="jz-session-close" aria-label={`关闭新建${name}`} title="关闭" disabled={busy} onClick={close}>
        <ActionIcon name="close" className="" />
      </button>
    </header>
    <form className="jz-create-content-form" onSubmit={onSubmit}>
      {kind === "work" && onProjectKindChange && <label><span>项目类型</span><select aria-label="项目类型" value={projectKind} disabled={busy} onChange={event => onProjectKindChange(event.target.value as "novel" | "video")}>
        {(availableKinds ?? ["novel", "video"]).map(kind => <option key={kind} value={kind}>{kind === "video" ? "视频" : "小说"}</option>)}
      </select></label>}
      {context && <p className="jz-create-content-context" id={contextId} title={context}>{context}</p>}
      <label>
        <span>{name}名称</span>
        <input ref={input} aria-label={`${name}名称`} placeholder={kind === "work" ? "为你的作品起个名字" : `输入${name}名称`} value={title} disabled={busy}
          onChange={(event) => { onTitleChange(event.target.value); }} />
      </label>
      {error !== null && <p className="jz-session-dialog-error" role="alert">{error}</p>}
      <div className="jz-create-content-actions">
        <IconButton icon="close" label={"取消"} type="button" disabled={busy} onClick={close} />
        <IconButton icon="add" label={(`确认新建${name}`)} type="submit" className="jz-create-content-confirm" aria-label={`确认新建${name}`} disabled={busy || title.trim() === ""} />
      </div>
    </form>
  </dialog>;
}
