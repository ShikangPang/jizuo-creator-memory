import { userErrorMessage } from "@jizuo/contracts";
import { EPISODE_CHAT_SOURCE, decodeEpisodeReference, episodeReferenceContent } from "./episode-chat-reference.ts";
import { composeDesignPrompt } from "./design-prompt.ts";
import { composeVisualPrompt } from "../../../contracts/src/visual-style-generation.ts";
import { STYLE_CHAT_SOURCE, decodeStyleReference } from "./style-chat-reference.ts";
import { visualStyleText } from "../../../contracts/src/visual-style.ts";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChapterTarget, VideoAssetView, VideoProject } from "@jizuo/contracts";
import type { JizuoContentRemote } from "../content/remote.ts";
import { DESIGN_CHAT_SOURCE, decodeDesignReference } from "./design-chat-reference.ts";
import { SHOT_CHAT_SOURCE, decodeShotChatReference } from "./shot-chat-reference.ts";
import { EDITING_CHAT_SOURCE, decodeEditingChatReference, editingReferencePreview } from "./editing-chat-reference.ts";
import { subscribeVideoProject } from "./useVideoProject.ts";
import { decodeChapterExcerptReference } from "../content/chapterTriggers.ts";
import { getSelection } from "../content/selection.ts";
import "./composer-prompt-reference-preview.css";

type Occurrence = { source: string; ref: string; invalid?: boolean; offset?: number; occurrenceId?: number | string };
type PreviewContent = { title: string; prompt: string };
type PreviewState = PreviewContent & { left: number; top: number; below: boolean; maxHeight: number; loading?: boolean; error?: boolean };
type PreviewResolver = { kind: "project"; workId: string; resolve(project: VideoProject): PreviewContent }
  | { kind: "chapter"; target: ChapterTarget }
  | { kind: "excerpt"; content: PreviewContent };
const supportedSources = new Set(["jizuo", EPISODE_CHAT_SOURCE, STYLE_CHAT_SOURCE, DESIGN_CHAT_SOURCE, SHOT_CHAT_SOURCE, EDITING_CHAT_SOURCE]);
const viewLabels: Record<VideoAssetView, string> = { "character-sheet": "六宫格", turnaround: "三视图", front: "正面", side: "侧面", back: "背面", expression: "表情", outfit: "服装", panorama: "360° 环景", detail: "场景画面" };

function decodePreview(occurrence: Occurrence): PreviewResolver {
  if (occurrence.invalid) throw new Error("引用已失效，请重新选择");
  if (occurrence.source === "jizuo") {
    const excerpt = decodeChapterExcerptReference(occurrence.ref);
    if (excerpt) return { kind: "excerpt", content: { title: `${excerpt.chapterTitle} · 选段`, prompt: excerpt.text } };
    const selected = getSelection();
    const parts = occurrence.ref === "current"
      ? [selected.workId, selected.volumeId, selected.chapterId]
      : occurrence.ref.split("/");
    if (parts.length !== 3 || parts.some(part => typeof part !== "string" || !part)) throw new Error("章节引用已失效，请重新选择");
    return { kind: "chapter", target: { workId: parts[0]!, volumeId: parts[1]!, chapterId: parts[2]! } };
  }
  if (occurrence.source === EPISODE_CHAT_SOURCE) {
    const ref=decodeEpisodeReference(occurrence.ref);
    return {kind:"project",workId:ref.workId,resolve(project){const content=episodeReferenceContent(project,ref);return {title:`视频集 · ${content.title}`,prompt:`原著章节：${content.sourceChapters.length} 章 · 镜头：${content.shotCount} 个\n${content.script || "尚未编写制作稿"}`};}};
  }
  if (occurrence.source === STYLE_CHAT_SOURCE) {
    const ref = decodeStyleReference(occurrence.ref);
    return { kind: "project", workId: ref.workId, resolve(project) {
      if(project.workId !== ref.workId) throw new Error("作品已切换");
      return { title: `作品画风 · ${project.visualStyle?.name ?? "未设置"}`, prompt: visualStyleText(project.visualStyle) || "尚未设置作品画风" };
    } };
  }
  if (occurrence.source === DESIGN_CHAT_SOURCE) {
    const ref = decodeDesignReference(occurrence.ref);
    return { kind: "project", workId: ref.workId, resolve(project) {
      const design = project.designs?.find(item => item.id === ref.designId);
      if (project.workId !== ref.workId || !design) throw new Error("人物或场景已删除，请重新选择");
      const view = ref.view ?? (design.kind === "character" ? "character-sheet" : undefined);
      return { title: `${design.name}${view ? ` · ${viewLabels[view]}` : ""}`, prompt: composeDesignPrompt(project, design, view) || "尚未设置提示词" };
    } };
  }
  if (occurrence.source === SHOT_CHAT_SOURCE) {
    const ref = decodeShotChatReference(occurrence.ref);
    return { kind: "project", workId: ref.workId, resolve(project) {
      const shot = project.episodes.find(item => item.id === ref.episodeId)?.shots.find(item => item.id === ref.shotId && !item.archived);
      if (project.workId !== ref.workId || !shot) throw new Error("镜头已删除，请重新选择");
      return { title: `${shot.title} · ${ref.kind === "image" ? "图片提示词" : "视频提示词"}`, prompt: composeVisualPrompt(project, (ref.kind === "image" ? shot.prompt : shot.videoPrompt) || "尚未设置提示词", undefined, []) };
    } };
  }
  if (occurrence.source === EDITING_CHAT_SOURCE) {
    const ref = decodeEditingChatReference(occurrence.ref);
    return { kind: "project", workId: ref.workId, resolve: project => editingReferencePreview(project, ref) };
  }
  throw new Error("该引用不支持提示词预览");
}

