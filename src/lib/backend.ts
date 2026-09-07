// Thin wrapper over the Rust core. Falls back to a bundled sample when the UI
// runs in a plain browser (vite dev without Tauri), so the shell stays
// previewable and screenshot-able.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { SAMPLE_FILES, SAMPLE_PROJECT } from "./sample";

export type EntryKind = "dir" | "tex" | "bib" | "code" | "figure" | "data" | "other";
export interface Entry { name: string; path: string; kind: EntryKind; children: Entry[] }
export interface Project { root: string; name: string; mainTex: string | null; hasGit: boolean; hasMemory: boolean; tree: Entry[] }

export interface Diagnostic { severity: "error" | "warning"; file: string | null; line: number | null; message: string }
export interface CompileResult { ok: boolean; pdf: string | null; log: string; diagnostics: Diagnostic[]; engine: string; millis: number }

export interface PdfPos { page: number; x: number; y: number }
export interface SrcPos { file: string; line: number }

export interface Change { path: string; status: string; add: number; del: number; binary: boolean }
export interface CommitInfo { id: string; summary: string; author: string; when: number }
export interface GitStatus { isRepo: boolean; branch: string | null; changes: Change[]; recent: CommitInfo[]; remote: string | null }

export interface Provider { id: string; label: string; hint: string; bin: string; installed: boolean; path: string | null }
export interface AgentEvent { runId: string; kind: "text" | "tool" | "log" | "done" | "error"; text: string; tool: string | null; ok: boolean | null }
export interface WorktreeDiff { patch: string; changes: Change[] }

export interface Fact { name: string; description: string; body: string; path: string }
export interface Artefact { artefact: string; command: string; inputs: string[]; producedAt: string | null; commit: string | null; dataHash: string | null; stale: boolean; missing: boolean }
export interface Skill { name: string; description: string; path: string }
export interface Memory { brief: string | null; briefPath: string; identity: string | null; envPrefix: string | null; facts: Fact[]; skills: Skill[]; runs: string[]; provenance: Artefact[]; pointers: string[] }
export interface RunOutput { ok: boolean; output: string; millis: number }

export const native = isTauri();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- project and files

