// The visual layer: CodeMirror decorations that make LaTeX read like the
// compiled paper while it stays one editable buffer. Markup hides, math and
// figures render as widgets, and anything under the cursor reveals its source.

import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField, type Range, type EditorState, type Extension } from "@codemirror/state";
import katex from "katex";
import type { BibEntry } from "./latex";
import { changesField, safeColor, type ChangeKind } from "./changes";

export interface VisualContext {
  revealOnClick: boolean;
  root: string;
  bib: Record<string, BibEntry>;
  macros: Record<string, string>;
  loadImage: (relPath: string) => Promise<string | null>; // data URL
  openFile: (relPath: string) => void;
}

let ctx: VisualContext = { revealOnClick: true, root: "", bib: {}, macros: {}, loadImage: async () => null, openFile: () => {} };
export function setVisualContext(c: VisualContext) { ctx = c; }
export const visualContext = () => ctx;

// ---------------------------------------------------------------- widgets

/** A pending suggestion that overlaps a widget's source. The widget cannot show the marked text itself,
 *  so it carries the author's colour and a label; clicking reveals the source with the marks. */
export interface SuggBadge { kind: ChangeKind | "mixed"; color: string; author: string; count: number }
const sameSugg = (a: SuggBadge | null, b: SuggBadge | null) => (a === b) || (!!a && !!b && a.kind === b.kind && a.color === b.color && a.author === b.author && a.count === b.count);

/** A coauthor's caret (and selection) as absolute offsets. Widgets that hide the caret's text wear the name instead. */
export interface RemoteCursor { pos: number; from: number; to: number; name: string; color: string }
export const setRemoteCursors = StateEffect.define<RemoteCursor[]>();
export const remoteCursorsField = StateField.define<RemoteCursor[]>({
  create: () => [],
  update(cs, tr) {
    for (const e of tr.effects) if (e.is(setRemoteCursors)) return e.value;
    return tr.docChanged ? cs.map((c) => ({ ...c, pos: tr.changes.mapPos(c.pos), from: tr.changes.mapPos(c.from), to: tr.changes.mapPos(c.to) })) : cs;
  },
});

class PeerCaret extends WidgetType {
  constructor(readonly name: string, readonly color: string) { super(); }
  eq(o: PeerCaret) { return o.name === this.name && o.color === this.color; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-peer-caret";
    el.style.setProperty("--peer-color", safeColor(this.color));
    el.setAttribute("aria-label", `${this.name} is here`);
    const name = document.createElement("span");
    name.className = "cm-peer-caret-name";
    name.textContent = this.name;
    el.appendChild(name);
    return el;
  }
  ignoreEvent() { return true; }
}

/** Nearest position CodeMirror can actually draw at. Visual replace-widgets swallow source offsets, which is why a
 *  caret that was accurate in Source vanished or sat on the wrong glyph in Visual. */
function nearestVisible(view: EditorView, pos: number): number {
  const len = view.state.doc.length;
  pos = Math.max(0, Math.min(pos, len));
  const ok = (p: number) => { try { return view.coordsAtPos(p) != null; } catch { return false; } };
  if (ok(pos)) return pos;
  for (let d = 1; d < 400; d++) {
    if (pos + d <= len && ok(pos + d)) return pos + d;
    if (pos - d >= 0 && ok(pos - d)) return pos - d;
  }
  return pos;
}

function peerCaretSet(view: EditorView): DecorationSet {
  const cs = view.state.field(remoteCursorsField, false) ?? [];
  const ranges: Range<Decoration>[] = [];
  for (const c of cs) {
    const from = nearestVisible(view, c.from);
    const to = nearestVisible(view, c.to);
    const a = Math.min(from, to), b = Math.max(from, to);
    if (b > a) ranges.push(Decoration.mark({ class: "cm-peer-sel", attributes: { style: `--peer-color:${safeColor(c.color)}` } }).range(a, b));
    ranges.push(Decoration.widget({ widget: new PeerCaret(c.name, c.color), side: 1 }).range(nearestVisible(view, c.pos)));
  }
  return Decoration.set(ranges, true);
}

/** Remote carets and selections that survive Visual's replace widgets. Always on; y-codemirror.next's own marks
 *  sit at source offsets and disappear inside hidden markup. */
