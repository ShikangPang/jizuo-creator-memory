import type { Context, Fiber, Plugin } from "@deepseek-ai/cordis";
import type { Config } from "./config.ts";

interface SharedHost {
  readonly configKey: string;
  readonly fiber: Fiber;
  owners: number;
  closing?: Promise<void>;
}

// The root owns the worker so disabling the first installed feature cannot
// dispose services still used by another feature's Loader entry.
const hosts = new WeakMap<Context, SharedHost>();

export async function mountSharedCreationHost(ctx: Context, config: Config, plugin: Plugin<Config>): Promise<void> {
  const root = ctx.root;
  while (hosts.get(root)?.closing) await hosts.get(root)!.closing;
  const configKey = JSON.stringify([config.worksRoot, config.settingsRoot, config.chapterWorkflowEnabled, config.hostUi]);
  let host = hosts.get(root);
  if (host && host.configKey !== configKey) {
    throw new Error("即作插件的共享目录配置不一致，请为各创作插件使用相同的作品和配置目录。");
  }
  if (!host) {
    host = { configKey, fiber: root.plugin(plugin, config), owners: 0 };
    hosts.set(root, host);
  }
  const owned = host;
  owned.owners++;
  const release = async () => {
    if (--owned.owners !== 0) return;
    owned.closing = owned.fiber.dispose();
    try { await owned.closing; }
    finally { if (hosts.get(root) === owned) hosts.delete(root); }
  };
  try { ctx.effect(() => release, "jizuo-shared-creation-host"); }
  catch (error) { await release(); throw error; }
  await owned.fiber.await();
}
