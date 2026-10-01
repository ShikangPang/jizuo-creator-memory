import { useEffect, useRef } from "react";
import type { JizuoContentRemote } from "../../jizuo-client/src/content/remote.ts";
import type { MainVideoComposer } from "../../jizuo-client/src/video/main-video-composer.ts";
import { WORK_IMAGE_DRAG_TYPE, parseWorkImageDrag } from "../../jizuo-client/src/video/work-image-drag.ts";
import "./composer-work-image-drop.css";

interface WorkImage { workId: string; assetId: string }
interface IntakeInput {
  isBusy(): boolean;
  addFile(file: File): void;
}

/** Existing work assets stay references for generation; chat receives actual image bytes. */
export function createWorkImageIntake({ remote, composer, inputFor, fetchImage = fetch }: {
  remote: JizuoContentRemote;
  composer: MainVideoComposer;
  inputFor(sessionId: string): IntakeInput | undefined;
  fetchImage?: typeof fetch;
}) {
  return async (sessionId: string, ref: WorkImage, signal: AbortSignal) => {
    const input = inputFor(sessionId), selected = composer.getSnapshot(sessionId);
    const check = () => {
      signal.throwIfAborted();
      if (!input || inputFor(sessionId) === undefined || input.isBusy()) throw new Error("输入框正在提交，请稍后添加图片");
      const current = composer.getSnapshot(sessionId);
      if (current.kind !== selected.kind || current.connectionId !== selected.connectionId
        || JSON.stringify(current.target) !== JSON.stringify(selected.target)) throw new Error("模型或镜头已切换，请重新拖入图片");
    };
    check();
    if (selected.kind !== "text") {
      if (!selected.target) throw new Error("请先在工作区选择镜头，再拖入参考图片");
      if (selected.target.workId !== ref.workId) throw new Error("请使用当前作品的图片作为参考");
      await composer.insertAsset(sessionId, ref.assetId, undefined, signal);
      return;
    }
    if (!remote.getVideoProject || !remote.getVideoAssetUrl) throw new Error("当前运行时无法读取作品图片");
    const project = await remote.getVideoProject({ workId: ref.workId });
    check();
    const asset = project.assets.find(item => item.id === ref.assetId && item.kind === "image");
    if (!asset) throw new Error("作品图片已不存在，请重新选择");
    const { url } = await remote.getVideoAssetUrl(ref);
    check();
    const response = await fetchImage(url, { signal });
    if (!response.ok) throw new Error("作品图片读取失败，请重试");
    const limit = 20 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > limit) throw new Error("图片超过 20 MB，请先缩小图片");
    const blob = await response.blob();
    check();
    if (!blob.size || blob.size > limit || !["image/png", "image/jpeg", "image/webp"].includes(blob.type)) throw new Error("请选择不超过 20 MB 的 PNG、JPEG 或 WebP 图片");
    input!.addFile(new File([blob], asset.label, { type: blob.type }));
  };
}

/** Listen only on this native composer card; local File drops keep their native intake. */
export function ComposerWorkImageDrop({ sessionId, attach, notify }: {
  sessionId: string;
  attach(sessionId: string, ref: WorkImage, signal: AbortSignal): Promise<void>;
  notify(sessionId: string, message: string): void;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const card = anchor.current?.closest<HTMLElement>("[data-composer-card]");
    if (!card) return;
    const controller = new AbortController();
    let busy = false;
    const isWorkImage = (event: DragEvent) => event.dataTransfer?.types.includes(WORK_IMAGE_DRAG_TYPE);
    const over = (event: DragEvent) => {
      if (!isWorkImage(event)) return;
      event.preventDefault(); event.stopPropagation();
      event.dataTransfer!.dropEffect = busy ? "none" : "copy";
      card.dataset.jizuoImageDrop = "true";
    };
    const reset = () => { delete card.dataset.jizuoImageDrop; };
    const leave = (event: DragEvent) => { if (!(event.relatedTarget instanceof Node) || !card.contains(event.relatedTarget)) reset(); };
    const drop = (event: DragEvent) => {
      if (!isWorkImage(event)) return;
      event.preventDefault(); event.stopPropagation(); reset();
      if (busy) return;
      const ref = parseWorkImageDrag(event.dataTransfer!.getData(WORK_IMAGE_DRAG_TYPE));
      if (!ref) { notify(sessionId, "图片引用无效，请从作品文件重新拖入"); return; }
      busy = true;
      void attach(sessionId, ref, controller.signal).catch(error => {
        if (!controller.signal.aborted) notify(sessionId, error instanceof Error ? error.message : "图片添加失败");
      }).finally(() => { busy = false; });
    };
    card.addEventListener("dragover", over, true);
    card.addEventListener("dragleave", leave, true);
    card.addEventListener("drop", drop, true);
    window.addEventListener("dragend", reset);
    return () => {
      controller.abort(); reset();
      card.removeEventListener("dragover", over, true);
      card.removeEventListener("dragleave", leave, true);
      card.removeEventListener("drop", drop, true);
      window.removeEventListener("dragend", reset);
    };
  }, [sessionId, attach, notify]);
  return <span ref={anchor} hidden />;
}