export async function pickFolder(title = "Open a paper"): Promise<string | null> {
  if (!native) return SAMPLE_PROJECT.root;
  const picked = await openDialog({ directory: true, multiple: false, title });
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

export function onCompileProgress(handler: (line: string) => void): () => void {
  if (!native) return () => {};
  let un: (() => void) | undefined;
  listen<string>("compile-progress", (e) => handler(e.payload)).then((u) => { un = u; });
  return () => un?.();
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent);

/** Check GitHub releases for a newer build; download, install and relaunch when the user agrees. */
export async function checkForUpdates(confirm: (version: string, notes: string) => Promise<boolean>): Promise<string> {
  if (!native) return "Updates are only available in the desktop app.";
  const { check } = await import("@tauri-apps/plugin-updater");
  const { relaunch } = await import("@tauri-apps/plugin-process");
  const update = await check();
  if (!update) return "Dabir is up to date.";
  if (!(await confirm(update.version, update.body ?? ""))) return "Update skipped.";
  await update.downloadAndInstall();
  await relaunch();
  return "Restarting to finish the update.";
}

export async function compile(mainTex: string): Promise<CompileResult> {
  if (!native) {
    await wait(900);
    return { ok: true, pdf: null, engine: "sample", millis: 900, log: "(browser preview: no TeX engine available)",
      diagnostics: [{ severity: "warning", file: "main.tex", line: 51, message: "Citation `chung2023dps' undefined in browser preview" }] };
  }
  return invoke<CompileResult>("compile", { mainTex });
}

export async function importOverleaf(): Promise<string | null> {
  if (!native) return SAMPLE_PROJECT.root;
  const picked = await openDialog({ multiple: false, title: "Import from Overleaf", filters: [{ name: "Overleaf project", extensions: ["zip"] }] });
  if (typeof picked !== "string") return null;
  return invoke<string>("import_overleaf_zip", { zipPath: picked, dest: null });
}

// ---------------------------------------------------------------- synctex

export async function synctexForward(mainTex: string, file: string, line: number): Promise<PdfPos | null> {
  if (!native) return null;
  return invoke<PdfPos | null>("synctex_forward", { mainTex, file, line });
}
export async function synctexInverse(mainTex: string, page: number, x: number, y: number): Promise<SrcPos | null> {
  if (!native) return null;
  return invoke<SrcPos | null>("synctex_inverse", { mainTex, page, x, y });
}

// ---------------------------------------------------------------- git

const SAMPLE_GIT: GitStatus = {
  isRepo: true, branch: "main", remote: "git@github.com:sadegh/isgd-tci.git",
  changes: [
    { path: "figures/psnr-vs-noise.pdf", status: "modified", add: 0, del: 0, binary: true },
    { path: "main.tex", status: "modified", add: 6, del: 4, binary: false },
  ],
  recent: [
    { id: "a41b9c2", summary: "Add injectivity proof to Appendix A", author: "Sadegh", when: Date.now() / 1000 - 86400 * 2 },
    { id: "0f3e1d7", summary: "Address reviewer 2 on the density condition", author: "Marta", when: Date.now() / 1000 - 86400 * 5 },
  ],
};

export async function gitStatus(root: string): Promise<GitStatus> {
  if (!native) return SAMPLE_GIT;
  return invoke<GitStatus>("git_status", { root });
}
export async function gitInit(root: string): Promise<void> { if (native) await invoke("git_init", { root }); }
export async function gitCommit(root: string, message: string, paths?: string[]): Promise<string> {
  if (!native) { await wait(300); SAMPLE_GIT.changes = []; SAMPLE_GIT.recent.unshift({ id: "b7c2e90", summary: message, author: "You", when: Date.now() / 1000 }); return "b7c2e90"; }
  return invoke<string>("git_commit", { root, message, paths: paths ?? null });
}
export async function gitClone(url: string, dest: string): Promise<string> {
  if (!native) { await wait(800); return SAMPLE_PROJECT.root; }
  return invoke<string>("git_clone", { url, dest });
}

// ---------------------------------------------------------------- agents

export async function agentProviders(): Promise<Provider[]> {
  if (!native) return [
    { id: "claude", label: "Claude Code", hint: "Claude Pro or Max, or an API key", bin: "claude", installed: true, path: "/usr/local/bin/claude" },
    { id: "codex", label: "Codex", hint: "ChatGPT Plus or Pro, or an API key", bin: "codex", installed: false, path: null },
    { id: "cursor", label: "Cursor", hint: "Cursor subscription", bin: "cursor-agent", installed: true, path: "~/.local/bin/cursor-agent" },
    { id: "grok", label: "Grok", hint: "SuperGrok or an xAI key", bin: "grok", installed: false, path: null },
    { id: "opencode", label: "OpenCode", hint: "Any model, including local", bin: "opencode", installed: false, path: null },
  ];
  return invoke<Provider[]>("agent_providers");
}

let sampleRunHandlers: ((e: AgentEvent) => void)[] = [];

export async function agentRun(root: string, provider: string, prompt: string): Promise<{ runId: string; worktree: string }> {
  if (!native) {
    const runId = Math.random().toString(16).slice(2, 10);
    (async () => {
      const send = (e: Omit<AgentEvent, "runId">) => sampleRunHandlers.forEach((h) => h({ runId, ...e }));
      await wait(400); send({ kind: "tool", tool: "Read", text: ".dabir/PROJECT.md", ok: null });
      await wait(700); send({ kind: "tool", tool: "Bash", text: "python code/sweep.py --sigma 0.3", ok: null });
      await wait(1200); send({ kind: "tool", tool: "Edit", text: "main.tex", ok: null });
      await wait(600); send({ kind: "text", text: "Reran the sweep to σ = 0.3, regenerated the figure and the table, and updated the margin claim in §2.3.", tool: null, ok: null });
      await wait(300); send({ kind: "done", text: "", tool: null, ok: true });
    })();
    return { runId, worktree: `${root}/.dabir/worktrees/${runId}` };
  }
  return invoke("agent_run", { root, provider, prompt });
}

export function onAgentEvent(handler: (e: AgentEvent) => void): () => void {
  if (!native) { sampleRunHandlers.push(handler); return () => { sampleRunHandlers = sampleRunHandlers.filter((h) => h !== handler); }; }
  let un: (() => void) | undefined;
  listen<AgentEvent>("agent-event", (e) => handler(e.payload)).then((u) => { un = u; });
  return () => un?.();
}

export async function agentCancel(runId: string): Promise<boolean> { return native ? invoke<boolean>("agent_cancel", { runId }) : true; }

export async function agentDiff(root: string, runId: string): Promise<WorktreeDiff> {
  if (!native) return {
    changes: [
      { path: "figures/psnr-vs-noise.pdf", status: "modified", add: 0, del: 0, binary: true },
      { path: "tables/psnr-sweep.tex", status: "modified", add: 2, del: 0, binary: false },
      { path: "main.tex", status: "modified", add: 2, del: 1, binary: false },
    ],
    patch: `diff --git a/tables/psnr-sweep.tex b/tables/psnr-sweep.tex\n--- a/tables/psnr-sweep.tex\n+++ b/tables/psnr-sweep.tex\n@@ -8,3 +8,5 @@\n 0.2 & 28.9 & 28.1 & 30.7 \\\\\n+0.25 & 27.0 & 26.2 & 28.9 \\\\\n+0.3 & 25.4 & 24.6 & 27.2 \\\\\n \\bottomrule\ndiff --git a/main.tex b/main.tex\n--- a/main.tex\n+++ b/main.tex\n@@ -40,2 +40,3 @@\n reports PSNR against noise level for three\n-baselines; the proposed method holds a 1.6 dB margin.\n+baselines; the proposed method holds a 1.8 dB margin up to $\\sigma = 0.3$.\n+\\input{tables/psnr-sweep}\n`,
  };
  return invoke<WorktreeDiff>("agent_diff", { root, runId });
}
export interface Pick { path: string; hunks: number[] | null }
export async function agentAccept(root: string, runId: string, message: string, picks: Pick[] | undefined, provider: string, prompt: string): Promise<string> {
  if (!native) { await wait(400); return "c1d2e3f"; }
  return invoke<string>("agent_accept", { root, runId, message, picks: picks ?? null, provider, prompt });
}
export async function contextPack(root: string, query: string): Promise<string> {
  if (!native) return "main.tex:38-52\n\\subsection{Guided sampling}\n…";
  return invoke<string>("context_pack", { root, query });
}
export async function compileCancel(): Promise<boolean> { return native ? invoke<boolean>("compile_cancel") : true; }
export async function agentReject(root: string, runId: string): Promise<void> { if (native) await invoke("agent_reject", { root, runId }); }
export async function agentPullRequest(root: string, runId: string, message: string): Promise<string> {
  if (!native) { await wait(400); return "https://github.com/sadegh/isgd-tci/pull/12"; }
  return invoke<string>("agent_pull_request", { root, runId, message });
}

// ---------------------------------------------------------------- memory

export async function memoryRead(root: string): Promise<Memory> {
  if (!native) return {
    brief: "# Injective Sampling…\n\n## Identity\nWe study when a masked measurement operator admits a unique reconstruction under a diffusion prior…", briefPath: `${root}/.dabir/PROJECT.md`,
    identity: "We study when a masked measurement operator admits a unique reconstruction under a diffusion prior.", envPrefix: "",
    skills: ["rerun-experiment", "update-figure-and-text", "address-reviewer", "tighten-prose", "check-references", "compile-and-fix"].map((n) => ({ name: `dabir-${n}`, description: "", path: `${root}/.dabir/skills/${n}/SKILL.md` })),
    runs: ["2026-09-07 · grok · Rerun the noise sweep to σ = 0.3 · figures/psnr-vs-noise.pdf, tables/psnr-sweep.tex, main.tex"],
    facts: [{ name: "reviewer-2-injectivity-proof", description: "Reviewer 2 asked for the injectivity constant to be made explicit; addressed in Appendix A", body: "", path: `${root}/.dabir/memory/reviewer-2-injectivity-proof.md` }],
    provenance: [
      { artefact: "figures/psnr-vs-noise.pdf", command: "python code/sweep.py --sigma 0.3", inputs: ["code/sweep.py"], producedAt: "2026-09-05", commit: "a41b9c2", dataHash: null, stale: false, missing: false },
      { artefact: "tables/psnr-sweep.tex", command: "python code/sweep.py --sigma 0.3", inputs: ["code/sweep.py"], producedAt: "2026-09-05", commit: "a41b9c2", dataHash: null, stale: true, missing: false },
    ],
    pointers: ["AGENTS.md", "CLAUDE.md"],
  };
  return invoke<Memory>("memory_read", { root });
}
export async function memorySetup(root: string, mainTex: string | null): Promise<string[]> {
  if (!native) { await wait(300); return [".dabir/PROJECT.md", "AGENTS.md", "CLAUDE.md"]; }
  return invoke<string[]>("memory_setup", { root, mainTex });
}
export async function provenanceRerun(root: string, artefact: string): Promise<RunOutput> {
  if (!native) { await wait(800); return { ok: true, output: "swept 7 noise levels x 5 seeds\nwrote figures/psnr-vs-noise.pdf and tables/psnr-sweep.tex\n", millis: 800 }; }
  return invoke<RunOutput>("provenance_rerun", { root, artefact });
}

// ---------------------------------------------------------------- live relay and remotes

export interface RelayInfo { url: string; lanUrl: string; pid: number }
export async function relayStart(port = 1234): Promise<RelayInfo> {
  if (!native) return { url: `ws://localhost:${port}`, lanUrl: `ws://localhost:${port}`, pid: 0 };
  return invoke<RelayInfo>("relay_start", { port });
}
export async function relayStop(): Promise<void> { if (native) await invoke("relay_stop"); }

export async function gitRemoteAdd(root: string, name: string, url: string): Promise<void> { if (native) await invoke("git_remote_add", { root, name, url }); }
export async function gitRemoteUrl(root: string, name: string): Promise<string | null> { return native ? invoke<string | null>("git_remote_url", { root, name }) : null; }
export async function gitPull(root: string, remote: string): Promise<string> { if (!native) { await wait(600); return "Already up to date."; } return invoke<string>("git_pull", { root, remote }); }
export async function gitPush(root: string, remote: string): Promise<string> { if (!native) { await wait(600); return "Pushed main."; } return invoke<string>("git_push", { root, remote }); }

// ---------------------------------------------------------------- window

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
