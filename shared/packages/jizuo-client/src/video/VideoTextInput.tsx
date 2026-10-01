import { useEffect, useRef, useState, type TextareaHTMLAttributes } from "react";

/** Keep typing and IME composition local; publish preview updates in short batches. */
export function VideoTextInput({ value, onTextChange, onBlur, onKeyDown, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string; onTextChange: (value: string) => void;
}) {
  const [local, setLocal] = useState(value);
  const latest = useRef(value), dirty = useRef(false), composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const change = useRef(onTextChange); change.current = onTextChange;
  const flush = () => {
    clearTimeout(timer.current);
    if (dirty.current) { dirty.current = false; change.current(latest.current); }
  };
  useEffect(() => {
    if (!dirty.current && !composing.current) { latest.current = value; setLocal(value); }
  }, [value]);
  const flushRef = useRef(flush); flushRef.current = flush;
  useEffect(() => {
    const handler = () => { if (!composing.current) flushRef.current(); };
    document.addEventListener("jizuo:flush-text-input", handler);
    return () => { document.removeEventListener("jizuo:flush-text-input", handler); clearTimeout(timer.current); };
  }, []);
  return <textarea {...props} value={local}
    onChange={event => {
      latest.current = event.target.value; dirty.current = true; setLocal(event.target.value);
      clearTimeout(timer.current);
      if (!composing.current) timer.current = setTimeout(flush, 100);
    }}
    onCompositionStart={() => { composing.current = true; clearTimeout(timer.current); }}
    onCompositionEnd={event => { composing.current = false; latest.current = event.currentTarget.value; dirty.current = true; flush(); }}
    onBlur={event => { composing.current = false; flush(); onBlur?.(event); }}
    onKeyDown={event => {
      if (!event.nativeEvent.isComposing && event.key === "Enter" && (event.ctrlKey || event.metaKey)) flush();
      if (onKeyDown && !event.nativeEvent.isComposing && event.key === "Escape") { clearTimeout(timer.current); dirty.current = false; }
      onKeyDown?.(event);
    }} />;
}
