import { useEffect, useRef, useState } from "react";
import type { VideoAsset } from "@jizuo/contracts";
import type { VideoAssetsRemote } from "./assets-remote.ts";
import { InlineNameEditor } from "../ui/InlineNameEditor.tsx";
import { publishVideoProject } from "./useVideoProject.ts";

export function VideoAssetLabelEditor({ asset, workId, revision, remote }: { asset: VideoAsset; workId: string; revision: number; remote: VideoAssetsRemote }) {
  const [editing, setEditing] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), restoreFocus = useRef(false);
  useEffect(() => { if (!editing && restoreFocus.current) { trigger.current?.focus(); restoreFocus.current = false; } }, [editing]);
  const close = () => { restoreFocus.current = true; setEditing(false); };
  return <figcaption title={asset.label}>{editing ? <InlineNameEditor value={asset.label} label="重命名素材" onCancel={close} onSave={async label => {
    const project = await remote.renameVideoAsset!({ workId, assetId: asset.id, expectedRevision: revision, label });
    publishVideoProject(project); close();
  }}/> : remote.renameVideoAsset ? <button ref={trigger} type="button" className="jz-asset-name-button" aria-label={`重命名素材“${asset.label}”`} title={`${asset.label}（点击重命名）`} onClick={() => setEditing(true)}>{asset.label}</button> : asset.label}</figcaption>;
}
