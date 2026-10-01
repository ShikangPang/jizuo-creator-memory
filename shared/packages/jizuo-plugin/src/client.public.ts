import type { Context } from "@deepseek-ai/cordis";
import { apply as applyClient } from "./client.tsx";
export { inject, creationClientApi } from "./client.tsx";

/** Public plugins extend the native Harness shell; Jizuo Desktop keeps its own shell. */
export function apply(ctx: Context) { return applyClient(ctx, { hostUi: "native" }); }
