import type { Context } from "@deepseek-ai/cordis";
import type { CreationHostRuntime } from "../../jizuo-plugin/src/creation-host.ts";
import { registerJizuoTools } from "../../writing-plugin/src/tools.ts";
export const name = "jizuo-memory";
export const inject = ["jizuoCreationHost", "tools"];
export function apply(ctx: Context) {
  const runtime = ctx.get("jizuoCreationHost") as CreationHostRuntime;
  runtime.registerSkills?.(ctx, "memory");
  ctx.provide("jizuoMemoryApi", runtime.apis.memory);
  registerJizuoTools(ctx, runtime.service, runtime.workflowChapterWrites, "memory");
}

export { MemoryRemoteApi } from "./remote-api.ts";
