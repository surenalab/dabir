// The visual layer for Typst: the same idea as the LaTeX layer, built on the
// same widgets. Headings, figures, tables, citations, links and emphasis read
// like the paper; set rules fold into a preamble row; math is translated to
// LaTeX for KaTeX and falls back to styled source when the translation cannot
// follow. Anything under the cursor shows its source.

import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { Range, EditorState } from "@codemirror/state";
import { ChipWidget, FigureWidget, FoldWidget, MathWidget, PreviewWidget, TextWidget, VzWidget, badger, citeLabel, cursorOnLine, decorationField, finishRanges, hide, inlineHtml, line, mark, renderMath, selectionTouches, visualContext, visualEvents, visualTheme } from "./visual";
import { typstMathToTex } from "./typst-math";

/** Index just past the `)` or `]` that closes the bracket opened at `open`, honouring strings and nesting. */
function closeOf(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [pairs[text[open]]];
  let quoted = false;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === "\\") i++; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c in pairs) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return i + 1; }
  }
  return -1;
}

/** The paper's own `#let` definitions: `#let kap = $kappa$`, `#let norm(x) = $||x||$`, `#let name = [text]`. */
export interface LetDef { params: string[]; body: string; math: boolean }
export function collectLets(text: string): Map<string, LetDef> {
  const out = new Map<string, LetDef>();
  const re = /^#let\s+([a-zA-Z_][\w-]*)\s*(?:\(([^)]*)\))?\s*=\s*(\$[^$\n]*\$|\[[^\]\n]*\]|"[^"\n]*"|[^\n]+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[3].trim();
    const params = m[2] ? m[2].split(",").map((x) => x.trim().split(":")[0].trim()).filter(Boolean) : [];
    if (raw.startsWith("$")) out.set(m[1], { params, body: raw.slice(1, -1).trim(), math: true });
    else if (raw.startsWith("[") || raw.startsWith('"')) out.set(m[1], { params, body: raw.slice(1, -1), math: false });
  }
  return out;
}
let lets = new Map<string, LetDef>();

/** `name` or `name(a, b)` in math, expanded from the paper's lets; other identifiers are left to the translator. */
function expandMath(src: string): string {
  if (!lets.size) return src;
  let out = src;
  for (let pass = 0; pass < 3; pass++) {
    const before = out;
    out = out.replace(/(?<![\w.])([a-zA-Z_][\w-]*)(\(([^()]*)\))?/g, (all, name: string, call: string | undefined, args: string | undefined) => {
      const def = lets.get(name);
      if (!def || !def.math) return all;
      if (!def.params.length) return call ? `(${def.body})${call}` : `(${def.body})`;
      if (!call) return all;
      const given = (args ?? "").split(",").map((a) => a.trim());
      let body = def.body;
      def.params.forEach((pm, i) => { body = body.replace(new RegExp(`(?<![\\w.])${pm}(?![\\w])`, "g"), given[i] ? `(${given[i]})` : ""); });
      return `(${body})`;
    });
    if (out === before) break;
  }
  return out;
}

/** `#name` and `#name(args)` in markup, expanded from the paper's lets; math lets come back as `$…$`. */
function expandCalls(src: string): string {
  if (!lets.size) return src;
  return src.replace(/#([a-zA-Z_][\w-]*)(\(([^()]*)\))?/g, (all, name: string, call: string | undefined, args: string | undefined) => {
    const def = lets.get(name);
    if (!def) return all;
    const given = (args ?? "").split(",").map((a) => unwrap(a.trim()));
    let body = def.body;
    def.params.forEach((pm, i) => { body = body.replace(new RegExp(def.math ? `(?<![\\w.])${pm}(?![\\w])` : `#${pm}\\b`, "g"), given[i] ?? ""); });
    if (!def.params.length && call) return all;
    return def.math ? `$${body}$` : body;
  });
}

