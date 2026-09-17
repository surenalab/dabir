// Word documents (.docx) as first-class papers: the pure part, shared by the Word view, the app shell and
// scripts/word.test.mjs, which imports this file directly. Erasable TypeScript only (no enums, no namespaces,
// no parameter properties), so Node runs it as it is.

/** True for a Word document Dabir opens in the Word view. Word's lock file beside an open document
 *  (`~$paper.docx`) is not a document. */
export function isWordPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const name = path.split(/[\\/]/).pop() ?? "";
  return /\.docx$/i.test(name) && !name.startsWith("~$");
}

/** A .docx is a zip, so it starts with the local file header `PK\x03\x04`. Anything else never replaces a Word file. */
export function looksLikeDocx(bytes: Uint8Array | null | undefined): boolean {
  return !!bytes && bytes.length > 22 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

const CORE_NAMESPACES: Record<string, string> = {
  cp: "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
  dc: "http://purl.org/dc/elements/1.1/",
  dcterms: "http://purl.org/dc/terms/",
  dcmitype: "http://purl.org/dc/dcmitype/",
  xsi: "http://www.w3.org/2001/XMLSchema-instance",
};

/** `docProps/core.xml` with every namespace prefix it uses declared. The Word engine adds `<dcterms:modified
 *  xsi:type=…>` on save without declaring `dcterms` and `xsi` when the file did not already, which makes the part
 *  malformed and Word refuse the document; this puts the declarations on the root element. */
export function repairCoreProperties(xml: string): string {
  const root = /<cp:coreProperties\b[^>]*>/.exec(xml);
  if (!root) return xml;
  const head = root[0];
  const missing = Object.entries(CORE_NAMESPACES).filter(([p]) => new RegExp(`[<\\s/]${p}:`).test(xml) && !head.includes(`xmlns:${p}=`));
  if (!missing.length) return xml;
  const declared = head.replace(/\s*(\/?)>$/, `${missing.map(([p, uri]) => ` xmlns:${p}="${uri}"`).join("")}$1>`);
  return xml.replace(head, declared);
}

/** A paragraph start tag (`<w:p>`, `<w:p …>`, `<w:p/>`) with no `w14:paraId`: not `<w:pPr>` or `<w:pStyle>`. */
const UNNUMBERED_PARAGRAPH = /<w:p(?=[\s>/])(?![^>]*\bw14:paraId=)/g;
const W14 = "http://schemas.microsoft.com/office/word/2010/wordml";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";

/** Does a part hold paragraphs without Word's `w14:paraId`? */
export function lacksParagraphIds(xml: string): boolean {
  return new RegExp(UNNUMBERED_PARAGRAPH.source).test(xml);
}

/** The paragraph ids a part already uses. */
export function paragraphIdsIn(xml: string): string[] {
  return [...xml.matchAll(/\bw14:paraId="([0-9A-Fa-f]{1,8})"/g)].map((m) => m[1].toUpperCase().padStart(8, "0"));
}

/** Fresh paragraph ids, as Word writes them (eight hex digits below 0x80000000), none of them in `taken`. */
export function paragraphIdMaker(taken: Set<string>): () => string {
  let n = 0x10000000;
  return () => {
    let id: string;
    do { id = (n++).toString(16).toUpperCase().padStart(8, "0"); } while (taken.has(id));
    taken.add(id);
    return id;
  };
}

/** Give every paragraph of a part a `w14:paraId`, as Word does on save, and declare the namespace on the part's
 *  root (ignorable for older readers). The Word view saves a document by rewriting only the paragraphs that
 *  changed, and it finds them by these ids; a document from pandoc, Google Docs or another tool has none, and is
 *  then rewritten whole, which loses fields that span paragraphs (a Zotero bibliography). */
export function addParagraphIds(xml: string, next: () => string): string {
  if (!lacksParagraphIds(xml)) return xml;
  const numbered = xml.replace(UNNUMBERED_PARAGRAPH, () => `<w:p w14:paraId="${next()}" w14:textId="77777777"`);
  return numbered.replace(/<(w:(?:document|ftr|hdr|footnotes|endnotes|comments))\b([^>]*)>/, (_, tag: string, attrs: string) => {
    let a = attrs;
    if (!/\sxmlns:w14=/.test(a)) a += ` xmlns:w14="${W14}"`;
    if (!/\sxmlns:mc=/.test(a)) a += ` xmlns:mc="${MC}"`;
    const ignorable = /\smc:Ignorable="([^"]*)"/.exec(a);
    if (!ignorable) a += ` mc:Ignorable="w14"`;
    else if (!ignorable[1].split(/\s+/).includes("w14")) a = a.replace(ignorable[0], ` mc:Ignorable="${`${ignorable[1]} w14`.trim()}"`);
    return `<${tag}${a}>`;
  });
}

/** Editing writes straight into the document; Suggesting records every edit as a tracked change under the
 *  author's name, as Word's Track Changes does; Viewing is read-only. */
export type WordMode = "editing" | "suggesting" | "viewing";
export const WORD_MODES: { value: WordMode; label: string; title: string }[] = [
  { value: "editing", label: "Editing", title: "Edit the document directly (⌘1)" },
  { value: "suggesting", label: "Suggesting", title: "Edits become tracked changes under your name, for a coauthor to accept or reject (⌘2)" },
  { value: "viewing", label: "Viewing", title: "Read without changing anything (⌘3)" },
];

/** What Export offers for a Word document, as the title bar's menu (`menu`, `hint`) and the Export sheet (`sheet`,
 *  `detail`) name it. */
