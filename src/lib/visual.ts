// The visual layer: CodeMirror decorations that make LaTeX read like the
// compiled paper while it stays one editable buffer. Markup hides, math and
// figures render as widgets, and anything under the cursor reveals its source.

import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { RangeSetBuilder, StateField, type Range, type EditorState } from "@codemirror/state";
import katex from "katex";
import type { BibEntry } from "./latex";

export interface VisualContext {
  root: string;
  bib: Record<string, BibEntry>;
  macros: Record<string, string>;
  loadImage: (relPath: string) => Promise<string | null>; // data URL
  openFile: (relPath: string) => void;
}

let ctx: VisualContext = { root: "", bib: {}, macros: {}, loadImage: async () => null, openFile: () => {} };
export function setVisualContext(c: VisualContext) { ctx = c; }

// ---------------------------------------------------------------- widgets

const katexCache = new Map<string, string>();
function renderMath(tex: string, display: boolean): string {
  const key = (display ? "D" : "I") + tex;
  let html = katexCache.get(key);
  if (!html) {
    html = katex.renderToString(tex, { displayMode: display, throwOnError: false, macros: ctx.macros, strict: false });
    katexCache.set(key, html);
  }
  return html;
}

class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean, readonly tag: string, readonly from: number) { super(); }
  eq(o: MathWidget) { return o.tex === this.tex && o.display === this.display && o.tag === this.tag; }
  toDOM() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "vz-eq" : "vz-math";
    el.dataset.from = String(this.from);
    el.innerHTML = renderMath(this.tex, this.display);
    if (this.display && this.tag) { const t = document.createElement("span"); t.className = "vz-eq-tag"; t.textContent = this.tag; el.appendChild(t); }
    return el;
  }
  ignoreEvent() { return false; }
}

class ChipWidget extends WidgetType {
  constructor(readonly kind: "cite" | "ref" | "input", readonly label: string, readonly title: string, readonly from: number, readonly target?: string) { super(); }
  eq(o: ChipWidget) { return o.kind === this.kind && o.label === this.label && o.title === this.title; }
  toDOM() {
    const el = document.createElement("span");
    el.className = `vz-chip vz-${this.kind}`;
    el.textContent = this.label;
    el.title = this.title;
    el.dataset.from = String(this.from);
    if (this.kind === "input" && this.target) {
      el.dataset.open = this.target;
    }
    return el;
  }
  ignoreEvent() { return false; }
}

class TextWidget extends WidgetType {
  constructor(readonly text: string, readonly from: number) { super(); }
  eq(o: TextWidget) { return o.text === this.text; }
  toDOM() { const el = document.createElement("span"); el.textContent = this.text; el.dataset.from = String(this.from); return el; }
  ignoreEvent() { return false; }
}

class TableWidget extends WidgetType {
  constructor(readonly inner: string, readonly number: number, readonly from: number) { super(); }
  eq(o: TableWidget) { return o.inner === this.inner && o.number === this.number; }
  toDOM() {
    const el = document.createElement("figure");
    el.className = "vz-figure vz-tablefig";
    el.dataset.from = String(this.from);
    const caption = /\\caption\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(this.inner)?.[1] ?? "";
    const tab = /\\begin\{tabular\*?\}(?:\{[^}]*\})?\{([^}]*)\}([\s\S]*?)\\end\{tabular\*?\}/.exec(this.inner);
    const table = document.createElement("table");
    table.className = "vz-tab";
    if (tab) {
      const body = tab[2].replace(/%[^\n]*/g, "");
      const rows = body.split(/\\\\/).map((r) => r.trim()).filter((r) => r && !/^\\(toprule|midrule|bottomrule|hline)\s*$/.test(r));
      let sawMid = false;
      rows.forEach((r) => {
        const rule = /\\(midrule|hline|toprule|bottomrule)/.test(r);
        const cleaned = r.replace(/\\(toprule|midrule|bottomrule|hline)/g, "").trim();
        if (!cleaned) { sawMid = sawMid || rule; return; }
        const tr = document.createElement("tr");
        if (rule && !sawMid) { sawMid = true; }
        cleaned.split("&").forEach((c) => {
          const cell = document.createElement(sawMid || table.rows.length > 0 ? "td" : "th");
          cell.innerHTML = inlineHtml(c.trim());
          tr.appendChild(cell);
        });
        table.appendChild(tr);
      });
      const first = table.querySelector("tr");
      if (first && first.querySelector("td") && !table.querySelector("th")) {
        first.querySelectorAll("td").forEach((td) => { const th = document.createElement("th"); th.innerHTML = td.innerHTML; td.replaceWith(th); });
      }
      el.appendChild(table);
    } else {
      const pre = document.createElement("pre"); pre.className = "vz-rawtable"; pre.textContent = this.inner.trim(); el.appendChild(pre);
    }
    const cap = document.createElement("figcaption");
    cap.innerHTML = `<b>Table ${this.number}.</b> ${inlineHtml(caption)}`;
    el.appendChild(cap);
    return el;
  }
  ignoreEvent() { return false; }
}

