import { IconButton } from "../ui/IconButton.tsx";
import { isDiscardedMediaJob } from "../../../contracts/src/media-job-policy.ts";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { VideoTimelinePreview } from "./VideoTimelinePreview.tsx";
import { VideoShot, type VideoAsset, type VideoEpisode, type VideoJob, type VideoProject } from "@jizuo/contracts";
import type { GenerateVideoMediaInput } from "../../../contracts/src/media-operations.ts";
import type { VideoShotsRemote } from "./shots-remote.ts";
import { requestVideoComposer } from "./video-composer-request.ts";
import { VideoAssetPreview } from "./VideoAssetPreview.tsx";
import { VideoReferencePicker } from "./VideoReferencePicker.tsx";
import { VideoMediaPreview } from "./VideoShotMedia.tsx";
import { publishVideoProject } from "./useVideoProject.ts";
import { MediaGenerationInfo } from "./MediaGenerationInfo.tsx";
import { useMediaGenerationSettings } from "./useMediaGenerationSettings.ts";
import { estimateMediaGeneration } from "./media-generation-estimate.ts";

type EditableShot = Pick<VideoShot, "description" | "prompt" | "videoPrompt" | "referenceAssetIds">;
type ShotDraft = { base: EditableShot; value: EditableShot; contentSignature: string; contextSignature: string };
const drafts = new Map<string, ShotDraft>();
const frameDrafts = new Map<string, { mode: "frames" | "references"; first: string | undefined; last: string | undefined; refs: string[] }>();
const videoReferenceDrafts = new Map<string, string[]>();
const editableFields = ({ description, prompt, videoPrompt, referenceAssetIds }: VideoShot): EditableShot => ({ description, prompt, videoPrompt, referenceAssetIds });
const contentSignature = (shot: VideoShot) => JSON.stringify([shot.title, shot.description, shot.dialogue, shot.durationSec, shot.prompt, shot.videoPrompt, shot.referenceAssetIds, shot.locked, shot.promptLocked, Boolean(shot.archived)]);
const contextSignature = (shot: VideoShot) => JSON.stringify([shot.title, shot.dialogue, shot.durationSec, shot.locked, shot.promptLocked, Boolean(shot.archived)]);
const freshDraft = (shot: VideoShot): ShotDraft => ({ base: editableFields(shot), value: editableFields(shot), contentSignature: contentSignature(shot), contextSignature: contextSignature(shot) });
const same = (a: EditableShot, b: EditableShot) => JSON.stringify(a) === JSON.stringify(b);
function reconcileDraft(draft: ShotDraft, shot: VideoShot): ShotDraft {
  if (draft.contentSignature === contentSignature(shot)) return draft;
  if (same(draft.base, draft.value)) return freshDraft(shot);
  // Changes to timing, dialogue or locks still require the author to review context.
  if (draft.contextSignature !== contextSignature(shot)) return draft;
  const latest = editableFields(shot);
  const changed = (key: keyof EditableShot) => JSON.stringify(draft.value[key]) !== JSON.stringify(draft.base[key]);
  const keys = ["description", "prompt", "videoPrompt", "referenceAssetIds"] as const;
  if (keys.some(key => changed(key) && JSON.stringify(latest[key]) !== JSON.stringify(draft.base[key]) && JSON.stringify(latest[key]) !== JSON.stringify(draft.value[key]))) return draft;
  return { ...freshDraft(shot), value: {
    description: changed("description") ? draft.value.description : latest.description,
    prompt: changed("prompt") ? draft.value.prompt : latest.prompt,
    videoPrompt: changed("videoPrompt") ? draft.value.videoPrompt : latest.videoPrompt,
    referenceAssetIds: changed("referenceAssetIds") ? draft.value.referenceAssetIds : latest.referenceAssetIds,
  } };
}
export const blocksShotGeneration = (job: VideoJob) => !isDiscardedMediaJob(job) && (typeof job.state?.generationBlocked === "boolean" ? job.state.generationBlocked : job.status === "queued" || job.status === "running" || job.status === "uncertain" || job.status === "cancelled" && (job.attempt ?? 0) > 0);
export const hasVideoShotDraft = (workId: string, episodeId: string, shotId: string) => drafts.has(`${workId}/${episodeId}/${shotId}`);

