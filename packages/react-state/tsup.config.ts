import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    "@tanstack-json-render/core",
    "@tanstack-json-render/core/store-utils",
    "react",
  ],
});
