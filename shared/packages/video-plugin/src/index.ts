import type { Context } from "@deepseek-ai/cordis";
import type { CreationHostRuntime } from "../../jizuo-plugin/src/creation-host.ts";
import { registerVideoTools } from "./tools.ts";
export const name = "jizuo-video";
export const inject = ["jizuoCreationHost", "tools"];
export function apply(ctx: Context) {
  const runtime = ctx.get("jizuoCreationHost") as CreationHostRuntime;
  ctx.provide("jizuoVideoApi", runtime.apis.video);
  registerVideoTools(ctx, runtime.service);
}

export { VideoRemoteApi } from "./remote-api.ts";