export function VideoShotCard({ project, episode, shot, index, remote, busy, aspectRatio, run, onDraftChange, active, selectionRequest = 0, controlsHost }: {
  controlsHost?: HTMLElement | null;
  project: VideoProject; episode: VideoEpisode; shot: VideoShot; index: number; remote: VideoShotsRemote; busy: boolean;
  aspectRatio: GenerateVideoMediaInput["aspectRatio"];
  run: (operation: () => Promise<VideoProject>) => Promise<void>;
  onDraftChange: () => void;
  active?: boolean | undefined;
  selectionRequest?: number;
}) {
  const key = `${project.workId}/${episode.id}/${shot.id}`;
  const promptId = useId();
  const [creationKind, setCreationKind] = useState<"image" | "video">(() => {
    const cached = drafts.get(key);
    return cached && cached.value.videoPrompt !== cached.base.videoPrompt ? "video" : "image";
  });
  const [kindSelectionRequest, setKindSelectionRequest] = useState(0);
  useEffect(() => {
    if (active === false || active === undefined && !selectionRequest && !kindSelectionRequest) return;
    requestVideoComposer({ workId: project.workId, episodeId: episode.id, shotId: shot.id, title: shot.title,
      action: "select", kind: creationKind, promptMode: "reference", aspectRatio });
  }, [key, active, selectionRequest, kindSelectionRequest]);
  const [previewId, setPreviewId] = useState("");
  const latestResultId = project.assets.filter(asset => !asset.deletedAt && !asset.panorama && (asset.kind === "image" || asset.kind === "video")
    && asset.episodeId === episode.id && asset.shotId === shot.id).at(-1)?.id;
  const previousResultId = useRef(latestResultId);
  useEffect(() => {
    if (latestResultId && latestResultId !== previousResultId.current) setPreviewId(latestResultId);
    previousResultId.current = latestResultId;
  }, [latestResultId]);
  const mediaState = useMediaGenerationSettings(remote);
  const imageEstimate = estimateMediaGeneration(mediaState.view, "image");
  const videoEstimate = estimateMediaGeneration(mediaState.view, "video", shot.durationSec);
  const [storedDraft, setDraft] = useState<ShotDraft>(() => drafts.get(key) ?? freshDraft(shot));
  const draft = useMemo(() => reconcileDraft(storedDraft, shot), [storedDraft, shot]);
  const [customVideoReferences, setVideoReferences] = useState<string[] | undefined>(() => videoReferenceDrafts.get(key));
  const setCustomVideoReferences = (ids: string[] | undefined) => {
    if (ids === undefined) videoReferenceDrafts.delete(key); else videoReferenceDrafts.set(key, ids);
    setVideoReferences(ids);
  };
  const [frameInput, setFrameInput] = useState(() => frameDrafts.get(key) ?? { mode: "frames" as const, first: shot.imageAssetId, last: undefined as string | undefined, refs: [] as string[] });
  const changeFrames = (patch: Partial<typeof frameInput>) => { const next = { ...frameInput, ...patch }; frameDrafts.set(key, next); setFrameInput(next); };
  const roleInput = videoEstimate.config?.protocol === "ark";
  const frameFirst = frameDrafts.has(key) ? frameInput.first : shot.imageAssetId;
  const frameIds = frameInput.mode === "references" ? frameInput.refs : [frameFirst, frameInput.last].filter((id): id is string => Boolean(id));
  const videoImageRoles = frameInput.mode === "references" ? frameIds.map(() => "reference_image" as const) : [...(frameFirst ? ["first_frame" as const] : []), ...(frameInput.last ? ["last_frame" as const] : [])];
  const invalidFrames = roleInput && frameInput.mode === "frames" && Boolean(frameInput.last) && !frameFirst;
  const dirty = !same(draft.base, draft.value);
  const conflict = dirty && contentSignature(shot) !== draft.contentSignature;
  const imageAsset = project.assets.find((asset) => asset.id === shot.imageAssetId && asset.kind === "image");
  const videoAsset = project.assets.find((asset) => asset.id === shot.videoAssetId && asset.kind === "video");
  const videoReferences = roleInput ? frameIds : customVideoReferences ?? (shot.imageAssetId ? [shot.imageAssetId] : []);
  const candidates = project.assets.filter((asset) => asset.kind === "video" && (!asset.shotId || asset.episodeId === episode.id && asset.shotId === shot.id));
  const imageCandidates = project.assets.filter((asset) => asset.kind === "image" && !asset.panorama && (!asset.shotId || asset.episodeId === episode.id && asset.shotId === shot.id));
  const jobs = project.jobs.filter((job) => (job.kind === "image" || job.kind === "video") && job.episodeId === episode.id && job.shotId === shot.id);
  const invalidReferences = (ids: string[]) => ids.length > 14 || ids.some((id) => !project.assets.some((asset) => asset.id === id && asset.kind === "image" && !asset.panorama));
  const editDisabled = busy || shot.locked || !remote.updateVideoEpisode;
  const generationDisabled = busy || mediaState.switching || shot.locked || conflict || (!draft.value.prompt.trim() && !draft.value.videoPrompt?.trim()) || dirty && !remote.updateVideoEpisode;
  useEffect(() => {
    if (draft === storedDraft) return;
    if (dirty) drafts.set(key, draft); else drafts.delete(key);
    setDraft(draft); onDraftChange();
  }, [draft, storedDraft, dirty, key, onDraftChange]);
  const change = (patch: Partial<EditableShot>) => {
    const next = { ...draft, value: { ...draft.value, ...patch } };
    if (same(next.base, next.value)) drafts.delete(key); else drafts.set(key, next);
    setDraft(next); onDraftChange();
  };
  const save = async (): Promise<VideoProject> => {
    if (!dirty) return project;
    if (conflict || shot.locked || !remote.updateVideoEpisode) throw new Error("镜头已有更新，请先处理本地草稿");
    if (shot.promptLocked && (draft.value.prompt !== draft.base.prompt || draft.value.videoPrompt !== draft.base.videoPrompt)) throw new Error("提示词已锁定，请先在制作稿中解锁");
    const parsed = VideoShot.parse({ ...shot, ...draft.value });
    const next = await remote.updateVideoEpisode({ workId: project.workId, episodeId: episode.id, expectedRevision: project.revision,
      patch: { shots: episode.shots.map((item) => item.id === shot.id ? parsed : item) } });
    const saved = next.episodes.find((item) => item.id === episode.id)?.shots.find((item) => item.id === shot.id);
    if (!saved) throw new Error("镜头已不存在，本地修改已保留");
    drafts.delete(key); setDraft(freshDraft(saved)); onDraftChange();
    publishVideoProject(next);
    return next;
  };
  const generate = (kind: "image" | "video") => {
    if (!remote.generateVideoMedia || generationDisabled || (kind === "image" ? imageEstimate : videoEstimate).insufficientCredits || jobs.some((job) => job.kind === kind && blocksShotGeneration(job))) return;
    // Saving a changed prompt clears imageAssetId; keep the exact first frame shown at click time.
    const selectedVideoReferences = [...videoReferences];
    void run(async () => {
      const next = await save();
      const savedShot = next.episodes.find((item) => item.id === episode.id)?.shots.find((item) => item.id === shot.id);
      if (!savedShot || savedShot.locked || savedShot.archived) throw new Error("镜头已锁定或移出，请检查最新制作稿");
      const referenceAssetIds = kind === "image" ? savedShot.referenceAssetIds : selectedVideoReferences;
      return remote.generateVideoMedia!({ workId: project.workId, episodeId: episode.id, shotId: shot.id, expectedRevision: next.revision, kind, aspectRatio, referenceAssetIds, selectResult: false, ...(kind === "video" && roleInput ? { videoImageRoles } : {}) });
    });
  };
  const videoInputs = (roleInput ? <div className="jz-video-frame-input">
      <label>视频输入方式<select aria-label="视频输入方式" value={frameInput.mode} disabled={busy || shot.locked} onChange={event => changeFrames({ mode: event.target.value as "frames" | "references" })}><option value="frames">首尾帧</option><option value="references">参考图片</option></select></label>
      {frameInput.mode === "frames" ? <>
        <VideoReferencePicker label="首帧" max={1} assets={project.assets} selected={frameFirst ? [frameFirst] : []} onChange={ids => changeFrames({ first: ids[0] })} remote={remote} workId={project.workId} disabled={busy || shot.locked} />
        <VideoReferencePicker label="尾帧（可选）" max={1} assets={project.assets} selected={frameInput.last ? [frameInput.last] : []} onChange={ids => changeFrames({ first: frameFirst, last: ids[0] })} remote={remote} workId={project.workId} disabled={busy || shot.locked} />
        {invalidFrames && <small role="alert">使用尾帧前，请先选择首帧。</small>}
        <small>不选图片时使用文字生成；选择首尾帧后生成两帧之间的动作。</small>
      </> : <>
        <VideoReferencePicker label="视频参考图片" max={/seedance-2[.-]5/.test(videoEstimate.config?.model ?? "") ? 14 : 9} assets={project.assets} selected={frameInput.refs} onChange={refs => changeFrames({ refs })} remote={remote} workId={project.workId} disabled={busy || shot.locked} />
        <small>用于人物、场景和风格参考，不固定首尾画面。需要支持参考图片的 Seedance 2.x 模型。</small>
      </>}
    </div> : <>
    <label className="jz-video-video-reference-toggle"><input type="checkbox" checked={customVideoReferences !== undefined} disabled={busy || shot.locked} onChange={(event) => setCustomVideoReferences(event.target.checked ? [...videoReferences] : undefined)} />为视频单独选择参考图</label>
    <p className="jz-video-assets-note">{customVideoReferences === undefined ? "默认使用上方镜头图片作为视频首帧。" : "以下图片将按选择顺序发送给视频模型；具体用途由模型决定。"}</p>
    {customVideoReferences !== undefined && <VideoReferencePicker label="视频参考图" assets={project.assets} selected={videoReferences} onChange={setCustomVideoReferences} remote={remote} workId={project.workId} disabled={busy || shot.locked} />}
    </>);
  const renderControls = (content: ReactNode) => controlsHost ? createPortal(content, controlsHost) : content;
  if (remote.discussVideoPrompt) {
    const versions = project.assets.filter(asset => !asset.deletedAt && !asset.panorama && (asset.kind === "image" || asset.kind === "video")
      && (asset.episodeId === episode.id && asset.shotId === shot.id || asset.id === shot.imageAssetId || asset.id === shot.videoAssetId));
    const preview = versions.find(asset => asset.id === previewId) ?? videoAsset ?? versions.filter(asset => asset.kind === "video").at(-1) ?? imageAsset ?? versions.at(-1);
    const request = (action: "optimize" | "generate", promptMode: "reference" | "text" = "reference", kind: "image" | "video" = creationKind) => requestVideoComposer({
      workId: project.workId, episodeId: episode.id, shotId: shot.id, title: shot.title,
      action, kind, aspectRatio, promptMode,
      ...(promptMode === "text" ? { prompt: kind === "image" ? draft.value.prompt : draft.value.videoPrompt ?? "" } : {}),
      ...(kind === "video" ? { referenceAssetIds: videoReferences } : {}),
      ...(kind === "video" && roleInput ? { videoImageRoles } : {}),
    });
    return <article className="jz-shot-workspace" aria-label={`视频镜头 ${index + 1}`}>
      <div className="jz-video-editor-heading"><h3>{index + 1}. {shot.title}</h3><span>{shot.durationSec} 秒{shot.locked ? " · 已锁定" : ""}</span></div>
      <p>{shot.description}</p>
      <div className="jz-shot-visual">
      {preview ? <section aria-label="镜头生成结果">
        <ShotPlayer key={preview.id} project={project} episode={episode} asset={preview} remote={remote} aspectRatio={aspectRatio} active={active !== false} />

      </section> : <div className="jz-shot-preview-empty"><strong>先为这个镜头准备画面</strong><p>生成图片后，在这里比较版本，再制作视频。</p></div>}
      </div>
      {renderControls(<div className="jz-shot-controls">
      {preview && <section className="jz-shot-version-controls" aria-label="镜头版本与生成">
        <small>{versions.filter(asset => asset.kind === "image").length} 张备选图片 · {versions.filter(asset => asset.kind === "video").length} 段备选视频</small>
        <div className="jz-video-tools"><select aria-label="镜头生成版本" value={preview.id} onChange={event => setPreviewId(event.target.value)}>
          {versions.map((asset, i) => <option key={asset.id} value={asset.id}>{asset.kind === "image" ? "图片" : "视频"} · {i + 1}. {asset.label}</option>)}
        </select>
          {remote.selectVideoAsset && <IconButton icon="apply" label={((preview.kind === "image" ? shot.imageAssetId : shot.videoAssetId) === preview.id ? "当前选用" : "选用此版本")} type="button" disabled={busy || shot.locked || (preview.kind === "image" ? shot.imageAssetId : shot.videoAssetId) === preview.id}
            onClick={() => void run(() => remote.selectVideoAsset!({ workId: project.workId, episodeId: episode.id, shotId: shot.id, assetId: preview.id, kind: preview.kind === "image" ? "image" : "video", expectedRevision: project.revision }))} />}
        </div><VideoVersionDetails project={project} jobId={preview.sourceJobId}/>
      </section>}

      <small>在主聊天中引用镜头，发送时使用最新提示词。输入 @ 可选择人物、场景或参考图片。</small>
      <div className="jz-video-shot-fields">
        {(["image", "video"] as const).map(kind => <div key={kind} className="jz-design-prompt jz-shot-prompt-field">
          <label htmlFor={`${promptId}-${kind}`}>{kind === "image" ? "图片提示词" : "视频提示词"}</label>
          <div className="jz-shot-prompt-box">
          <textarea id={`${promptId}-${kind}`} rows={4} value={kind === "image" ? draft.value.prompt : draft.value.videoPrompt ?? ""} maxLength={32000}
            readOnly={editDisabled || shot.promptLocked || conflict}
            placeholder={kind === "image" ? "描述静态画面的主体、构图、环境与光线。" : "描述动作、运镜、节奏和声音；与图片提示词分别保存。"}
            onFocus={() => { if (creationKind !== kind) { setCreationKind(kind); setKindSelectionRequest(value => value + 1); } }}
            onChange={event => change(kind === "image" ? { prompt: event.target.value } : { videoPrompt: event.target.value })}/>
          <div className="jz-video-tools jz-shot-prompt-actions" role="group" aria-label={kind === "image" ? "图片提示词操作" : "视频提示词操作"}>
            <IconButton icon="sparkles" label={kind === "image" ? "优化图片提示词" : "优化视频提示词"} type="button" disabled={busy || dirty}
              onClick={() => { setCreationKind(kind); request("optimize", "reference", kind); }} />
            <IconButton icon={kind} label={kind === "image" ? "生成图片" : "生成视频"} aria-pressed={creationKind === kind} type="button"
              disabled={busy || dirty || shot.locked || mediaState.switching || (kind === "video" && invalidFrames) || jobs.some(job => job.kind === kind && blocksShotGeneration(job))}
              onClick={() => { setCreationKind(kind); request("generate", "reference", kind); }} />
          </div>
          </div>
        </div>)}
      </div>
      {(shot.locked || shot.promptLocked) && <small>{shot.locked ? "镜头" : "提示词"}已锁定，可在制作稿中解锁。</small>}
      {dirty && <div>
        <div className="jz-video-tools">
          <span role="status">有未保存修改</span>
          <IconButton icon="save" label={"保存镜头修改"} type="button" disabled={editDisabled || shot.promptLocked || conflict} onClick={() => void run(save)} />
          <IconButton icon="undo" label={"放弃修改"} type="button" disabled={busy} onClick={() => { drafts.delete(key); setDraft(freshDraft(shot)); onDraftChange(); }} />
        </div>
        {conflict && <p role="alert">镜头已有更新，本地修改已保留。请复制需要的内容，再放弃修改以载入最新提示词。</p>}
      </div>}
      {creationKind === "video" && <details><summary>视频参考图与首尾帧</summary>{videoInputs}</details>}
      <small>在聊天中发送后生成新备选，已有结果和当前选用保持不变。</small>
      {jobs.some(job => job.status === "running" || job.status === "queued") && <small role="status">正在生成，进度可在工作区上方的任务记录中查看。</small>}
      {!!shot.promptDiscussion?.length && <details><summary>历史提示词建议</summary>{shot.promptDiscussion.map(turn => <div className="jz-video-tools" key={turn.id}><span>{turn.message.slice(0, 60)}</span><IconButton icon="apply" label={"使用此建议"} type="button" disabled={busy||dirty} onClick={() => {
        setCreationKind("video");
        requestVideoComposer({ workId: project.workId, episodeId: episode.id, shotId: shot.id, title: shot.title,
          action: "generate", kind: "video", promptMode: "text", prompt: turn.prompt, aspectRatio,
          referenceAssetIds: turn.referenceAssetIds ?? videoReferences,
          ...(turn.referenceAssetIds === undefined && roleInput ? { videoImageRoles } : {}),
        });
      }} /></div>)}</details>}
      </div>)}
    </article>;
  }
  return <>{controlsHost && <ShotPlayer key={videoAsset?.id ?? imageAsset?.id ?? shot.id} project={project} episode={episode} asset={videoAsset ?? imageAsset} remote={remote} aspectRatio={aspectRatio} active={active !== false} />}{renderControls(<article aria-label={`视频镜头 ${index + 1}`}>
    <div className="jz-video-editor-heading"><h3>{index + 1}. {shot.title}</h3><span>{shot.durationSec} 秒{shot.locked ? " · 已锁定" : ""}</span></div>
    <div className="jz-video-shot-workspace">
      {!controlsHost && <div className="jz-video-shot-visuals">
        {imageAsset && <figure><VideoAssetPreview remote={remote} workId={project.workId} asset={imageAsset} /><figcaption>镜头图片 · 视频默认首帧</figcaption></figure>}
        {videoAsset && <figure><VideoMediaPreview remote={remote} workId={project.workId} asset={videoAsset} /><figcaption>当前镜头视频</figcaption></figure>}
        {!imageAsset && !videoAsset && <p className="jz-video-assets-note">填写画面提示词，生成第一张镜头图片。</p>}
      </div>}
      <div className="jz-video-shot-fields">
        <label>画面内容<textarea rows={2} value={draft.value.description} maxLength={50000} disabled={editDisabled} onChange={(event) => change({ description: event.target.value })} /></label>
        <label>图片提示词<textarea rows={4} value={draft.value.prompt} maxLength={32000} disabled={editDisabled || shot.promptLocked} onChange={(event) => change({ prompt: event.target.value })} /></label>
        {shot.promptLocked && <small>提示词已锁定，可在制作稿中解锁。</small>}
        <div className="jz-video-tools"><span role="status">{dirty ? "有未保存修改" : "已保存"}</span><IconButton icon="save" label={"保存镜头"} type="button" disabled={!dirty || editDisabled || conflict} onClick={() => { void run(save); }} /></div>
        {conflict && <p role="alert">镜头已有更新，本地修改已保留。请复制需要的内容，再载入最新镜头。</p>}
        {dirty && <IconButton icon="reset" label={"放弃本地修改并载入最新镜头"} type="button" disabled={busy} onClick={() => { drafts.delete(key); setDraft(freshDraft(shot)); onDraftChange(); }} />}
      </div>
    </div>
    <VideoReferencePicker label="图片参考图" assets={project.assets} selected={draft.value.referenceAssetIds} onChange={(referenceAssetIds) => change({ referenceAssetIds })} remote={remote} workId={project.workId} disabled={editDisabled || shot.promptLocked} />
    <MediaGenerationInfo disabled={busy} state={mediaState} kind="image" referenceCount={draft.value.referenceAssetIds.length} />
    {remote.generateVideoMedia && <IconButton icon="image" label={(dirty ? "保存并生成图片" : imageAsset ? "重新生成图片" : "生成图片")} type="button" disabled={generationDisabled || !draft.value.prompt.trim() || imageEstimate.insufficientCredits || invalidReferences(draft.value.referenceAssetIds) || jobs.some((job) => job.kind === "image" && blocksShotGeneration(job))} onClick={() => generate("image")} />}
    <label>视频提示词<textarea rows={4} value={draft.value.videoPrompt ?? ""} maxLength={32000} disabled={editDisabled || shot.promptLocked} onChange={event => change({ videoPrompt: event.target.value })} placeholder="描述动作、运镜、节奏和声音" /></label>
    {videoInputs}
    <MediaGenerationInfo disabled={busy} state={mediaState} kind="video" durationSec={shot.durationSec} referenceCount={videoReferences.length} />
    {remote.generateVideoMedia && <IconButton icon="video" label={(dirty ? "保存并生成视频" : videoAsset ? "生成视频新版本" : "生成视频")} type="button" disabled={generationDisabled || !(draft.value.videoPrompt ?? "").trim() || videoEstimate.insufficientCredits || invalidFrames || invalidReferences(videoReferences) || jobs.some((job) => job.kind === "video" && blocksShotGeneration(job))} onClick={() => generate("video")} />}
    {!videoReferences.length && <small className="jz-video-assets-note">图生视频模型需要先生成镜头图片或选择参考图。</small>}
    {jobs.some((job) => job.status === "running" || job.status === "queued") && <small role="status">正在生成，进度可在任务记录中查看。</small>}

    {imageCandidates.length > 0 && remote.selectVideoAsset && <details><summary>候选图片 · {imageCandidates.length} 张</summary><div className="jz-video-candidates">{imageCandidates.map((asset) => <figure key={asset.id}><VideoAssetPreview remote={remote} workId={project.workId} asset={asset} /><figcaption>{asset.label}</figcaption><IconButton icon="apply" label={(shot.imageAssetId === asset.id ? "当前图片" : "选用此图片")} type="button" disabled={busy || shot.locked || shot.imageAssetId === asset.id} onClick={() => { void run(() => remote.selectVideoAsset!({ workId: project.workId, episodeId: episode.id, shotId: shot.id, assetId: asset.id, kind: "image", expectedRevision: project.revision })); }} /></figure>)}</div></details>}
    {candidates.length > 0 && <details><summary>候选视频 · {candidates.length} 个</summary><div className="jz-video-candidates">{candidates.map((asset) => <figure key={asset.id}><VideoMediaPreview remote={remote} workId={project.workId} asset={asset} /><figcaption>{asset.label}</figcaption><VideoVersionDetails project={project} jobId={asset.sourceJobId} />{remote.selectVideoAsset && <IconButton icon="apply" label={(shot.videoAssetId === asset.id ? "当前视频" : "选用此视频")} type="button" disabled={busy || shot.locked || shot.videoAssetId === asset.id} onClick={() => { void run(() => remote.selectVideoAsset!({ workId: project.workId, episodeId: episode.id, shotId: shot.id, assetId: asset.id, kind: "video", expectedRevision: project.revision })); }} />}</figure>)}</div></details>}
  </article>)}</>;
}

