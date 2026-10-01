import type { Context } from "@deepseek-ai/cordis";
import type { PanelFactory, creationClientApi } from "../../jizuo-plugin/src/creation-client.ts";
import { setSelection } from "../../jizuo-client/src/content/selection.ts";
import { ChapterInspector } from "../../jizuo-client/src/overlay/ChapterInspector.tsx";
import { VolumeOutlineInspector } from "../../jizuo-client/src/overlay/VolumeOutlineInspector.tsx";
export const panels: PanelFactory = (host, remote, changes, navigation) => {
  const close = () => setSelection({ overlay: null });
  return {
    chapter: () => host.slots.register({ name: "shell.overlay", id: "jizuo-chapter-inspector", order: 20,
      inject: () => ({ remote, subscribeWorksChanges: changes, close,
        onQuoteExcerpt: host.conversation ? (quote: Parameters<NonNullable<typeof host.conversation>["appendChapterExcerpt"]>[0]) => host.conversation!.appendChapterExcerpt(quote) : undefined }),
    }, ChapterInspector),
    volume: () => host.slots.register({ name: "shell.overlay", id: "jizuo-volume-outline", order: 20,
      inject: () => ({ remote, close }),
    }, VolumeOutlineInspector),
  };
};
export const inject = ["jizuoCreationClient"];
export function apply(ctx: Context) {
  const api = ctx.get("jizuoCreationClient") as typeof creationClientApi;
  return ctx.effect(() => api.registerPanels("writing", panels));
}