const imageCache = new Map<string, Promise<string | null>>();

class FigureWidget extends WidgetType {
  constructor(readonly file: string | null, readonly caption: string, readonly number: number, readonly from: number) { super(); }
  eq(o: FigureWidget) { return o.file === this.file && o.caption === this.caption && o.number === this.number; }
  toDOM() {
    const el = document.createElement("figure");
    el.className = "vz-figure";
    el.dataset.from = String(this.from);
    const box = document.createElement("div");
    box.className = "vz-figure-box";
    box.textContent = this.file ? `Loading ${this.file}…` : "No file";
    el.appendChild(box);
    const cap = document.createElement("figcaption");
    cap.innerHTML = `<b>Figure ${this.number}.</b> ${inlineHtml(this.caption)}`;
    el.appendChild(cap);
    if (this.file) {
      const key = this.file;
      if (!imageCache.has(key)) imageCache.set(key, ctx.loadImage(key));
      imageCache.get(key)!.then((url) => {
        if (!url) { box.textContent = `${key} (not found or not renderable)`; return; }
        box.textContent = "";
        const img = document.createElement("img");
        img.src = url; img.alt = `Figure ${this.number}`;
        box.appendChild(img);
      });
    }
    return el;
  }
  ignoreEvent() { return false; }
}

/** Small inline renderer for captions inside widgets. */
function inlineHtml(src: string): string {
  return src
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/\$([^$]+)\$/g, (_, t) => renderMath(t, false))
    .replace(/\\emph\{([^}]*)\}/g, "<em>$1</em>")
    .replace(/\\textbf\{([^}]*)\}/g, "<b>$1</b>")
    .replace(/\\label\{[^}]*\}/g, "")
    .replace(/~/g, " ");
}

function citeLabel(key: string): string {
  const e = ctx.bib[key];
  if (e) return e.label;
  const m = /^([a-zA-Z\-]+?)(\d{4})?[a-z]*$/.exec(key);
  if (!m) return key;
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return m[2] ? `${name} ${m[2]}` : name;
}

// ---------------------------------------------------------------- decoration builder

const hide = Decoration.replace({});
const mark = (cls: string) => Decoration.mark({ class: cls });
const line = (cls: string) => Decoration.line({ class: cls });

const ENV_BLOCK = /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|figure\*?|table\*?)\}/g;