export function VideoVersionDetails({project,jobId}:{project:VideoProject;jobId:string|undefined}) {
  const job=project.jobs.find(item=>item.id===jobId);
  const summary=job?.state?.generationSummary;
  if(!summary||typeof summary!=="object"||Array.isArray(summary))return null;
  return <details><summary>本版本生成记录</summary>
    {typeof summary.model==="string"&&<p>{summary.model}{typeof summary.durationSeconds==="number"?` · ${summary.durationSeconds} 秒`:""}{typeof summary.aspectRatio==="string"?` · ${summary.aspectRatio}`:""}</p>}
    {(typeof summary.resolution==="string"||typeof summary.generateAudio==="boolean")&&<p>{typeof summary.resolution==="string"?summary.resolution:""}{typeof summary.generateAudio==="boolean"?` · ${summary.generateAudio?"有声":"无声"}`:""}</p>}
    {typeof summary.prompt==="string"&&<p style={{whiteSpace:"pre-wrap"}}>{summary.prompt}</p>}
  </details>;
}

function ShotPlayer({project, episode, asset, remote, aspectRatio, active}: {project: VideoProject; episode: VideoEpisode; asset: VideoAsset | undefined; remote: VideoShotsRemote; aspectRatio: GenerateVideoMediaInput["aspectRatio"]; active: boolean}) {
  const previewEpisode: VideoEpisode = {...episode, aspectRatio, texts: [], textTracks: [], videoTrackCount: 0, videoTrackBelowCount: 0,
    timeline: asset ? [{id: `preview-${asset.id}`, assetId: asset.id, inSec: 0, outSec: asset.durationSec ?? 5, volume: 1, subtitle: "", track: "video"}] : []};
  return <VideoTimelinePreview project={project} episode={previewEpisode} remote={remote} active={active} />;
}
