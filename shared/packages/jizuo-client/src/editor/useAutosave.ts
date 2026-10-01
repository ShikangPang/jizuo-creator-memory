import { useCallback, useEffect, useRef, useState } from "react";

export type AutosaveState = "idle" | "pending" | "saving" | "saved" | "conflict" | "error";

export interface UseAutosaveOptions<T> {
  resetKey: string | null;
  content: string;
  savedContent: string;
  enabled: boolean;
  delay?: number;
  save: (content: string) => Promise<T>;
  isConflict: (error: unknown) => boolean;
  onSaved: (value: T) => void;
  onConflict: (error: unknown) => void;
  onError: (error: unknown) => void;
}

export function useAutosave<T>(options: UseAutosaveOptions<T>) {
  const [state, setState] = useState<AutosaveState>("idle");
  const blocked = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    blocked.current = false;
    setState("idle");
  }, [options.resetKey]);

  const performSave = useCallback(async (content: string) => {
    const current = optionsRef.current;
    if (!current.enabled || blocked.current || content === current.savedContent) return;
    setState("saving");
    try {
      const saved = await current.save(content);
      setState("saved");
      current.onSaved(saved);
    } catch (error) {
      if (current.isConflict(error)) {
        blocked.current = true;
        setState("conflict");
        current.onConflict(error);
      } else {
        setState("error");
        current.onError(error);
      }
    }
  }, []);

  useEffect(() => {
    if (!options.enabled || blocked.current || options.content === options.savedContent) return;
    setState("pending");
    const timeout = globalThis.setTimeout(() => {
      void performSave(options.content);
    }, options.delay ?? 800);
    return () => { globalThis.clearTimeout(timeout); };
  }, [options.content, options.delay, options.enabled, options.savedContent, performSave]);

  return {
    state,
    saveNow: () => performSave(optionsRef.current.content),
  };
}
