import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/webview",
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    emptyOutDir: true,
    manifest: ".vite/manifest.json",
    outDir: "../../dist/webview",
    sourcemap: false,
  },
});