export function remoteCarets(): Extension {
  return ViewPlugin.fromClass(class {
    deco: DecorationSet;
    constructor(view: EditorView) { this.deco = peerCaretSet(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(setRemoteCursors)))) this.deco = peerCaretSet(u.view);
    }
  }, { decorations: (v) => v.deco });
}
const samePeers = (a: RemoteCursor[], b: RemoteCursor[]) => a.length === b.length && a.every((x, i) => x.name === b[i].name && x.color === b[i].color);

export abstract class VzWidget extends WidgetType {
  sugg: SuggBadge | null = null;
  peers: RemoteCursor[] = [];
  abstract render(): HTMLElement;
  /** Subclasses compare their own content; this adds the badges every widget can wear. */
  sameBadges(o: VzWidget) { return sameSugg(this.sugg, o.sugg) && samePeers(this.peers, o.peers); }
  toDOM() {
    const el = this.render();
    const s = this.sugg;
    if (s) {
      el.classList.add("vz-sugg", s.kind);
      el.style.setProperty("--sugg-color", safeColor(s.color));
      const what = s.kind === "insert" ? "an insertion" : s.kind === "delete" ? "a deletion" : `${s.count} changes`;
      el.dataset.sugg = `${s.author} suggests ${what}`;
      el.title = `${s.author} suggests ${what} here. Click to review the source.`;
    }
    if (this.peers.length) {
      el.classList.add("vz-peers");
      el.style.setProperty("--peer-color", safeColor(this.peers[0].color));
      const tags = document.createElement("span");
      tags.className = "vz-peer-tags";
      tags.setAttribute("aria-label", `${this.peers.map((p) => p.name).join(", ")} editing here`);
      for (const p of this.peers) {
        const t = document.createElement("span");
        t.className = "vz-peer";
        t.style.setProperty("--peer-color", safeColor(p.color));
        t.textContent = p.name;
        tags.appendChild(t);
      }
      el.appendChild(tags);
    }
    return el;
  }
}

const katexCache = new Map<string, string>();
export function renderMath(tex: string, display: boolean): string {
  const key = (display ? "D" : "I") + tex;
  let html = katexCache.get(key);
  if (!html) {
    html = katex.renderToString(tex, { displayMode: display, throwOnError: false, macros: ctx.macros, strict: false });
    katexCache.set(key, html);
  }
  return html;
}

export class MathWidget extends VzWidget {
  constructor(readonly tex: string, readonly display: boolean, readonly tag: string, readonly from: number) { super(); }
  eq(o: MathWidget) { return this.sameBadges(o) && o.tex === this.tex && o.display === this.display && o.tag === this.tag; }
  render() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "vz-eq" : "vz-math";
    el.dataset.from = String(this.from);
    el.innerHTML = renderMath(this.tex, this.display);
    if (this.display && this.tag) { const t = document.createElement("span"); t.className = "vz-eq-tag"; t.textContent = this.tag; el.appendChild(t); }
    return el;
  }
  ignoreEvent() { return false; }
}

/** A folded run of preamble lines. Click to open it. */
export class FoldWidget extends VzWidget {
  constructor(readonly lines: number, readonly first: string, readonly from: number) { super(); }
  eq(o: FoldWidget) { return this.sameBadges(o) && o.lines === this.lines && o.first === this.first; }
  render() {
    const el = document.createElement("div");
    el.className = "vz-fold";
    el.dataset.from = String(this.from);
    el.title = "Click to edit the preamble";
    el.innerHTML = `<span class="vz-fold-label">Preamble</span><span class="vz-fold-meta">${this.lines} line${this.lines === 1 ? "" : "s"} · ${this.first.replace(/&/g, "&amp;").replace(/</g, "&lt;").slice(0, 60)}</span>`;
    return el;
  }
  ignoreEvent() { return false; }
}

/** Rendered preview shown under an equation while its source is open for editing. */
export class PreviewWidget extends WidgetType {
  constructor(readonly tex: string) { super(); }
  eq(o: PreviewWidget) { return o.tex === this.tex; }
  toDOM() {
    const el = document.createElement("div");
    el.className = "vz-preview";
    el.innerHTML = renderMath(this.tex, true);
    return el;
  }
  ignoreEvent() { return true; }
}

