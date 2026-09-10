import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
import { execSync } from "node:child_process";
const host = process.env.TAURI_DEV_HOST;

// Stamp each build with its commit and day so a running copy can be told apart from an older one.
const build = (() => {
  try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "dev"; }
})();
const built = new Date().toISOString().slice(0, 10);

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],
  define: { __DABIR_BUILD__: JSON.stringify(`${build} · ${built}`) },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      // Agent worktrees and compile output live under .dabir; a change there must never reload the app.
      ignored: ["**/src-tauri/**", "**/.dabir/**", "**/examples/**", "**/Dabir Sessions/**"],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/pdfjs-dist")) return "pdfjs";
          if (id.includes("node_modules/katex")) return "katex";
          if (id.includes("node_modules/yjs") || id.includes("node_modules/y-") || id.includes("node_modules/lib0")) return "yjs";
          if (id.includes("node_modules/@codemirror") || id.includes("node_modules/codemirror-lang-latex") || id.includes("node_modules/@lezer") || id.includes("node_modules/style-mod") || id.includes("node_modules/w3c-keyname")) return "codemirror";
          if (id.includes("node_modules/lucide-react")) return "icons";
        },
      },
    },
  },
}));
