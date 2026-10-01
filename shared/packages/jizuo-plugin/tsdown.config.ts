import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { defineConfig } from "tsdown";

const PLUGIN_ID = "@jizuo/plugin";
const CSS_PREFIX = "\0jizuo-css:";
const CSS_SUFFIX = ".mjs";
export const CLIENT_EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-api-remotes/client",
  "@deepseek-ai/dsh-api-session-controller/client",
  "@deepseek-ai/dsh-api-workspace-controller/client",
  "@deepseek-ai/dsh-client-ui-layout/client",
  "@deepseek-ai/dsh-client-ui-renderer/client",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-workspace/client",
] as const;
const HOST_EXTERNALS = [/^node:/, /^@deepseek-ai\//] as const;

function hostDependencies() {
  return {
    neverBundle: [...HOST_EXTERNALS],
    alwaysBundle: (id: string) => (
      HOST_EXTERNALS.some((pattern) => pattern.test(id)) ? undefined : true
    ),
    onlyBundle: false as const,
  };
}

export function inlineCssPlugin(pluginId = PLUGIN_ID) {
  return {
    name: "jizuo-inline-css",
    resolveId(source: string, importer?: string) {
      if (!source.endsWith(".css")) return null;
      const file = importer === undefined ? source : resolve(dirname(importer), source);
      return `${CSS_PREFIX}${file}${CSS_SUFFIX}`;
    },
    async load(id: string) {
      if (!id.startsWith(CSS_PREFIX)) return null;
      const file = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length);
      const css = await readFile(file, "utf8");
      const tagId = `${pluginId}/${basename(file)}`;
      return [
        "if (typeof document !== 'undefined') {",
        `  const selector = ${JSON.stringify(`style[data-jizuo-css="${tagId}"]`)};`,
        "  if (document.querySelector(selector) === null) {",
        "    const tag = document.createElement('style');",
        `    tag.dataset.jizuoCss = ${JSON.stringify(tagId)};`,
        `    tag.textContent = ${JSON.stringify(css)};`,
        "    document.head.appendChild(tag);",
        "  }",
        "}",
        "export default {};",
      ].join("\n");
    },
  };
}

export default defineConfig([
  {
    name: "jizuo-plugin/host",
    entry: { index: "src/index.ts" },
    outDir: "lib",
    format: "esm",
    platform: "node",
    target: "es2024",
    fixedExtension: false,
    dts: false,
    clean: true,
    deps: hostDependencies(),
    plugins: [publicWorkflowBoundary()],
  },
  {
    // A fork has no Desktop host resolver. Keep the worker independent of host chunks.
    name: "jizuo-plugin/dream-worker",
    entry: { "dream-worker": "src/dream-worker.ts" },
    outDir: "lib",
    format: "esm",
    platform: "node",
    target: "es2024",
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: [/^node:/, /^better-sqlite3$/], alwaysBundle: (id: string) => id.startsWith("node:") || id === "better-sqlite3" ? undefined : true, onlyBundle: false },
    outputOptions: { codeSplitting: false },
  },
  {
    name: "jizuo-plugin/typert",
    entry: { "typert.host": "src/typert.host.ts" },
    outDir: "lib",
    format: "esm",
    platform: "node",
    target: "es2024",
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: hostDependencies(),
    plugins: [publicWorkflowBoundary()],
  },
  {
    name: "jizuo-plugin/workflow-verifier",
    entry: { "workflow-verifier": "src/workflow-verifier.ts" },
    outDir: "lib",
    format: "esm",
    platform: "node",
    target: "es2024",
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: hostDependencies(),
    plugins: [publicWorkflowBoundary()],
  },
  {
    name: "jizuo-plugin/client",
    entry: { client: "src/client.public.ts" },
    outDir: "lib",
    format: "cjs",
    platform: "browser",
    target: "es2022",
    fixedExtension: false,
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: [...CLIENT_EXTERNALS],
      alwaysBundle: (id: string) => (
        CLIENT_EXTERNALS.includes(id as (typeof CLIENT_EXTERNALS)[number]) ? undefined : true
      ),
      onlyBundle: false,
    },
    plugins: [inlineCssPlugin()],
    outputOptions: {
      // The desktop module loader consumes one factory; lazy panels initialize on demand inside it.
      codeSplitting: false,
      entryFileNames: "client.js",
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      intro: "var module = { exports: {} }; var exports = module.exports;",
      footer: "return module.exports; } });",
    },
  },
]);

function publicWorkflowBoundary() {
  return { name: 'public-workflow-boundary', resolveId(id: string) { return id === 'better-sqlite3' ? '\0creator-workflow-unavailable' : null; }, load(id: string) { return id === '\0creator-workflow-unavailable' ? 'export default class Database { constructor() { throw new Error("此公开插件版本不提供旧章节工作流；请使用普通创作对话。"); } }' : null; } };
}
