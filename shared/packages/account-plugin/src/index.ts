import type { Context } from "@deepseek-ai/cordis";
import type { CreationHostRuntime } from "../../jizuo-plugin/src/creation-host.ts";
export const name = "jizuo-account";
export const inject = ["jizuoCreationHost"];
export function apply(ctx: Context) {
  const {service} = ctx.get("jizuoCreationHost") as CreationHostRuntime;
  ctx.provide("jizuoAccount", {getState: () => service.getAccountState()});
  ctx.effect(() => {
    void service.setAccountEnabled(true);
    // Refresh only this provider; never select a model or initiate inference.
    void service.getAccountState().catch(() => {});
    // Disabling is immediate; provider cleanup reconciles after this lifecycle.
    return () => { void service.setAccountEnabled(false).catch(() => {}); };
  });
}
