// Thin wrapper over the Rust core. Falls back to a bundled sample when the UI
// runs in a plain browser (vite dev without Tauri), so the shell stays
// previewable and screenshot-able.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { SAMPLE_FILES, SAMPLE_PROJECT, SAMPLE_WORD_ROOT, sampleWordProject } from "./sample";
import { looksLikeDocx } from "./word";
import { applyPatch } from "./review";

export type EntryKind = "dir" | "tex" | "bib" | "code" | "figure" | "data" | "word" | "other";
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

export interface Provider { id: string; label: string; hint: string; bin: string; installed: boolean; path: string | null; install: string; login: string; plan: string }
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

/** Browser preview: `?docx=name.docx` puts another document from DABIR_SAMPLE_DOCX_DIR in the Word paper. */
const previewDocx = () => { try { return new URLSearchParams(location.search).get("docx"); } catch { return null; } };
/** Open a folder as a paper. `main` names the manuscript when the author chose it (a Word document opened on its own). */
export async function openProject(path: string, main: string | null = null): Promise<Project> {
  if (!native) return path === SAMPLE_WORD_ROOT ? sampleWordProject(previewDocx() || undefined) : SAMPLE_PROJECT;
  return invoke<Project>("open_project", { path, main });
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

/** Browser preview only: binary files written this session, by path. */
const PREVIEW_BINARY = new Map<string, Uint8Array>();
/** `npm run dev` only: where the preview's compile says its PDF is. vite.config.ts serves that file at /__sample.pdf. */
const DEV_PDF = "/.dabir/build/main.pdf";
async function devBytes(url: string): Promise<Uint8Array> {
  try { const r = await fetch(url); return r.ok ? new Uint8Array(await r.arrayBuffer()) : new Uint8Array(); } catch { return new Uint8Array(); }
}
async function previewBinary(path: string): Promise<Uint8Array> {
  const kept = PREVIEW_BINARY.get(path);
  if (kept) return kept.slice();
  // Everything below is served by `npm run dev` alone, and the guard drops it from a production build.
  if (!import.meta.env.DEV) return new Uint8Array();
  // The preview compile's PDF (vite.config.ts), and the sample Word paper's documents (scripts/vite-word-preview.mjs).
  if (path.endsWith(DEV_PDF)) return devBytes("/__sample.pdf");
  if (path.startsWith(`${SAMPLE_WORD_ROOT}/`)) return devBytes(`/__dabir/word?name=${encodeURIComponent(path.split("/").pop() ?? "")}`);
  return new Uint8Array();
}

export async function readBinary(path: string): Promise<Uint8Array> {
  if (!native) return previewBinary(path);
  const bytes = await invoke<ArrayBuffer | number[]>("read_binary", { path });
  return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : Uint8Array.from(bytes);
}

/** Replace a binary file in one step (a temporary file beside it, then a rename), so a crash never leaves half a
 *  document. A .docx must be a zip; anything else is refused rather than written over the author's document. */
export async function writeBinary(path: string, bytes: Uint8Array): Promise<void> {
  if (/\.docx$/i.test(path) && !looksLikeDocx(bytes)) throw new Error(`Refused to save ${path.split(/[\\/]/).pop()}: the editor produced something that is not a Word document.`);
  if (!native) {
    PREVIEW_BINARY.set(path, bytes.slice());
    PREVIEW_WRITES.push({ path: path.split("/").slice(-2).join("/"), head: `${bytes.length} bytes` });
    (window as unknown as { __writes?: unknown }).__writes = PREVIEW_WRITES;
    // `npm run dev`: keep a copy under the system temp folder so a round trip can be checked outside the browser.
    if (import.meta.env.DEV) fetch(`/__dabir/word-saved?name=${encodeURIComponent(path.split("/").pop() ?? "")}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes.slice() }).catch(() => {});
    return;
  }
  // A raw body reaches the command without a JSON array of numbers; the path travels in a header.
  return invoke("write_binary", bytes, { headers: { "x-dabir-path": encodeURIComponent(path) } });
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
    // The dev server has a real PDF to show (see previewBinary); a production preview does not.
    return { ok: true, pdf: import.meta.env.DEV ? mainTex.replace(/\/[^/]*$/, DEV_PDF) : null, engine: "sample", millis: 900, log: "(browser preview: no TeX engine available)",
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
  id: string; label: string; venue: string; group: string; engine: "latex" | "typst" | "word";
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
const WORD_TEMPLATE_VENUE = "A research article as a Word document, for journals and coauthors that work in .docx";
const WORD_TEMPLATE_SUMMARY = "Title, authors and affiliations, abstract and keywords, IMRaD headings, captions and a reference list, on Word's own styles so a journal's template can restyle it. Opens in Dabir's Word editor with nothing to compile, and stays a .docx for coauthors in Word.";
const SAMPLE_TEMPLATES: TemplateListing = {
  groups: [{ id: "ml", label: "Machine learning" }, { id: "vision", label: "Vision and graphics" }, { id: "nlp", label: "Language" }, { id: "publishers", label: "Journals and publishers" }, { id: "biology", label: "Biology and medicine" }, { id: "math", label: "Mathematics" }, { id: "general", label: "General" }, { id: "typst", label: "Typst" }, { id: "word", label: "Word documents" }],
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
    { id: "word-manuscript", label: "Word document", venue: WORD_TEMPLATE_VENUE, group: "word", engine: "word", official: false, featured: true, version: null, summary: WORD_TEMPLATE_SUMMARY, site: null, main: "manuscript.docx", kit: null, cached: true, notes: [] },
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
/** Open a URL in the user's own app for it: mailto: in Mail, sms: in Messages, https: in the browser. */
export async function openExternal(url: string): Promise<void> {
  if (!native) { window.open(url, "_blank"); return; }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
/** dabir:// links: the one the app was launched with, then every one opened while it runs. */
export async function onDeepLink(handler: (urls: string[]) => void): Promise<() => void> {
  if (!native) return () => {};
  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  try { const first = await getCurrent(); if (first?.length) handler(first); } catch { /* not launched by a link */ }
  return onOpenUrl(handler);
}
export async function templatesList(): Promise<TemplateListing> {
  if (!native) return SAMPLE_TEMPLATES;
  return invoke<TemplateListing>("templates_list");
}
export async function newPaper(parent: string, name: string, template: string): Promise<string> {
  if (!native) {
    const say = (message: string) => templateHandlers.forEach((h) => h({ template, message }));
    if (template === "word-manuscript") { await wait(300); say("Laying out the paper…"); await wait(300); say("Initialising Git and the memory scaffold…"); await wait(300); return SAMPLE_WORD_ROOT; }
    await wait(300); say("Fetching the official kit from media.neurips.cc…");
    await wait(900); say("Unpacking the kit…");
    await wait(300); say("Laying out the paper…");
    await wait(300); say("Initialising Git and the memory scaffold…");
    await wait(300);
    return SAMPLE_PROJECT.root;
  }
  return invoke<string>("new_paper", { parent, name, template });
}
// ---------------------------------------------------------------- Word import

/** What a Word import converted, and what to check against the Word file. */
export interface WordImport {
  path: string; main: string; source: string; title: string;
  /** One sentence: what was converted. */
  summary: string;
  sections: number; figures: number; tables: number; equations: number; inlineMath: number;
  citations: number; references: number; footnotes: number;
  /** What to check, most important first. */
  notes: string[];
  pandoc: string;
}
/** The .docx to import; null when the panel is cancelled. */
export async function pickWordDocument(): Promise<string | null> {
  if (!native) return "/Users/ada/Downloads/Draft from Maryam.docx";
  const picked = await openDialog({ multiple: false, title: "Import Word Document", filters: [{ name: "Word document", extensions: ["docx"] }] });
  return typeof picked === "string" ? picked : null;
}
/** Convert `docx` into a new paper at `parent/name` (new or empty), set up with Git and the memory scaffold. */
export async function importWord(docx: string, parent: string, name: string): Promise<WordImport> {
  if (!native) {
    await wait(1100);
    return {
      path: SAMPLE_PROJECT.root, main: `${SAMPLE_PROJECT.root}/main.tex`, source: docx.split(/[\\/]/).pop() ?? docx,
      title: "Score Anchors for Low-Dose CT",
      summary: "Converted 6 sections, 2 figures, 1 table, 4 equations, 11 inline formulas, 14 citations and 2 footnotes from Draft from Maryam.docx.",
      sections: 6, figures: 2, tables: 1, equations: 4, inlineMath: 11, citations: 14, references: 12, footnotes: 2,
      notes: [
        "9 tracked changes were accepted, as in Word's No Markup view; the .docx still has them.",
        "3 comments were left out; they stay in the .docx.",
        "14 citations from Zotero became \\cite commands, with 12 entries in refs.bib listed by \\bibliographystyle{plain}.",
        "Figures are in figures/ at the width they had on the Word page; LaTeX places captioned ones where they fit.",
        "Compare the equations with the Word file; displayed ones are equation*, since Word numbers none of its own. Change one to equation where you want LaTeX to number it.",
      ],
      pandoc: "pandoc 3.11",
    };
  }
  return invoke<WordImport>("import_word", { docx, parent, name });
}

// ---------------------------------------------------------------- Word documents

/** File › Open Word Document…: a .docx anywhere; its folder opens with it as the paper. Null when cancelled. */
export async function pickWordToOpen(): Promise<string | null> {
  if (!native) return `${SAMPLE_WORD_ROOT}/manuscript.docx`;
  const picked = await openDialog({ multiple: false, title: "Open Word Document", filters: [{ name: "Word document", extensions: ["docx"] }] });
  return typeof picked === "string" ? picked : null;
}
/** The document as Markdown (headings, lists, tables, footnotes; insertions kept, deletions left out), read from disk. */
export async function wordMarkdown(path: string): Promise<string> {
  if (!native) {
    await wait(200);
    return "# Willow buffers remove more nitrate than grass strips in lowland streams\n\nAda Lindqvist, Maryam Karimi, Tomás Ferreira\n\n## Introduction\n\nNitrate leaching from arable land is the main cause of nutrient enrichment in lowland streams.\n";
  }
  return invoke<string>("word_markdown", { path });
}
/** Git's user.name for the paper (then the global one): the author a Word document's changes carry when Dabir has no name on record. */
export async function authorName(root: string): Promise<string | null> {
  if (!native) return "Ada Lindqvist";
  try { return await invoke<string | null>("author_name", { root }); } catch { return null; }
}
/** Print the window through the system panel (its PDF button saves a PDF); the Word view shows only its pages while printing. */
export async function printWindow(): Promise<void> {
  if (!native) { window.print(); return; }
  await invoke("print_window");
}

// ---------------------------------------------------------------- export

export type ExportKind = "pdf" | "arxiv" | "source" | "docx" | "html" | "md";
export interface ExportReport { path: string; files: number; bytes: number; notes: string[] }
export async function exportTools(): Promise<{ pandoc: string | null }> {
  // Browser preview: ?pandoc=1 shows the sheets as they are with pandoc installed, for screenshots.
  if (!native) return { pandoc: new URLSearchParams(location.search).get("pandoc") === "1" ? "pandoc 3.11" : null };
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

const SAMPLE_WORD_GIT: GitStatus = {
  isRepo: true, branch: "main", remote: null,
  changes: [
    { path: "manuscript.docx", status: "modified", add: 0, del: 0, binary: true },
    { path: "code/removal.R", status: "modified", add: 2, del: 1, binary: false },
  ],
  recent: [{ id: "1f7e6a0", summary: "New paper from Word document template", author: "Ada", when: Date.now() / 1000 - 86400 * 2 }],
};

export async function gitStatus(root: string): Promise<GitStatus> {
  if (!native) return root === SAMPLE_WORD_ROOT ? SAMPLE_WORD_GIT : SAMPLE_GIT;
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
  if (!native) return SAMPLE_PROVIDERS;
  return invoke<Provider[]>("agent_providers");
}

const SAMPLE_PROVIDERS: Provider[] = [
  { id: "claude", label: "Claude Code", hint: "", bin: "claude", installed: true, path: "/usr/local/bin/claude", install: "curl -fsSL https://claude.ai/install.sh | bash", login: "claude auth login", plan: "Claude Pro, Max, Team or Enterprise, or an Anthropic Console account" },
  { id: "codex", label: "Codex", hint: "", bin: "codex", installed: false, path: null, install: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", login: "codex login", plan: "ChatGPT Plus, Pro, Business, Edu or Enterprise, or an OpenAI API key" },
  { id: "cursor", label: "Cursor", hint: "", bin: "cursor-agent", installed: true, path: "~/.local/bin/cursor-agent", install: "curl https://cursor.com/install -fsS | bash", login: "cursor-agent login", plan: "a Cursor account" },
  { id: "grok", label: "Grok", hint: "", bin: "grok", installed: false, path: null, install: "curl -fsSL https://x.ai/cli/install.sh | bash", login: "grok login", plan: "an X or xAI account" },
  { id: "opencode", label: "OpenCode", hint: "", bin: "opencode", installed: false, path: null, install: "curl -fsSL https://opencode.ai/install | bash", login: "opencode auth login", plan: "your own key for any model provider, or OpenCode Zen" },
];

/** Whether the provider's CLI has an account behind it; null when the tool cannot say without a request. */
export async function agentSignedIn(provider: string): Promise<boolean | null> {
  if (!native) return provider === "cursor" ? false : provider === "claude" ? true : null;
  return invoke<boolean | null>("agent_signed_in", { provider });
}

// ---- Setup: what this machine has, and the two things Dabir installs itself ----
export interface SetupEngine { path: string | null; version: string | null; managed: boolean }
export interface SetupStatus {
  latex: SetupEngine; latexReady: boolean;
  /** The bundled engine does not start here (a glibc too old for the binary, a missing library); never Ready while set. */
  latexError: string | null; latexCacheMb: number;
  typst: SetupEngine; typstSizeMb: number;
  agents: (Provider & { signedIn: boolean | null })[]; pandoc: string | null; pandocInstall: string | null; gh: string | null; git: string | null; gitInstall: string | null; home: string; platform: string;
}
export interface SetupProgress { task: string; message: string; fraction: number | null; done: boolean; ok: boolean }

export async function setupStatus(): Promise<SetupStatus> {
  if (!native) return {
    latex: { path: "/Applications/Dabir.app/Contents/MacOS/tectonic", version: "0.15.0", managed: true }, latexReady: false, latexError: null, latexCacheMb: 0,
    typst: { path: null, version: null, managed: false }, typstSizeMb: 14,
    agents: SAMPLE_PROVIDERS.map((p, i) => ({ ...p, signedIn: p.installed ? i === 0 : null })), pandoc: null, pandocInstall: "brew install pandoc", gh: "/opt/homebrew/bin/gh", git: "/usr/bin/git", gitInstall: "xcode-select --install", home: "/Users/me", platform: "macos",
  };
  return invoke<SetupStatus>("setup_status");
}
/** Compile a document that uses the common packages, so the first real compile does not wait on downloads. */
export async function setupWarmLatex(): Promise<void> {
  if (!native) { await sampleProgress("latex", ["Fetching latex.fmt", "Fetching amsmath.sty", "Fetching hyperref.sty", "Fetching tikz.sty", "Running BibTeX"], "LaTeX is ready: the packages most papers use are on this machine."); return; }
  await invoke("setup_warm_latex");
}
/** Download Typst for this machine into the app's data folder. */
export async function setupInstallTypst(): Promise<string> {
  if (!native) { await sampleProgress("typst", ["Finding the latest release…", "Downloading Typst v0.15.1 · 4 of 14 MB", "Downloading Typst v0.15.1 · 11 of 14 MB", "Unpacking…"], "Typst 0.15.1 is installed."); return "/Users/me/Library/Application Support/com.surenalab.dabir/bin/typst"; }
  return invoke<string>("setup_install_typst");
}
let setupHandlers: ((p: SetupProgress) => void)[] = [];
export function onSetupProgress(handler: (p: SetupProgress) => void): () => void {
  if (!native) { setupHandlers.push(handler); return () => { setupHandlers = setupHandlers.filter((h) => h !== handler); }; }
  let un: (() => void) | null = null;
  listen<SetupProgress>("setup-progress", (e) => handler(e.payload)).then((u) => { un = u; });
  return () => { un?.(); };
}
async function sampleProgress(task: string, steps: string[], last: string) {
  for (let i = 0; i < steps.length; i++) {
    await new Promise((r) => setTimeout(r, 350));
    setupHandlers.forEach((h) => h({ task, message: steps[i], fraction: (i + 1) / (steps.length + 1), done: false, ok: true }));
  }
  await new Promise((r) => setTimeout(r, 350));
  setupHandlers.forEach((h) => h({ task, message: last, fraction: 1, done: true, ok: true }));
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
export interface Focus { file: string; line: number; endLine?: number; selection?: string; /** A Word document's paragraph at the cursor. */ paragraph?: string }
export async function agentRun(root: string, provider: string, prompt: string, model = "", effort = "", followUp: FollowUp | null = null, focus: Focus | null = null): Promise<{ runId: string; worktree: string; repoNote?: string | null }> {
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
// The Word paper's history in the preview: a Word document's step reads as a diff of its text (see git::checkpoint_patch).
const SAMPLE_WORD_HISTORY: Checkpoint[] = [
  { id: "4c1d2e8", message: "You edited manuscript.docx", at: now - 240, files: [{ path: "manuscript.docx", status: "modified", add: 2, del: 1, binary: true }] },
  { id: "9ab03f1", message: "Rscript code/removal.R", at: now - 3600 * 3, files: [{ path: "tables/removal.csv", status: "modified", add: 3, del: 3, binary: false }] },
  { id: "1f7e6a0", message: "New paper from Word document template", at: now - 86400 * 2, files: [{ path: "manuscript.docx", status: "added", add: 0, del: 0, binary: true }] },
];
const SAMPLE_WORD_PATCH = "diff --git a/manuscript.docx b/manuscript.docx\n--- a/manuscript.docx (as text)\n+++ b/manuscript.docx (as text)\n@@ -9,3 +9,3 @@\n \n-Willow buffers removed 58 % of incoming nitrate against 31 % for grass strips of the same width.\n+Willow buffers removed 58 % (95 % CI 51–64) of incoming nitrate against 31 % for grass strips of the same width.\n \n@@ -21,0 +22,2 @@\n+\n+Sites were sampled after at least three dry days.\n";
export async function checkpoint(root: string, message: string, coalesce = false): Promise<string | null> { return native ? invoke<string | null>("checkpoint", { root, message, coalesce }) : null; }
export async function checkpoints(root: string): Promise<Checkpoint[]> { return native ? invoke<Checkpoint[]>("checkpoints", { root }) : root === SAMPLE_WORD_ROOT ? SAMPLE_WORD_HISTORY : SAMPLE_HISTORY; }
export async function checkpointPatch(root: string, id: string): Promise<string> { if (!native) { await wait(150); return root === SAMPLE_WORD_ROOT ? SAMPLE_WORD_PATCH : SAMPLE_PATCH; } return invoke<string>("checkpoint_patch", { root, id }); }
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

export interface GithubPerson { login: string; role: string; pending: boolean; invitationId: number | null }
export interface GithubPeople {
  repo: string | null;
  gh: boolean;
  signedIn: boolean;
  me: string | null;
  permission: string | null;
  collaborators: GithubPerson[];
  error: string | null;
}
const SAMPLE_PEOPLE: GithubPeople = {
  repo: "ada/paper",
  gh: true,
  signedIn: true,
  me: "ada",
  permission: "admin",
  collaborators: [
    { login: "ada", role: "admin", pending: false, invitationId: null },
    { login: "bob", role: "write", pending: false, invitationId: null },
    { login: "cam", role: "write", pending: true, invitationId: 1 },
  ],
  error: null,
};
export async function githubPeople(root: string): Promise<GithubPeople> {
  if (!native) return SAMPLE_PEOPLE;
  return invoke<GithubPeople>("github_people", { root });
}
export async function githubInvite(root: string, login: string, permission: string): Promise<void> {
  if (!native) return;
  return invoke("github_invite", { root, login, permission });
}
export async function githubRemove(root: string, login: string, invitationId: number | null): Promise<void> {
  if (!native) return;
  return invoke("github_remove", { root, login, invitationId });
}

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
