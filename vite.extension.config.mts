import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: "src/extension/extension.ts",
      fileName: () => "extension.js",
      formats: ["cjs"],
    },
    outDir: "dist/extension",
    rollupOptions: {
      external: [
        "vscode",
        "node:child_process",
        "node:crypto",
        "node:fs/promises",
        "node:path",
      ],
    },
    sourcemap: false,
  },
});
