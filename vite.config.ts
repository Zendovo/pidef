import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const nodeStub = fileURLToPath(new URL("./src/web/node-stub.ts", import.meta.url));
const isTauriBuild = Boolean(process.env.TAURI_ENV_PLATFORM);

export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  resolve: {
    alias: {
      fs: nodeStub,
      path: nodeStub,
      "node:fs": nodeStub,
      "node:path": nodeStub,
    },
  },
  worker: {
    format: "es",
  },
  build: {
    target: isTauriBuild
      ? process.env.TAURI_ENV_PLATFORM === "windows"
        ? "chrome105"
        : "safari13"
      : "es2022",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