export type WordExport = "docx" | "pdf" | "md" | "latex";
export const WORD_EXPORTS: { kind: WordExport; menu: string; sheet: string; hint: string; detail: string; action: string }[] = [
  { kind: "docx", menu: "Word Document…", sheet: "Word document", hint: "A copy of the .docx as it stands", detail: "A copy of the document as it stands in the editor, tracked changes and comments included.", action: "Export…" },
  { kind: "pdf", menu: "PDF…", sheet: "PDF", hint: "Opens the print panel; choose Save as PDF", detail: "The pages as laid out here. Opens the print panel; choose Save as PDF there.", action: "Print…" },
  { kind: "md", menu: "Markdown…", sheet: "Markdown", hint: "Headings, text, lists, tables and footnotes", detail: "Headings, text, lists, tables and footnotes. Insertions are kept and deletions left out, as in Word's No Markup view.", action: "Export…" },
  { kind: "latex", menu: "Convert to LaTeX Paper…", sheet: "Convert to LaTeX paper", hint: "A new LaTeX paper beside this one; the Word file stays as it is", detail: "A new LaTeX paper in a folder beside this one, through pandoc. The Word document is not changed.", action: "Convert…" },
];

/** Fit width, the whole page, or a fixed scale (1 = 100 %). */
export type WordZoom = "fit" | "page" | number;
export const WORD_ZOOM_MIN = 0.25;
export const WORD_ZOOM_MAX = 4;
/** One press of zoom in; zoom out divides by it. */
export const WORD_ZOOM_STEP = 1.18;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The scale for `zoom` given the page and the pane, in CSS pixels. `gutter` is the room the editor keeps around the
 *  page (its 24 px padding either side and a scroll bar), across and, for a whole page, down. A pane not laid out
 *  yet gives 1. */
export function wordScale(zoom: WordZoom, page: { w: number; h: number }, pane: { w: number; h: number }, gutter = 64): number {
  if (typeof zoom === "number") return clamp(zoom, WORD_ZOOM_MIN, WORD_ZOOM_MAX);
  if (page.w <= 0 || page.h <= 0 || pane.w <= gutter || pane.h <= gutter) return 1;
  const fitW = (pane.w - gutter) / page.w;
  const scale = zoom === "fit" ? fitW : Math.min(fitW, (pane.h - gutter) / page.h);
  // Fit width stops at 200 %: past that a line is too long to read.
  return clamp(Math.floor(scale * 100) / 100, WORD_ZOOM_MIN, zoom === "fit" ? 2 : WORD_ZOOM_MAX);
}

/** The next fixed zoom from `current` (a mode resolves to the scale it shows). */
export function stepWordZoom(current: number, dir: 1 | -1): number {
  const next = dir > 0 ? current * WORD_ZOOM_STEP : current / WORD_ZOOM_STEP;
  return clamp(Math.round(next * 100) / 100, WORD_ZOOM_MIN, WORD_ZOOM_MAX);
}

/** The width the Word engine lays out when its comment column is open: the page at full size, its 24 px padding
 *  either side, the 340 px column and a 4 px gap, whatever the zoom. */
export function markupWidth(pageW: number): number {
  return Math.ceil(pageW) + 48 + 340 + 4;
}

/** "Fit width · 98 %", "Whole page · 60 %" or "125 %", for the status bar. */
export function zoomLabel(zoom: WordZoom, scale: number): string {
  const pct = `${Math.round(scale * 100)} %`;
  if (zoom === "fit") return `Fit width · ${pct}`;
  if (zoom === "page") return `Whole page · ${pct}`;
  return pct;
}

/** Page size in CSS pixels from Word's twentieths of a point; A4 when the section does not say. */
export function pagePixels(widthTwips?: number | null, heightTwips?: number | null): { w: number; h: number } {
  const px = (t: number | null | undefined, fallback: number) => (t && t > 0 ? t / 15 : fallback);
  return { w: px(widthTwips, 793.7), h: px(heightTwips, 1122.5) };
}

/** Words as Word counts them, closely enough: runs of letters or digits, with inner apostrophes and hyphens kept. */
export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:['’\-‐][\p{L}\p{N}]+)*/gu) ?? []).length;
}

/** A heading the engine found: its text, Word's outline level (0 = Heading 1) and its position in the document. */
export interface WordHeading { text: string; level: number; pmPos: number }
/** A row of the sidebar outline. `line` is the heading's 1-based index, which the Word view turns back into a position. */
export interface WordOutlineRow { level: 1 | 2 | 3; number: string; text: string; line: number; hint: string }

/** Headings 1–3 as outline rows. Deeper levels fold under their parent, as in the LaTeX outline; empty headings are skipped. */
export function wordOutline(headings: WordHeading[]): WordOutlineRow[] {
  const rows: WordOutlineRow[] = [];
  headings.forEach((h, i) => {
    const text = h.text.replace(/\s+/g, " ").trim();
    if (!text || h.level < 0 || h.level > 2) return;
    rows.push({ level: (h.level + 1) as 1 | 2 | 3, number: "", text, line: i + 1, hint: `Heading ${h.level + 1}` });
  });
  return rows;
}

/** Where the read-only Markdown copy of a Word document sits in an agent's worktree. Keep in step with
 *  `word::context_rel` in src-tauri/src/word.rs. */
export function wordContextPath(rel: string): string {
  const flat = rel.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.docx$/i, "").replace(/\//g, "__");
  return `.dabir/context/${flat}.md`;
}

/** File name without folders or the .docx extension. */
export function wordStem(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.docx$/i, "");
}

/** The folder name offered for a LaTeX copy of a Word paper: the document's name, lower-case and hyphenated, with `-latex`. */
export function latexFolderFor(path: string): string {
  const slug = wordStem(path).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug || "word-paper"}-latex`;
}

/** The parent folder of a path, with the separator the path uses. */
export function parentFolder(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}
