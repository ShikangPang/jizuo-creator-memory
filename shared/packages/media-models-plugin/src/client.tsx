import type { Context } from "@deepseek-ai/cordis";
import type { creationClientApi } from "../../jizuo-plugin/src/creation-client.ts";
export const inject = ["jizuoCreationClient"];
export function apply(ctx: Context) {
  const api = ctx.get("jizuoCreationClient") as typeof creationClientApi;
  return ctx.effect(() => api.registerExtension("media-models"));
}
