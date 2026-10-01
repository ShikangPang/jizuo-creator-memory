import type { MediaProviderConfig } from "../../../contracts/src/media.ts";
import { MediaProviderError } from "./provider-error.ts";

/** Execution is independent of the output kind; adapters still own their wire format. */
export function resolveMediaExecution(config: MediaProviderConfig, kind: "image" | "video"): "sync" | "async" {
  if (config.protocol === "nspox") {
    if (config.executionMode === "sync") throw new MediaProviderError("NSPOX 使用统一任务接口，请使用自动或异步方式。", "not-submitted");
    return "async";
  }
  const defaultMode = kind === "video" || config.protocol === "kuaishou" || config.protocol === "tencent" || (config.protocol === "dashscope" && config.options?.imageApi === "wan") ? "async" : "sync";
  const mode = config.executionMode ?? "auto";
  if (mode === "auto") return defaultMode;
  const both = kind === "image" && config.protocol === "dashscope" && (
    (config.options?.imageApi !== "wan" && config.options?.imageApi !== "z-image" && /^qwen-image-3\.0(?:-|$)/i.test(config.model)) ||
    (config.options?.imageApi === "wan" && /^wan2\.6-t2i(?:-|$)/i.test(config.model))
  );
  if (mode !== defaultMode && !both) throw new MediaProviderError("当前接口不支持所选执行方式，请使用自动识别或接口支持的同步／异步方式。", "not-submitted");
  return mode;
}
