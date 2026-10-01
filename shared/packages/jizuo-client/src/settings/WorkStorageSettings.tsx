import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useState } from "react";

import "./work-storage.css";

export interface WorkLocationStatus {
  path: string;
  available: boolean;
  reason?: string;
}

export interface WorkLocations {
  schemaVersion: 1;
  createRoot: string;
  roots: string[];
  statuses: WorkLocationStatus[];
  warning?: string;
}

export interface WorkLocationsRemote {
  video?: WorkLocationsRemote;
  get(): Promise<WorkLocations>;
  setCreateRoot(path: string): Promise<WorkLocations>;
  resetCreateRoot(): Promise<WorkLocations>;
}

export interface WorkStorageSettingsProps {
  remote: WorkLocationsRemote;
  pickDirectory?: () => Promise<string | null>;
  syncLocations?(locations: WorkLocations): Promise<void>;
}

function messageOf(reason: unknown, fallback: string): string {
  return userErrorMessage(reason, fallback, { operation: "WorkStorageSettings" });
}

export function WorkStorageSettings(props: WorkStorageSettingsProps) {
  return <div className="jz-work-storage-groups">
    <StorageLocation {...props} title="小说存储" />
    {props.remote.video && <StorageLocation {...props} remote={props.remote.video} title="视频项目存储" />}
  </div>;
}

function StorageLocation({ remote, pickDirectory, syncLocations, title }: WorkStorageSettingsProps & { title: string }) {
  const [locations, setLocations] = useState<WorkLocations>();
  const [busy, setBusy] = useState<"choose" | "reset">();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [draftPath, setDraftPath] = useState("");

  useEffect(() => {
    let active = true;
    setError(undefined);
    remote.get().then(
      (value) => { if (active) setLocations(value); },
      (reason) => { if (active) setError(messageOf(reason, "作品存储位置加载失败")); },
    );
    return () => { active = false; };
  }, [remote]);

  const choose = async () => {
    setError(undefined);
    setMessage(undefined);
    let path: string | null;
    try {
      path = pickDirectory ? await pickDirectory() : draftPath.trim();
    } catch (reason) {
      setError(messageOf(reason, "无法打开文件夹选择器"));
      return;
    }
    if (!path) return;
    setBusy("choose");
    try {
      const saved = await remote.setCreateRoot(path);
      setLocations(saved);
      try {
        await syncLocations?.(saved);
        setMessage("已保存，从下一次创建或导入作品开始使用。");
      } catch {
        setMessage("已保存，文件自动刷新将在重启后恢复。");
      }
    } catch (reason) {
      setError(messageOf(reason, "作品存储位置保存失败"));
    } finally {
      setBusy(undefined);
    }
  };

  const reset = async () => {
    setError(undefined);
    setMessage(undefined);
    setBusy("reset");
    try {
      const saved = await remote.resetCreateRoot();
      setLocations(saved);
      try {
        await syncLocations?.(saved);
        setMessage("已恢复默认位置，从下一次创建或导入作品开始使用。");
      } catch {
        setMessage("已保存，文件自动刷新将在重启后恢复。");
      }
    } catch (reason) {
      setError(messageOf(reason, "默认作品存储位置恢复失败"));
    } finally {
      setBusy(undefined);
    }
  };

  const disabled = locations === undefined || busy !== undefined;
  return (
    <section className="jz-work-storage" aria-label={`${title}设置`} aria-busy={locations === undefined || busy !== undefined}>
      <header><h2>{title}</h2></header>
      <p>设置以后新建作品和导入作品的保存位置。</p>
      <div className="jz-work-storage-path">
        <span>当前新建位置</span>
        <code>{locations?.createRoot ?? "正在加载…"}</code>
      </div>
      <p>只影响以后创建或导入的作品，已有作品不会移动。</p>
      {!pickDirectory && <label className="jz-work-storage-path">
        <span>{title}文件夹路径</span>
        <input value={draftPath} onChange={event => setDraftPath(event.target.value)} placeholder="输入运行 Harness 的设备上的绝对路径" disabled={disabled} />
        <span>路径位于运行 Harness 的设备上。</span>
      </label>}
      <div className="jz-work-storage-actions">
        <IconButton icon="library" label={(busy === "choose" ? "保存中…" : pickDirectory ? "选择文件夹" : "保存位置")} type="button" disabled={disabled || (!pickDirectory && !draftPath.trim())} onClick={() => { void choose(); }} />
        <IconButton icon="reset" label={(busy === "reset" ? "恢复中…" : "恢复默认位置")} type="button" disabled={disabled} onClick={() => { void reset(); }} />
      </div>
      {locations?.warning && <p role="status">{locations.warning}</p>}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