export class ChipWidget extends VzWidget {
  constructor(readonly kind: "cite" | "ref" | "input" | "note" | "link", readonly label: string, readonly title: string, readonly from: number, readonly target?: string) { super(); }
  eq(o: ChipWidget) { return this.sameBadges(o) && o.kind === this.kind && o.label === this.label && o.title === this.title; }
  render() {
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

export class TextWidget extends VzWidget {
  constructor(readonly text: string, readonly from: number) { super(); }
  eq(o: TextWidget) { return this.sameBadges(o) && o.text === this.text; }
  render() { const el = document.createElement("span"); el.textContent = this.text; el.dataset.from = String(this.from); return el; }
  ignoreEvent() { return false; }
}

class TableWidget extends VzWidget {
  constructor(readonly inner: string, readonly number: number, readonly from: number) { super(); }
  eq(o: TableWidget) { return this.sameBadges(o) && o.inner === this.inner && o.number === this.number; }
  render() {
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

export class FigureWidget extends VzWidget {
  constructor(readonly file: string | null, readonly caption: string, readonly number: number, readonly from: number) { super(); }
  eq(o: FigureWidget) { return this.sameBadges(o) && o.file === this.file && o.caption === this.caption && o.number === this.number; }
  render() {
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
export function inlineHtml(src: string): string {
  return src
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/\$([^$]+)\$/g, (_, t) => renderMath(t, false))
    .replace(/\\emph\{([^}]*)\}/g, "<em>$1</em>")
    .replace(/\\textbf\{([^}]*)\}/g, "<b>$1</b>")
    .replace(/\\label\{[^}]*\}/g, "")
    .replace(/~/g, " ");
}

/** KaTeX renders align and gather only through their inner forms. */
function mathBody(env: string, inner: string): string {
  const tex = inner.replace(/\\label\{[^}]*\}/g, "").trim();
  const base = env.replace("*", "");
  if (base === "align") return `\\begin{aligned}${tex}\\end{aligned}`;
  if (base === "gather") return `\\begin{gathered}${tex}\\end{gathered}`;
  if (base === "multline") return `\\begin{gathered}${tex.replace(/\\\\/g, "\\\\")}\\end{gathered}`;
  return tex;
}

export function citeLabel(key: string): string {
  const e = ctx.bib[key];
  if (e) return e.label;
  const m = /^([a-zA-Z-]+?)(\d{4})?[a-z]*$/.exec(key);
  if (!m) return key;
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return m[2] ? `${name} ${m[2]}` : name;
}

// ---------------------------------------------------------------- decoration builder

export const hide = Decoration.replace({});
export const mark = (cls: string) => Decoration.mark({ class: cls });
export const line = (cls: string) => Decoration.line({ class: cls });

const ENV_BLOCK = /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|figure\*?|table\*?)\}/g;

/** True when the selection lies strictly inside the range, or a non-empty selection overlaps it. */
export function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.empty) { if (r.from > from && r.from < to) return true; }
    else if (r.from < to && r.to > from) return true;
  }
  return false;
}
export function cursorOnLine(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).from, b = state.doc.lineAt(r.to).to;
    if (a <= to && b >= from) return true;
  }
  return false;
}

/** Suggestions whose text a widget would hide, and coauthors' carets inside it: the widget wears the badges instead. */
export function badger(state: EditorState) {
  const suggs = state.field(changesField, false)?.items ?? [];
  const cursors = state.field(remoteCursorsField, false) ?? [];
  return <T extends VzWidget>(w: T, from: number, to: number): T => {
    const hits = suggs.filter((c) => c.from < to && c.to > from);
    if (hits.length) {
      const kinds = new Set(hits.map((c) => c.kind));
      w.sugg = { kind: kinds.size === 1 ? hits[0].kind : "mixed", color: hits[0].color, author: hits.every((c) => c.author === hits[0].author) ? hits[0].author : `${hits[0].author} and others`, count: hits.length };
    }
    const here = cursors.filter((c) => c.pos > from && c.pos < to);
    if (here.length) w.peers = here;
    return w;
  };
}

/** Sorts the collected ranges and drops overlaps the builder cannot take (a hide inside a replaced block, for example). */
export function finishRanges(ranges: Range<Decoration>[]): DecorationSet {
  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  const builder = new RangeSetBuilder<Decoration>();
  let lastFrom = -1, lastTo = -1;
  for (const r of ranges) {
    if (r.from < lastTo && !(r.from === lastFrom && r.to === lastTo && r.value.spec.class)) continue;
    builder.add(r.from, r.to, r.value);
    if (r.to > r.from) { lastFrom = r.from; lastTo = r.to; }
  }
  return builder.finish();
}

