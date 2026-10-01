import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useRef, useState } from "react";
import type { VideoEpisode, VideoProject, VideoShot } from "@jizuo/contracts";
import type { VideoShotsRemote } from "./shots-remote.ts";
import { hasVideoShotDraft } from "./VideoShotCard.tsx";

type Details = Pick<VideoShot, "title" | "description" | "dialogue" | "durationSec">;
const drafts = new Map<string, { base: VideoShot; draft: Details }>();
export const hasVideoShotDetailsDraft = (workId: string, episodeId: string, shotId: string) => drafts.has(`${workId}/${episodeId}/${shotId}`);
const fields = (shot: VideoShot): Details => ({ title: shot.title, description: shot.description, dialogue: shot.dialogue, durationSec: shot.durationSec });
export function VideoShotDetailsEditor({ project, episode, shot, remote, busy, run, onDraftChange }: {
  project: VideoProject; episode: VideoEpisode; shot: VideoShot; remote: VideoShotsRemote; busy: boolean;
  onDraftChange: () => void;
  run: (operation: () => Promise<VideoProject>, success?: () => void) => Promise<void>;
}) {
  const key = `${project.workId}/${episode.id}/${shot.id}`;
  const [draft, setDraft] = useState(() => drafts.get(key)?.draft ?? fields(shot));
  const base = useRef(drafts.get(key)?.base ?? shot);
  const dirty = JSON.stringify(draft) !== JSON.stringify(fields(base.current));
  const conflict = dirty && JSON.stringify(shot) !== JSON.stringify(base.current);
  useEffect(() => { if (!dirty) { base.current = shot; setDraft(fields(shot)); } }, [shot]);
  useEffect(() => { if (dirty) drafts.set(key, { base: base.current, draft }); else drafts.delete(key); onDraftChange(); }, [key, dirty, draft]);
  if (!remote.updateVideoEpisode) return null;
  const blocked = busy || shot.locked || conflict || hasVideoShotDraft(project.workId, episode.id, shot.id);
  return <section className="jz-shot-details-form" aria-label="编辑镜头资料">
    <div className="jz-shot-details-fields">
    {conflict && <p role="alert">镜头已更新，输入仍保留。请重新载入后编辑。</p>}
    <label>镜头名称<input value={draft.title} maxLength={120} disabled={blocked} onChange={event => setDraft({ ...draft, title: event.target.value })}/></label>
    <label>画面描述<textarea value={draft.description} maxLength={50000} disabled={blocked} onChange={event => setDraft({ ...draft, description: event.target.value })}/></label>
    <label>对白<textarea value={draft.dialogue} maxLength={50000} disabled={blocked} onChange={event => setDraft({ ...draft, dialogue: event.target.value })}/></label>
    <label>镜头时长（秒）<input type="number" min={0.1} max={3600} step={0.1} value={Number.isFinite(draft.durationSec) ? draft.durationSec : ""} disabled={blocked} onChange={event => setDraft({ ...draft, durationSec: event.target.valueAsNumber })}/></label>
    </div>
    <footer className="jz-shot-details-footer">
    <small>修改资料后，已生成素材仍保留在素材库中。</small>
    <div className="jz-video-tools" role="group" aria-label="镜头资料操作"><IconButton icon="save" label={"保存镜头资料"} type="button" disabled={blocked || !dirty || !draft.title.trim() || !Number.isFinite(draft.durationSec) || draft.durationSec <= 0 || draft.durationSec > 3600}
      onClick={() => void run(async () => {
        const next = await remote.updateVideoEpisode!({ workId: project.workId, episodeId: episode.id, expectedRevision: project.revision,
          patch: { shots: episode.shots.map(item => item.id === shot.id ? { ...item, ...draft, title: draft.title.trim() } : item) } });
        const saved = next.episodes.find(item => item.id === episode.id)?.shots.find(item => item.id === shot.id);
        if (saved) { drafts.delete(key); base.current = saved; setDraft(fields(saved)); }
        return next;
      })} />
      <IconButton icon="reset" label={"重新载入镜头"} type="button" disabled={busy || !dirty} onClick={() => { base.current = shot; setDraft(fields(shot)); }} /></div>
    </footer>
  </section>;
}
