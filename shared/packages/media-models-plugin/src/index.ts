import type { Context } from "@deepseek-ai/cordis";
import type { CreationHostRuntime } from "../../jizuo-plugin/src/creation-host.ts";
import { registerChatMediaTools, type ChatAttachmentReader } from "../../jizuo-plugin/src/video/chat-media-tools.ts";
import type { ToolsContext } from "../../jizuo-plugin/src/tools.ts";
export const name = "jizuo-media-models";
export const inject = ["jizuoCreationHost", "tools"];
export function apply(ctx: Context) {
  const runtime = ctx.get("jizuoCreationHost") as CreationHostRuntime;
  runtime.registerSkills?.(ctx, "media-models");
  const {service} = runtime;
  if (!service.chatMedia || !service.mediaSettings) throw new Error("媒体模型服务尚未就绪");
  ctx.provide("jizuoMediaModels", service.mediaSettings);
  registerChatMediaTools(ctx as unknown as ToolsContext, service.chatMedia, () => ctx.get("attachments") as ChatAttachmentReader | undefined);
}
