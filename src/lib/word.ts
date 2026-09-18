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
 *  malformed and Word refuse the document; this puts the declarations on the root element. Still needed at
 *  docx-editor 1.12.0: `updateCoreProperties` in the engine's `docx/rezip.ts` is unchanged since 1.9.0. */
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
 *  then rewritten whole, which loses fields that span paragraphs (a Zotero bibliography). Still needed at
 *  docx-editor 1.12.0: the `hasUntrackedChanges` bail-out in the engine's `docx/selectiveSave.ts` is unchanged
 *  since 1.9.0, and with the injection off a full repack drops the comments part and rewrites the relationships. */
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

/** A run's properties as OOXML writes them: the element name (`w:i`, `w:rFonts`, …) against its attributes. */
export type RunProps = Map<string, Record<string, string>>;
/** A document's style sheet, as much of it as run properties need: the defaults every run starts from, each style
 *  with what it sets and what it is based on, and the theme's font names, which `w:rFonts` refers to by slot. */
export interface WordStyles { defaults: RunProps; styles: Map<string, { basedOn: string | null; props: RunProps }>; theme: Record<string, string> }

/** Properties whose absent `w:val` means on, so `<w:i/>` and `<w:i w:val="1"/>` are the same thing. */
const TOGGLES = new Set(["w:b", "w:bCs", "w:i", "w:iCs", "w:caps", "w:smallCaps", "w:strike", "w:dstrike", "w:outline", "w:shadow", "w:emboss", "w:imprint", "w:vanish", "w:webHidden", "w:rtl", "w:noProof", "w:snapToGrid", "w:specVanish", "w:oMath"]);
/** Word writes a complex-script twin beside the property it mirrors; the engine copies both out of the style. */
const TWINS: Record<string, string> = { "w:bCs": "w:b", "w:iCs": "w:i", "w:szCs": "w:sz" };
/** The four faces `w:rFonts` names, each of which may be given outright or through a theme slot. */
const FONT_SLOTS = ["ascii", "hansi", "cs", "eastasia"];

const attrsOf = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1].toLowerCase()] = m[2];
  return out;
};

/** The children of one `<w:rPr>`, by element name. */
export function runPropsIn(inner: string): RunProps {
  const out: RunProps = new Map();
  for (const m of inner.matchAll(/<(w:[\w]+)((?:[^>"]|"[^"]*")*?)(?:\/>|>[\s\S]*?<\/\1>)/g)) out.set(m[1], attrsOf(m[2]));
  return out;
}

const firstRunProps = (xml: string): RunProps => {
  const m = /<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/.exec(xml);
  return m ? runPropsIn(m[1]) : new Map();
};

/** The style sheet a document saves with: `styles.xml`, and `theme1.xml` for the names behind the font slots. */
export function readWordStyles(stylesXml: string, themeXml?: string | null): WordStyles {
  const theme: Record<string, string> = {};
  for (const kind of ["major", "minor"] as const) {
    const block = new RegExp(`<a:${kind}Font>([\\s\\S]*?)</a:${kind}Font>`).exec(themeXml ?? "")?.[1] ?? "";
    const face = (tag: string) => new RegExp(`<a:${tag}\\b[^>]*typeface="([^"]*)"`).exec(block)?.[1] ?? "";
    const latin = face("latin");
    theme[`${kind}hansi`] = theme[`${kind}ascii`] = latin;
    // An empty slot in the theme means the latin face, which is what Word shows and what the engine writes out.
    theme[`${kind}eastasia`] = face("ea") || latin;
    theme[`${kind}bidi`] = face("cs") || latin;
  }
  const defaults = firstRunProps(/<w:rPrDefault>([\s\S]*?)<\/w:rPrDefault>/.exec(stylesXml)?.[1] ?? "");
  const styles = new Map<string, { basedOn: string | null; props: RunProps }>();
  for (const m of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = attrsOf(m[1])["w:styleid"];
    if (!id) continue;
    const body = m[2].replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, "");
    styles.set(id, { basedOn: /<w:basedOn\b[^>]*w:val="([^"]*)"/.exec(body)?.[1] ?? null, props: firstRunProps(body) });
  }
  return { defaults, styles, theme };
}

/** What a run in a paragraph styled `pStyle` (and with the character style `rStyle`) already has without saying so:
 *  the defaults, then each style from the root of its `w:basedOn` chain down, then the character style. */
export function resolveRunProps(sheet: WordStyles, pStyle: string | null, rStyle: string | null): RunProps {
  const out: RunProps = new Map(sheet.defaults);
  const apply = (id: string | null) => {
    const chain: { basedOn: string | null; props: RunProps }[] = [];
    for (let at = id, guard = 0; at && guard < 32; guard++) {
      const style = sheet.styles.get(at);
      if (!style) break;
      chain.unshift(style);
      at = style.basedOn;
    }
    for (const style of chain) for (const [name, attrs] of style.props) out.set(name, attrs);
  };
  apply(pStyle);
  apply(rStyle);
  return out;
}

const isOn = (attrs: Record<string, string>) => !["0", "false", "off"].includes((attrs["w:val"] ?? "1").toLowerCase());
/** The face each slot ends up with, whether it was named outright or through a theme slot. */
const faces = (attrs: Record<string, string>, theme: Record<string, string>) =>
  FONT_SLOTS.map((slot) => (attrs[`w:${slot}`] ?? theme[(attrs[`w:${slot}theme`] ?? "").toLowerCase()] ?? "").toLowerCase()).join("|");

/** Does a run property say exactly what the style behind it already says? */
export function sameRunProp(name: string, mine: Record<string, string>, inherited: Record<string, string> | undefined, theme: Record<string, string>): boolean {
  if (!inherited) return false;
  if (TOGGLES.has(name)) return isOn(mine) === isOn(inherited);
  if (name === "w:rFonts") return faces(mine, theme) === faces(inherited, theme) && (mine["w:hint"] ?? "") === (inherited["w:hint"] ?? "");
  const keys = new Set([...Object.keys(mine), ...Object.keys(inherited)]);
  return [...keys].every((k) => (mine[k] ?? "") === (inherited[k] ?? ""));
}

const signature = (name: string, attrs: Record<string, string>) =>
  `${name} ${Object.keys(attrs).sort().map((k) => `${k}=${attrs[k]}`).join(" ")}`;

/** Every run property each paragraph of a part already carried, by paragraph id: what the author put there, as
 *  opposed to what a save adds. A paragraph the part does not have yet answers with nothing. */
export function runPropsBefore(xml: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of xml.matchAll(/<w:p\b[^>]*\bw14:paraId="([0-9A-Fa-f]+)"([\s\S]*?)<\/w:p>/g)) {
    const seen = out.get(p[1].toUpperCase()) ?? new Set<string>();
    for (const r of p[2].matchAll(/<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/g)) for (const [name, attrs] of runPropsIn(r[1])) seen.add(signature(name, attrs));
    out.set(p[1].toUpperCase(), seen);
  }
  return out;
}

