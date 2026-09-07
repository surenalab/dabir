// Thin wrapper over the Rust core. Falls back to a bundled sample when the UI
// runs in a plain browser (vite dev without Tauri), so the shell stays
// previewable and screenshot-able.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { SAMPLE_FILES, SAMPLE_PROJECT } from "./sample";

export type EntryKind = "dir" | "tex" | "bib" | "code" | "figure" | "data" | "other";

export interface Entry {
  name: string;
  path: string;
  kind: EntryKind;
  children: Entry[];
}

export interface Project {
  root: string;
  name: string;
  mainTex: string | null;
  hasGit: boolean;
  hasMemory: boolean;
  tree: Entry[];
}

export interface Diagnostic {
  severity: "error" | "warning";
  file: string | null;
  line: number | null;
  message: string;
}

export interface CompileResult {
  ok: boolean;
  pdf: string | null;
  log: string;
  diagnostics: Diagnostic[];
  engine: string;
  millis: number;
}

export const native = isTauri();

export async function pickFolder(): Promise<string | null> {
  if (!native) return SAMPLE_PROJECT.root;
  const picked = await openDialog({ directory: true, multiple: false, title: "Open a paper" });
  return typeof picked === "string" ? picked : null;
}

export async function openProject(path: string): Promise<Project> {
  if (!native) return SAMPLE_PROJECT;
  return invoke<Project>("open_project", { path });
}

export async function readText(path: string): Promise<string> {
  if (!native) return SAMPLE_FILES[path] ?? "";
  return invoke<string>("read_text", { path });
}

export async function writeText(path: string, contents: string): Promise<void> {
  if (!native) { SAMPLE_FILES[path] = contents; return; }
  return invoke("write_text", { path, contents });
}

export async function readBinary(path: string): Promise<Uint8Array> {
  if (!native) return new Uint8Array();
  const bytes = await invoke<ArrayBuffer | number[]>("read_binary", { path });
  return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : Uint8Array.from(bytes);
}

export async function compile(mainTex: string): Promise<CompileResult> {
  if (!native) {
    await new Promise((r) => setTimeout(r, 900));
    return {
      ok: true, pdf: null, engine: "sample", millis: 900,
      log: "(browser preview: no TeX engine available)",
      diagnostics: [{ severity: "warning", file: "main.tex", line: 51, message: "Citation `chung2023dps' undefined in browser preview" }],
    };
  }
  return invoke<CompileResult>("compile", { mainTex });
}

/** Menu commands arrive from the native menu bar. In the browser they come from the keyboard fallback. */
export function onMenu(handler: (id: string) => void): () => void {
  if (!native) return () => {};
  let un: (() => void) | undefined;
  listen<string>("menu", (e) => handler(e.payload)).then((u) => { un = u; });
  return () => un?.();
}

export function setWindowTitle(title: string) {
  if (native) getCurrentWindow().setTitle(title).catch(() => {});
  document.title = title;
}

export function onWindowFocus(handler: (focused: boolean) => void): () => void {
  if (!native) {
    const f = () => handler(true), b = () => handler(false);
    window.addEventListener("focus", f); window.addEventListener("blur", b);
    return () => { window.removeEventListener("focus", f); window.removeEventListener("blur", b); };
  }
  let un: (() => void) | undefined;
  getCurrentWindow().onFocusChanged(({ payload }) => handler(payload)).then((u) => { un = u; });
  return () => un?.();
}
