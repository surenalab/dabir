// Thin wrapper over the Rust core. Falls back to a bundled sample when the UI
// runs in a plain browser (vite dev without Tauri), so the shell stays
// previewable and screenshot-able.

import { invoke, isTauri } from "@tauri-apps/api/core";
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
  if (!native) return;
  return invoke("write_text", { path, contents });
}
