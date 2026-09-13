// Thin wrapper over the Rust core. Falls back to a bundled sample when the UI
// runs in a plain browser (vite dev without Tauri), so the shell stays
// previewable and screenshot-able.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { SAMPLE_FILES, SAMPLE_PROJECT } from "./sample";
import { applyPatch } from "./review";

export type EntryKind = "dir" | "tex" | "bib" | "code" | "figure" | "data" | "other";
export interface Entry { name: string; path: string; kind: EntryKind; children: Entry[] }
/** Where the code runs when `dabir.toml [remote]` names a host: an ssh destination and the repository's path there. */
export interface Remote { host: string; dir: string }
export interface Project { root: string; name: string; mainTex: string | null; hasGit: boolean; hasMemory: boolean; tree: Entry[]; treeTruncated?: boolean; remote?: Remote | null }

export interface Diagnostic { severity: "error" | "warning" | "info"; category: string; file: string | null; line: number | null; message: string; context: string | null }
export interface CompileResult { ok: boolean; pdf: string | null; log: string; diagnostics: Diagnostic[]; engine: string; millis: number }

export interface PdfPos { page: number; x: number; y: number }
export interface SrcPos { file: string; line: number }

export interface Change { path: string; status: string; add: number; del: number; binary: boolean }
export interface CommitInfo { id: string; summary: string; author: string; when: number }
export interface GitStatus { isRepo: boolean; branch: string | null; changes: Change[]; recent: CommitInfo[]; remote: string | null }

export interface Provider { id: string; label: string; hint: string; bin: string; installed: boolean; path: string | null }
export interface AgentEvent { runId: string; kind: "text" | "tool" | "log" | "thinking" | "done" | "error"; text: string; tool: string | null; ok: boolean | null }
export interface WorktreeDiff { patch: string; changes: Change[] }

export interface Fact { name: string; description: string; body: string; path: string }
export interface Artefact { artefact: string; command: string; inputs: string[]; producedAt: string | null; commit: string | null; dataHash: string | null; stale: boolean; missing: boolean }
export interface Skill { name: string; description: string; path: string }
export interface Memory { brief: string | null; briefPath: string; identity: string | null; envPrefix: string | null; facts: Fact[]; skills: Skill[]; runs: string[]; provenance: Artefact[]; pointers: string[] }
export interface RunOutput { ok: boolean; output: string; millis: number }

export const native = isTauri();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- project and files