/** True when the selection lies strictly inside the range, or a non-empty selection overlaps it. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.empty) { if (r.from > from && r.from < to) return true; }
    else if (r.from < to && r.to > from) return true;
  }
  return false;
}
function cursorOnLine(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).from, b = state.doc.lineAt(r.to).to;
    if (a <= to && b >= from) return true;
  }
  return false;
}

export function buildDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const text = doc.toString();
  const ranges: Range<Decoration>[] = [];
  const push = (from: number, to: number, d: Decoration) => { if (to >= from) ranges.push(d.range(from, to)); };

  // Preamble: everything before \begin{document}
  const beginDoc = text.indexOf("\\begin{document}");
  const bodyStart = beginDoc >= 0 ? beginDoc : 0;
  if (beginDoc > 0) {
    let l = doc.lineAt(0);
    while (l.from < beginDoc) { if (!/^\s*\\(title|author)\{/.test(l.text)) push(l.from, l.from, line("vz-preamble")); if (l.to >= doc.length) break; l = doc.lineAt(l.to + 1); }
  }

  // Block environments: equations, figures, tables. Whole-doc scan.
  const blocked: [number, number][] = [];
  let eqCount = 0, figCount = 0, tabCount = 0;
  ENV_BLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENV_BLOCK.exec(text))) {
    const env = m[1];
    const endTag = `\\end{${env}}`;
    const end = text.indexOf(endTag, m.index);
    if (end < 0) continue;
    const from = m.index, to = end + endTag.length;
    const inner = text.slice(m.index + m[0].length, end);
    const isMath = /^(equation|align|gather|multline)/.test(env);
    const isFig = env.startsWith("figure");
    const isTab = env.startsWith("table");
    if (isMath && !env.endsWith("*")) eqCount++;
    if (isFig) figCount++;
    if (isTab) tabCount++;
    blocked.push([from, to]);
    if (selectionTouches(state, from, to)) {
      // Revealed: dim the env tags, keep source editable.
      push(from, from + m[0].length, mark("vz-envtag"));
      push(end, to, mark("vz-envtag"));
      continue;
    }
    if (isMath) {
      const tex = inner.replace(/\\label\{[^}]*\}/g, "").trim();
      const tag = env.endsWith("*") ? "" : `(${eqCount})`;
      push(from, to, Decoration.replace({ widget: new MathWidget(tex, true, tag, from), block: true }));
    } else if (isFig) {
      const file = /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/.exec(inner)?.[1] ?? null;
      const caption = /\\caption\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(inner)?.[1] ?? "";
      push(from, to, Decoration.replace({ widget: new FigureWidget(file, caption, figCount, from), block: true }));
    } else if (isTab) {
      push(from, to, Decoration.replace({ widget: new TableWidget(inner, tabCount, from), block: true }));
    }
  }
  const inBlocked = (pos: number) => blocked.some(([a, b]) => pos >= a && pos < b);

  // Line-based rules
  for (let i = 1; i <= doc.lines; i++) {
    const l = doc.line(i);
    const s = l.text;
    if (l.from < bodyStart && beginDoc > 0 && !/^\s*\\(title|author)\{/.test(s)) continue;
    if (inBlocked(l.from) && !selectionTouches(state, l.from, l.to)) continue;
    const revealed = cursorOnLine(state, l.from, l.to);

    // Comments
    const cm = /(^|[^\\])(%.*)$/.exec(s);
    if (cm) push(l.from + cm.index + cm[1].length, l.to, mark("vz-comment"));

    // Headings and title/author
    const sec = /^(\s*)\\(section|subsection|subsubsection|paragraph|title|author)\*?\{(.*)\}\s*$/.exec(s);
    if (sec) {
      push(l.from, l.from, line(`vz-${sec[2]}`));
      if (!revealed) {
        const open = l.from + sec[1].length + sec[2].length + 2 + (s.includes("*{") ? 1 : 0);
        push(l.from + sec[1].length, open, hide);
        push(l.from + s.lastIndexOf("}"), l.to, hide);
        if (sec[2] === "author") {
          const andRe = /\s*\\and\b\s*/g; let am: RegExpExecArray | null;
          while ((am = andRe.exec(s))) push(l.from + am.index, l.from + am.index + am[0].length, Decoration.replace({ widget: new TextWidget(", ", l.from + am.index) }));
        }
      }
      continue;
    }

    // Lines that are pure scaffolding
    if (/^\s*\\(begin\{document\}|end\{document\}|maketitle|centering|noindent|begin\{abstract\}|end\{abstract\}|begin\{itemize\}|end\{itemize\}|begin\{enumerate\}|end\{enumerate\}|label\{[^}]*\}|bibliographystyle\{[^}]*\}|clearpage|newpage|vspace\{[^}]*\})\s*$/.test(s)) {
      push(l.from, l.from, line(revealed ? "vz-scaffold" : "vz-hidden"));
      if (!revealed && l.to > l.from) push(l.from, l.to, hide);
      continue;
    }
    if (/^\s*\\bibliography\{/.test(s)) {
      push(l.from, l.from, line("vz-references"));
      if (!revealed) push(l.from, l.to, Decoration.replace({ widget: new ChipWidget("ref", "References are generated at compile time from " + (/\{([^}]*)\}/.exec(s)?.[1] ?? "") + ".bib", s, l.from) }));
      continue;
    }

    // Abstract body: the lines between \begin{abstract} and \end{abstract}
    // are handled by the vz-abstract line class computed below.

    // \item
    const item = /^(\s*)\\item\s?/.exec(s);
    if (item) { push(l.from, l.from, line("vz-item")); if (!revealed) push(l.from + item[1].length, l.from + item[0].length, Decoration.replace({ widget: new ChipWidget("ref", "•", "\\item", l.from) })); }

    if (revealed) continue;

    // Inline math
    const im = /\$([^$\n]+)\$/g; let mm: RegExpExecArray | null;
    while ((mm = im.exec(s))) {
      const from = l.from + mm.index, to = from + mm[0].length;
      if (selectionTouches(state, from, to)) continue;
      push(from, to, Decoration.replace({ widget: new MathWidget(mm[1], false, "", from) }));
    }
    // Citations and refs
    const cr = /\\(cite[tp]?\*?|ref|eqref|autoref|cref|Cref)\{([^}]*)\}/g;
    while ((mm = cr.exec(s))) {
      const from = l.from + mm.index, to = from + mm[0].length;
      if (selectionTouches(state, from, to)) continue;
      const keys = mm[2].split(",").map((k) => k.trim());
      if (mm[1].startsWith("cite")) push(from, to, Decoration.replace({ widget: new ChipWidget("cite", keys.map(citeLabel).join("; "), keys.map((k) => ctx.bib[k]?.title ?? k).join("\n"), from) }));
      else push(from, to, Decoration.replace({ widget: new ChipWidget("ref", keys[0].replace(/^(fig|eq|sec|tab):/, ""), mm[0], from) }));
    }
    // \input / \include
    const inp = /\\(?:input|include)\{([^}]*)\}/g;
    while ((mm = inp.exec(s))) {
      const from = l.from + mm.index, to = from + mm[0].length;
      if (selectionTouches(state, from, to)) continue;
      const rel = mm[1].endsWith(".tex") ? mm[1] : `${mm[1]}.tex`;
      push(from, to, Decoration.replace({ widget: new ChipWidget("input", `Included: ${rel}`, "Click to open", from, rel) }));
    }
    // Emphasis: hide the markup, style the content
    const em = /\\(emph|textit|textbf|texttt)\{([^{}]*)\}/g;
    while ((mm = em.exec(s))) {
      const from = l.from + mm.index, to = from + mm[0].length;
      if (selectionTouches(state, from, to)) continue;
      const open = from + mm[1].length + 2;
      push(from, open, hide);
      push(open, to - 1, mark(mm[1] === "textbf" ? "vz-bold" : mm[1] === "texttt" ? "vz-mono" : "vz-em"));
      push(to - 1, to, hide);
    }
    // Inline scaffolding inside text
    const lab = /\\label\{[^}]*\}|~|\\@|\\,|\\and\b|\\\\|---|--/g;
    while ((mm = lab.exec(s))) {
      const from = l.from + mm.index, to = from + mm[0].length;
      if (selectionTouches(state, from, to)) continue;
      const t = mm[0];
      const replacement = t === "~" ? "\u00a0" : t === "\\and" ? ", " : t === "---" ? "\u2014" : t === "--" ? "\u2013" : t === "\\\\" ? "" : null;
      if (replacement === null) push(from, to, hide);
      else push(from, to, Decoration.replace({ widget: new TextWidget(replacement, from) }));
    }
  }

  // Abstract lines
  const absStart = text.indexOf("\\begin{abstract}"), absEnd = text.indexOf("\\end{abstract}");
  if (absStart >= 0 && absEnd > absStart) {
    let l = doc.lineAt(absStart + 16);
    let first = true;
    while (l.from < absEnd) {
      if (l.text.trim()) { push(l.from, l.from, line(first ? "vz-abstract vz-abstract-first" : "vz-abstract")); first = false; }
      if (l.to >= doc.length) break; l = doc.lineAt(l.to + 1);
    }
  }

  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  const builder = new RangeSetBuilder<Decoration>();
  let lastFrom = -1, lastTo = -1;
  for (const r of ranges) {
    // Drop overlaps that the builder cannot take (a hide inside a replaced block, for example).
    if (r.from < lastTo && !(r.from === lastFrom && r.to === lastTo && r.value.spec.class)) continue;
    builder.add(r.from, r.to, r.value);
    if (r.to > r.from) { lastFrom = r.from; lastTo = r.to; }
  }
  return builder.finish();
}

