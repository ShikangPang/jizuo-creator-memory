import { userErrorMessage } from "@jizuo/contracts";
import { EPISODE_CHAT_SOURCE, decodeEpisodeReference, serializeEpisodeReference, type EpisodeChatReference } from "./episode-chat-reference.ts";
import { renderSkillPrompt } from "../../../contracts/src/skill-prompt.ts";
import { STYLE_CHAT_SOURCE, decodeStyleReference, serializeStyleReference, type StyleReference } from "./style-chat-reference.ts";
import type { InputTriggerSource, ReferenceInsert, SubmitAttachment } from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import { SHOT_CHAT_SOURCE, decodeShotChatReference, serializeShotChatReference } from "./shot-chat-reference.ts";
import type { VideoComposerInputs, VideoComposerRequest } from "./video-composer-request.ts";
import { mediaGenerationControls } from "../../../contracts/src/media-generation-controls.ts";
import type { MediaProviderConfig } from "../../../contracts/src/media.ts";
import { getMediaInputCapabilityError, resolveMediaInputCapabilities } from "../../../contracts/src/media-input-capabilities.ts";
import type { JizuoContentRemote } from "../content/remote.ts";
import { publishVideoProject } from "./useVideoProject.ts";
import type { ImageChatSubmissionObserver } from "./image-chat-store.ts";
import { hasVideoShotDraft } from "./VideoShotCard.tsx";
import type { VideoAssetView } from "@jizuo/contracts";
import { DESIGN_CHAT_SOURCE, decodeDesignReference, serializeDesignReference } from "./design-chat-reference.ts";
import { searchDesignReferenceAssets } from "./design-reference-assets.ts";
import { resolveComposerReferenceInputs } from "./composer-reference-inputs.ts";
import { EDITING_CHAT_SOURCE, decodeEditingChatReference, serializeEditingChatReference } from "./editing-chat-reference.ts";

type SubmitImageAttachment = Extract<SubmitAttachment, {type:"image"}>;
export type VideoComposerMode = "generate" | "image";
export type VideoImageRole = "reference_image" | "first_frame" | "last_frame";
export type VideoComposerTarget = { workId: string; episodeId: string; shotId: string; designId?: undefined; view?: undefined; editing?: undefined; clipId?: undefined };
export type DesignComposerTarget = { workId: string; designId: string; view: VideoAssetView; episodeId?: undefined; shotId?: undefined; editing?: undefined; clipId?: undefined };
export type EditingComposerTarget = { workId: string; episodeId: string; editing: true; clipId?: string; shotId?: undefined; designId?: undefined; view?: undefined };
export type MediaComposerTarget = VideoComposerTarget | DesignComposerTarget | EditingComposerTarget;
export type ComposerModelSelection = { kind: "text" | "image" | "video"; connectionId?: string | undefined };
export type ComposerSnapshot = ComposerModelSelection & { attachedMedia?: {workId: string; imageIds: string[]; videoIds: string[]} | undefined; selectionPending?: boolean; workId?: string | undefined; target?: MediaComposerTarget | undefined; activeReference?: {source:string;ref:string} | undefined; inputs: Partial<VideoComposerInputs>; imageRoles: Readonly<Record<string, VideoImageRole>> };
type Span = { start: number; end: number; draftRev: number };
export interface NativeVideoInput {
  state: { getSnapshot(): { draft: string; draftRev: number; phase?: string; attachmentIds?: readonly string[]; occurrences: readonly { source: string; ref: string; offset: number; length: number; invalid?: boolean }[] } };
  setDraft(text: string): void;
  insertReference(ref: ReferenceInsert, span: Span): boolean;
  insertText?(text: string, span: Span): boolean;
  consumeSpan?(span: Span): boolean;
}
export interface ComposerSubmissionRoute {
  images: true;
  submit(signal?: AbortSignal, images?: readonly SubmitAttachment[]): Promise<{ kind: "success" | "error"; text?: string }>;
}
export const draftImageRoleKey = (id: string) => `draft:${id}`;
export const VIDEO_IMAGE_SOURCE = "视频图片";
export const VIDEO_VIDEO_SOURCE = "参考视频";
export const VIDEO_AUDIO_SOURCE = "参考音频";
const EMPTY: ComposerSnapshot = { kind: "text", inputs: {}, imageRoles: {} };
function validateDraftImage(image: SubmitImageAttachment) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(image.mediaType)) throw new Error("生成参考图仅支持 PNG、JPEG 或 WebP 图片");
  const data = image.data;
  if (typeof data !== "string" || !data.length || data.length % 4 || data.length > 4 * Math.ceil(10 * 1024 * 1024 / 3)) throw new Error("参考图片内容无效或超过 10 MB，请重新添加");
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if (data.length / 4 * 3 - padding > 10 * 1024 * 1024) throw new Error("每张参考图片不能超过 10 MB");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || btoa(atob(data.slice(-4))) !== data.slice(-4)) throw new Error("参考图片内容无效，请重新添加");
}
export function decodeVideoImage(ref: string): { workId: string; assetId: string } | null {
  try { const value = JSON.parse(decodeURIComponent(ref)); return typeof value.workId === "string" && typeof value.assetId === "string" ? value : null; } catch { return null; }
}