/** Where to write an export; null when the user cancels. */
export async function pickSavePath(defaultPath: string, filterName: string, extensions: string[]): Promise<string | null> {
  if (!native) return `/Users/ada/Desktop/${defaultPath}`;
  const picked = await saveDialog({ defaultPath, filters: [{ name: filterName, extensions }], title: "Export" });
  return typeof picked === "string" ? picked : null;
}
export async function revealPath(path: string): Promise<void> {
  if (!native) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

/**
 * Where a new paper goes: the save panel, so the folder is named and placed in one native step
 * (Save As + Where) instead of a typed name and a second dialog. Returns the full path of the
 * folder to create, or null when cancelled.
 */
export async function pickNewPaperPath(suggested: string): Promise<string | null> {
  if (!native) return `/Users/ada/Papers/${suggested}`;
  const picked = await saveDialog({ defaultPath: suggested, title: "New Paper", canCreateDirectories: true });
  return typeof picked === "string" ? picked : null;
}

export async function pickFolder(title = "Open a paper"): Promise<string | null> {
  if (!native) return SAMPLE_PROJECT.root;
  const picked = await openDialog({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}

export async function openProject(path: string): Promise<Project> {
  if (!native) return SAMPLE_PROJECT;
  return invoke<Project>("open_project", { path });
}

/** A heading in the paper, with the file and line it starts on. */
export interface PaperHeading { level: number; title: string; file: string; line: number; numbered: boolean }
/** A label, float, equation, theorem or macro, with where it lives and the section it sits under. */
export interface PaperAnchor { kind: string; name: string; file: string; line: number; detail: string; section: number | null }
export interface PaperMap {
  main: string;
  files: [string, number][];
  beginDocument: [string, number] | null;
  headings: PaperHeading[];
  anchors: PaperAnchor[];
  bibs: [string, number][];
  cites: number;
  typst: boolean;
}

/** The paper's structure across all its files: what the outline, completions and go-to-definition read. */
export async function paperMap(root: string): Promise<PaperMap | null> {
  if (!native) return null;
  try { return await invoke<PaperMap>("paper_map", { root }); } catch { return null; }
}

export async function readText(path: string): Promise<string> {
  if (!native) {
    // The sample run's worktree: the file as the demo patch leaves it.
    const wt = /^(.*)\/\.dabir\/worktrees\/[^/]+\/(.+)$/.exec(path);
    if (wt) { const base = SAMPLE_FILES[`${wt[1]}/${wt[2]}`]; if (base == null) throw new Error("No such file"); return applyPatch(base, SAMPLE_PATCH, wt[2]); }
    return SAMPLE_FILES[path] ?? "";
  }
  return invoke<string>("read_text", { path });
}

/** Browser preview only: every write, in order, so automated checks can see what would have hit the disk. */
export const PREVIEW_WRITES: { path: string; head: string }[] = [];
export async function writeText(path: string, contents: string): Promise<void> {
  if (!native) { SAMPLE_FILES[path] = contents; PREVIEW_WRITES.push({ path: path.split("/").slice(-2).join("/"), head: contents.slice(0, 40) }); (window as unknown as { __writes?: unknown }).__writes = PREVIEW_WRITES; return; }
  return invoke("write_text", { path, contents });
}

export async function readBinary(path: string): Promise<Uint8Array> {
  if (!native) return new Uint8Array();
  const bytes = await invoke<ArrayBuffer | number[]>("read_binary", { path });
  return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : Uint8Array.from(bytes);
}

export interface SnapFile { path: string; text: string | null; base64: string | null; size: number }
export interface Snapshot { files: SnapFile[]; skipped: string[]; total: number }
/** Every file of the project small enough to travel to a live-session joiner. */
export async function projectSnapshot(root: string): Promise<Snapshot> {
  if (!native) return { files: Object.entries(SAMPLE_FILES).filter(([k]) => k.startsWith(root)).map(([k, v]) => ({ path: k.slice(root.length + 1), text: v, base64: null, size: v.length })), skipped: [], total: 0 };
  return invoke<Snapshot>("project_snapshot", { root });
}
/** Rebuild a host's project under ~/Dabir Sessions/<name>; returns that folder. */
export async function sessionMaterialize(name: string, files: SnapFile[]): Promise<string | null> {
  if (!native) return null;
  return invoke<string>("session_materialize", { name, files });
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
      diagnostics: [
        { severity: "error", category: "syntax", file: "main.tex", line: 41, message: "Undefined control sequence", context: "! Undefined control sequence.\nl.41 \\section{Results}\\undefinedmacro\n                                     {x}" },
        { severity: "warning", category: "citation", file: "main.tex", line: 51, message: "Citation `chung2023dps' on page 1 undefined", context: "LaTeX Warning: Citation `chung2023dps' on page 1 undefined on input line 51." },
        { severity: "info", category: "font", file: "main.tex", line: 503, message: "Font shape `TU/ptm/m/n' undefined", context: null },
      ] };
  }
  return invoke<CompileResult>("compile", { mainTex });
}

export async function importOverleaf(): Promise<string | null> {
  if (!native) return SAMPLE_PROJECT.root;
  const picked = await openDialog({ multiple: false, title: "Import from Overleaf", filters: [{ name: "Overleaf project", extensions: ["zip"] }] });
  if (typeof picked !== "string") return null;
  return invoke<string>("import_overleaf_zip", { zipPath: picked, dest: null });
}

// ---------------------------------------------------------------- new paper and references

export interface Template {
  id: string; label: string; venue: string; group: string; engine: "latex" | "typst";
  official: boolean; featured: boolean; version: string | null; summary: string; site: string | null;
  main: string;
  /** Host the official kit is fetched from; null when bundled. */
  kit: string | null;
  /** Bundled, or fetched before: usable offline. */
  cached: boolean;
  /** Reasons for the adjustments Dabir makes to the kit. */
  notes: string[];
}
export interface TemplateGroup { id: string; label: string }
export interface TemplateListing { groups: TemplateGroup[]; templates: Template[] }
const SAMPLE_TEMPLATES: TemplateListing = {
  groups: [{ id: "ml", label: "Machine learning" }, { id: "vision", label: "Vision and graphics" }, { id: "nlp", label: "Language" }, { id: "publishers", label: "Journals and publishers" }, { id: "biology", label: "Biology and medicine" }, { id: "math", label: "Mathematics" }, { id: "general", label: "General" }, { id: "typst", label: "Typst" }],
  templates: [
    { id: "neurips", label: "NeurIPS 2026", venue: "Conference on Neural Information Processing Systems", group: "ml", engine: "latex", official: true, featured: true, version: "2026", summary: "The official neurips_2026.sty with the paper checklist. Anonymous with line numbers by default; add the final or preprint option when the time comes.", site: "https://neurips.cc/Conferences/2026/CallForPapers", main: "main.tex", kit: "media.neurips.cc", cached: false, notes: [] },
    { id: "iclr", label: "ICLR 2027", venue: "International Conference on Learning Representations", group: "ml", engine: "latex", official: true, featured: true, version: "2027", summary: "The official ICLR style, bibliography style and math_commands.tex from the ICLR master template.", site: "https://github.com/ICLR/Master-Template", main: "main.tex", kit: "raw.githubusercontent.com", cached: true, notes: [] },
    { id: "icml", label: "ICML 2026", venue: "International Conference on Machine Learning", group: "ml", engine: "latex", official: true, featured: false, version: "2026", summary: "The official icml2026.sty and bibliography style with the example paper.", site: "https://icml.cc/Conferences/2026/CallForPapers", main: "main.tex", kit: "media.icml.cc", cached: false, notes: [] },
    { id: "cvpr", label: "CVPR 2026", venue: "IEEE/CVF Conference on Computer Vision and Pattern Recognition", group: "vision", engine: "latex", official: true, featured: true, version: "2026-v1", summary: "The official CVF author kit: cvpr.sty, the IEEE natbib style, sections split under sec/, and the rebuttal template.", site: "https://github.com/cvpr-org/author-kit", main: "main.tex", kit: "codeload.github.com", cached: false, notes: [] },
    { id: "siggraph", label: "SIGGRAPH", venue: "SIGGRAPH and SIGGRAPH Asia (ACM TOG journal track)", group: "vision", engine: "latex", official: false, featured: true, version: null, summary: "A short paper on ACM's acmart class in acmtog mode, the layout SIGGRAPH asks for; acmart is fetched from CTAN on first compile. Switch to sigconf for the conference track.", site: "https://www.siggraph.org/", main: "main.tex", kit: null, cached: false, notes: [] },
    { id: "acl", label: "ACL", venue: "ACL, EMNLP, NAACL and other ACL venues", group: "nlp", engine: "latex", official: true, featured: true, version: "master", summary: "The official ACL style files (acl.sty, acl_natbib.bst) and the example paper from the ACL organisation's repository, shared by every ACL venue.", site: "https://github.com/acl-org/acl-style-files", main: "main.tex", kit: "raw.githubusercontent.com", cached: false, notes: [] },
    { id: "plos", label: "PLOS", venue: "PLOS ONE, PLOS Biology, PLOS Computational Biology and the other PLOS journals", group: "biology", engine: "latex", official: true, featured: true, version: "2025-08", summary: "The official PLOS LaTeX template and plos2025 bibliography style, shared by every PLOS journal.", site: "https://journals.plos.org/plosone/s/latex", main: "main.tex", kit: "journals.plos.org", cached: false, notes: ["the template's ligature switch is pdfTeX-only and stops the bundled engine"] },
    { id: "frontiers", label: "Frontiers", venue: "Frontiers journals (Harvard and Vancouver reference styles)", group: "biology", engine: "latex", official: true, featured: false, version: "2025-04", summary: "The official Frontiers kit: FrontiersinHarvard and FrontiersinVancouver classes, both bibliography styles and the supplementary-material template.", site: "https://www.frontiersin.org/about/author-guidelines", main: "main.tex", kit: "www.frontiersin.org", cached: false, notes: ["the class embeds its logo as EPS, which the bundled engine cannot read; the kit ships the same logo as PDF"] },
    { id: "springer-nature", label: "Springer Nature", venue: "Springer, BMC and Nature Portfolio journals", group: "publishers", engine: "latex", official: true, featured: true, version: "2024-12", summary: "The official sn-jnl.cls (December 2024) with all eight reference styles and the sample article.", site: "https://www.springernature.com/gp/authors/campaigns/latex-author-support", main: "main.tex", kit: "cms-resources.apps.public.k8s.springernature.io", cached: false, notes: ["EPS figures cannot be embedded by the bundled engine"] },
    { id: "ieee-journal", label: "IEEE Transactions", venue: "IEEE journals and transactions", group: "publishers", engine: "latex", official: false, featured: true, version: null, summary: "A short paper on IEEEtran in journal mode, fetched from CTAN by the engine on first compile.", site: "https://ctan.org/pkg/ieeetran", main: "main.tex", kit: null, cached: true, notes: [] },
    { id: "siam", label: "SIAM journals", venue: "Society for Industrial and Applied Mathematics", group: "math", engine: "latex", official: true, featured: true, version: "251216", summary: "The official siamart251216.cls, siamplain.bst and the example article with its shared front matter.", site: "https://epubs.siam.org/journal-authors", main: "main.tex", kit: "epubs.siam.org", cached: false, notes: ["the SIAM class only compiles under pdfLaTeX or dvips without this prelude", "EPS figures cannot be embedded by the bundled engine"] },
    { id: "article", label: "Plain article", venue: "Preprints, notes and drafts", group: "general", engine: "latex", official: false, featured: true, version: null, summary: "The standard article class with the usual packages and a numbered bibliography. Nothing to fetch.", site: null, main: "main.tex", kit: null, cached: true, notes: [] },
    { id: "typst-ieee", label: "IEEE (Typst)", venue: "IEEE-style conference and journal papers", group: "typst", engine: "typst", official: false, featured: false, version: null, summary: "The charged-ieee template from Typst Universe (MIT-0).", site: "https://typst.app/universe/package/charged-ieee", main: "main.typ", kit: null, cached: true, notes: [] },
  ],
};
/** The bundled sample paper, copied under Documents/Dabir the first time (or reopened), for the guided tour. */
export async function openSample(): Promise<string> {
  if (!native) return SAMPLE_PROJECT.root;
  return invoke<string>("open_sample", { parent: null });
}
export async function openGuide(): Promise<void> {
  const url = "https://github.com/surenalab/dabir/blob/main/docs/GUIDE.md";
  if (!native) { window.open(url, "_blank"); return; }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
export async function templatesList(): Promise<TemplateListing> {
  if (!native) return SAMPLE_TEMPLATES;
  return invoke<TemplateListing>("templates_list");
}
export async function newPaper(parent: string, name: string, template: string): Promise<string> {
  if (!native) {
    const say = (message: string) => templateHandlers.forEach((h) => h({ template, message }));
    await wait(300); say("Fetching the official kit from media.neurips.cc…");
    await wait(900); say("Unpacking the kit…");
    await wait(300); say("Laying out the paper…");
    await wait(300); say("Initialising Git and the memory scaffold…");
    await wait(300);
    return SAMPLE_PROJECT.root;
  }
  return invoke<string>("new_paper", { parent, name, template });
}
// ---------------------------------------------------------------- export

export type ExportKind = "pdf" | "arxiv" | "source" | "docx" | "html" | "md";
export interface ExportReport { path: string; files: number; bytes: number; notes: string[] }
export async function exportTools(): Promise<{ pandoc: string | null }> {
  if (!native) return { pandoc: null };
  return invoke("export_tools");
}
export async function exportPaper(root: string, main: string, dest: string, kind: ExportKind): Promise<ExportReport> {
  if (!native) {
    await wait(700);
    if (kind === "docx" || kind === "html" || kind === "md") throw new Error("pandoc is not installed. Install it with `brew install pandoc` (or from pandoc.org), then export again.");
    return { path: dest, files: kind === "pdf" ? 1 : 14, bytes: kind === "pdf" ? 412_000 : 2_300_000, notes: kind === "arxiv" ? ["3 files under code/ left out; arXiv only needs what compiles."] : [] };
  }
  return invoke("export_paper", { root, main, dest, kind });
}

export interface TemplateProgress { template: string; message: string }
let templateHandlers: ((p: TemplateProgress) => void)[] = [];
export function onTemplateProgress(handler: (p: TemplateProgress) => void): () => void {
  if (!native) { templateHandlers.push(handler); return () => { templateHandlers = templateHandlers.filter((h) => h !== handler); }; }
  let un: (() => void) | undefined;
  listen<TemplateProgress>("template-progress", (e) => handler(e.payload)).then((u) => { un = u; });
  return () => un?.();
}
export async function bibImportFile(root: string): Promise<string | null> {
  if (!native) { await wait(300); return "Added 3 new entries to refs.bib."; }
  const picked = await openDialog({ multiple: false, title: "Import references", filters: [{ name: "BibTeX", extensions: ["bib"] }] });
  if (typeof picked !== "string") return null;
  return invoke<string>("bib_import_file", { root, path: picked });
}
export async function zoteroImport(root: string): Promise<string> {
  if (!native) { await wait(300); return "Imported 5 new entries from Zotero into refs.bib."; }
  return invoke<string>("zotero_import", { root });
}

// ---------------------------------------------------------------- reference sync

export interface ZoteroCollection { key: string; name: string; parent: string | null }
export interface ZoteroStatus { reachable: boolean; betterBibtex: boolean; collections: ZoteroCollection[] }
export interface SyncReport { file: string; added: number; updated: number; total: number; keys: string[] }
export interface LinkedSync { mtime: number; report: SyncReport | null }
let sampleLinkedTick = 0;
export async function zoteroStatus(): Promise<ZoteroStatus> {
  if (!native) { await wait(400); return { reachable: true, betterBibtex: true, collections: [{ key: "C1", name: "Thesis", parent: null }, { key: "C2", name: "Thesis / Diffusion", parent: "C1" }, { key: "C3", name: "Reading", parent: null }] }; }
  return invoke<ZoteroStatus>("zotero_status");
}
export async function zoteroSync(root: string, collection: string | null, betterBibtex: boolean): Promise<SyncReport> {
  if (!native) { await wait(900); return { file: "refs.bib", added: 3, updated: 1, total: 42, keys: ["ho2020ddpm", "song2021score", "chung2023dps", "kingma2014adam"] }; }
  return invoke<SyncReport>("zotero_sync", { root, collection, betterBibtex });
}
export async function refsAdd(root: string, id: string): Promise<SyncReport> {
  if (!native) { await wait(700); if (!/^(10\.|arxiv|\d{4}\.\d{4,5})/i.test(id.trim())) throw new Error("Enter a DOI (10.xxxx/…) or an arXiv id (2301.00001)."); return { file: "refs.bib", added: 1, updated: 0, total: 43, keys: ["vaswani2017attention"] }; }
  return invoke<SyncReport>("refs_add", { root, id });
}
export async function refsLinkedSync(root: string, path: string, since: number): Promise<LinkedSync> {
  if (!native) { sampleLinkedTick += 1; return sampleLinkedTick === 1 ? { mtime: Date.now(), report: { file: "refs.bib", added: 2, updated: 0, total: 44, keys: ["a", "b"] } } : { mtime: since, report: null }; }
  return invoke<LinkedSync>("refs_linked_sync", { root, path, since });
}
/** Choose a .bib another reference manager keeps up to date; null when cancelled. */
export async function pickBibFile(title = "Link a BibTeX file"): Promise<string | null> {
  if (!native) { await wait(200); return "/Users/ada/Library/Application Support/Mendeley Desktop/library.bib"; }
  const picked = await openDialog({ multiple: false, title, filters: [{ name: "BibTeX", extensions: ["bib"] }] });
  return typeof picked === "string" ? picked : null;
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
  isRepo: true, branch: "main", remote: "git@github.com:vantreight/score-anchor.git",
  changes: [
    { path: "figures/psnr-vs-noise.pdf", status: "modified", add: 0, del: 0, binary: true },
    { path: "main.tex", status: "modified", add: 6, del: 4, binary: false },
  ],
  recent: [
    { id: "a41b9c2", summary: "Add anchor-ratio sweep to Appendix A", author: "Aurelio", when: Date.now() / 1000 - 86400 * 2 },
    { id: "0f3e1d7", summary: "Address reviewer 2 on the anchor ratio", author: "Ilse", when: Date.now() / 1000 - 86400 * 5 },
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
    { id: "claude", label: "Claude Code", hint: "", bin: "claude", installed: true, path: "/usr/local/bin/claude" },
    { id: "codex", label: "Codex", hint: "", bin: "codex", installed: false, path: null },
    { id: "cursor", label: "Cursor", hint: "", bin: "cursor-agent", installed: true, path: "~/.local/bin/cursor-agent" },
    { id: "grok", label: "Grok", hint: "", bin: "grok", installed: false, path: null },
    { id: "opencode", label: "OpenCode", hint: "", bin: "opencode", installed: false, path: null },
  ];
  return invoke<Provider[]>("agent_providers");
}

let sampleRunHandlers: ((e: AgentEvent) => void)[] = [];
// Line numbers match src/lib/sample.ts, so the review preview shows the marks on the real text.
const SAMPLE_PATCH = `diff --git a/tables/psnr-sweep.tex b/tables/psnr-sweep.tex\n--- a/tables/psnr-sweep.tex\n+++ b/tables/psnr-sweep.tex\n@@ -8,3 +8,5 @@\n 0.2 & 28.9 & 28.1 & 30.7 \\\\\n+0.25 & 27.0 & 26.2 & 28.9 \\\\\n+0.3 & 25.4 & 24.6 & 27.2 \\\\\n \\bottomrule\ndiff --git a/main.tex b/main.tex\n--- a/main.tex\n+++ b/main.tex\n@@ -33,1 +33,1 @@\n-We plug $\\tilde{g}_t$ into a standard predictor--corrector sampler. Figure~\\ref{fig:psnr} reports PSNR against noise level for three baselines; anchoring holds a 1.8 dB margin up to $\\sigma = 0.3$.\n+We plug $\\tilde{g}_t$ into a standard predictor--corrector sampler. Figure~\\ref{fig:psnr} reports PSNR against noise level for three baselines; anchoring holds a 1.8 dB margin up to $\\sigma = 0.3$ (Table~\\ref{tab:psnr}).\n@@ -44,1 +44,2 @@\n \\input{tables/psnr-sweep}\n+The sweep in Table~\\ref{tab:psnr} now extends to $\\sigma = 0.3$.\n`;

export interface ModelChoice { id: string; label: string }
export interface ModelOptions { models: ModelChoice[]; efforts: string[]; defaultModel: string | null; custom: boolean }
/** Models and effort levels a provider's CLI accepts; asks the CLI where it can list them. */
export async function agentModels(provider: string): Promise<ModelOptions> {
  if (!native) {
    await wait(200);
    if (provider === "claude") return { models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }, { id: "haiku", label: "Haiku" }], efforts: ["low", "medium", "high", "xhigh", "max"], defaultModel: null, custom: true };
    if (provider === "cursor") return { models: [{ id: "composer-2.5", label: "Composer 2.5" }, { id: "claude-opus-5-thinking-high", label: "Claude Opus 5 Thinking" }, { id: "gpt-5.6-sol-high", label: "GPT-5.6 Sol High" }], efforts: [], defaultModel: "auto", custom: true };
    return { models: [], efforts: ["low", "medium", "high", "xhigh"], defaultModel: null, custom: true };
  }
  return invoke<ModelOptions>("agent_models", { provider });
}

