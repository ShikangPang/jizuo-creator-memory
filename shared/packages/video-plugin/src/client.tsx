import type { Context } from "@deepseek-ai/cordis";
import type { PanelFactory, creationClientApi } from "../../jizuo-plugin/src/creation-client.ts";
import { setSelection } from "../../jizuo-client/src/content/selection.ts";
import { VideoInspector, type VideoEpisodeQuote } from "../../jizuo-client/src/video/VideoInspector.tsx";
import type { StoryboardChatRequest } from "../../jizuo-client/src/video/storyboard-chat.ts";
export const panels: PanelFactory = (host, remote, changes, navigation) => {
  const close = () => setSelection({ overlay: null });
  return {
    video: () => host.slots.register({ name: "shell.overlay", id: "jizuo-video-inspector", order: 20,
      inject: () => ({ remote, close,
        onQuoteEpisode: (quote: VideoEpisodeQuote) => { if (!host.conversation?.appendVideoEpisode?.(quote)) throw new Error("视频集引用未添加，请确认当前作品对话已就绪后重试"); },
        onGenerateStoryboard: async (request: StoryboardChatRequest) => {
          if (!host.conversation?.generateStoryboard) throw new Error("当前对话不可用，请重新打开作品对话后重试");
          await navigation.openWork(request.workId);
          await host.conversation.generateStoryboard(request);
          close();
        },
      }),
    }, VideoInspector),
  };
};
export const inject = ["jizuoCreationClient"];
export function apply(ctx: Context) {
  const api = ctx.get("jizuoCreationClient") as typeof creationClientApi;
  return ctx.effect(() => api.registerPanels("video", panels));
}
