import type { Context } from "@deepseek-ai/cordis";
import type { CreationHostRuntime } from "../../jizuo-plugin/src/creation-host.ts";
import { registerJizuoTools } from "./tools.ts";
export const name = "jizuo-writing";
export const inject = ["jizuoCreationHost", "tools"];
export function apply(ctx: Context) {
  const runtime = ctx.get("jizuoCreationHost") as CreationHostRuntime;
  ctx.provide("jizuoWritingApi", runtime.apis.writing);
  registerJizuoTools(ctx, runtime.service, runtime.workflowChapterWrites, "writing");
}

export { WritingRemoteApi } from "./remote-api.ts";
