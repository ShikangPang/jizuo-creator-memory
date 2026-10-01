import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useRef, useState } from "react";
import type { DeleteVideoItemInput } from "@jizuo/contracts";
import type { VideoAssetsRemote } from "./assets-remote.ts";
import { publishVideoProject } from "./useVideoProject.ts";
import { VideoErrorNotice } from "./VideoErrorNotice.tsx";

export function DeleteVideoItemButton({ remote, input, label, detail, disabled = false, onDeleted, buttonLabel, compact = false }: {
  remote: VideoAssetsRemote; input: DeleteVideoItemInput; label: string; detail: string;
  buttonLabel?: string; compact?: boolean;
  disabled?: boolean; onDeleted?: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  useEffect(() => { setError(""); }, [input.expectedRevision]);
  if (!remote.deleteVideoItem) return null;
  const remove = async () => {
    if (busyRef.current || disabled) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const next = await remote.deleteVideoItem!(input);
      onDeleted?.(); publishVideoProject(next); setConfirm(false);
    } catch (cause) { setError(userErrorMessage(cause, "删除失败，请重试", { operation: "DeleteVideoItemButton" })); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <div className="jz-video-delete-item">
    {confirm ? <div role="group" aria-label={`确认删除${label}`}>
      <p>删除「{label}」？{detail}</p>
      <div className="jz-video-tools"><IconButton icon="delete" label={(busy ? "删除中…" : input.detachReferences ? "确认取消引用并删除" : "确认删除")} type="button" disabled={busy || disabled} onClick={() => void remove()} />
      <IconButton icon="close" label={"取消"} type="button" disabled={busy} onClick={() => { setConfirm(false); setError(""); }} /></div>
    </div> : <IconButton icon="delete" label={buttonLabel ?? `删除${input.kind === "design" ? "设定" : input.kind === "shot" ? "镜头" : "素材"}`} type="button" className={compact ? "jz-row-action" : undefined} aria-label={buttonLabel} title={buttonLabel} disabled={disabled} onClick={() => setConfirm(true)} />}
    {error && <VideoErrorNotice title="删除未完成" message={error}/>}
  </div>;
}
