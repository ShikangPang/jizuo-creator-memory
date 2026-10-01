import { userErrorMessage } from "@jizuo/contracts";
import type { StoryboardChatRequest } from "./storyboard-chat.ts";
import { ActionIcon } from "../ui/ActionIcon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useState } from "react";
import { VideoEpisode, type VideoProject, type VideoShot } from "@jizuo/contracts";
import type { JizuoContentRemote } from "../content/remote.ts";
import { publishVideoProject } from "./useVideoProject.ts";
import { VideoReferencePicker } from "./VideoReferencePicker.tsx";
import { VideoSourcePicker } from "./VideoSourcePicker.tsx";

type Draft = { base: VideoEpisode; episode: VideoEpisode; revision: number };
// Keep unsaved work when the user visits another episode and comes back.
const drafts = new Map<string, Draft>();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function VideoStoryboardEditor({ project, episode, remote, onGenerateStoryboard }: { onGenerateStoryboard?: ((request: StoryboardChatRequest) => Promise<void>) | undefined; project: VideoProject; episode: VideoEpisode; remote: JizuoContentRemote }) {
  const key = `${project.workId}/${episode.id}`;
  const [draft, setDraft] = useState<Draft>(() => drafts.get(key) ?? { base: episode, episode, revision: project.revision });
  const [expandedShotId, setExpandedShotId] = useState<string | null>(() => episode.shots.find(shot => !shot.archived)?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const dirty = !same(draft.base, draft.episode);
  const conflict = project.revision !== draft.revision && !same(episode, draft.base);
  const editable = Boolean(remote.updateVideoEpisode) && !busy;
  useEffect(() => {
    if (!dirty) {
      setDraft({ base: episode, episode, revision: project.revision });
    } else if (same(episode, draft.base) && project.revision !== draft.revision) {
      const next = { ...draft, revision: project.revision };
      drafts.set(key, next);
      setDraft(next);
    }
  }, [episode, project.revision, key, dirty, draft.base, draft.revision]);
  const change = (next: VideoEpisode) => {
    const value = { ...draft, episode: next };
    if (same(value.base, next)) drafts.delete(key); else drafts.set(key, value);
    setDraft(value);
  };
  const shotChange = (id: string, patch: Partial<VideoShot>) => change({ ...draft.episode,
    shots: draft.episode.shots.map((shot) => shot.id === id ? { ...shot, ...patch } : shot) });
  const accept = (next: VideoProject) => {
    const saved = next.episodes.find((item) => item.id === episode.id);
    if (!saved) throw new Error("视频集已不存在，请重新选择");
    drafts.delete(key);
    setDraft({ base: saved, episode: saved, revision: next.revision });
    publishVideoProject(next);
  };
  const save = async () => {
    if (!remote.updateVideoEpisode || busy || conflict) return;
    setBusy(true); setError(null);
    try {
      const parsed = VideoEpisode.parse(draft.episode);
      await remote.updateVideoEpisode({ workId: project.workId, episodeId: episode.id, expectedRevision: draft.revision,
        patch: { title: parsed.title, sourceChapters: parsed.sourceChapters, script: parsed.script, shots: parsed.shots } }).then(accept);
    } catch (cause) { setError(userErrorMessage(cause, "保存失败，本地修改已保留", { operation: "VideoStoryboardEditor" })); }
    finally { setBusy(false); }
  };
  const adapt = async (shotIds?: string[]) => {
    if (!onGenerateStoryboard || dirty || conflict || busy) return;
    setBusy(true); setError(null);
    try { await onGenerateStoryboard({ workId: project.workId, episodeId: episode.id, title: episode.title,
      instructions: instructions.trim(), sourceChapters: draft.episode.sourceChapters, ...(shotIds ? { shotIds } : {}) }); }
    catch (cause) { setError(userErrorMessage(cause, "生成失败，原制作稿已保留", { operation: "VideoStoryboardEditor" })); }
    finally { setBusy(false); }
  };
  const reload = async () => {
    setBusy(true); setError(null);
    try { accept(remote.getVideoProject ? await remote.getVideoProject({ workId: project.workId }) : project); }
    catch (cause) { setError(userErrorMessage(cause, "载入失败", { operation: "VideoStoryboardEditor", effect: "read" })); }
    finally { setBusy(false); }
  };
  const move = (id: string, delta: number) => {
    const shots = [...draft.episode.shots];
    const active = shots.filter((shot) => !shot.archived);
    const from = active.findIndex((shot) => shot.id === id);
    const target = active[from + delta];
    if (!target) return;
    const a = shots.findIndex((shot) => shot.id === id), b = shots.findIndex((shot) => shot.id === target.id);
    [shots[a], shots[b]] = [shots[b]!, shots[a]!];
    change({ ...draft.episode, shots });
  };
  const activeShots = draft.episode.shots.filter((shot) => !shot.archived);
  return <section className="jz-video-storyboard jz-video-editor" aria-label="制作稿">
    <div className="jz-video-editor-heading"><div className="jz-storyboard-heading-status"><h3>制作稿</h3>
      <span role="status">{busy ? "处理中…" : dirty ? "有未保存修改" : "已保存"}</span>
    </div><div className="jz-video-tools">
      <IconButton icon="add" label={"添加镜头"} type="button" disabled={!editable} onClick={() => {
      const id = crypto.randomUUID();
      change({ ...draft.episode, shots: [...draft.episode.shots, {
        id, title: `镜头 ${activeShots.length + 1}`, description: "", dialogue: "", prompt: "", durationSec: 5,
        referenceAssetIds: [], locked: false, promptLocked: false, revision: 0,
      }] });
      setExpandedShotId(id);
    }} />
      <IconButton icon="save" label={"保存制作稿"} type="button" disabled={!editable || !dirty || conflict} onClick={() => { void save(); }} />
    </div></div>
    {error && <p role="alert">{error}；本地修改已保留。</p>}
    {conflict && <p role="alert">制作稿已有更新，本地修改已保留。请复制需要保留的内容，再载入最新版本。</p>}
    {(error || conflict || dirty) && <IconButton icon="reset" label={"放弃本地修改并载入最新版本"} type="button" disabled={busy} onClick={() => { void reload(); }} />}
    <details><summary>剧本与原著 · {draft.episode.sourceChapters.length} 个章节</summary>
      <label>视频集名称<input value={draft.episode.title} maxLength={120} disabled={!editable} onChange={(event) => change({ ...draft.episode, title: event.target.value })} /></label>
      <VideoSourcePicker remote={remote} workId={project.workId} value={draft.episode.sourceChapters} disabled={!editable} onChange={(sourceChapters) => change({ ...draft.episode, sourceChapters })} />
      <label>改编剧本<textarea rows={6} value={draft.episode.script} maxLength={500000} disabled={!editable} onChange={(event) => change({ ...draft.episode, script: event.target.value })} /></label>
    </details>
    {onGenerateStoryboard && <details open={!activeShots.length}><summary>AI 整理制作稿</summary>
      <label>改编要求<textarea rows={2} maxLength={10000} value={instructions} disabled={busy} placeholder="例如：竖屏短剧，保留雨夜对峙，减少旁白" onChange={(event) => setInstructions(event.target.value)} /></label>
      <div className="jz-video-tools"><IconButton icon="sparkles" label={(activeShots.length ? "重新整理制作稿" : "从原著生成制作稿")} type="button" disabled={busy || dirty || conflict || !draft.episode.sourceChapters.length} onClick={() => { void adapt(); }} /></div>
      <small>{dirty ? "请先保存修改，再交给 AI。" : !draft.episode.sourceChapters.length ? "先在“剧本与原著”中选择并保存原著章节。" : "点击后在作品对话中由 AI 生成并保存制作稿。锁定内容会保留。"}</small>
    </details>}
    {!activeShots.length && <div className="jz-video-empty"><h3>尚未添加镜头</h3><p>先整理内容与提示词，再生成画面。</p></div>}
    {activeShots.map((shot, index) => {
      const original = draft.base.shots.find((item) => item.id === shot.id);
      const contentDisabled = !editable || Boolean(original?.locked) || shot.locked;
      const promptDisabled = contentDisabled || Boolean(original?.promptLocked) || shot.promptLocked;
      const lockPending = Boolean(original?.locked && !shot.locked || original?.promptLocked && !shot.promptLocked);
      const expanded = expandedShotId === shot.id;
      return <article key={shot.id} aria-label={`镜头 ${index + 1}`} className="jz-storyboard-shot" data-expanded={expanded}>
        <button type="button" className="jz-storyboard-shot-summary" aria-expanded={expanded} onClick={() => setExpandedShotId(expanded ? null : shot.id)}>
          <span className="jz-video-episode-number">{String(index + 1).padStart(2, "0")}</span>
          <span className="jz-storyboard-shot-title">{shot.title || "未命名镜头"}<small>{shot.description || "尚未填写画面内容"}</small></span>
          <small>{shot.durationSec} 秒{shot.locked ? " · 已锁定" : ""}</small><span aria-hidden="true"><ActionIcon name={expanded ? "down" : "right"} /></span>
        </button>
        {expanded && <div className="jz-storyboard-shot-fields">
        <div className="jz-video-editor-heading"><strong>镜头 {index + 1}</strong><div className="jz-video-tools">
          <IconButton icon="up" label={(`上移镜头 ${index + 1}`)} type="button" aria-label={`上移镜头 ${index + 1}`} disabled={!editable || index === 0} onClick={() => move(shot.id, -1)} />
          <IconButton icon="down" label={(`下移镜头 ${index + 1}`)} type="button" aria-label={`下移镜头 ${index + 1}`} disabled={!editable || index === activeShots.length - 1} onClick={() => move(shot.id, 1)} />
          <IconButton icon={shot.locked ? "unlock" : "lock"} label={(shot.locked ? "解锁镜头" : "锁定镜头")} type="button" aria-pressed={shot.locked} disabled={!editable} onClick={() => shotChange(shot.id, { locked: !shot.locked })} />
        </div></div>
        {lockPending && <small>请先保存解锁，再编辑内容。</small>}
        <div className="jz-storyboard-shot-basics">
        <label>镜头名称<input value={shot.title} maxLength={120} disabled={contentDisabled} onChange={(event) => shotChange(shot.id, { title: event.target.value })} /></label>
        <label>时长（秒）<input type="number" min={0.1} max={3600} step="any" value={shot.durationSec} disabled={contentDisabled} onChange={(event) => shotChange(shot.id, { durationSec: event.target.valueAsNumber })} /></label>
        </div>
        <label>画面内容<textarea rows={2} value={shot.description} maxLength={50000} disabled={contentDisabled} onChange={(event) => shotChange(shot.id, { description: event.target.value })} /></label>
        <div className="jz-video-shot-meta">
          {onGenerateStoryboard && <IconButton icon="sparkles" label={"AI 调整此镜头"} type="button" disabled={busy || dirty || conflict || shot.locked || !draft.episode.sourceChapters.length} onClick={() => { void adapt([shot.id]); }} />}
        </div>
        <details><summary>对白、提示词与参考图{shot.promptLocked ? " · 提示词已锁定" : ""}</summary>
          <label>对白 / 旁白<textarea rows={2} value={shot.dialogue} maxLength={50000} disabled={contentDisabled} onChange={(event) => shotChange(shot.id, { dialogue: event.target.value })} /></label>
          <label>图片提示词<textarea rows={4} value={shot.prompt} maxLength={32000} disabled={promptDisabled} onChange={(event) => shotChange(shot.id, { prompt: event.target.value })} /></label>
          <label>视频提示词<textarea rows={4} value={shot.videoPrompt ?? ""} maxLength={32000} disabled={promptDisabled} onChange={event => shotChange(shot.id, { videoPrompt: event.target.value })} placeholder="描述动作、运镜、节奏和声音" /></label>
          <IconButton icon={shot.promptLocked ? "unlock" : "lock"} label={(shot.promptLocked ? "解锁提示词" : "锁定提示词")} type="button" aria-pressed={shot.promptLocked} disabled={!editable || shot.locked || Boolean(original?.locked)} onClick={() => shotChange(shot.id, { promptLocked: !shot.promptLocked })} />
          <VideoReferencePicker assets={project.assets} selected={shot.referenceAssetIds} onChange={(referenceAssetIds) => shotChange(shot.id, { referenceAssetIds })} remote={remote} workId={project.workId} disabled={promptDisabled} />
          <IconButton icon="delete" label={"移出制作稿"} type="button" disabled={contentDisabled || Boolean(original?.promptLocked) || shot.promptLocked} onClick={() => shotChange(shot.id, { archived: true })} />
        </details>
        </div>}
      </article>;
    })}
    {draft.episode.shots.some((shot) => shot.archived) && <details><summary>已移出镜头</summary>{draft.episode.shots.filter((shot) => shot.archived).map((shot) => <div key={shot.id} className="jz-video-editor-heading"><span>{shot.title}</span><IconButton icon="undo" label={"恢复镜头"} type="button" disabled={!editable || shot.locked} onClick={() => shotChange(shot.id, { archived: false })} /></div>)}</details>}
  </section>;
}