/** Typst math as LaTeX that KaTeX accepts, or null when it does not translate or render. */
function mathTex(src: string, display: boolean): string | null {
  const tex = typstMathToTex(expandMath(src));
  if (tex === null) return null;
  const body = display && /&|\\\\/.test(tex) ? `\\begin{aligned}${tex}\\end{aligned}` : tex;
  return renderMath(body, display).includes("katex-error") ? null : body;
}

/** Typst inline markup rewritten into the LaTeX-ish form the shared widgets' inlineHtml renders. */
function latexish(src: string): string {
  return expandCalls(src)
    .replace(/\$([^$]*)\$/g, (_, m: string) => { const t = mathTex(m, false); return t ? `$${t}$` : m; })
    .replace(/(^|[\s(])\*(\S[^*]*?)\*/g, "$1\\textbf{$2}")
    .replace(/(^|[\s(])_(\S[^_]*?)_/g, "$1\\emph{$2}")
    .replace(/#[a-zA-Z.]+(\([^)]*\))?(\[([^\]]*)\])?/g, (_, _a, _b, inner: string | undefined) => inner ?? "")
    .replace(/<[^>]*>/g, "")
    .trim();
}
const inlineTypst = (src: string) => inlineHtml(latexish(src));

/** Splits call arguments on top-level commas, honouring brackets and strings. Returns [positional, named]. */
function splitArgs(src: string): [string[], Record<string, string>] {
  const pos: string[] = []; const named: Record<string, string> = {};
  let depth = 0, quoted = false, cur = "";
  const flush = () => {
    const t = cur.trim(); cur = "";
    if (!t) return;
    const nm = /^([a-zA-Z_][\w-]*)\s*:\s*([\s\S]*)$/.exec(t);
    if (nm) named[nm[1]] = nm[2]; else pos.push(t);
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) { cur += c; if (c === "\\") { cur += src[++i] ?? ""; } else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; cur += c; continue; }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) { flush(); continue; }
    cur += c;
  }
  flush();
  return [pos, named];
}

/** Body of a `[...]` content block, or the string inside quotes, or the source itself. */
const unwrap = (s: string) => { const t = s.trim(); return /^\[[\s\S]*\]$/.test(t) ? t.slice(1, -1).trim() : /^"[\s\S]*"$/.test(t) ? t.slice(1, -1) : t; };

/** A `table(...)` call parsed into header and body rows of cell markup. */
function parseTable(args: string): { header: string[]; rows: string[][] } | null {
  const [pos, named] = splitArgs(args);
  const cols = named.columns?.trim() ?? "";
  let n = /^\d+$/.test(cols) ? Number(cols) : cols.startsWith("(") ? splitArgs(cols.slice(1, -1))[0].length : 0;
  const header: string[] = []; const cells: string[] = [];
  for (const a of pos) {
    const hm = /^table\.header\(([\s\S]*)\)$/.exec(a);
    if (hm) { header.push(...splitArgs(hm[1])[0].map(unwrap)); continue; }
    if (/^table\.(hline|vline|cell)\(/.test(a) && !/^table\.cell\(/.test(a)) continue;
    cells.push(unwrap(a.replace(/^table\.cell\([^)]*\)/, "")));
  }
  if (!n) n = header.length || Math.ceil(Math.sqrt(cells.length)) || 1;
  const rows: string[][] = [];
  for (let i = 0; i < cells.length; i += n) rows.push(cells.slice(i, i + n));
  if (!header.length && rows.length > 1) header.push(...rows.shift()!);
  return header.length || rows.length ? { header, rows } : null;
}

class TypstTableWidget extends VzWidget {
  constructor(readonly header: string[], readonly rows: string[][], readonly caption: string, readonly number: number, readonly from: number) { super(); }
  eq(o: TypstTableWidget) { return this.sameBadges(o) && o.caption === this.caption && o.number === this.number && JSON.stringify(o.header) === JSON.stringify(this.header) && JSON.stringify(o.rows) === JSON.stringify(this.rows); }
  render() {
    const el = document.createElement("figure");
    el.className = "vz-figure vz-tablefig";
    el.dataset.from = String(this.from);
    const table = document.createElement("table"); table.className = "vz-tab";
    if (this.header.length) { const tr = document.createElement("tr"); for (const h of this.header) { const th = document.createElement("th"); th.innerHTML = inlineTypst(h); tr.appendChild(th); } table.appendChild(tr); }
    for (const r of this.rows) { const tr = document.createElement("tr"); for (const c of r) { const td = document.createElement("td"); td.innerHTML = inlineTypst(c); tr.appendChild(td); } table.appendChild(tr); }
    el.appendChild(table);
    if (this.number) { const cap = document.createElement("figcaption"); cap.innerHTML = `<b>Table ${this.number}.</b> ${inlineTypst(this.caption)}`; el.appendChild(cap); }
    return el;
  }
  ignoreEvent() { return false; }
}

/** A `#grid(...)`: its cells side by side in as many columns as it declares, each cell as inline markup.
 * A `#stack(...)` is the same widget in one column (or one row for `dir: ltr`), without the grid's frame. */
class GridWidget extends VzWidget {
  constructor(readonly cells: string[], readonly columns: number, readonly from: number, readonly kind: "grid" | "stack" = "grid") { super(); }
  eq(o: GridWidget) { return this.sameBadges(o) && o.kind === this.kind && o.columns === this.columns && JSON.stringify(o.cells) === JSON.stringify(this.cells); }
  render() {
    const el = document.createElement("div");
    el.className = this.kind === "stack" ? "vz-grid vz-stack" : "vz-grid";
    el.dataset.from = String(this.from);
    el.style.gridTemplateColumns = `repeat(${this.columns}, minmax(0, 1fr))`;
    for (const c of this.cells) {
      const cell = document.createElement("div"); cell.className = "vz-grid-cell";
      const fig = /image\(\s*"([^"]*)"/.exec(c);
      if (fig) { const img = document.createElement("div"); img.className = "vz-grid-image"; img.textContent = fig[1].split("/").pop() ?? fig[1]; cell.appendChild(img); }
      else cell.innerHTML = inlineTypst(c);
      el.appendChild(cell);
    }
    return el;
  }
  ignoreEvent() { return false; }
}

/** The children of a `stack(...)` and whether they run across (`dir: ltr` or `rtl`) rather than down. */
function parseStack(args: string): { cells: string[]; across: boolean } | null {
  const [pos, named] = splitArgs(args);
  const cells = pos.map(unwrap).filter((c) => c.trim());
  const dir = named.dir?.trim() ?? "ttb";
  return cells.length ? { cells: dir === "rtl" ? cells.reverse() : cells, across: dir === "ltr" || dir === "rtl" } : null;
}

/** A `#columns(n)[...]`: the body flowing through n columns, paragraph by paragraph. Block-level pieces inside
 * (headings, display math, figures) are set as text; click to edit them in the source. */
class ColumnsWidget extends VzWidget {
  constructor(readonly body: string, readonly columns: number, readonly from: number) { super(); }
  eq(o: ColumnsWidget) { return this.sameBadges(o) && o.columns === this.columns && o.body === this.body; }
  render() {
    const el = document.createElement("div");
    el.className = "vz-columns";
    el.dataset.from = String(this.from);
    el.style.columnCount = String(this.columns);
    el.title = `${this.columns} columns; click to edit`;
    for (const para of this.body.split(/\n\s*\n/)) {
      const lines = para.split("\n").map((l) => l.trim()).filter(Boolean);
      // A heading line stands on its own; the lines after it are the paragraph that follows.
      while (lines.length && /^=+\s+/.test(lines[0])) {
        const h = document.createElement("h4"); h.innerHTML = inlineTypst(lines.shift()!.replace(/^=+\s+/, "")); el.appendChild(h);
      }
      if (!lines.length) continue;
      const p = document.createElement("p"); p.innerHTML = inlineTypst(lines.join(" ")); el.appendChild(p);
    }
    return el;
  }
  ignoreEvent() { return false; }
}

/** The cells and column count of a `grid(...)` argument list. */
function parseGrid(args: string): { cells: string[]; columns: number } | null {
  const [pos, named] = splitArgs(args);
  const cols = named.columns?.trim() ?? "";
  const n = /^\d+$/.test(cols) ? Number(cols) : cols.startsWith("(") ? splitArgs(cols.slice(1, -1))[0].length : 0;
  const cells = pos.filter((a) => !/^grid\.(hline|vline)\(/.test(a)).map((a) => unwrap(a.replace(/^grid\.cell\([^)]*\)/, "")));
  return cells.length ? { cells, columns: n || Math.min(cells.length, 3) } : null;
}

/** The paper's title and authors, from the template's title block or a show rule's arguments. */
class TitleWidget extends VzWidget {
  constructor(readonly title: string, readonly authors: string[], readonly from: number) { super(); }
  eq(o: TitleWidget) { return this.sameBadges(o) && o.title === this.title && o.authors.join("|") === this.authors.join("|"); }
  render() {
    const el = document.createElement("div");
    el.className = "vz-titleblock";
    el.dataset.from = String(this.from);
    el.title = "Click to edit the title block";
    const t = document.createElement("div"); t.className = "vz-title"; t.innerHTML = inlineTypst(this.title); el.appendChild(t);
    if (this.authors.length) { const a = document.createElement("div"); a.className = "vz-author"; a.textContent = this.authors.join(", "); el.appendChild(a); }
    return el;
  }
  ignoreEvent() { return false; }
}

/** Author names out of a Typst `authors:` value: strings, or dictionaries with a `name`. */
function authorNames(src: string): string[] {
  const t = src.trim();
  const inner = t.startsWith("(") ? t.slice(1, -1) : t;
  return splitArgs(inner)[0].map((a) => {
    const nm = /name\s*:\s*("([^"]*)"|\[([^\]]*)\])/.exec(a);
    return nm ? (nm[2] ?? nm[3]) : unwrap(a);
  }).filter(Boolean);
}

