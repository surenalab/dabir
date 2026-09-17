import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { execSync, execFile } from "node:child_process";
// @ts-expect-error type error without @types/node package
import { existsSync, mkdirSync, readFileSync } from "node:fs";
// @ts-expect-error type error without @types/node package
import { tmpdir } from "node:os";
// @ts-expect-error type error without @types/node package
import { join } from "node:path";
const host = process.env.TAURI_DEV_HOST;

// Browser preview only (`npm run dev`, never in a build): /__sample.pdf serves a PDF so the PDF view can be checked
// without the desktop app. DABIR_SAMPLE_PDF names any PDF (a long one exercises lazy rendering); otherwise the bundled
// sample is compiled once with Tectonic into the system temp folder, so nothing is written under examples/.
function samplePdf(): Plugin {
  return {
    name: "dabir-sample-pdf",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__sample.pdf", (_req, res) => {
        const send = (file: string) => { res.setHeader("Content-Type", "application/pdf"); res.end(readFileSync(file)); };
        const missing = () => { res.statusCode = 404; res.end(); };
        const named = process.env.DABIR_SAMPLE_PDF;
        if (named) return existsSync(named) ? send(named) : missing();
        const out = join(tmpdir(), "dabir-sample-pdf"), pdf = join(out, "main.pdf");
        if (existsSync(pdf)) return send(pdf);
        mkdirSync(out, { recursive: true });
        execFile("tectonic", ["-X", "compile", "--outdir", out, "main.tex"], { cwd: "examples/score-anchor" }, () => (existsSync(pdf) ? send(pdf) : missing()));
      });
    },
  };
}

// Stamp each build with its commit and day so a running copy can be told apart from an older one.
const build = (() => {
  try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "dev"; }
})();
const built = new Date().toISOString().slice(0, 10);

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), samplePdf()],
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
