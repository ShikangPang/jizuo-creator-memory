import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";
import { CLIENT_EXTERNALS, inlineCssPlugin } from "../packages/jizuo-plugin/tsdown.config.ts";
const root = fileURLToPath(new URL("..", import.meta.url));
const stores = {
  selection: "content/selection.ts",
  shellChrome: "overlay/shellChrome.ts",
  preferences: "plugins/preferences.ts",
  videoProject: "video/useVideoProject.ts",
};
function sharedClientState() {
  const modules = Object.entries(stores).map(([key, path]) => {
    const file = resolve(root, "packages/jizuo-client/src", path);
    const exports = [...readFileSync(file, "utf8").matchAll(/^export (?:async )?(?:function|const|let|class) (\w+)/gm)].map(match => match[1]);
    return { key, file, exports };
  });
  return {
    name: "jizuo-shared-client-state",
    resolveId(source: string, importer?: string) {
      if (!importer || !source.startsWith(".")) return null;
      const entry = modules.find(item => item.file === resolve(dirname(importer), source));
      return entry ? `\0jizuo-shared:${entry.key}` : null;
    },
    load(id: string) {
      const entry = modules.find(item => id === `\0jizuo-shared:${item.key}`);
      if (!entry) return null;
      return `import { creationClientApi } from "@jizuo/plugin";\n` + entry.exports.map(name =>
        `export const ${name} = creationClientApi.${entry.key}.${name};`).join("\n");
    },
  };
}
export function featurePluginBuild(id: string) {
  return defineConfig([
    { entry: { index: "src/index.ts" }, outDir: "lib", format: "esm", platform: "node", fixedExtension: false, target: "es2024", dts: false, clean: true,
      deps: { neverBundle: [/^node:/, /^@deepseek-ai\//, /^better-sqlite3$/], alwaysBundle: (id: string) => /^(node:|@deepseek-ai\/|better-sqlite3$)/.test(id) ? undefined : true, onlyBundle: false } },
    { entry: { client: "src/client.tsx" }, outDir: "lib", format: "cjs", platform: "browser", target: "es2022", dts: false, clean: false,
      deps: { neverBundle: [...CLIENT_EXTERNALS, "@jizuo/plugin"], alwaysBundle: (id: string) => [...CLIENT_EXTERNALS, "@jizuo/plugin"].includes(id) ? undefined : true, onlyBundle: false },
      plugins: [sharedClientState(), inlineCssPlugin(id)],
      outputOptions: { codeSplitting: false, entryFileNames: "client.js",
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
        intro: "var module = { exports: {} }; var exports = module.exports;",
        footer: "return module.exports; } });" },
    },
  ]);
}