const PREAMBLE_LINE = /^\s*(#(set|show|import|include|let)\b.*|\/\/.*)?\s*$/;

export function buildTypstDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const text = doc.toString();
  const ranges: Range<Decoration>[] = [];
  const push = (from: number, to: number, d: Decoration) => { if (to >= from) ranges.push(d.range(from, to)); };
  const badge = badger(state);
  const bib = visualContext().bib;
  lets = collectLets(text);

  // Title block: `#show: tmpl.with(title: …, authors: …)` or the template's `#align(center)[#text(…)[Title] \\ Authors]`.
  const blocked: [number, number][] = [];
  let titleSpan: [number, number] | null = null;
  {
    const show = /^#show:\s*[\w.]+\.with\(/m.exec(text);
    if (show) {
      const to = closeOf(text, show.index + show[0].length - 1);
      const [, named] = to > 0 ? splitArgs(text.slice(show.index + show[0].length, to - 1)) : [[], {} as Record<string, string>];
      if (to > 0 && (named.title || named.authors)) {
        const end = doc.lineAt(to).to;
        titleSpan = [show.index, end];
        blocked.push(titleSpan);
        if (selectionTouches(state, show.index, end + 1)) { let x = doc.lineAt(show.index); while (x.from <= end) { push(x.from, x.from, line("vz-preamble")); if (x.to >= doc.length) break; x = doc.lineAt(x.to + 1); } }
        else push(show.index, end, Decoration.replace({ widget: badge(new TitleWidget(unwrap(named.title ?? ""), named.authors ? authorNames(named.authors) : [], show.index), show.index, end), block: true }));
      }
    }
    const al = /^#align\(center\)\[\s*#text\([^)]*\)\[([^\]]*)\]\s*(?:\\\s*([^\]]*))?\]\s*$/m.exec(text);
    if (al && !titleSpan) {
      const end = al.index + al[0].length;
      titleSpan = [al.index, end];
      blocked.push(titleSpan);
      if (selectionTouches(state, al.index, end + 1)) push(al.index, al.index, line("vz-preamble"));
      else push(al.index, end, Decoration.replace({ widget: badge(new TitleWidget(al[1].trim(), al[2] ? al[2].split(/\s*(?:,|\\\\|\\)\s*/).map((a) => a.trim()).filter(Boolean) : [], al.index), al.index, end), block: true }));
    }
  }

  // Preamble: the leading run of set/show/import rules folds into one row until the cursor enters it.
  let preambleEnd = 0;
  {
    let l = doc.line(1), last = -1, lines = 0;
    while (PREAMBLE_LINE.test(l.text) && !(titleSpan && l.from >= titleSpan[0])) {
      if (l.text.trim()) { last = l.to; lines++; }
      if (l.to >= doc.length) break; l = doc.lineAt(l.to + 1);
    }
    if (last > 0 && lines >= 2) {
      preambleEnd = last;
      const touched = state.selection.ranges.some((r) => (r.empty ? r.from <= last : r.from <= last));
      if (touched) {
        let x = doc.line(1);
        while (x.from <= last) { push(x.from, x.from, line("vz-preamble")); if (x.to >= doc.length) break; x = doc.lineAt(x.to + 1); }
      } else {
        push(0, last, Decoration.replace({ widget: badge(new FoldWidget(lines, doc.line(1).text.trim(), 0), 0, last), block: true }));
      }
    }
  }

  // Figures and tables: #figure(...) and bare #table(...) spanning one or more lines become rendered blocks.
  let figCount = 0, tabCount = 0;
  const figRe = /#(figure|table)\(/g; let m: RegExpExecArray | null;
  while ((m = figRe.exec(text))) {
    const from = m.index, to = closeOf(text, m.index + m[0].length - 1);
    if (to < 0 || from < preambleEnd) continue;
    // Take the trailing label too, so the row hides completely.
    const tail = /^\s*<[^>\n]*>/.exec(text.slice(to));
    const end = tail ? to + tail[0].length : to;
    blocked.push([from, end]);
    const inner = text.slice(from + m[0].length, to - 1);
    const [pos, named] = m[1] === "figure" ? splitArgs(inner) : [[`table(${inner})`], {} as Record<string, string>];
    const body = pos[0] ?? "";
    const tab = /^table\(([\s\S]*)\)$/.exec(body);
    const parsed = tab ? parseTable(tab[1]) : null;
    if (parsed) tabCount++; else figCount++;
    if (selectionTouches(state, from, end)) { push(from, from + m[0].length, mark("vz-envtag")); push(to - 1, to, mark("vz-envtag")); continue; }
    const caption = named.caption ? unwrap(named.caption) : "";
    if (parsed) push(from, end, Decoration.replace({ widget: badge(new TypstTableWidget(parsed.header, parsed.rows, caption, m[1] === "figure" ? tabCount : 0, from), from, end), block: true }));
    else {
      const file = /image\(\s*"([^"]*)"/.exec(body)?.[1] ?? null;
      push(from, end, Decoration.replace({ widget: badge(new FigureWidget(file, latexish(caption), figCount, from), from, end), block: true }));
    }
  }
  // Grids: #grid(columns: …, [cell], [cell]) on its own becomes a row of cells.
  const gridRe = /^#grid\(/gm;
  while ((m = gridRe.exec(text))) {
    const from = m.index, to = closeOf(text, m.index + m[0].length - 1);
    if (to < 0 || from < preambleEnd || blocked.some(([a, b]) => from >= a && from < b)) continue;
    const parsed = parseGrid(text.slice(from + m[0].length, to - 1));
    if (!parsed) continue;
    const end = to;
    blocked.push([from, end]);
    if (selectionTouches(state, from, end)) { push(from, from + m[0].length, mark("vz-envtag")); push(to - 1, to, mark("vz-envtag")); continue; }
    push(from, end, Decoration.replace({ widget: badge(new GridWidget(parsed.cells, parsed.columns, from), from, end), block: true }));
  }
  // Stacks: #stack(dir: ttb, spacing: 1em, [a], [b]) on its own becomes its children one under the other.
  const stackRe = /^#stack\(/gm;
  while ((m = stackRe.exec(text))) {
    const from = m.index, to = closeOf(text, m.index + m[0].length - 1);
    if (to < 0 || from < preambleEnd || blocked.some(([a, b]) => from >= a && from < b)) continue;
    const parsed = parseStack(text.slice(from + m[0].length, to - 1));
    if (!parsed) continue;
    blocked.push([from, to]);
    if (selectionTouches(state, from, to)) { push(from, from + m[0].length, mark("vz-envtag")); push(to - 1, to, mark("vz-envtag")); continue; }
    push(from, to, Decoration.replace({ widget: badge(new GridWidget(parsed.cells, parsed.across ? parsed.cells.length : 1, from, "stack"), from, to), block: true }));
  }
  // Columns: #columns(2)[ body ] or #columns(2, gutter: 1em)[ body ] shows the body flowing in that many columns.
  const colRe = /^#columns\(/gm;
  while ((m = colRe.exec(text))) {
    const from = m.index, argsEnd = closeOf(text, m.index + m[0].length - 1);
    if (argsEnd < 0 || from < preambleEnd || blocked.some(([a, b]) => from >= a && from < b)) continue;
    const open = argsEnd + (/^\s*/.exec(text.slice(argsEnd))?.[0].length ?? 0);
    if (text[open] !== "[") continue;
    const to = closeOf(text, open);
    if (to < 0) continue;
    const [pos] = splitArgs(text.slice(from + m[0].length, argsEnd - 1));
    const n = /^\d+$/.test(pos[0]?.trim() ?? "") ? Number(pos[0]) : 2;
    const body = text.slice(open + 1, to - 1);
    blocked.push([from, to]);
    if (selectionTouches(state, from, to)) { push(from, open + 1, mark("vz-envtag")); push(to - 1, to, mark("vz-envtag")); continue; }
    push(from, to, Decoration.replace({ widget: badge(new ColumnsWidget(body, n, from), from, to), block: true }));
  }
  const inBlocked = (pos: number) => blocked.some(([a, b]) => pos >= a && pos < b);

  // Math: every $…$ pair. Padded delimiters ($ x $) mean display; on a line of its own it becomes a block.
  let eqCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "$" || text[i - 1] === "\\") continue;
    let j = i + 1;
    while (j < text.length && !(text[j] === "$" && text[j - 1] !== "\\")) j++;
    if (j >= text.length) break;
    const from = i, to = j + 1, inner = text.slice(i + 1, j);
    i = j;
    if (from < preambleEnd || inBlocked(from) || !inner.trim()) continue;
    const display = /^\s/.test(inner) && /\s$/.test(inner);
    const lineFrom = doc.lineAt(from), lineTo = doc.lineAt(to);
    const tail = /^\s*(<[^>\n]*>)?\s*$/.exec(text.slice(to, lineTo.to));
    const ownLine = display && !text.slice(lineFrom.from, from).trim() && !!tail;
    const end = ownLine ? lineTo.to : to;
    if (ownLine) blocked.push([lineFrom.from, end]);
    const label = ownLine && tail?.[1] ? true : false;
    if (label) eqCount++;
    const touched = ownLine ? selectionTouches(state, lineFrom.from, end + 1) : selectionTouches(state, from, to) || cursorOnLine(state, from, to);
    const tex = mathTex(inner, display);
    if (touched) {
      if (ownLine && tex) { push(from, from + 1, mark("vz-envtag")); push(to - 1, to, mark("vz-envtag")); push(end, end, Decoration.widget({ widget: new PreviewWidget(tex), block: true, side: 1 })); }
      continue;
    }
    if (tex) push(ownLine ? lineFrom.from : from, end, Decoration.replace({ widget: badge(new MathWidget(tex, ownLine, label ? `(${eqCount})` : "", from), from, end), block: ownLine }));
    else { push(from, from + 1, hide); push(from + 1, to - 1, mark("vz-typ-math")); push(to - 1, to, hide); }
  }

  for (let i = 1; i <= doc.lines; i++) {
    const l = doc.line(i);
    const s = l.text;
    if (l.to <= preambleEnd) continue;
    if (inBlocked(l.from) && !selectionTouches(state, l.from, l.to)) continue;
    const revealed = cursorOnLine(state, l.from, l.to);

    // Comments
    const cm = /(^|[^:])(\/\/.*)$/.exec(s);
    if (cm && !/https?:$/.test(s.slice(0, cm.index + cm[1].length))) push(l.from + cm.index + cm[1].length, l.to, mark("vz-comment"));

    // Abstract paragraph: *Abstract.* text
    if (/^\s*\*Abstract\.?\*/.test(s)) push(l.from, l.from, line("vz-abstract"));

    // Headings: = Title, == Subtitle, === Sub-subtitle
    const sec = /^(\s*)(=+)\s+(.*)$/.exec(s);
    if (sec) {
      const level = ["section", "subsection", "subsubsection", "paragraph"][Math.min(sec[2].length, 4) - 1];
      push(l.from, l.from, line(`vz-${level}`));
      if (!revealed) push(l.from + sec[1].length, l.from + sec[1].length + sec[2].length + 1, hide);
      continue;
    }

    // Lines that are pure scaffolding
    if (/^\s*(#(set|show|pagebreak\(\)|colbreak\(\)|v\([^)]*\)|h\([^)]*\)|align\(\w+\)|label\("[^"]*"\))|<[^>]+>)\s*$/.test(s)) {
      push(l.from, l.from, line(revealed ? "vz-scaffold" : "vz-hidden"));
      if (!revealed && l.to > l.from) push(l.from, l.to, hide);
      continue;
    }
    const bibl = /^\s*#bibliography\(/.exec(s);
    if (bibl) {
      push(l.from, l.from, line("vz-references"));
      if (!revealed) {
        // The chip says what the compiled list will be: its title, the style, the .bib files it draws from.
        const end = closeOf(s, bibl[0].length - 1);
        const [pos, named] = splitArgs(end > 0 ? s.slice(bibl[0].length, end - 1) : "");
        const files = pos.flatMap((a) => Array.from(a.matchAll(/"([^"]*)"/g), (x) => x[1]));
        const title = named.title ? (named.title.trim() === "none" ? "" : unwrap(named.title).replace(/^"|"$/g, "")) : "Bibliography";
        const style = named.style ? unwrap(named.style).replace(/^"|"$/g, "") : "ieee";
        const parts = [title || "Untitled reference list", `${style} style`, files.length ? `from ${files.join(", ")}` : null, named.full?.trim() === "true" ? "every entry, cited or not" : null].filter(Boolean);
        push(l.from, l.to, Decoration.replace({ widget: new ChipWidget("ref", `${parts.join(" · ")} — generated at compile time`, s, l.from) }));
      }
      continue;
    }

    // List items
    const item = /^(\s*)([-+])\s/.exec(s);
    if (item) { push(l.from, l.from, line("vz-item")); if (!revealed) push(l.from + item[1].length, l.from + item[0].length, Decoration.replace({ widget: new ChipWidget("ref", item[2] === "-" ? "•" : "1.", "list item", l.from) })); }

    if (revealed) continue;

    let mm: RegExpExecArray | null;
    // Citations and references: @key, #cite(<key>), #ref(<key>)
    const cr = /@([\w:.-]+)|#(cite|ref)\(\s*<([^>]*)>\s*\)/g;
    while ((mm = cr.exec(s))) {
      if (mm[0][0] === "@" && /[@\w]/.test(s[mm.index - 1] ?? " ")) continue; // an e-mail address, not a reference
      const key = (mm[1] ?? mm[3]).replace(/[.:]$/, ""); // a sentence's full stop is not part of the key
      const from = l.from + mm.index, to = from + (mm[0][0] === "@" ? 1 + key.length : mm[0].length);
      if (selectionTouches(state, from, to)) continue;
      const isRef = mm[2] === "ref" || (mm[2] !== "cite" && !(key in bib) && /^(fig|eq|sec|tab|tbl|thm|lem|alg|app)[:-]/.test(key));
      if (isRef) push(from, to, Decoration.replace({ widget: badge(new ChipWidget("ref", key.replace(/^(fig|eq|sec|tab|tbl|thm|lem|alg|app)[:-]/, ""), mm[0], from), from, to) }));
      else push(from, to, Decoration.replace({ widget: badge(new ChipWidget("cite", citeLabel(key), bib[key]?.title ?? key, from), from, to) }));
    }
    // #include "file.typ"
    const inc = /#include\s+"([^"]*)"/g;
    while ((mm = inc.exec(s))) {
      const from = l.from + mm.index, to = from + mm[0].length;
      if (selectionTouches(state, from, to)) continue;
      push(from, to, Decoration.replace({ widget: badge(new ChipWidget("input", `Included: ${mm[1]}`, "Click to open", from, mm[1]), from, to) }));
    }
    // The paper's own lets in prose: `#kap` shows κ, `#method` shows its text.
    const call = /#([a-zA-Z_][\w-]*)(\([^()\n]*\))?/g;
    while ((mm = call.exec(s))) {
      const def = lets.get(mm[1]);
      if (!def || (def.params.length > 0) !== !!mm[2]) continue;
      const from = l.from + mm.index, to = from + mm[0].length;
      if (selectionTouches(state, from, to)) continue;
      const expanded = expandCalls(mm[0]);
      const tex = def.math ? mathTex(expanded.slice(1, -1), false) : null;
      if (def.math && !tex) continue;
      push(from, to, Decoration.replace({ widget: def.math ? badge(new MathWidget(tex!, false, "", from), from, to) : new TextWidget(expanded, from) }));
    }
    // Footnotes and links
    const fn = /#footnote\[((?:[^[\]]|\[[^[\]]*\])*)\]/g;
    while ((mm = fn.exec(s))) {
      const from = l.from + mm.index, to = from + mm[0].length;
      if (selectionTouches(state, from, to)) continue;
      push(from, to, Decoration.replace({ widget: badge(new ChipWidget("note", "†", mm[1], from), from, to) }));
    }
    const url = /#link\("([^"]*)"\)(?:\[([^\]]*)\])?/g;
    while ((mm = url.exec(s))) {
      const from = l.from + mm.index, to = from + mm[0].length;
      if (selectionTouches(state, from, to)) continue;
      push(from, to, Decoration.replace({ widget: badge(new ChipWidget("link", mm[2] ?? mm[1], mm[1], from), from, to) }));
    }
    // Emphasis: *strong* and _emphasis_, markers hidden
    const em = /(^|[\s(])(\*|_)(?=\S)([^*_\n]+?)(?<=\S)\2(?=$|[\s.,;:!?)~])/g;
    while ((mm = em.exec(s))) {
      const from = l.from + mm.index + mm[1].length, to = from + mm[0].length - mm[1].length;
      if (selectionTouches(state, from, to)) continue;
      push(from, from + 1, hide);
      push(from + 1, to - 1, mark(mm[2] === "*" ? "vz-bold" : "vz-em"));
      push(to - 1, to, hide);
    }
    // Inline scaffolding: labels, non-breaking space, dashes, line breaks, escapes
    const lab = /<[\w:.-]+>|~|---|--|\\$|\\[#@$*_~\\]/g;
    const glyph: Record<string, string> = { "~": "\u00a0", "---": "\u2014", "--": "\u2013", "\\": "" };
    while ((mm = lab.exec(s))) {
      const from = l.from + mm.index, to = from + mm[0].length;
      if (selectionTouches(state, from, to)) continue;
      const t = mm[0];
      if (t[0] === "<") { push(from, to, hide); continue; }
      const replacement = t in glyph ? glyph[t] : t.length === 2 && t[0] === "\\" ? t[1] : null;
      if (replacement === null) push(from, to, hide);
      else push(from, to, Decoration.replace({ widget: new TextWidget(replacement, from) }));
    }
  }

  return finishRanges(ranges);
}

const typstField = decorationField(buildTypstDecorations);

export function typstVisualExtensions() { return [typstField, visualEvents, visualTheme, EditorView.editorAttributes.of({ class: "cm-visual cm-visual-typst" })]; }
