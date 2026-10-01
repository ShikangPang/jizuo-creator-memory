import { JizuoBrandMark } from "../brand/JizuoBrandMark.tsx";

export function JizuoBrand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="jz-sidebar-brand">
      <JizuoBrandMark size={26} className="jz-sidebar-mark" />
      {!compact && <span className="jz-sidebar-wordmark">即作</span>}
    </span>
  );
}