/** Take back the formatting a save copied out of a paragraph's own style.
 *
 *  docx-editor resolves the style cascade into the editor's marks when it reads a document (toProseDoc merges the
 *  paragraph style's formatting into every run), and writes those marks back as direct formatting (fromProseDoc has
 *  no style resolver at all), so editing one word in a paragraph styled `TableCaption` returns it with the style's
 *  own italic, size and font written onto the run. The paragraph still names the style, but the text no longer
 *  follows it: put the manuscript on a journal's style sheet afterwards and that paragraph stays as it was.
 *
 *  This drops a run property only when both hold: the paragraph did not carry it before this save (`before`, the
 *  document as it was read), and it says exactly what the style behind it already says. The author's own direct
 *  formatting is therefore never touched, and a property that differs from the style — a real override — stays.
 *  Reported upstream; remove this when the engine stops writing them. */
export function dropStyleEchoes(xml: string, before: string | null, sheet: WordStyles): string {
  const had = runPropsBefore(before ?? "");
  const tags = /<(\/?)w:(p|pPr|rPr)(?=[\s/>])([^>]*?)(\/?)>/g;
  let out = "", from = 0, inPPr = false;
  const open: { style: string | null; sigs: Set<string> }[] = [];
  for (let m = tags.exec(xml); m; m = tags.exec(xml)) {
    const [whole, closing, name, attrs, selfClosing] = m;
    if (name === "p") {
      if (closing) open.pop();
      else if (!selfClosing) open.push({ style: null, sigs: had.get((/\bw14:paraId="([0-9A-Fa-f]+)"/.exec(attrs)?.[1] ?? "").toUpperCase()) ?? new Set() });
      continue;
    }
    if (name === "pPr") {
      inPPr = !closing && !selfClosing;
      if (inPPr && open.length) {
        const shut = xml.indexOf("</w:pPr>", m.index);
        const style = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(shut < 0 ? "" : xml.slice(m.index, shut))?.[1];
        if (style) open[open.length - 1].style = style;
      }
      continue;
    }
    if (closing || selfClosing || !open.length) continue;
    // A paragraph's own `<w:pPr><w:rPr>` formats its mark, not its text, and the style it names sits in the pPr.
    const end = xml.indexOf("</w:rPr>", m.index);
    if (end < 0) continue;
    const inner = xml.slice(m.index + whole.length, end);
    if (inPPr) continue;
    const paragraph = open[open.length - 1];
    const props = runPropsIn(inner);
    if (!props.size) continue;
    const inherited = resolveRunProps(sheet, paragraph.style, props.get("w:rStyle")?.["w:val"] ?? null);
    const echoes = new Set<string>();
    for (const [name2, attrs2] of props) {
      if (name2 === "w:rStyle" || paragraph.sigs.has(signature(name2, attrs2))) continue;
      if (sameRunProp(name2, attrs2, inherited.get(name2), sheet.theme)) echoes.add(name2);
    }
    // A complex-script twin the save added beside an echo is one too: the style says nothing about it either.
    for (const [twin, base] of Object.entries(TWINS)) {
      const attrs2 = props.get(twin);
      if (attrs2 && echoes.has(base) && !paragraph.sigs.has(signature(twin, attrs2)) && !inherited.has(twin)) echoes.add(twin);
    }
    if (!echoes.size) continue;
    let kept = inner;
    for (const name2 of echoes) kept = kept.replace(new RegExp(`<${name2}(?=[\\s/>])(?:[^>"]|"[^"]*")*?(?:/>|>[\\s\\S]*?</${name2}>)`, "g"), "");
    out += xml.slice(from, m.index) + (kept.trim() ? `${whole}${kept}</w:rPr>` : "");
    from = end + "</w:rPr>".length;
  }
  return from ? out + xml.slice(from) : xml;
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
