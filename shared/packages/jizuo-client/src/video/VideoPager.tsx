import { IconButton } from "../ui/IconButton.tsx";
import "./video-pager.css";
export function VideoPager({ label, items, currentId, onChange, disabled }: {
  label: string; items: { id: string; title: string }[]; currentId: string; onChange: (id: string) => void; disabled?: boolean;
}) {
  const index = items.findIndex(item => item.id === currentId);
  if (index < 0) return null;
  return <nav className="jz-video-pager" aria-label={`${label}翻页`}>
    <IconButton icon="left" label={(`上一${label}`)} type="button" disabled={disabled || index === 0} aria-label={`上一${label}`} onClick={() => onChange(items[index - 1]!.id)} />
    <select aria-label={`跳转${label}`} value={currentId} disabled={disabled} onChange={event => onChange(event.target.value)}>
      {items.map((item, i) => <option key={item.id} value={item.id}>{i + 1}. {item.title}</option>)}
    </select>
    <span aria-live="polite">{index + 1} / {items.length}</span>
    <IconButton icon="right" label={(`下一${label}`)} type="button" disabled={disabled || index === items.length - 1} aria-label={`下一${label}`} onClick={() => onChange(items[index + 1]!.id)} />
  </nav>;
}
