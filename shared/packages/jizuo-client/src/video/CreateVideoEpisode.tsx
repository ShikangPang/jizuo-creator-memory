import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useState, type FormEvent } from "react";
import type { VideoSourceChapter } from "@jizuo/contracts";
import type { JizuoContentRemote } from "../content/remote.ts";
import { getSelection, setSelection } from "../content/selection.ts";
import { publishVideoProject } from "./useVideoProject.ts";
import { VideoSourcePicker } from "./VideoSourcePicker.tsx";

export function CreateVideoEpisode({ remote, workId, close }: { remote: JizuoContentRemote; workId: string; close: () => void }) {
  const [title, setTitle] = useState("");
  const [sourceChapters, setSourceChapters] = useState<VideoSourceChapter[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || !title.trim() || !remote.createVideoEpisode) return;
    setBusy(true);
    setError(null);
    try {
      const project = await remote.createVideoEpisode({ workId, title: title.trim(), sourceChapters });
      publishVideoProject(project);
      const episode = project.episodes.at(-1);
      if (episode && getSelection().workId === workId && getSelection().mode === "video") {
        setSelection({ workId, episodeId: episode.id, volumeId: null, chapterId: null, designId: null, shotId: null, videoSection: "storyboard", overlay: "video" });
      }
      close();
    } catch (cause) {
      setError(userErrorMessage(cause, "创建视频集失败", { operation: "CreateVideoEpisode" }));
    } finally { setBusy(false); }
  };
  return <form className="jz-video-create" onSubmit={(event) => { void create(event); }}>
    <input aria-label="视频集名称" placeholder="视频集名称" autoFocus maxLength={120} value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
    <VideoSourcePicker remote={remote} workId={workId} value={sourceChapters} onChange={setSourceChapters} disabled={busy} />
    <div><IconButton icon="close" label={"取消"} type="button" disabled={busy} onClick={close} /><IconButton icon="add" label={(busy ? "创建中…" : "创建")} type="submit" disabled={busy || !title.trim()} /></div>
    {error && <p role="alert">{error}</p>}
  </form>;
}