/** Native reference chips retain their editing behavior; only their hover/focus preview is added. */
export function ComposerPromptReferencePreview({ remote, session, input }: {
  remote: JizuoContentRemote;
  session: { sessionId: string };
  input: { occurrences: readonly Occurrence[] };
}) {
  const marker = useRef<HTMLSpanElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const [preview, setPreview] = useState<PreviewState>();
  // Native occurrences and DOM chips share document order. Never match labels: distinct versions
  // and separate sessions can have the same display name.
  const signature = JSON.stringify(input.occurrences.map(({ source, ref, invalid, offset, occurrenceId }) => [source, ref, invalid, offset, occurrenceId]));
  useEffect(() => {
    const card = marker.current?.closest<HTMLElement>("[data-composer-card]");
    if (!card) return;
    const occurrences = input.occurrences;
    let sequence = 0;
    let active: { chip: HTMLElement; occurrence: Occurrence; key: string; revision: number; resolve: PreviewResolver } | undefined;
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    const modified = new Map<HTMLElement, { tabIndex: string | null; describedBy: string | null }>();
    const titles = new Map<HTMLElement, string>();
    const cancelLeave = () => { if (leaveTimer) clearTimeout(leaveTimer); leaveTimer = undefined; };
    const hide = () => {
      cancelLeave(); sequence += 1;
      if (active) {
        const original = modified.get(active.chip)?.describedBy;
        if (original == null) active.chip.removeAttribute("aria-describedby"); else active.chip.setAttribute("aria-describedby", original);
      }
      active = undefined;
      setPreview(undefined);
    };
    setPreview(undefined);
    const chips = () => Array.from(card.querySelectorAll<HTMLElement>("[data-composer-input] [data-composer-chip]"));
    const match = (chip: HTMLElement) => {
      const all = chips(), index = all.indexOf(chip), occurrence = occurrences[index];
      if (all.length !== occurrences.length || index < 0 || !occurrence || occurrence.source !== chip.dataset.composerChip || !supportedSources.has(occurrence.source)) return undefined;
      return { occurrence, key: `${index}:${occurrence.source}:${occurrence.ref}:${occurrence.invalid ?? false}` };
    };
    const decorate = () => {
      for (const chip of chips()) {
        if (!match(chip)) continue;
        if (!modified.has(chip)) {
          modified.set(chip, { tabIndex: chip.getAttribute("tabindex"), describedBy: chip.getAttribute("aria-describedby") });
          if (!chip.hasAttribute("tabindex")) chip.tabIndex = 0;
        }
        // The native chip's title contains only its insert-time label. Avoid a second stale tooltip.
        for (const element of chip.querySelectorAll<HTMLElement>("[title]")) {
          if (!titles.has(element)) titles.set(element, element.title);
          element.removeAttribute("title");
        }
      }
      if (active && (!active.chip.isConnected || match(active.chip)?.key !== active.key)) hide();
    };
    const belongs = (target: EventTarget | null): boolean => target instanceof Node && Boolean(active?.chip.contains(target) || popup.current?.contains(target));
    const scheduleHide = () => { cancelLeave(); leaveTimer = setTimeout(hide, 150); };
    const show = (chip: HTMLElement) => {
      cancelLeave();
      const matched = match(chip);
      if (!matched || active?.chip === chip && active.key === matched.key) return;
      hide();
      const current = ++sequence;
      const rect = chip.getBoundingClientRect(), below = rect.top < 180;
      const width = Math.min(440, Math.max(0, window.innerWidth - 24));
      const position = { left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: below ? rect.bottom + 8 : rect.top - 8, below,
        maxHeight: Math.max(80, Math.min(320, below ? window.innerHeight - rect.bottom - 24 : rect.top - 24)) };
      let decoded: PreviewResolver;
      try { decoded = decodePreview(matched.occurrence); }
      catch {
        active = { chip, ...matched, revision: -1, resolve: { kind: "excerpt", content: { title: "引用已失效", prompt: "无法读取此引用，请重新选择" } } };
        setPreview({ ...position, title: "引用已失效", prompt: "无法读取此引用，请重新选择", error: true }); return;
      }
      active = { chip, ...matched, revision: -1, resolve: decoded };
      const original = modified.get(chip)?.describedBy;
      chip.setAttribute("aria-describedby", [original, tooltipId].filter(Boolean).join(" "));
      if (decoded.kind === "excerpt") { setPreview({ ...position, ...decoded.content }); return; }
      setPreview({ ...position, title: decoded.kind === "chapter" ? "章节预览" : "提示词预览", prompt: "正在读取最新内容…", loading: true });
      if (decoded.kind === "chapter") {
        void remote.readChapter(decoded.target).then(chapter => {
          if (sequence === current && active?.chip === chip && match(chip)?.key === matched.key)
            setPreview({ ...position, title: chapter.title, prompt: chapter.content.trim() || "章节正文为空" });
        }).catch(() => {
          if (sequence === current && active?.chip === chip) setPreview({ ...position, title: "暂时无法预览", prompt: "章节读取失败，请移开鼠标后重试", error: true });
        });
        return;
      }
      const accept = (project: VideoProject) => {
        if (sequence !== current || !active || active.chip !== chip || match(chip)?.key !== matched.key || project.revision < active.revision) return;
        const content = decoded.resolve(project);
        active.revision = project.revision;
        setPreview({ ...position, ...content });
      };
      if (!remote.getVideoProject) { setPreview({ ...position, title: "暂时无法预览", prompt: "当前运行时不支持读取提示词", error: true }); return; }
      void remote.getVideoProject({ workId: decoded.workId }).then(project => {
        try { accept(project); }
        catch (cause) { if (sequence === current && active?.chip === chip) setPreview({ ...position, title: "引用已不可用", prompt: userErrorMessage(cause, "请重新选择", { operation: "ComposerPromptReferencePreview" }), error: true }); }
      }).catch(() => {
        if (sequence === current && active?.chip === chip) setPreview({ ...position, title: "暂时无法预览", prompt: "读取失败，请移开鼠标后重试", error: true });
      });
    };
    const findChip = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-composer-chip]") : null;
    const enter = (event: Event) => {
      if (popup.current?.contains(event.target as Node)) { cancelLeave(); return; }
      const chip = findChip(event.target);
      if (chip && card.contains(chip)) show(chip);
    };
    const leave = (event: Event) => {
      if (!belongs(event.target)) return;
      if (belongs((event as MouseEvent).relatedTarget)) cancelLeave(); else scheduleHide();
    };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    const onScroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) hide(); };
    const stopProject = subscribeVideoProject(project => {
      if (!active || active.resolve.kind !== "project" || active.resolve.workId !== project.workId || project.revision < active.revision) return;
      try {
        const content = active.resolve.resolve(project);
        active.revision = project.revision;
        setPreview(previous => previous && { ...previous, ...content, loading: false, error: false });
      } catch { hide(); }
    });
    const observer = new MutationObserver(decorate);
    observer.observe(card, { subtree: true, childList: true });
    decorate();
    document.addEventListener("pointerover", enter);
    document.addEventListener("pointerout", leave);
    document.addEventListener("focusin", enter);
    document.addEventListener("focusout", leave);
    document.addEventListener("keydown", keydown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hide);
    return () => {
      sequence += 1; cancelLeave(); observer.disconnect(); stopProject();
      document.removeEventListener("pointerover", enter);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusin", enter);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", hide);
      for (const [chip, original] of modified) {
        if (original.tabIndex === null) chip.removeAttribute("tabindex"); else chip.setAttribute("tabindex", original.tabIndex);
        if (original.describedBy === null) chip.removeAttribute("aria-describedby"); else chip.setAttribute("aria-describedby", original.describedBy);
      }
      for (const [element, title] of titles) element.setAttribute("title", title);
    };
  }, [remote, session.sessionId, signature, tooltipId]);
  return <>
    <span ref={marker} hidden data-jizuo-prompt-preview-anchor="" />
    {preview && createPortal(<div ref={popup} id={tooltipId} role="tooltip" className="jz-composer-prompt-preview" aria-busy={preview.loading || undefined}
      style={{ left: preview.left, top: preview.top, maxHeight: preview.maxHeight, transform: preview.below ? undefined : "translateY(-100%)" }}>
      <strong>{preview.title}</strong>
      <p className={preview.error ? "jz-composer-prompt-preview-error" : undefined}>{preview.prompt}</p>
    </div>, document.body)}
  </>;
}
