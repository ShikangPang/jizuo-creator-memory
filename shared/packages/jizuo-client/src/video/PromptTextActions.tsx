/** Saved/current prompt stays selectable even when its subject is locked or generating. */
export function PromptTextActions({ prompt, onChange, readOnly = false, maxLength = 10000 }: { prompt: string; onChange?: (prompt: string) => void; readOnly?: boolean; maxLength?: number }) {
  const editable = Boolean(onChange) && !readOnly;
  return <label className="jz-design-prompt">提示词<textarea aria-label="提示词文本" rows={5} value={prompt} readOnly={!editable} maxLength={editable ? maxLength : undefined} onChange={event => { if (editable) onChange?.(event.target.value); }} placeholder={editable ? "直接编辑提示词，或在主聊天中让 AI 生成并保存。" : "尚未设置提示词，可在主聊天中与 AI 一起完善。"} /></label>;
}