/** One sentence to continue the prose at the cursor, from the chosen agent. Nothing is written to the checkout. */
export async function agentComplete(root: string, provider: string, file: string, context: string, model = "", effort = ""): Promise<string> {
  if (!native) { await wait(900); return "The anchor keeps every guided step inside the region where the prior score is still trustworthy, so the sampler cannot be pulled off the data manifold."; }
  return invoke<string>("agent_complete", { root, provider, file, context, model: model || null, effort: effort || null });
}

/** A follow-up continues the run under review in its own worktree, on top of the changes it made. */
export interface FollowUp { runId: string; prompt: string; reply: string }
/** Where the author is in the editor when asking: file, cursor line, selection. "This paragraph" resolves against it. */
export interface Focus { file: string; line: number; endLine?: number; selection?: string }
export async function agentRun(root: string, provider: string, prompt: string, model = "", effort = "", followUp: FollowUp | null = null, focus: Focus | null = null): Promise<{ runId: string; worktree: string }> {
  if (!native) {
    const runId = followUp?.runId ?? Math.random().toString(16).slice(2, 10);
    (async () => {
      const send = (e: Omit<AgentEvent, "runId">) => sampleRunHandlers.forEach((h) => h({ runId, ...e }));
      await wait(300); send({ kind: "thinking", text: "The sweep script writes both the figure and the table; rerunning it with a finer grid changes the margin claim in the sampler section too.", tool: null, ok: null });
      await wait(400); send({ kind: "tool", tool: "Read", text: `${root}/.dabir/worktrees/${runId}/.dabir/PROJECT.md`, ok: null });
      await wait(200); send({ kind: "tool", tool: "Read", text: `${root}/.dabir/worktrees/${runId}/main.tex`, ok: null });
      await wait(200); send({ kind: "tool", tool: "Read", text: `${root}/.dabir/worktrees/${runId}/code/sweep.py`, ok: null });
      await wait(200); send({ kind: "tool", tool: "Read", text: `${root}/.dabir/worktrees/${runId}/tables/psnr-sweep.tex`, ok: null });
      await wait(700); send({ kind: "tool", tool: "Bash", text: "python code/sweep.py --sigma 0.3", ok: null });
      await wait(1200); send({ kind: "tool", tool: "Edit", text: `${root}/.dabir/worktrees/${runId}/main.tex`, ok: null });
      await wait(400); send({ kind: "tool", tool: "Bash", text: "tectonic -X compile --keep-logs --synctex --outdir .dabir/build main.tex", ok: null });
      await wait(600); send({ kind: "text", text: "Reran the sweep to σ = 0.3 and updated the paper.\n\n- `code/sweep.py` now covers σ ∈ {0.25, 0.3}; the figure and **Table 1** were regenerated.\n- The margin claim in §2.3 now reads 1.8 dB up to σ = 0.3 and points at the table.\n\nThe paper compiles cleanly.", tool: null, ok: null });
      await wait(300); send({ kind: "done", text: "", tool: null, ok: true });
    })();
    return { runId, worktree: `${root}/.dabir/worktrees/${runId}` };
  }
  return invoke("agent_run", { root, provider, prompt, model: model || null, effort: effort || null, followUp, focus });
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
    patch: SAMPLE_PATCH,
  };
  return invoke<WorktreeDiff>("agent_diff", { root, runId });
}
export interface Pick { path: string; hunks: number[] | null }
export async function agentAccept(root: string, runId: string, message: string, picks: Pick[] | undefined, provider: string, prompt: string, reply = ""): Promise<string> {
  if (!native) { await wait(400); return "c1d2e3f"; }
  return invoke<string>("agent_accept", { root, runId, message, picks: picks ?? null, provider, prompt, reply: reply || null });
}
export async function contextPack(root: string, query: string): Promise<string> {
  if (!native) return "main.tex:38-52\n\\subsection{Guided sampling}\n…";
  return invoke<string>("context_pack", { root, query });
}
export async function compileCancel(): Promise<boolean> { return native ? invoke<boolean>("compile_cancel") : true; }
/** Discard a run. The request and the agent's report are still logged as rejected, so the next run knows. */
export async function agentReject(root: string, runId: string, provider = "", prompt = "", reply = ""): Promise<void> { if (native) await invoke("agent_reject", { root, runId, provider: provider || null, prompt: prompt || null, reply: reply || null }); }
/** Accept without committing: the changes land in the checkout and a snapshot is taken. */
export async function agentApply(root: string, runId: string, picks: Pick[] | undefined, prompt: string, provider: string, reply = ""): Promise<string[]> {
  if (!native) { await wait(300); return ["main.tex"]; }
  return invoke<string[]>("agent_apply", { root, runId, picks: picks ?? null, prompt, provider, reply: reply || null });
}
/** One step of the paper's history: a snapshot of the working tree and what it changed against the step before. */
export interface Checkpoint { id: string; message: string; at: number; files: Change[] }
const now = Math.floor(Date.now() / 1000);
const SAMPLE_HISTORY: Checkpoint[] = [
  { id: "9c1e4d2", message: "Grok: add a figure", at: now - 420, files: [{ path: "main.tex", status: "modified", add: 14, del: 2, binary: false }] },
  { id: "7b02a51", message: "You edited main.tex", at: now - 1500, files: [{ path: "main.tex", status: "modified", add: 3, del: 1, binary: false }] },
  { id: "5d7f9e0", message: "Claude Code: Rerun the noise sweep to σ = 0.3 and update Table 1", at: now - 5400, files: [{ path: "tables/psnr-sweep.tex", status: "modified", add: 2, del: 0, binary: false }, { path: "main.tex", status: "modified", add: 2, del: 1, binary: false }, { path: "figures/psnr-vs-noise.pdf", status: "modified", add: 0, del: 0, binary: true }] },
  { id: "31a8c77", message: "You edited refs.bib", at: now - 86400 - 600, files: [{ path: "refs.bib", status: "modified", add: 6, del: 0, binary: false }] },
];
/** Snapshot the working tree; `coalesce` folds a repeat of the newest message within a few minutes into it. */
export async function checkpoint(root: string, message: string, coalesce = false): Promise<string | null> { return native ? invoke<string | null>("checkpoint", { root, message, coalesce }) : null; }
export async function checkpoints(root: string): Promise<Checkpoint[]> { return native ? invoke<Checkpoint[]>("checkpoints", { root }) : SAMPLE_HISTORY; }
export async function checkpointPatch(root: string, id: string): Promise<string> { if (!native) { await wait(150); return SAMPLE_PATCH; } return invoke<string>("checkpoint_patch", { root, id }); }
/** Put the paper back as it was at this step. The current state is snapshotted first. */
export async function checkpointRestore(root: string, id: string): Promise<void> { if (native) await invoke("checkpoint_restore", { root, id }); }
/** Take this one step out, leaving later edits in place; fails when they overlap. */
export async function checkpointUndo(root: string, id: string): Promise<void> { if (native) await invoke("checkpoint_undo", { root, id }); }
/** Put one file back to its committed state (or delete it when untracked). Snapshotted first. */
export async function gitDiscard(root: string, path: string): Promise<void> { if (native) await invoke("git_discard", { root, path }); }
export async function agentPullRequest(root: string, runId: string, message: string): Promise<string> {
  if (!native) { await wait(400); return "https://github.com/vantreight/score-anchor/pull/12"; }
  return invoke<string>("agent_pull_request", { root, runId, message });
}

