import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: "esm",
  target: "es2024",
  dts: false,
  deps: {
    neverBundle: [/^react(?:\/.*)?$/, /^@jizuo\//],
  },
  outDir: "lib",
  clean: true,
});
