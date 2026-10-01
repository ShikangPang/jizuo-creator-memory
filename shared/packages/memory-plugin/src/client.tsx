import type { Context } from "@deepseek-ai/cordis";
import type { PanelFactory, creationClientApi } from "../../jizuo-plugin/src/creation-client.ts";
import { setSelection } from "../../jizuo-client/src/content/selection.ts";
import { MemoryPalaceOverlay } from "../../jizuo-client/src/overlay/MemoryPalaceOverlay.tsx";
export const panels: PanelFactory = (host, remote, changes, navigation) => {
  const close = () => setSelection({ overlay: null });
  return {
    memory: () => host.slots.register({ name: "shell.overlay", id: "jizuo-memory-palace", order: 20,
      inject: () => ({ remote, close }),
    }, MemoryPalaceOverlay),
  };
};
export const inject = ["jizuoCreationClient"];
export function apply(ctx: Context) {
  const api = ctx.get("jizuoCreationClient") as typeof creationClientApi;
  return ctx.effect(() => api.registerPanels("memory", panels));
}