// ---------------------------------------------------------------- memory

export async function memoryRead(root: string): Promise<Memory> {
  if (!native) return {
    brief: "# Score Anchoring…\n\n## Identity\nDiffusion posterior sampling drifts when the guidance gradient and the learned score disagree…", briefPath: `${root}/.dabir/PROJECT.md`,
    identity: "Diffusion posterior sampling drifts when the guidance gradient and the learned score disagree at low noise levels.", envPrefix: "",
    skills: ["rerun-experiment", "update-figure-and-text", "address-reviewer", "tighten-prose", "check-references", "compile-and-fix"].map((n) => ({ name: `dabir-${n}`, description: "", path: `${root}/.dabir/skills/${n}/SKILL.md` })),
    runs: ["2026-09-08 · grok · Rerun the noise sweep to σ = 0.3 · figures/psnr-vs-noise.pdf, tables/psnr-sweep.tex, main.tex"],
    facts: [{ name: "reviewer-2-anchor-ratio", description: "Reviewer 2 asked how sensitive results are to the anchor ratio; addressed with a sweep in Appendix A", body: "", path: `${root}/.dabir/memory/reviewer-2-anchor-ratio.md` }],
    provenance: [
      { artefact: "figures/psnr-vs-noise.pdf", command: "python3 code/sweep.py --sigma 0.3", inputs: ["code/sweep.py"], producedAt: "2026-09-05", commit: "a41b9c2", dataHash: null, stale: false, missing: false },
      { artefact: "tables/psnr-sweep.tex", command: "python3 code/sweep.py --sigma 0.3", inputs: ["code/sweep.py"], producedAt: "2026-09-05", commit: "a41b9c2", dataHash: null, stale: true, missing: false },
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

// ---- terminal pane: a shell in the paper's folder

/** Start a shell in `cwd`; output arrives through `onTerminalData`. Null in the browser preview. */
export async function termOpen(cwd: string, cols: number, rows: number, remote: Remote | null = null): Promise<number | null> {
  if (!native) return null;
  return invoke<number>("term_open", { cwd, cols, rows, remote });
}
export async function termWrite(id: number, data: string): Promise<void> {
  if (!native) return;
  await invoke("term_write", { id, data });
}
export async function termResize(id: number, cols: number, rows: number): Promise<void> {
  if (!native) return;
  await invoke("term_resize", { id, cols, rows }).catch(() => {});
}
export async function termClose(id: number): Promise<void> {
  if (!native) return;
  await invoke("term_close", { id }).catch(() => {});
}
export function onTerminalData(handler: (e: { id: number; data: string }) => void): () => void {
  if (!native) return () => {};
  let un: (() => void) | null = null;
  listen<{ id: number; data: string }>("term-data", (e) => handler(e.payload)).then((u) => { un = u; });
  return () => { un?.(); };
}
export function onTerminalExit(handler: (e: { id: number; code: number | null }) => void): () => void {
  if (!native) return () => {};
  let un: (() => void) | null = null;
  listen<{ id: number; code: number | null }>("term-exit", (e) => handler(e.payload)).then((u) => { un = u; });
  return () => { un?.(); };
}

// ---- language servers for code files

export async function lspAvailable(candidates: string[]): Promise<string[]> {
  if (!native) return [];
  return invoke<string[]>("lsp_available", { candidates }).catch(() => []);
}
export interface Filtered { code: number; stdout: string; stderr: string }
/** Run a formatter or any filter over text in `cwd`: stdin in, stdout out. Rejects when the command cannot start. */
export async function runFilter(command: string, args: string[], cwd: string, input: string): Promise<Filtered> {
  if (!native) throw new Error("Formatters run in the app; the browser preview has none.");
  return invoke<Filtered>("run_filter", { command, args, cwd, input });
}
/** The file as HEAD has it (path relative to root); null when new, binary or not under Git. */
const SAMPLE_HEAD: Record<string, string> = {};
export async function gitHeadText(root: string, path: string): Promise<string | null> {
  // The browser sample's "HEAD" is the file as shipped, so edits in the preview light the change gutter.
  if (!native) { const k = `${root}/${path}`; SAMPLE_HEAD[k] ??= SAMPLE_FILES[k] ?? ""; return SAMPLE_HEAD[k] || null; }
  return invoke<string | null>("git_head_text", { root, path }).catch(() => null);
}
export async function lspProbe(command: string, args: string[]): Promise<boolean> {
  if (!native) return false;
  return invoke<boolean>("lsp_probe", { command, args }).catch(() => false);
}
export async function lspStart(root: string, command: string, args: string[]): Promise<number | null> {
  if (!native) return null;
  return invoke<number>("lsp_start", { root, command, args }).catch(() => null);
}
export async function lspSend(id: number, message: string): Promise<void> {
  if (!native) return;
  await invoke("lsp_send", { id, message }).catch(() => {});
}
export async function lspStop(id: number): Promise<void> {
  if (!native) return;
  await invoke("lsp_stop", { id }).catch(() => {});
}
export function onLspMessage(handler: (e: { id: number; message: string }) => void): () => void {
  if (!native) return () => {};
  let un: (() => void) | null = null;
  listen<{ id: number; message: string }>("lsp-message", (e) => handler(e.payload)).then((u) => { un = u; });
  return () => { un?.(); };
}
export function onLspExit(handler: (e: { id: number }) => void): () => void {
  if (!native) return () => {};
  let un: (() => void) | null = null;
  listen<{ id: number }>("lsp-exit", (e) => handler(e.payload)).then((u) => { un = u; });
  return () => { un?.(); };
}

// ---- find in paper

export interface SearchHit { file: string; line: number; col: number; len: number; text: string; cut: boolean }
/** Every text file of the paper that contains `query` (smart case), at most 400 lines. Empty in the browser preview. */
export async function searchPaper(root: string, query: string): Promise<SearchHit[]> {
  if (!native) return [];
  return invoke<SearchHit[]>("search_paper", { root, query }).catch(() => []);
}
