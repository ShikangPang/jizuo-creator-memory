import { useEffect, useState } from "react";
export function useEditorPreference<T>(key: string, fallback: T, valid: (value: unknown) => value is T) {
  const [value, setValue] = useState<T>(() => {
    try { const saved: unknown = JSON.parse(localStorage.getItem(`jizuo.editor.${key}`) ?? "null"); return valid(saved) ? saved : fallback; } catch { return fallback; }
  });
  useEffect(() => { try { localStorage.setItem(`jizuo.editor.${key}`, JSON.stringify(value)); } catch { /* Storage unavailable: keep this session editable. */ } }, [key, value]);
  return [value, setValue] as const;
}
export const validLayout = (value: unknown): value is string => typeof value === "string" && ["default","portrait-left","portrait-right","materials","properties"].includes(value);
export const validPanelWidths = (value: unknown): value is {library:number;properties:number} => Boolean(value && typeof value === "object" && ["library","properties"].every(key => { const width = (value as Record<string,unknown>)[key]; return typeof width === "number" && Number.isFinite(width) && width >= 180 && width <= 480; }));
export const validTimelineHeight = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 180 && value <= 600;
export const validTimelineZoom = (value: unknown): value is number | null => value === null || typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 64;
