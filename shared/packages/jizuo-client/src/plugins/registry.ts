/** Built-in UI contributions. Data, AI tools and background jobs belong to the host. */
export const WORKSPACE_PLUGINS = [
  { id: "writing", label: "写作", description: "章节列表、分卷、大纲与正文编辑", mode: "novel", icon: "book", overlays: ["chapter", "volume"] },
  { id: "video", label: "视频", description: "分镜、镜头、时间线编辑与导出", mode: "video", icon: "video", overlays: ["video"] },
  { id: "memory", label: "记忆", description: "人物、事件与关联记忆", mode: null, icon: "memory", overlays: ["memory"] },
] as const;
export type WorkspacePluginId = typeof WORKSPACE_PLUGINS[number]["id"];
export function pluginForOverlay(overlay: string | null) {
  return WORKSPACE_PLUGINS.find(plugin => (plugin.overlays as readonly string[]).includes(overlay ?? ""));
}