export function buildDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const text = doc.toString();
  const ranges: Range<Decoration>[] = [];
  const push = (from: number, to: number, d: Decoration) => { if (to >= from) ranges.push(d.range(from, to)); };
  const badge = badger(state);

  // Preamble: everything before \begin{document}
  const beginDoc = text.indexOf("\\begin{document}");
  const bodyStart = beginDoc >= 0 ? beginDoc : 0;
  if (beginDoc > 0) {
    // Runs of preamble lines fold into one row; title and author stay visible. A run opens when the cursor enters it.
    let l = doc.lineAt(0);
    let run: { from: number; to: number; lines: number } | null = null;
    const flush = () => {
      if (!run) return;
      const r0 = run;
      const touched = state.selection.ranges.some((r) => (r.empty ? r.from > r0.from && r.from <= r0.to : r.from < r0.to && r.to > r0.from));
      if (touched || r0.lines < 2) {
        let x = doc.lineAt(r0.from);
        while (x.from <= r0.to) { push(x.from, x.from, line("vz-preamble")); if (x.to >= doc.length) break; x = doc.lineAt(x.to + 1); }
      } else {
        push(r0.from, r0.to, Decoration.replace({ widget: badge(new FoldWidget(r0.lines, doc.lineAt(r0.from).text.trim(), r0.from), r0.from, r0.to), block: true }));
      }
      run = null;
    };
    while (l.from < beginDoc) {
      if (/^\s*\\(title|author)\{/.test(l.text)) flush();
      else if (run) { run.to = l.to; run.lines++; }
      else run = { from: l.from, to: l.to, lines: 1 };
      if (l.to >= doc.length) break; l = doc.lineAt(l.to + 1);
    }
    flush();
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
      // Revealed: dim the env tags, keep source editable, and show the rendered result underneath as it changes.
      push(from, from + m[0].length, mark("vz-envtag"));
      push(end, to, mark("vz-envtag"));
      if (isMath) push(to, to, Decoration.widget({ widget: new PreviewWidget(mathBody(env, inner)), block: true, side: 1 }));
      continue;
    }
    if (isMath) {
      const tex = mathBody(env, inner);
      const tag = env.endsWith("*") ? "" : `(${eqCount})`;
      push(from, to, Decoration.replace({ widget: badge(new MathWidget(tex, true, tag, from), from, to), block: true }));
    } else if (isFig) {
      const file = /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/.exec(inner)?.[1] ?? null;
      const caption = /\\caption\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(inner)?.[1] ?? "";
      push(from, to, Decoration.replace({ widget: badge(new FigureWidget(file, caption, figCount, from), from, to), block: true }));
    } else if (isTab) {
      push(from, to, Decoration.replace({ widget: badge(new TableWidget(inner, tabCount, from), from, to), block: true }));
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
      push(from, to, Decoration.replace({ widget: badge(new MathWidget(mm[1], false, "", from), from, to) }));
    }
    // Citations and refs
    const cr = /\\(cite[tp]?\*?|ref|eqref|autoref|cref|Cref)\{([^}]*)\}/g;
    while ((mm = cr.exec(s))) {
      const from = l.from + mm.index, to = from + mm[0].length;
      if (selectionTouches(state, from, to)) continue;
      const keys = mm[2].split(",").map((k) => k.trim());
      if (mm[1].startsWith("cite")) push(from, to, Decoration.replace({ widget: badge(new ChipWidget("cite", keys.map(citeLabel).join("; "), keys.map((k) => ctx.bib[k]?.title ?? k).join("\n"), from), from, to) }));
      else push(from, to, Decoration.replace({ widget: badge(new ChipWidget("ref", keys[0].replace(/^(fig|eq|sec|tab):/, ""), mm[0], from), from, to) }));
    }
    // \input / \include
    const inp = /\\(?:input|include)\{([^}]*)\}/g;
    while ((mm = inp.exec(s))) {
      const from = l.from + mm.index, to = from + mm[0].length;
      if (selectionTouches(state, from, to)) continue;
      const rel = mm[1].endsWith(".tex") ? mm[1] : `${mm[1]}.tex`;
      push(from, to, Decoration.replace({ widget: badge(new ChipWidget("input", `Included: ${rel}`, "Click to open", from, rel), from, to) }));
    }
    // Footnotes become a marker that shows the note on hover
    const fn = /\\footnote\{((?:[^{}]|\{[^{}]*\})*)\}/g;
    while ((mm = fn.exec(s))) {
      const from = l.from + mm.index, to = from + mm[0].length;
      if (selectionTouches(state, from, to)) continue;
      push(from, to, Decoration.replace({ widget: badge(new ChipWidget("note", "†", mm[1], from), from, to) }));
    }
    // Links
    const url = /\\(?:href\{([^}]*)\}\{([^}]*)\}|url\{([^}]*)\})/g;
    while ((mm = url.exec(s))) {
      const from = l.from + mm.index, to = from + mm[0].length;
      if (selectionTouches(state, from, to)) continue;
      push(from, to, Decoration.replace({ widget: badge(new ChipWidget("link", mm[2] ?? mm[3] ?? "", mm[1] ?? mm[3] ?? "", from), from, to) }));
    }
    // Emphasis: hide the markup, style the content
    const em = /\\(emph|textit|textbf|texttt|textsc|textsuperscript|textsubscript)\{([^{}]*)\}/g;
    const emClass: Record<string, string> = { textbf: "vz-bold", texttt: "vz-mono", textsc: "vz-sc", textsuperscript: "vz-sup", textsubscript: "vz-sub" };
    while ((mm = em.exec(s))) {
      const from = l.from + mm.index, to = from + mm[0].length;
      if (selectionTouches(state, from, to)) continue;
      const open = from + mm[1].length + 2;
      push(from, open, hide);
      push(open, to - 1, mark(emClass[mm[1]] ?? "vz-em"));
      push(to - 1, to, hide);
    }
    // Inline scaffolding inside text
    const lab = /\\label\{[^}]*\}|~|\\@|\\,|\\;|\\and\b|\\\\|---|--|``|''|\\(?:ldots|dots)\b|\\[%&_#$]/g;
    const glyph: Record<string, string> = { "~": "\u00a0", "\\and": ", ", "---": "\u2014", "--": "\u2013", "\\\\": "", "``": "\u201c", "''": "\u201d", "\\ldots": "\u2026", "\\dots": "\u2026", "\\%": "%", "\\&": "&", "\\_": "_", "\\#": "#", "\\$": "$" };
    while ((mm = lab.exec(s))) {
      const from = l.from + mm.index, to = from + mm[0].length;
      if (selectionTouches(state, from, to)) continue;
      const t = mm[0];
      const replacement = t in glyph ? glyph[t] : null;
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

  return finishRanges(ranges);
}

// ---------------------------------------------------------------- extension

// Block widgets must come from a state field, not a view plugin.
export function decorationField(build: (state: EditorState) => DecorationSet) {
  return StateField.define<DecorationSet>({
    create: (state) => build(state),
    update: (deco, tr) => {
      if (tr.docChanged) return build(tr.state);
      if (tr.startState.field(changesField, false)?.items !== tr.state.field(changesField, false)?.items) return build(tr.state);
      if (tr.effects.some((e) => e.is(setRemoteCursors))) return build(tr.state);
      if (!tr.selection) return deco;
      // Skip a full rebuild when the caret stays on the same line(s); widgets only reveal on line intersection.
      const a = tr.startState.selection.main, b = tr.state.selection.main;
      const sameLine = tr.startState.doc.lineAt(a.head).number === tr.state.doc.lineAt(b.head).number
        && tr.startState.doc.lineAt(a.anchor).number === tr.state.doc.lineAt(b.anchor).number
        && a.empty === b.empty;
      return sameLine ? deco : build(tr.state);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
const visualField = decorationField(buildDecorations);

export const visualEvents = EditorView.domEventHandlers({
  mousedown(e, view) {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-from]");
    if (!t) return false;
    if (t.dataset.open) { ctx.openFile(t.dataset.open); e.preventDefault(); return true; }
    if (!ctx.revealOnClick) return false;
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
  "&": { fontFamily: "var(--font-doc)", fontSize: "var(--doc-size, 16.5px)" },
  ".cm-content": { maxWidth: "68ch", margin: "0 auto", padding: "56px 48px 160px", lineHeight: "var(--doc-leading)", fontFamily: "var(--font-doc)" },
  ".cm-line": { padding: "0" },
  ".cm-gutters": { display: "none" },
  ".cm-activeLine": { backgroundColor: "transparent" },
});

export function visualExtensions() { return [visualField, visualEvents, visualTheme, EditorView.editorAttributes.of({ class: "cm-visual" })]; }
