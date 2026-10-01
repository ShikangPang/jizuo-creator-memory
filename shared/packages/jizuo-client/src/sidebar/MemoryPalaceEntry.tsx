import { setSelection, useSelection } from "../content/selection.ts";
import { isBuiltinPluginEnabled, isWorkspacePluginAvailable, useWorkspacePlugins } from "../plugins/preferences.ts";
import { ActionIcon } from "../ui/ActionIcon.tsx";

export function MemoryPalaceEntry() {
  const selection = useSelection();
  const enabled = useWorkspacePlugins();
  if (!isWorkspacePluginAvailable("memory") || !isBuiltinPluginEnabled("memory")
    || selection.workId !== null && !enabled(selection.workId, "memory")) return null;
  return <button type="button" className="jz-memory-palace-entry" aria-label="打开记忆宫殿"
    title={selection.workId === null ? "请先选择作品" : "打开记忆宫殿"}
    disabled={selection.workId === null} aria-pressed={selection.overlay === "memory"}
    onClick={() => setSelection({ overlay: "memory" })}>
    <span aria-hidden="true"><ActionIcon name="memory" /></span><span>记忆宫殿</span>
  </button>;
}
