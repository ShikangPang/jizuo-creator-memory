import { useState } from "react";
import { useSelection } from "../content/selection.ts";
import { WORKSPACE_PLUGINS, pluginForOverlay } from "./registry.ts";
import { isBuiltinPluginEnabled, setWorkspacePluginEnabled, useWorkspacePlugins } from "./preferences.ts";

export function ProjectFeatures({ workId, projectKind }: { workId: string; projectKind?: "novel" | "video" }) {
  const enabled = useWorkspacePlugins();
  const selection = useSelection();
  const [error, setError] = useState<string>();
  return <details className="jz-project-features">
    <summary>项目功能</summary>
    <p>选择此项目的功能入口，停用后保留已有内容。</p>
    {WORKSPACE_PLUGINS.filter(plugin => !projectKind || !plugin.mode || plugin.mode === projectKind).map(plugin => {
      const editing = selection.workId === workId && pluginForOverlay(selection.overlay)?.id === plugin.id;
      return <label key={plugin.id}>
        <input type="checkbox" aria-label={`${plugin.label}插件`} checked={enabled(workId, plugin.id)} disabled={editing || !isBuiltinPluginEnabled(plugin.id)}
          onChange={event => {
            try { setWorkspacePluginEnabled(workId, plugin.id, event.target.checked); setError(undefined); }
            catch (cause) { setError((cause as Error).message); }
          }} />
        <span><strong>{plugin.label}</strong><small>{!isBuiltinPluginEnabled(plugin.id) ? "请先在设置 → 内置插件中启用" : editing ? "请先关闭编辑面板再停用" : plugin.description}</small></span>
      </label>;
    })}
    {error && <p role="alert">{error}</p>}
  </details>;
}
