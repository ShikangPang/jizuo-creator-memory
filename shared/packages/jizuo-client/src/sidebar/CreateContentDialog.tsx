import { ActionIcon } from "../ui/ActionIcon.tsx";
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
  const name = kind === "work" ? "项目" : kind === "volume" ? "分卷" : "章节";
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
      {kind === "work" && onProjectKindChange && <fieldset className="jz-create-project-kinds" disabled={busy}>
        <legend>项目类型</legend>
        <div className="jz-create-project-kind-options">
          {(["novel", "video"] as const).map(value => {
            const available = (availableKinds ?? ["novel", "video"]).includes(value);
            const label = value === "video" ? "视频" : "小说";
            return <label key={value} data-selected={projectKind === value} data-disabled={!available}>
              <input type="radio" name="projectKind" value={value} checked={projectKind === value} disabled={!available}
                onChange={() => onProjectKindChange(value)} aria-label={label} />
              <ActionIcon name={value === "video" ? "video" : "novel"} className="jz-icon" />
              <span>{label}</span>
              {!available && <small>请先启用{value === "video" ? "视频" : "写作"}插件</small>}
            </label>;
          })}
        </div>
      </fieldset>}
      {context && <p className="jz-create-content-context" id={contextId} title={context}>{context}</p>}
      <label>
        <span>{name}名称</span>
        <input ref={input} aria-label={`${name}名称`} placeholder={`输入${name}名称`} value={title} disabled={busy}
          onChange={(event) => { onTitleChange(event.target.value); }} />
      </label>
      {error !== null && <p className="jz-session-dialog-error" role="alert">{error}</p>}
      <div className="jz-create-content-actions">
        <button type="button" disabled={busy} onClick={close}>取消</button>
        <button type="submit" className="jz-create-content-confirm" aria-label={`确认新建${name}`} disabled={busy || title.trim() === ""}>{busy ? "创建中…" : "创建"}</button>
      </div>
    </form>
  </dialog>;
}
