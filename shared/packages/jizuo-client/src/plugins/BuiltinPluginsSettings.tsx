import { useState } from "react";
import { useSelection } from "../content/selection.ts";
import { WORKSPACE_PLUGINS, pluginForOverlay } from "./registry.ts";
import { isBuiltinPluginEnabled, setBuiltinPluginEnabled, useWorkspacePlugins } from "./preferences.ts";
import "./plugins-settings.css";

export function BuiltinPluginsSettings() {
  useWorkspacePlugins();
  const selection = useSelection();
  const [error, setError] = useState<string>();
  return <section className="jz-builtin-plugins" aria-label="创作插件设置">
    <h2>创作插件</h2>
    <p>控制所有项目的界面功能。关闭后保留内容，不影响聊天生成与后台任务。设置保存在当前设备。</p>
    {WORKSPACE_PLUGINS.map(plugin => {
      const enabled = isBuiltinPluginEnabled(plugin.id);
      const editing = enabled && pluginForOverlay(selection.overlay)?.id === plugin.id;
      return <label className="jz-builtin-plugin" key={plugin.id}>
        <span><strong>{plugin.label}</strong><small>{plugin.description}</small>
          {editing && <small>请先关闭编辑面板再停用。</small>}</span>
        <input type="checkbox" role="switch" aria-label={`${plugin.label}插件`} checked={enabled} disabled={editing}
          onChange={event => {
            try { setBuiltinPluginEnabled(plugin.id, event.target.checked); setError(undefined); }
            catch { setError("插件设置未保存，请检查本地存储后重试。"); }
          }} />
      </label>;
    })}
    <p>启用后，可在各项目的「项目功能」中单独收起不需要的插件。</p>
    {error && <p role="alert">{error}</p>}
  </section>;
}
