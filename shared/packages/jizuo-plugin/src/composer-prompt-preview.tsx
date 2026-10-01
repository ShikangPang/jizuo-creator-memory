import { useSyncExternalStore } from "react";
import { ComposerPromptReferencePreview } from "../../jizuo-client/src/video/ComposerPromptReferencePreview.tsx";
import type { JizuoContentRemote } from "../../jizuo-client/src/content/remote.ts";
import type { NativeVideoInput } from "../../jizuo-client/src/video/main-video-composer.ts";

type InputStore = NativeVideoInput["state"] & { subscribe(listener: () => void): () => void };
const empty = { occurrences: [] };

/** The native overlay slot supplies only sessionId, unlike the composer dock. */
export function ComposerPromptPreview({ sessionId, remote, inputStore }: {
  sessionId: string; remote: JizuoContentRemote; inputStore?: InputStore;
}) {
  const input = useSyncExternalStore(listener => inputStore?.subscribe(listener) ?? (() => {}), () => inputStore?.getSnapshot() ?? empty);
  return <ComposerPromptReferencePreview remote={remote} session={{ sessionId }} input={input} />;
}
