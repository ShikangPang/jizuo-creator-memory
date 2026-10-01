import { useWorkspacePlugins } from "../plugins/preferences.ts";
import { setSelection, useSelection } from "../content/selection.ts";
import { IconButton } from "../ui/IconButton.tsx";
import "./main-video-composer.css";

export function ComposerWorkspaceAccess() {
  const selection = useSelection();
  const enabled = useWorkspacePlugins();
  if (!enabled(selection.workId, "video")) return null;
  return <IconButton icon="library" label="工作区" className="jz-composer-workspace-access" onClick={() => setSelection({mode: "video", overlay: "video"})} />;
}