export function createMainVideoComposer(remote: JizuoContentRemote, inputFor: (sessionId: string) => NativeVideoInput | undefined, imageChat?: ImageChatSubmissionObserver) {
  const states = new Map<string, ComposerSnapshot>();
  const listeners = new Map<string, Set<() => void>>();
  const pending = new Set<string>();
  const selections = new Map<string, number>();
  const designLabels = new Map<string, string>();
  // Native attachment IDs survive failed submissions; imported assets can be reused on retry.
  const importedImages = new Map<string, string>();
  const getSnapshot = (sessionId: string) => states.get(sessionId) ?? EMPTY;
  const hasContent = (sessionId: string) => {
    const input = inputFor(sessionId)?.state.getSnapshot();
    return Boolean(input && (input.draft.trim() || input.occurrences.length || input.attachmentIds?.length));
  };
  const update = (sessionId: string, patch: Partial<ComposerSnapshot>) => {
    states.set(sessionId, { ...getSnapshot(sessionId), ...patch });
    listeners.get(sessionId)?.forEach(listener => listener());
  };
  const subscribe = (sessionId: string, listener: () => void) => {
    const list = listeners.get(sessionId) ?? new Set(); list.add(listener); listeners.set(sessionId, list);
    return () => { list.delete(listener); if (!list.size) listeners.delete(sessionId); };
  };
  const configure = (sessionId: string, value: VideoComposerRequest) => update(sessionId, { inputs: structuredClone(value) });
  const updateInputs = (sessionId: string, patch: Partial<VideoComposerInputs>) => update(sessionId, { inputs: { ...getSnapshot(sessionId).inputs, ...patch } });
  const unbind = (sessionId: string) => update(sessionId, { target: undefined, inputs: {}, imageRoles: {} });
  const beginSelection = (sessionId: string) => {
    selections.set(sessionId, (selections.get(sessionId) ?? 0) + 1);
    update(sessionId, { selectionPending: true });
  };
  const cancelSelection = (sessionId: string) => {
    selections.set(sessionId, (selections.get(sessionId) ?? 0) + 1);
    if (getSnapshot(sessionId).selectionPending) update(sessionId, { selectionPending: false });
  };
  const clearSelection = (sessionId: string) => {
    const selected = getSnapshot(sessionId), input = inputFor(sessionId), draft = input?.state.getSnapshot();
    if (pending.has(sessionId) || ["submitting", "adjudicating"].includes(draft?.phase ?? "")) throw new Error("当前输入正在提交，请稍后切换");
    selections.set(sessionId, (selections.get(sessionId) ?? 0) + 1);
    const previous = draft?.occurrences.find(item => item.source === selected.activeReference?.source && item.ref === selected.activeReference.ref);
    if (previous && (!input?.consumeSpan || !input.consumeSpan({ start: previous.offset, end: previous.offset + previous.length, draftRev: draft!.draftRev }))) throw new Error("引用清除失败，请重新选择");
    update(sessionId, { target: undefined, activeReference: undefined, selectionPending: false, inputs: {} });
  };
  const setWork = (sessionId: string, workId: string | undefined) => {
    if (getSnapshot(sessionId).workId !== workId) update(sessionId, { workId, target: undefined, selectionPending: false, inputs: {}, imageRoles: {} });
  };
  const getImageRole = (sessionId: string, assetId: string) => getSnapshot(sessionId).imageRoles[assetId] ?? "reference_image";
  const setImageRole = (sessionId: string, assetId: string, role: VideoImageRole) => update(sessionId, { imageRoles: { ...getSnapshot(sessionId).imageRoles, [assetId]: role } });
  const bind = (sessionId: string, target: MediaComposerTarget) => {
    if (JSON.stringify(getSnapshot(sessionId).target) !== JSON.stringify(target)) update(sessionId, { workId: target.workId, target, inputs: {}, imageRoles: {} });
  };
  const readTarget = async (target: MediaComposerTarget | undefined) => {
    if (!target || !remote.getVideoProject) throw new Error("请先在工作区选择人物、场景或镜头");
    const project = await remote.getVideoProject({ workId: target.workId });
    if (project.workId !== target.workId) throw new Error("作品已变化，请重新选择");
    if (target.editing) {
      const episode = project.episodes.find(item => item.id === target.episodeId);
      if (!episode || target.clipId && !episode.timeline.some(item => item.id === target.clipId)) throw new Error("当前剪辑已不存在，请重新选择");
      return { target, project, episode, shot: undefined, design: undefined };
    }
    if (target.designId) {
      const design = project.designs?.find(item => item.id === target.designId);
      if (!design) throw new Error("当前设定已不存在，请重新选择");
      return { target, project, design, episode: undefined, shot: undefined };
    }
    const episode = project.episodes.find(item => item.id === target.episodeId), shot = episode?.shots.find(item => item.id === target.shotId && !item.archived);
    if (!episode || !shot) throw new Error("当前镜头已不存在，请重新选择");
    return { target, project, episode, shot, design: undefined };
  };
  const read = (sessionId: string) => readTarget(getSnapshot(sessionId).target);
  const rememberDiscussionTarget = (sessionId: string) => {
    const selected = getSnapshot(sessionId), snapshot = inputFor(sessionId)?.state.getSnapshot();
    const references = snapshot?.occurrences.filter(item => [SHOT_CHAT_SOURCE, DESIGN_CHAT_SOURCE, EDITING_CHAT_SOURCE].includes(item.source)) ?? [];
    if (!references.length) return;
    try {
      if (references.some(item => item.invalid)) throw new Error("引用无效");
      const editing = references.filter(item => item.source === EDITING_CHAT_SOURCE);
      if (editing.length) {
        const targets = new Map(editing.map(item => { const ref = decodeEditingChatReference(item.ref); return [JSON.stringify(ref), ref]; }));
        const target = targets.values().next().value;
        if (targets.size !== 1 || !target || target.workId !== selected.workId) throw new Error("需要选择剪辑对象");
        bind(sessionId, target);
        updateInputs(sessionId, { promptMode: "reference", kind: "video", title: selected.inputs.title ?? "剪辑上下文" });
        return;
      }
      const shots = new Map(references.filter(item => item.source === SHOT_CHAT_SOURCE).map(item => { const ref = decodeShotChatReference(item.ref); return [JSON.stringify(ref), ref]; }));
      const designs = new Map(references.filter(item => item.source === DESIGN_CHAT_SOURCE).map(item => { const ref = decodeDesignReference(item.ref); return [JSON.stringify(ref), ref]; }));
      if (shots.size > 1 || !shots.size && designs.size !== 1) throw new Error("需要选择生成对象");
      const ref = shots.values().next().value ?? designs.values().next().value;
      if (!ref || ref.workId !== (selected.workId ?? selected.target?.workId)) throw new Error("作品已变化");
      const target: MediaComposerTarget = "shotId" in ref
        ? { workId: ref.workId, episodeId: ref.episodeId, shotId: ref.shotId }
        : ref.view ? { workId: ref.workId, designId: ref.designId, view: ref.view }
          : selected.target?.designId === ref.designId ? selected.target : (() => { throw new Error("请在对话中选择设定视图"); })();
      const kind = "kind" in ref ? ref.kind : "image";
      const title = JSON.stringify(selected.target) === JSON.stringify(target) ? selected.inputs.title
        : target.designId ? designLabels.get(`${target.workId}/${target.designId}`) : undefined;
      bind(sessionId, target);
      updateInputs(sessionId, { promptMode: "reference", kind, title: title ?? (target.designId ? "人物或场景" : "镜头提示词") });
    } catch {
      // Multiple subjects can be discussed together; do not restore an unrelated old generation target.
      unbind(sessionId);
    }
  };
  const submissionRoute = (sessionId: string): ComposerSubmissionRoute | undefined => {
    const selected = getSnapshot(sessionId);
    if (selected.selectionPending) return { images: true, async submit() { return { kind: "error", text: "正在切换工作区引用，请稍后发送" }; } };
    if (selected.kind === "text") { rememberDiscussionTarget(sessionId); return undefined; }
    const captured = structuredClone(selected);
    const input = inputFor(sessionId), draft = input?.state.getSnapshot();
    // A route belongs to one submit attempt, including its exact prompt and reference ranges.
    const snapshot = draft ? { ...draft, attachmentIds: draft.attachmentIds?.slice(), occurrences: draft.occurrences.map(item => ({ ...item })) } : undefined;
    return { images: true,
      async submit(signal, images = []) {
        if (pending.has(sessionId)) return { kind: "error", text: "当前操作尚未完成" };
        pending.add(sessionId);
        let mediaSubmissionId: string | undefined;
        try {
          signal?.throwIfAborted();
          if (!input || !snapshot) throw new Error("主对话框已不可用");
          const nativeIds = snapshot.attachmentIds ?? [], attachments = images.map(image => { if(image.type !== "image") throw new Error("生成参考图请使用图片附件，视频和音频请通过媒体引用添加"); return {...image}; });
          if (nativeIds.length !== attachments.length || new Set(nativeIds).size !== nativeIds.length) throw new Error("参考图片读取不完整，请重新添加后提交");
          attachments.forEach(validateDraftImage);
          const current = getSnapshot(sessionId);
          if (JSON.stringify(current.target) !== JSON.stringify(captured.target)) throw new Error("创作镜头已切换，请重新提交");
          if (current.connectionId !== captured.connectionId || current.kind !== captured.kind) throw new Error("模型已切换，请重新提交");
          const checkSelection = () => {
            signal?.throwIfAborted();
            const latest = getSnapshot(sessionId);
            if (JSON.stringify(latest.target) !== JSON.stringify(captured.target) || latest.connectionId !== captured.connectionId || latest.kind !== captured.kind) throw new Error("镜头或模型已切换，请重新提交");
          };
          const { project, episode, shot, design, target } = await read(sessionId);
          checkSelection();
          if (target.editing) throw new Error("当前引用的是剪辑，请切换到对话讨论剪辑，或选择镜头后生成");
          if (shot && episode && hasVideoShotDraft(target.workId, episode.id, shot.id)) throw new Error("镜头有未保存修改，请先保存或放弃修改");
          const kind = captured.kind === "image" ? "image" : "video";
          if (design && kind !== "image") throw new Error("人物和场景设定用于图片生成，生成视频请先选择镜头");
          const settings = await remote.getMediaSettings?.();
          checkSelection();
          const connection = captured.connectionId ? settings?.connections?.find(item => item.id === captured.connectionId && item.kind === kind && item.keyConfigured) : undefined;
          if (captured.connectionId && !connection) throw new Error("所选模型已移除或凭据不可用，请重新选择模型");
          const config = connection?.config ?? settings?.settings[kind];
          if (remote.getMediaSettings && !config) throw new Error(`请先配置${kind === "image" ? "图片" : "视频"}模型`);
          const inputs = captured.inputs;
          const hasShotReference = snapshot.occurrences.some(item => item.source === SHOT_CHAT_SOURCE);
          const hasPromptReference = hasShotReference || snapshot.occurrences.some(item => item.source === DESIGN_CHAT_SOURCE);
          // Explicit media choices remain editable; otherwise a live reference follows the saved subject.
          const { referenceAssetIds: ids, referenceVideoAssetIds: videoIds } = resolveComposerReferenceInputs(project, captured, snapshot.occurrences);
          let prompt = snapshot.draft;
          for (const occurrence of [...snapshot.occurrences].sort((a, b) => a.offset - b.offset)) {
            if (occurrence.source === STYLE_CHAT_SOURCE && !occurrence.invalid) {
              if (decodeStyleReference(occurrence.ref).workId !== target.workId) throw new Error("画风引用不属于当前作品");
              continue;
            }
            if (occurrence.source === SHOT_CHAT_SOURCE && !occurrence.invalid) {
              const ref = decodeShotChatReference(occurrence.ref);
              if (ref.workId !== target.workId || ref.episodeId !== target.episodeId || ref.shotId !== target.shotId || !shot) throw new Error("提示词引用与当前镜头不一致，请重新选择");
              continue;
            }
            if (occurrence.source === DESIGN_CHAT_SOURCE && !occurrence.invalid) {
              const ref = decodeDesignReference(occurrence.ref);
              if (ref.workId !== target.workId || !project.designs?.some(item => item.id === ref.designId)) throw new Error("人物或场景设定已不可用，请重新选择");
              continue;
            }
            if (occurrence.source === VIDEO_AUDIO_SOURCE) throw new Error("当前生成接口暂不支持音频参考；可先试听，生成前请移除音频引用");
            if (![VIDEO_IMAGE_SOURCE, VIDEO_VIDEO_SOURCE].includes(occurrence.source) || occurrence.invalid) throw new Error("生成仅接受本作品的设定和参考素材，请移除其他引用");
            const ref = decodeVideoImage(occurrence.ref), assetKind = occurrence.source === VIDEO_IMAGE_SOURCE ? "image" : "video";
            if (!ref || ref.workId !== target.workId || !project.assets.some(asset => asset.id === ref.assetId && asset.kind === assetKind && !asset.panorama)) throw new Error("引用素材不属于当前作品或已不可用");
            const list = assetKind === "image" ? ids : videoIds;
            if (!list.includes(ref.assetId)) list.push(ref.assetId);
          }
          for (const occurrence of [...snapshot.occurrences].sort((a, b) => b.offset - a.offset)) {
            if (occurrence.source === STYLE_CHAT_SOURCE) { prompt = prompt.slice(0,occurrence.offset) + prompt.slice(occurrence.offset + occurrence.length); continue; }
            if (occurrence.source === SHOT_CHAT_SOURCE) {
              const value = kind === "image" ? shot!.prompt : shot!.videoPrompt ?? "";
              if (!value.trim()) throw new Error(`当前镜头还没有${kind === "image" ? "图片" : "视频"}提示词，请先与 AI 优化或手动编辑`);
              prompt = prompt.slice(0, occurrence.offset) + value + prompt.slice(occurrence.offset + occurrence.length);
              continue;
            }
            if (occurrence.source === DESIGN_CHAT_SOURCE) {
              const ref = decodeDesignReference(occurrence.ref), value = project.designs!.find(item => item.id === ref.designId)!;
              if (!value.description.trim()) throw new Error(`「${value.name}」还没有提示词，请先与 AI 优化或手动编辑`);
              prompt = prompt.slice(0, occurrence.offset) + (value.id === target.designId ? value.description : `${value.name}（${value.description}）`) + prompt.slice(occurrence.offset + occurrence.length);
              continue;
            }
            const ref = decodeVideoImage(occurrence.ref)!;
            const image = occurrence.source === VIDEO_IMAGE_SOURCE;
            prompt = prompt.slice(0, occurrence.offset) + `@${image ? "图片" : "视频"}${(image ? ids : videoIds).indexOf(ref.assetId) + 1}` + prompt.slice(occurrence.offset + occurrence.length);
          }
          if (ids.some(id => !project.assets.some(asset => asset.id === id && asset.kind === "image" && !asset.panorama))) throw new Error("参考图片已不可用，请移除后重选");
          if (videoIds.some(id => !project.assets.some(asset => asset.id === id && asset.kind === "video" && asset.sourceUrl))) throw new Error("参考视频需要本作品中带远程链接的生成视频");
          prompt = prompt.trim();
          if (!prompt) throw new Error("请在主输入框填写生成提示词");
          if (prompt.length > 32000) throw new Error("提示词与引用设定合计超过 32000 字，请精简后再生成");
          const capabilities = config ? resolveMediaInputCapabilities(config, kind) : undefined;
          const defaultRole = capabilities?.firstFrame && !capabilities.referenceImages.max ? "first_frame" : "reference_image";
          const roles = ids.map(id => captured.imageRoles[id] ?? inputs.videoImageRoles?.[inputs.referenceAssetIds?.indexOf(id) ?? -1] ?? defaultRole);
          roles.push(...nativeIds.map(id => captured.imageRoles[draftImageRoleKey(id)] ?? defaultRole));
          const allIds = [...ids, ...nativeIds.map(draftImageRoleKey)];
          if (allIds.length > 14) throw new Error("一次生成最多支持 14 张参考图片，请减少图片后重试");
          if (config) {
            const invalid = getMediaInputCapabilityError(config as MediaProviderConfig, { kind,
              references: allIds.map((id, i) => ({ url: `https://reference.invalid/${encodeURIComponent(id)}`, ...(kind === "video" ? { role: roles[i]! } : {}) })),
              ...(videoIds.length ? { videoReferences: videoIds.map(id => ({ url: project.assets.find(asset => asset.id === id)!.sourceUrl! })) } : {}),
            });
            if (invalid) throw new Error(invalid);
          }
          const oldPrompt = design?.description ?? (kind === "image" ? shot?.prompt : shot?.videoPrompt) ?? "";
          if (design?.locked || shot?.locked || shot?.promptLocked && prompt !== oldPrompt) throw new Error("设定、镜头或提示词已锁定，请先解锁后修改");
          if (!remote.generateVideoMedia) throw new Error("媒体生成尚未连接");
          const label = design ? `${design.name}` : shot!.title;
          if (imageChat) mediaSubmissionId = imageChat.start(sessionId, target.workId, { kind, prompt, ...(config?.model ? { model: config.model } : {}), label });
          let prepared = project;
          checkSelection();
          if (attachments.length) {
            if (!remote.importVideoAsset) throw new Error("参考图片导入尚未连接");
            prepared = await remote.getVideoProject!({ workId: target.workId });
            checkSelection();
            if (design) {
              if (JSON.stringify(prepared.designs?.find(item => item.id === design.id)) !== JSON.stringify(design)) throw new Error("设定已修改，请确认后重新提交");
            } else {
              const latestEpisode = prepared.episodes.find(item => item.id === episode!.id);
              if (!latestEpisode || JSON.stringify(latestEpisode.shots) !== JSON.stringify(episode!.shots)) throw new Error("镜头已修改，请确认后重新提交");
            }
            if (ids.some(id => !prepared.assets.some(asset => asset.id === id && asset.kind === "image" && !asset.panorama)) || videoIds.some(id => !prepared.assets.some(asset => asset.id === id && asset.kind === "video" && asset.sourceUrl))) throw new Error("参考素材已变化，请重新选择");
            for (const [index, image] of attachments.entries()) {
              checkSelection();
              const key = JSON.stringify([sessionId, target.workId, nativeIds[index]]);
              let assetId = importedImages.get(key);
              if (!assetId || !prepared.assets.some(asset => asset.id === assetId && asset.kind === "image" && !asset.panorama)) {
                const previous = prepared;
                prepared = await remote.importVideoAsset({ workId: target.workId, expectedRevision: previous.revision, kind: "image", label: image.name?.trim().slice(0, 120) || `参考图片 ${index + 1}`, mimeType: image.mediaType as "image/png" | "image/jpeg" | "image/webp", base64: image.data });
                assetId = prepared.assets.find(asset => asset.kind === "image" && !previous.assets.some(item => item.id === asset.id))?.id;
                if (!assetId) throw new Error("图片已保存到素材库，请从素材库重新选择");
                importedImages.set(key, assetId);
                publishVideoProject(prepared);
              }
              checkSelection();
              ids.push(assetId);
            }
          }
          if (kind === "video" && shot && episode && !hasPromptReference && prompt !== oldPrompt) {
            if (!remote.updateVideoEpisode) throw new Error("镜头提示词保存尚未连接");
            checkSelection();
            prepared = await remote.updateVideoEpisode({ workId: target.workId, episodeId: episode.id, expectedRevision: prepared.revision,
              patch: { shots: episode.shots.map(item => item.id === shot.id ? { ...item, videoPrompt: prompt } : item) } });
            publishVideoProject(prepared);
          }
          checkSelection();
          const preferredRatio = inputs.aspectRatio ?? episode?.aspectRatio ?? (design ? "16:9" : "9:16");
          const supportedRatios = config ? mediaGenerationControls(config, kind, ids.length > 0).ratios : [];
          const aspectRatio = supportedRatios.length && !supportedRatios.includes(preferredRatio) ? supportedRatios[0]! : preferredRatio;
          const next = await remote.generateVideoMedia({ ...target, expectedRevision: prepared.revision, kind, prompt, referenceAssetIds: ids,
            ...(captured.connectionId ? { connectionId: captured.connectionId } : {}),
            selectResult: false,
            ...(inputs.generationSettings ? { generationSettings: inputs.generationSettings } : {}),
            ...(kind === "video" && inputs.durationSeconds !== undefined ? { durationSeconds: inputs.durationSeconds } : {}),
            sourceSessionId: sessionId,
            ...(kind === "video" && ids.length ? { videoImageRoles: roles } : {}),
            ...(videoIds.length ? { referenceVideoAssetIds: videoIds } : {}), ...(design ? { label } : {}), aspectRatio });
          publishVideoProject(next);
          if (mediaSubmissionId) imageChat?.accepted(sessionId, mediaSubmissionId, next);
          return imageChat ? { kind: "success" } : { kind: "success", text: kind === "image" ? "图片任务已提交，完成后保存到素材库" : "视频任务已提交，请在侧边工作区查看" };
        } catch (error) {
          const text = userErrorMessage(error, "媒体创作操作失败", { operation: "main-video-composer" });
          if (mediaSubmissionId) imageChat?.failed(sessionId, mediaSubmissionId, text);
          return { kind: "error", text };
        }
        finally { pending.delete(sessionId); }
      },
    };
  };
  const setModel = (sessionId: string, selection: ComposerModelSelection) => {
    const input = inputFor(sessionId);
    if (!input || pending.has(sessionId) || ["submitting", "adjudicating"].includes(input.state.getSnapshot().phase ?? "")) return false;
    const previous = getSnapshot(sessionId).inputs;
    let inputs = previous;
    if (selection.kind !== "text" && previous.kind && previous.kind !== selection.kind) {
      const { referenceAssetIds: _images, referenceVideoAssetIds: _videos, videoImageRoles: _roles, ...shared } = previous;
      inputs = { ...shared, kind: selection.kind };
    }
    if (getSnapshot(sessionId).kind !== selection.kind || getSnapshot(sessionId).connectionId !== selection.connectionId) {
      const { generationSettings: _settings, durationSeconds: _duration, ...rest } = inputs;
      inputs = rest;
    }
    update(sessionId, { kind: selection.kind, connectionId: selection.kind === "text" ? undefined : selection.connectionId, inputs });
    return true;
  };
  const promptReference = (target: MediaComposerTarget, kind: "image" | "video", label: string, withoutDesignView = false): ReferenceInsert => {
    const value = target.designId && withoutDesignView
      ? { workId: target.workId, designId: target.designId }
      : target.designId || target.editing ? target : { ...target, kind };
    return {
      source: target.editing ? EDITING_CHAT_SOURCE : target.designId ? DESIGN_CHAT_SOURCE : SHOT_CHAT_SOURCE,
      ref: encodeURIComponent(JSON.stringify(value)),
      label, appearance: "file", clipboardText: `@${label}`,
    };
  };
  const selectModel = (sessionId: string, selection: ComposerModelSelection) => {
    const selected = getSnapshot(sessionId), input = inputFor(sessionId);
    if (!input || pending.has(sessionId) || ["submitting", "adjudicating"].includes(input.state.getSnapshot().phase ?? "")) return false;
    if (selection.kind !== "text" && selection.kind !== selected.kind && selected.target && !selected.target.editing && selected.inputs.promptMode === "reference" && !hasContent(sessionId)) {
      const snapshot = input.state.getSnapshot();
      const reference = promptReference(selected.target, selection.kind, selected.inputs.title || (selected.target.designId ? "人物或场景" : "镜头提示词"));
      if (!input.insertReference(reference, { start: snapshot.draft.length, end: snapshot.draft.length, draftRev: snapshot.draftRev })) return false;
      update(sessionId, { activeReference: { source: reference.source, ref: reference.ref } });
    }
    // A shot reference follows the selected image/video type without materializing its prompt.
    if (selection.kind !== "text" && selection.kind !== selected.kind) {
      for (const occurrence of [...input.state.getSnapshot().occurrences].filter(item => item.source === SHOT_CHAT_SOURCE && !item.invalid).sort((a, b) => b.offset - a.offset)) {
        const ref = decodeShotChatReference(occurrence.ref);
        if (ref.kind === selection.kind) continue;
        const snapshot = input.state.getSnapshot();
        const reference = promptReference(ref, selection.kind, selected.inputs.title || "镜头提示词");
        if (!input.insertReference(reference, { start: occurrence.offset, end: occurrence.offset + occurrence.length, draftRev: snapshot.draftRev })) return false;
        if (selected.activeReference?.ref === occurrence.ref) update(sessionId, { activeReference: { source: reference.source, ref: reference.ref } });
      }
    }
    return setModel(sessionId, selection);
  };
  const activate = (sessionId: string, mode: VideoComposerMode, text?: string) => {
    const input = inputFor(sessionId); if (!input) return false;
    const selected = getSnapshot(sessionId), kind = mode === "image" ? "image" : "video";
    if (!setModel(sessionId, { kind, connectionId: selected.kind === kind ? selected.connectionId : undefined })) return false;
    if (text !== undefined) input.setDraft(text);
    return true;
  };
  const insertAsset = async (sessionId: string, assetId: string, role?: VideoImageRole, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const input = inputFor(sessionId); if (!input) throw new Error("主输入框不可用");
    const busy = () => pending.has(sessionId) || ["submitting", "adjudicating"].includes(input.state.getSnapshot().phase ?? "");
    if (busy()) throw new Error("输入框正在提交，请稍后添加参考素材");
    const selection = getSnapshot(sessionId);
    const before = input.state.getSnapshot(), { target, project } = await read(sessionId);
    signal?.throwIfAborted();
    const asset = project.assets.find(item => item.id === assetId && ["image", "video"].includes(item.kind) && !item.panorama);
    if (!asset) throw new Error("参考素材已不可用");
    const current = getSnapshot(sessionId);
    if (busy() || current.kind !== selection.kind || current.connectionId !== selection.connectionId) throw new Error("模型或输入状态已变化，请重新选择参考素材");
    if (input.state.getSnapshot().draftRev !== before.draftRev || JSON.stringify(target) !== JSON.stringify(getSnapshot(sessionId).target)) throw new Error("镜头或输入已变化，请重新选择参考素材");
    if (current.kind !== "text") {
      const refs = current.attachedMedia?.workId === project.workId ? current.attachedMedia : {workId: project.workId, imageIds: [], videoIds: []};
      const key = asset.kind === "image" ? "imageIds" : "videoIds";
      update(sessionId, { attachedMedia: {...refs, [key]: [...new Set([...refs[key], assetId])]} });
      if (role) setImageRole(sessionId, asset.id, role);
      return;
    }
    if (role) setImageRole(sessionId, asset.id, role);
    if (!input.insertReference({ source: asset.kind === "image" ? VIDEO_IMAGE_SOURCE : VIDEO_VIDEO_SOURCE, ref: encodeURIComponent(JSON.stringify({ workId: project.workId, assetId })), label: asset.label, appearance: "file", clipboardText: `@${asset.label}` }, { start: before.draft.length, end: before.draft.length, draftRev: before.draftRev })) throw new Error("参考素材添加失败，请重试");
  };
  const removeReference = (sessionId: string, assetId: string, resolvedImageIds?: readonly string[]) => {
    const input = inputFor(sessionId); if (!input) return false;
    let snapshot = input.state.getSnapshot();
    const occurrences = snapshot.occurrences.filter(item => [VIDEO_IMAGE_SOURCE, VIDEO_VIDEO_SOURCE].includes(item.source) && decodeVideoImage(item.ref)?.assetId === assetId).sort((a, b) => b.offset - a.offset);
    if (occurrences.length && !input.consumeSpan) return false;
    for (const item of occurrences) {
      snapshot = input.state.getSnapshot();
      if (!input.consumeSpan!({ start: item.offset, end: item.offset + item.length, draftRev: snapshot.draftRev })) return false;
    }
    const attached = getSnapshot(sessionId).attachedMedia;
    if (attached) update(sessionId, {attachedMedia: {...attached, imageIds: attached.imageIds.filter(id => id !== assetId), videoIds: attached.videoIds.filter(id => id !== assetId)}});
    const inputs = getSnapshot(sessionId).inputs, old = resolvedImageIds ?? inputs.referenceAssetIds ?? [];
    updateInputs(sessionId, { referenceAssetIds: old.filter(id => id !== assetId), videoImageRoles: old.flatMap((id, i) => id !== assetId && inputs.videoImageRoles?.[i] ? [inputs.videoImageRoles[i]!] : []), referenceVideoAssetIds: (inputs.referenceVideoAssetIds ?? []).filter(id => id !== assetId) });
    return true;
  };
  const insertDesign = async (sessionId: string, designId: string) => {
    const input = inputFor(sessionId); if (!input) throw new Error("主输入框不可用");
    const before = input.state.getSnapshot(), selected = getSnapshot(sessionId), workId = selected.target?.workId ?? selected.workId;
    if (!workId || !remote.getVideoProject) throw new Error("请先选择作品");
    const project = await remote.getVideoProject({ workId }), design = project.designs?.find(item => item.id === designId);
    const latest = getSnapshot(sessionId);
    if (!design || latest.workId !== selected.workId || latest.kind !== selected.kind || latest.connectionId !== selected.connectionId || JSON.stringify(latest.target) !== JSON.stringify(selected.target) || input.state.getSnapshot().draftRev !== before.draftRev) throw new Error("设定或输入已变化，请重新选择");
    if (pending.has(sessionId) || ["submitting", "adjudicating"].includes(input.state.getSnapshot().phase ?? "")) throw new Error("输入框正在提交，请稍后添加设定");
    designLabels.set(`${workId}/${designId}`, `${design.name}`);
    if (!input.insertReference({ source: DESIGN_CHAT_SOURCE, ref: encodeURIComponent(JSON.stringify({ workId, designId })), label: `${design.name}`, appearance: "file", clipboardText: `@${design.name}` }, { start: before.draft.length, end: before.draft.length, draftRev: before.draftRev })) throw new Error("设定引用添加失败，请重试");
  };
  const fillPrompt = (sessionId: string, text: string, assetIds: readonly string[], mode: VideoComposerMode | "text", context: Awaited<ReturnType<typeof readTarget>>) => {
    const input = inputFor(sessionId); if (!input) throw new Error("主输入框不可用");
    const { target, project, design } = context;
    update(sessionId, { activeReference: undefined });
    if (assetIds.some(id => !project.assets.some(asset => asset.id === id && asset.kind === "image" && !asset.panorama))) throw new Error("引用图片已不可用");
    if (mode === "text") {
      if (!setModel(sessionId, { kind: "text" })) throw new Error("输入框正在忙，请稍后加载");
      input.setDraft(text);
      if (design) {
        const snapshot = input.state.getSnapshot();
        if (!input.insertReference({ source: DESIGN_CHAT_SOURCE, ref: encodeURIComponent(JSON.stringify({ workId: target.workId, designId: design.id })), label: `${design.name}`, appearance: "file", clipboardText: `@${design.name}` }, { start: snapshot.draft.length, end: snapshot.draft.length, draftRev: snapshot.draftRev })) throw new Error("设定引用添加失败，请用 @ 重新选择");
      }
      return;
    }
    if (!activate(sessionId, mode, text)) throw new Error("输入框正在忙，请稍后加载");
    for (const [index, id] of [...new Set(assetIds)].entries()) {
      const asset = project.assets.find(item => item.id === id)!;
      const snapshot = input.state.getSnapshot(), token = `@图片${index + 1}`, found = snapshot.draft.indexOf(token), start = found < 0 ? snapshot.draft.length : found;
      if (!input.insertReference({ source: VIDEO_IMAGE_SOURCE, ref: encodeURIComponent(JSON.stringify({ workId: project.workId, assetId: id })), label: asset.label, appearance: "file", clipboardText: `@${asset.label}` }, { start, end: found < 0 ? start : start + token.length, draftRev: snapshot.draftRev })) throw new Error("图片引用插入未完成，请用 @ 重新选择");
    }
  };
  const loadPrompt = async (sessionId: string, text: string, assetIds: readonly string[] = [], mode: VideoComposerMode | "text" = "generate") => {
    const input = inputFor(sessionId); if (!input) throw new Error("主输入框不可用");
    const before = input.state.getSnapshot(), selected = getSnapshot(sessionId), context = await read(sessionId);
    if (selected !== getSnapshot(sessionId) || inputFor(sessionId)?.state !== input.state || input.state.getSnapshot().draftRev !== before.draftRev) throw new Error("设定、镜头或输入内容已变化，请重新加载");
    updateInputs(sessionId, { promptMode: "text" });
    fillPrompt(sessionId, text, assetIds, mode, context);
  };
  const fillReference = (sessionId: string, kind: "image" | "video", mode: ComposerModelSelection["kind"], context: Awaited<ReturnType<typeof readTarget>>, message = "") => {
    const { target, shot, design, episode, project } = context, selected = getSnapshot(sessionId);
    const input = inputFor(sessionId)!;
    if (message) {
      const before = input.state.getSnapshot();
      if (input.insertText) {
        if (!input.insertText(message, { start: 0, end: 0, draftRev: before.draftRev })) throw new Error("无法添加优化要求，请重试");
      } else if (!before.occurrences.length) input.setDraft(message + before.draft);
      else throw new Error("输入框尚不支持保留引用并添加文字，请更新后重试");
    }
    const snapshot = input.state.getSnapshot();
    const matchesTarget = (item: typeof snapshot.occurrences[number]) => {
      if (!selected.target) return false;
      try {
        const ref = item.source === DESIGN_CHAT_SOURCE ? decodeDesignReference(item.ref) : item.source === SHOT_CHAT_SOURCE ? decodeShotChatReference(item.ref) : item.source === EDITING_CHAT_SOURCE ? decodeEditingChatReference(item.ref) : undefined;
        if (!ref || ref.workId !== selected.target.workId) return false;
        if ("designId" in ref) return ref.designId === selected.target.designId;
        if ("editing" in ref) return selected.target.editing && ref.episodeId === selected.target.episodeId && ref.clipId === selected.target.clipId;
        return ref.episodeId === selected.target.episodeId && ref.shotId === selected.target.shotId;
      } catch { return false; }
    };
    const previous = snapshot.occurrences.find(item => item.source === selected.activeReference?.source && item.ref === selected.activeReference.ref)
      ?? snapshot.occurrences.find(matchesTarget);
    const clip = target.editing && target.clipId ? episode?.timeline.find(item => item.id === target.clipId) : undefined;
    const label = target.editing ? clip ? `剪辑 · ${project.assets.find(item => item.id === clip.assetId)?.label ?? "片段"}` : `剪辑 · ${episode!.title}` : design ? `${design.name}` : shot!.title;
    const reference = promptReference(target, kind, label, mode === "text");
    const start = previous?.offset ?? snapshot.draft.length;
    if (!input.insertReference(reference, { start, end: start + (previous?.length ?? 0), draftRev: snapshot.draftRev })) throw new Error("提示词引用切换失败，请重新选择");
    if (!setModel(sessionId, { kind: mode, connectionId: mode === selected.kind ? selected.connectionId : undefined })) throw new Error("输入框正在忙，请稍后加载");
    update(sessionId, { activeReference: { source: reference.source, ref: reference.ref } });
  };
  const fillOptimization = (sessionId: string, kind: "image" | "video", context: Awaited<ReturnType<typeof readTarget>>, prompt?: string) => {
    const subject = context.design ? context.design.kind === "character" ? "人物" : "场景" : "镜头";
    const message = renderSkillPrompt("optimize-media-request", {subject,kind:kind === "image" ? "图片" : "视频",draft:prompt}) + "\n";
    fillReference(sessionId, kind, "text", context, message);
  };
  /** Validate a selection before changing either the generation target or the user's draft. */
  const applyRequest = async (sessionId: string, request: VideoComposerRequest, _replaceExisting = false, signal?: AbortSignal): Promise<"applied"> => {
    signal?.throwIfAborted();
    const input = inputFor(sessionId); if (!input) throw new Error("主输入框不可用");
    beginSelection(sessionId);
    const sequence = selections.get(sessionId)!;
    const before = input.state.getSnapshot(), initial = getSnapshot(sessionId);
    let selected = initial;
    const promptMode = request.promptMode ?? "reference";
    const liveSelection = request.action === "select" && promptMode === "reference";
    const check = () => {
      signal?.throwIfAborted();
      if (selections.get(sessionId) !== sequence || inputFor(sessionId)?.state !== input.state || initial.workId !== getSnapshot(sessionId).workId || !liveSelection && initial !== getSnapshot(sessionId) || promptMode === "text" && input.state.getSnapshot().draftRev !== before.draftRev) throw new Error("设定、模型或输入内容已变化，请重新选择");
      if (pending.has(sessionId) || ["submitting", "adjudicating"].includes(input.state.getSnapshot().phase ?? "")) throw new Error("当前输入正在提交，请稍后切换");
    };
    try {
    check();
    const target: MediaComposerTarget = request.editing
      ? { workId: request.workId, episodeId: request.episodeId, editing: true, ...(request.clipId ? { clipId: request.clipId } : {}) } : request.designId
      ? { workId: request.workId, designId: request.designId, view: request.view! }
      : { workId: request.workId, episodeId: request.episodeId!, shotId: request.shotId! };
    const context = await readTarget(target);
    check();
    selected = getSnapshot(sessionId);
    if (request.referenceAssetIds?.some(id => !context.project.assets.some(asset => asset.id === id && asset.kind === "image" && !asset.panorama))) throw new Error("引用图片已不可用");
    const { prompt: _prompt, ...configuration } = request;
    const kind = request.action === "select" && !target.designId && !target.editing && selected.kind !== "text" ? selected.kind : request.kind;
    if (target.editing) fillReference(sessionId, "video", "text", context);
    else if (request.action === "optimize") fillOptimization(sessionId, kind, context, promptMode === "text" ? request.prompt : undefined);
    else if (promptMode === "text") {
      const text = request.prompt ?? context.design?.description ?? (request.kind === "image" ? context.shot?.prompt : context.shot?.videoPrompt) ?? "";
      fillPrompt(sessionId, text, request.referenceAssetIds ?? context.design?.referenceAssetIds ?? (request.kind === "image" ? context.shot?.referenceAssetIds : undefined) ?? [], request.action === "select" && selected.kind === "text" ? "text" : request.kind === "image" ? "image" : "generate", context);
    } else fillReference(sessionId, kind, request.action === "select" && selected.kind === "text" ? "text" : kind, context);
    bind(sessionId, target);
    configure(sessionId, { ...configuration, kind, promptMode });
    // Uploaded images and independently attached media keep their chosen roles.
    const keptIds = new Set((input.state.getSnapshot().attachmentIds ?? []).map(draftImageRoleKey));
    if (selected.attachedMedia?.workId === target.workId) for (const id of selected.attachedMedia.imageIds) keptIds.add(id);
    for (const item of input.state.getSnapshot().occurrences) if (item.source === VIDEO_IMAGE_SOURCE) { const ref = decodeVideoImage(item.ref); if (ref?.workId === target.workId) keptIds.add(ref.assetId); }
    update(sessionId, { imageRoles: Object.fromEntries(Object.entries(selected.imageRoles).filter(([id]) => keptIds.has(id))) });
    return "applied";
    } finally { if (selections.get(sessionId) === sequence) update(sessionId, { selectionPending: false }); }
  };
  const assetSource = (kind: "image" | "video" | "audio"): InputTriggerSource => ({ trigger: "@", name: kind === "image" ? VIDEO_IMAGE_SOURCE : kind === "video" ? VIDEO_VIDEO_SOURCE : VIDEO_AUDIO_SOURCE, order: 5, showGroupTitle: true,
    async candidates(session, { query, signal }) {
      const selected = getSnapshot(session.sessionId);
      const workId = selected.target?.workId ?? selected.workId;
      if (!workId || !remote.getVideoProject) return [];
      if (selected.kind !== "text" && kind !== "audio") {
        const settings = await remote.getMediaSettings?.(); signal.throwIfAborted();
        const config = selected.connectionId
          ? settings?.connections?.find(item => item.id === selected.connectionId && item.kind === selected.kind && item.keyConfigured)?.config
          : settings?.settings[selected.kind];
        if (!config) return [];
        const caps = resolveMediaInputCapabilities(config, selected.kind);
        if (kind === "image" ? !caps.referenceImages.max && !caps.firstFrame : !caps.referenceVideos.max) return [];
      }
      const project = await remote.getVideoProject({ workId }); signal.throwIfAborted();
      const latest = getSnapshot(session.sessionId);
      if (latest.workId !== selected.workId || latest.kind !== selected.kind || latest.connectionId !== selected.connectionId || JSON.stringify(latest.target) !== JSON.stringify(selected.target)) return [];
      if (kind === "audio") return project.assets.filter(asset => asset.kind === "audio" && asset.label.toLowerCase().includes(query.toLowerCase())).map(asset => ({name: asset.label, description: "作品音频 · 可试听，暂不支持生成参考", icon: "file" as const, value: encodeURIComponent(JSON.stringify({workId: project.workId, assetId: asset.id}))}));
      if (kind === "image") return searchDesignReferenceAssets(project, query).map(({ asset, design, label }) => ({ name: label, description: design ? `${design.kind === "character" ? "人物" : "场景"}参考图片` : "作品参考图片", icon: "file" as const, value: encodeURIComponent(JSON.stringify({ workId: project.workId, assetId: asset.id })) }));
      return project.assets.filter(asset => asset.kind === "video" && !asset.panorama && asset.sourceUrl && asset.mimeType === "video/mp4" && asset.label.toLowerCase().includes(query.toLowerCase())).map(asset => ({ name: asset.label, description: "作品参考视频", icon: "file" as const, value: encodeURIComponent(JSON.stringify({ workId: project.workId, assetId: asset.id })) }));
    },
    onPick: ({ candidate }) => candidate.value ? { insert: { source: kind === "image" ? VIDEO_IMAGE_SOURCE : kind === "video" ? VIDEO_VIDEO_SOURCE : VIDEO_AUDIO_SOURCE, ref: candidate.value, label: candidate.name, appearance: "file", clipboardText: `@${candidate.name}` } } : undefined,
    codec: { clipboardText: () => kind === "image" ? "@参考图片" : kind === "video" ? "@参考视频" : "@参考音频", async serialize(ref) {
      const value = decodeVideoImage(ref); if (!value || !remote.getVideoProject) throw new Error("素材引用无效");
      const project = await remote.getVideoProject({ workId: value.workId }), asset = project.assets.find(item => item.id === value.assetId && item.kind === kind);
      if (!asset) throw new Error("素材已不可用");
      return renderSkillPrompt("media-asset-reference",{kind:kind === "image" ? "图片" : kind === "video" ? "视频" : "音频",label:asset.label,id:asset.id});
    } },
  });
  const prepareOptimization = async (sessionId: string, kind: "image" | "video") => {
    const input = inputFor(sessionId); if (!input) throw new Error("主输入框不可用");
    const before = input.state.getSnapshot();
    if (before.draft.trim() || before.occurrences.length) throw new Error("主输入框还有未发送内容，请先发送或清空，再优化提示词");
    const selected = getSnapshot(sessionId), context = await read(sessionId);
    if (context.target.editing) throw new Error("请直接在对话中讨论当前剪辑，或选择镜头优化生成提示词");
    if (selected !== getSnapshot(sessionId) || inputFor(sessionId)?.state !== input.state || input.state.getSnapshot().draftRev !== before.draftRev) throw new Error("设定、镜头或输入内容已变化，请重新选择");
    updateInputs(sessionId, { promptMode: "reference", kind, title: context.design ? `${context.design.name}` : context.shot!.title });
    fillOptimization(sessionId, kind, context);
  };
  const insertStyle = (sessionId: string, ref: StyleReference) => {
    const input = inputFor(sessionId), selected = getSnapshot(sessionId);
    if (!input || selected.workId !== ref.workId || !selectModel(sessionId, {kind:"text"})) throw new Error("请先结束当前发送，再讨论作品画风");
    const before = input.state.getSnapshot();
    if (!input.insertReference({source:STYLE_CHAT_SOURCE,ref:encodeURIComponent(JSON.stringify(ref)),label:ref.scope === "style" ? "作品画风" : "按作品画风整理提示词",appearance:"file",clipboardText:"@作品画风"},{start:before.draft.length,end:before.draft.length,draftRev:before.draftRev})) throw new Error("画风引用添加失败，请重试");
    if (ref.scope !== "style" && input.insertText) {
      const next = input.state.getSnapshot();
      input.insertText(renderSkillPrompt("style-alignment-request"),{start:next.draft.length,end:next.draft.length,draftRev:next.draftRev});
    }
  };
  const styleSource: InputTriggerSource = {trigger:"@",name:STYLE_CHAT_SOURCE,order:8,showGroupTitle:true,
    async candidates(session,{query}) { const workId=getSnapshot(session.sessionId).workId; return workId && "作品画风".includes(query) ? [{name:"作品画风",description:"全作品统一视觉风格",icon:"file" as const,value:encodeURIComponent(JSON.stringify({workId,scope:"style"}))}] : []; },
    onPick:({candidate})=>candidate.value?{insert:{source:STYLE_CHAT_SOURCE,ref:candidate.value,label:candidate.name,appearance:"file",clipboardText:"@作品画风"}}:undefined,
    codec:{clipboardText:()=>"@作品画风",async serialize(ref) {const value=decodeStyleReference(ref);if(!remote.getVideoProject)throw new Error("画风资料不可用");return serializeStyleReference(await remote.getVideoProject({workId:value.workId}),value);}},
  };
  const insertEpisode = (sessionId: string, ref: EpisodeChatReference, title: string) => {
    const input = inputFor(sessionId);
    if (!input || getSnapshot(sessionId).workId !== ref.workId || !selectModel(sessionId, {kind:"text"})) return false;
    const before = input.state.getSnapshot();
    const encoded = encodeURIComponent(JSON.stringify({workId:ref.workId,episodeId:ref.episodeId}));
    if (before.occurrences.some(item => item.source === EPISODE_CHAT_SOURCE && item.ref === encoded)) return true;
    return input.insertReference({source:EPISODE_CHAT_SOURCE,ref:encoded,label:title,appearance:"file",clipboardText:`@${title}`},{start:before.draft.length,end:before.draft.length,draftRev:before.draftRev});
  };
  const episodeSource: InputTriggerSource = { trigger:"@",name:EPISODE_CHAT_SOURCE,order:5,showGroupTitle:true,
    async candidates(session,{query,signal}) {
      const workId=getSnapshot(session.sessionId).workId;
      if (!workId || !remote.getVideoProject) return [];
      const project=await remote.getVideoProject({workId}); signal.throwIfAborted();
      if(getSnapshot(session.sessionId).workId!==workId)return [];
      return project.episodes.filter(item=>item.title.toLowerCase().includes(query.toLowerCase())).map(item=>({name:item.title,description:`视频集 · ${item.sourceChapters.length} 个原著章节`,icon:"file" as const,value:encodeURIComponent(JSON.stringify({workId,episodeId:item.id}))}));
    },
    onPick:({candidate})=>candidate.value?{insert:{source:EPISODE_CHAT_SOURCE,ref:candidate.value,label:candidate.name,appearance:"file",clipboardText:`@${candidate.name}`}}:undefined,
    codec:{clipboardText:()=>"@视频集",async serialize(ref){const value=decodeEpisodeReference(ref);if(!remote.getVideoProject)throw new Error("视频集资料不可用");return serializeEpisodeReference(await remote.getVideoProject({workId:value.workId}),value);}},
  };
  const shotSource: InputTriggerSource = { trigger: "@", name: SHOT_CHAT_SOURCE, order: 6, candidates: async () => [], onPick: () => undefined,
    codec: { clipboardText: () => "@镜头", async serialize(ref) { const value = decodeShotChatReference(ref); if (!remote.getVideoProject) throw new Error("镜头资料不可用"); return serializeShotChatReference(await remote.getVideoProject({ workId: value.workId }), value); } },
  };
  const editingSource: InputTriggerSource = { trigger: "@", name: EDITING_CHAT_SOURCE, order: 7, candidates: async () => [], onPick: () => undefined,
    codec: { clipboardText: () => "@剪辑", async serialize(ref) { const value = decodeEditingChatReference(ref); if (!remote.getVideoProject) throw new Error("剪辑资料不可用"); return serializeEditingChatReference(await remote.getVideoProject({ workId: value.workId }), value); } },
  };
  const designSource: InputTriggerSource = { trigger: "@", name: DESIGN_CHAT_SOURCE, order: 4, showGroupTitle: true,
    async candidates(session, { query, signal }) {
      const selected = getSnapshot(session.sessionId), workId = selected.target?.workId ?? selected.workId;
      if (!workId || !remote.getVideoProject) return [];
      const project = await remote.getVideoProject({ workId }); signal.throwIfAborted();
      if (getSnapshot(session.sessionId).workId !== selected.workId) return [];
      return (project.designs ?? []).filter(item => `${item.name} ${item.version} ${item.kind === "character" ? "人物" : "场景"}`.toLowerCase().includes(query.toLowerCase())).map(item => {
        const name = `${item.name}`;
        designLabels.set(`${workId}/${item.id}`, name);
        return { name, description: item.kind === "character" ? "设定库人物" : "设定库场景", icon: "file" as const, value: encodeURIComponent(JSON.stringify({ workId, designId: item.id })) };
      });
    },
    onPick: ({ candidate }) => candidate.value ? { insert: { source: DESIGN_CHAT_SOURCE, ref: candidate.value, label: candidate.name, appearance: "file", clipboardText: `@${candidate.name}` } } : undefined,
    codec: { clipboardText: () => "@人物或场景", async serialize(ref) { const value = decodeDesignReference(ref); if (!remote.getVideoProject) throw new Error("设定不可用"); return serializeDesignReference(await remote.getVideoProject({ workId: value.workId }), value); } },
  };
  return { episodeSource, insertEpisode, styleSource, insertStyle, getSnapshot, hasContent, subscribe, selectModel, setWork, bind, unbind, beginSelection, cancelSelection, clearSelection, configure, updateInputs, applyRequest, prepareOptimization, shotSource, designSource, editingSource, insertDesign, getImageRole, setImageRole, activate, loadPrompt, insertAsset, removeReference, submissionRoute, imageSource: assetSource("image"), videoSource: assetSource("video"), audioSource: assetSource("audio") };
}
export type MainVideoComposer = ReturnType<typeof createMainVideoComposer>;
