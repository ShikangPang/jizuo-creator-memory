import { ErrorText } from "../ui/ErrorText.tsx";
import { userErrorMessage } from "@jizuo/contracts";
import { ComposerInlineMediaReferences } from "./ComposerInlineMediaReferences.tsx";
import { decodeStyleReference } from "./style-chat-reference.ts";
import { planVisualReferences } from "../../../contracts/src/visual-style-generation.ts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JizuoContentRemote } from "../content/remote.ts";
import { getSelection, setSelection, useSelection } from "../content/selection.ts";
import type { MainVideoComposer } from "./main-video-composer.ts";
import type { VideoComposerRequest } from "./video-composer-request.ts";
import { useMediaGenerationSettings } from "./useMediaGenerationSettings.ts";
import { subscribeVideoProject, useVideoProject } from "./useVideoProject.ts";
import { resolveComposerReferenceInputs } from "./composer-reference-inputs.ts";
import { ComposerGenerationSettings } from "./ComposerGenerationSettings.tsx";
import { ComposerMediaLayout } from "./ComposerMediaLayout.tsx";
import { ComposerMediaReferences, type ComposerDraftImages } from "./ComposerMediaReferences.tsx";
import "./main-video-composer.css";

/** Native input owns text; this dock contains media settings and references. */
export function MainVideoComposerDock({ remote, composer, session, input, draftImages }: {
  draftImages?: ComposerDraftImages | undefined;
  remote: JizuoContentRemote; composer: MainVideoComposer; session: { sessionId: string };
  input: { draft: string; phase?: string; attachmentIds?: readonly string[]; occurrences: readonly { source: string; ref: string; invalid?: boolean }[] };
}) {
  const selection = useSelection();
  const state = useSyncExternalStore(listener => composer.subscribe(session.sessionId, listener), () => composer.getSnapshot(session.sessionId));
  const [error, setError] = useState("");
  const [pendingRequest, setPendingRequest] = useState<VideoComposerRequest & { composerSessionId: string }>();
  const [pendingClear, setPendingClear] = useState<{workId:string;episodeId?:string;composerSessionId:string}>();
  const previousSession = useRef(session.sessionId);
  const requested = useRef<VideoComposerRequest>();
  const operation = useRef<AbortController | null>(null);
  const previousSelection = useRef<typeof selection | null>(null);
  const media = useMediaGenerationSettings(remote);
  const episodeId=state.target?.episodeId ?? selection.episodeId;
  const { project, error: projectError } = useVideoProject(remote, state.kind !== "text" || state.target || selection.mode === "video" ? selection.workId : null,
    episodeId ? {scope:"episode",episodeId} : {scope:"overview"});
  const busy = input.phase === "submitting" || input.phase === "adjudicating";
  const queue = (next: VideoComposerRequest) => {
    const current = getSelection();
    if (next.workId !== current.workId || !next.designId && next.episodeId !== current.episodeId) return;
    operation.current?.abort();
    requested.current = next;
    composer.beginSelection(session.sessionId); setPendingClear(undefined);
    setPendingRequest({ ...next, composerSessionId: session.sessionId }); setError("");
  };
  useEffect(() => {
    if (previousSession.current === session.sessionId) return;
    operation.current?.abort(); composer.cancelSelection(previousSession.current);
    previousSession.current = session.sessionId; previousSelection.current = null; requested.current = undefined;
    setPendingRequest(undefined); setPendingClear(undefined); setError("");
  }, [composer, session.sessionId]);
  useEffect(() => subscribeVideoProject(next => {
    const target = composer.getSnapshot(session.sessionId).target;
    if (!target || target.workId !== next.workId) return;
    const episode = next.episodes.find(item => item.id === target.episodeId && !item.deletedAt);
    const missing = target.designId ? !next.designs?.some(item => item.id === target.designId && !item.deletedAt)
      : target.episodeId ? !episode || Boolean(target.shotId && !episode.shots.some(item => item.id === target.shotId && !item.archived)) : false;
    if (!missing) return;
    operation.current?.abort(); requested.current = undefined; setPendingRequest(undefined);
    if (busy) {
      composer.beginSelection(session.sessionId);
      setPendingClear({ workId: next.workId, composerSessionId: session.sessionId });
    } else {
      try { composer.clearSelection(session.sessionId); }
      catch (cause) { setError(userErrorMessage(cause, "引用清除失败", { operation: "MainVideoComposerDock" })); }
    }
  }), [composer, session.sessionId, busy]);
  useEffect(() => {
    const open = (event: Event) => {
      const next = (event as CustomEvent<VideoComposerRequest>).detail;
      if (next) queue(next);
    };
    const clear = (event:Event) => {
      const next=(event as CustomEvent<{workId:string;episodeId?:string}>).detail, current=getSelection();
      if (!next || next.workId !== current.workId || next.episodeId && next.episodeId !== current.episodeId) return;
      operation.current?.abort(); requested.current=undefined; setPendingRequest(undefined); setError("");
      composer.beginSelection(session.sessionId); setPendingClear({ ...next, composerSessionId: session.sessionId });
    };
    window.addEventListener("jizuo:video-composer", open);
    window.addEventListener("jizuo:video-composer-clear", clear);
    return () => {
      operation.current?.abort(); composer.cancelSelection(session.sessionId);
      window.removeEventListener("jizuo:video-composer", open); window.removeEventListener("jizuo:video-composer-clear", clear);
    };

  }, [composer, session.sessionId]);
  useEffect(() => {
    const previous = previousSelection.current;
    const workChanged = previous && previous.workId !== selection.workId;
    const scopeChanged = workChanged || previous && (previous.episodeId !== selection.episodeId || previous.mode !== selection.mode);
    if (scopeChanged) {
      operation.current?.abort();
      const next = requested.current;
      if (selection.mode !== "video" || !next || next.workId !== selection.workId || !next.designId && next.episodeId !== selection.episodeId) {
        composer.cancelSelection(session.sessionId); requested.current = undefined;
        setPendingRequest(undefined);
        if (!pendingClear || pendingClear.workId !== selection.workId || pendingClear.episodeId) setPendingClear(undefined);
      }
    }
    if (workChanged) {
      operation.current?.abort(); setError("");
      setPendingClear(undefined);
      if (requested.current?.workId !== selection.workId) { requested.current = undefined; setPendingRequest(undefined); }
    }
    composer.setWork(session.sessionId, selection.workId ?? undefined);
    const target = composer.getSnapshot(session.sessionId).target;
    const changedShot = previous && (previous.workId !== selection.workId || previous.episodeId !== selection.episodeId || previous.shotId !== selection.shotId);
    const alreadyRequested = requested.current?.workId === selection.workId && requested.current.episodeId === selection.episodeId && requested.current.shotId === selection.shotId;
    if (selection.workId && selection.episodeId && selection.shotId) {
      if (changedShot && !alreadyRequested) queue({ workId: selection.workId, episodeId: selection.episodeId, shotId: selection.shotId, title: "镜头", action: "select", kind: "image", promptMode: "reference" });
      else if (!target && !requested.current) composer.bind(session.sessionId, { workId: selection.workId, episodeId: selection.episodeId, shotId: selection.shotId });
    } else if (!target?.designId && !target?.editing && !pendingRequest) composer.unbind(session.sessionId);
    previousSelection.current = selection;
  }, [composer, session.sessionId, selection.workId, selection.episodeId, selection.shotId, selection.mode]);
  useEffect(() => {
    if (!pendingRequest || pendingRequest.composerSessionId !== session.sessionId || busy) return;
    const { composerSessionId: _originSession, ...next } = pendingRequest;
    const current = getSelection();
    if (next.workId !== current.workId || !next.designId && next.episodeId !== current.episodeId) return;
    const active = new AbortController(); operation.current = active;
    void composer.applyRequest(session.sessionId, next, false, active.signal).then(() => {
      if (active.signal.aborted) return;
      setPendingRequest(undefined);
      if (next.shotId) setSelection({ shotId: next.shotId });
      // Selection should not steal focus from timeline controls or interrupt keyboard navigation.
    }).catch((cause: unknown) => {
      if (!active.signal.aborted) { setError(userErrorMessage(cause, "无法切换提示词引用", { operation: "MainVideoComposerDock" })); setPendingRequest(undefined); }
    });
    return () => active.abort();
  }, [composer, session.sessionId, pendingRequest, busy]);
  useEffect(() => {
    if (!pendingClear || pendingClear.composerSessionId !== session.sessionId || busy) return;
    const current=getSelection();
    if (pendingClear.workId !== current.workId || pendingClear.episodeId && pendingClear.episodeId !== current.episodeId) return;
    try { composer.clearSelection(session.sessionId); setPendingClear(undefined); }
    catch (cause) { setError(userErrorMessage(cause, "引用清除失败", { operation: "MainVideoComposerDock" })); }
  }, [composer, session.sessionId, pendingClear, busy]);
  useEffect(() => {
    const discuss = (event: Event) => {
      try { const ref=decodeStyleReference(encodeURIComponent(JSON.stringify((event as CustomEvent).detail)));
        if(ref.workId !== selection.workId)return;
        composer.insertStyle(session.sessionId,ref);
      } catch(cause) {setError(userErrorMessage(cause, "画风讨论暂不可用", { operation: "MainVideoComposerDock" }));}
    };
    window.addEventListener("jizuo:work-style-discuss",discuss);
    return ()=>window.removeEventListener("jizuo:work-style-discuss",discuss);
  },[composer,session.sessionId,selection.workId]);
  const design = project?.designs?.find(item => item.id === state.target?.designId);
  if (state.kind === "text" && !state.target?.designId && !state.target?.editing && !project?.visualStyle) return error ? <div className="jz-main-video-mode"><p role="alert">{error}</p></div> : null;
  const kind = state.kind;
  const config = kind !== "text" ? state.connectionId ? media.view?.connections?.find(item => item.kind === kind && item.id === state.connectionId)?.config : media.view?.settings[kind] : undefined;
  const episode = project?.episodes.find(item => item.id === state.target?.episodeId), shot = episode?.shots.find(item => item.id === state.target?.shotId);
  const referenceIds = project ? resolveComposerReferenceInputs(project, state, input.occurrences).referenceAssetIds : [];
  const hasReferences = Boolean((config && project ? planVisualReferences(config,state.kind === "video" ? "video" : "image",referenceIds,state.inputs.videoImageRoles,project.visualStyle?.referenceAssetIds ?? []).ids.length : 0) || referenceIds.length || input.attachmentIds?.length || input.occurrences.some(item => item.source === "视频图片" && !item.invalid));
  return <ComposerMediaLayout draftPreviewUrls={draftImages?.read(input.attachmentIds ?? []).map(image => image.previewUrl)} label={kind === "text" ? "提示词讨论" : "生成模式"} references={kind !== "text" && project && state.target && !state.target.editing && config && <ComposerMediaReferences key={JSON.stringify(state.target)} remote={remote} project={project} composer={composer} sessionId={session.sessionId} state={state} config={config} occurrences={input.occurrences} draftImageIds={input.attachmentIds} draftImages={draftImages} disabled={busy}/>}>
    {kind === "text" && project && <ComposerInlineMediaReferences remote={remote} project={project} occurrences={input.occurrences} imageIds={project.assets.filter(a=>a.kind==="image").map(a=>a.id)} videoIds={project.assets.filter(a=>a.kind==="video").map(a=>a.id)} />}
    {config && project?.visualStyle?.referenceAssetIds.length && planVisualReferences(config,state.kind === "video" ? "video" : "image",referenceIds,state.inputs.videoImageRoles,project.visualStyle.referenceAssetIds).textOnly ? <small>当前输入方式仅使用文字画风，画风图不会作为首尾帧传入。</small> : null}
    {(error || projectError || kind !== "text" && media.error) && <p role="alert">{<ErrorText error={error || projectError || media.error} operation="MainVideoComposerDock" />}</p>}

    {kind !== "text" && config && <ComposerGenerationSettings key={`${session.sessionId}:${kind}:${state.connectionId ?? config.model}:${state.target?.view ?? ""}`} config={config} kind={kind} inputs={state.inputs} onChange={patch => composer.updateInputs(session.sessionId, patch)} ratio={episode?.aspectRatio ?? (design ? "16:9" : "9:16")} duration={shot?.durationSec ?? 5} view={state.target?.view} hasReferences={hasReferences} disabled={busy || Boolean(state.selectionPending)} />}
    {kind !== "text" && !config && !media.loading && <small>请从模型选择器中选择已配置的{kind === "image" ? "图片" : "视频"}模型。</small>}
  </ComposerMediaLayout>;
}


/** Footer slots expose the session input as a standard observable hook. */
export function MainVideoComposerFooter({remote, composer, sessionId, useInput, draftImagesFor}: {
  remote: JizuoContentRemote; composer: MainVideoComposer; sessionId: string;
  draftImagesFor?: ((sessionId: string) => ComposerDraftImages) | undefined;
  useInput: <T>(selector: (input: Parameters<typeof MainVideoComposerDock>[0]["input"]) => T) => T;
}) {
  const input = useInput(value => value);
  return <MainVideoComposerDock remote={remote} composer={composer} session={{sessionId}} input={input} draftImages={draftImagesFor?.(sessionId)}/>;
}