// ---------------------------------------------------------------- extension

// Block widgets must come from a state field, not a view plugin.
const visualField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (deco, tr) => (tr.docChanged || tr.selection ? buildDecorations(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

const visualEvents = EditorView.domEventHandlers({
  mousedown(e, view) {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-from]");
    if (!t) return false;
    if (t.dataset.open) { ctx.openFile(t.dataset.open); e.preventDefault(); return true; }
    const from = Number(t.dataset.from);
    const isBlock = t.classList.contains("vz-eq") || t.classList.contains("vz-figure");
    // Place the cursor just inside the construct so it reveals its source.
    const inside = Math.min(view.state.doc.length, isBlock ? view.state.doc.lineAt(from).to + 1 : from + 1);
    view.dispatch({ selection: { anchor: inside }, scrollIntoView: true });
    view.focus();
    e.preventDefault();
    return true;
  },
});

export const visualTheme = EditorView.theme({
  "&": { fontFamily: "var(--font-doc)", fontSize: "var(--doc-size)" },
  ".cm-content": { maxWidth: "68ch", margin: "0 auto", padding: "56px 48px 160px", lineHeight: "var(--doc-leading)", fontFamily: "var(--font-doc)" },
  ".cm-line": { padding: "0" },
  ".cm-gutters": { display: "none" },
  ".cm-activeLine": { backgroundColor: "transparent" },
});

export function visualExtensions() { return [visualField, visualEvents, visualTheme, EditorView.editorAttributes.of({ class: "cm-visual" })]; }
