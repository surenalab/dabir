// The visual layer for Typst: the same idea as the LaTeX layer, built on the
// same widgets. Headings, figures, citations, links and emphasis read like the
// paper; set rules fold into a preamble row; math stays as source, because
// Typst's math syntax has no browser renderer here. Anything under the cursor
// shows its source.

import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { Range, EditorState } from "@codemirror/state";
import { ChipWidget, FigureWidget, FoldWidget, TextWidget, badger, citeLabel, cursorOnLine, decorationField, finishRanges, hide, line, mark, selectionTouches, visualContext, visualEvents, visualTheme } from "./visual";

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

/** Caption text for a widget: Typst markup reduced to plain words. */
function plainCaption(src: string): string {
  return src.replace(/\$[^$]*\$/g, (m) => m.slice(1, -1)).replace(/[*_]/g, "").replace(/#[a-zA-Z]+(\[[^\]]*\])?/g, (m) => /\[/.test(m) ? m.slice(m.indexOf("[") + 1, -1) : "").replace(/<[^>]*>/g, "").trim();
}

const PREAMBLE_LINE = /^\s*(#(set|show|import|include|let)\b.*|\/\/.*)?\s*$/;

export function buildTypstDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const text = doc.toString();
  const ranges: Range<Decoration>[] = [];
  const push = (from: number, to: number, d: Decoration) => { if (to >= from) ranges.push(d.range(from, to)); };
  const badge = badger(state);
  const bib = visualContext().bib;

  // Preamble: the leading run of set/show/import rules folds into one row until the cursor enters it.
  let preambleEnd = 0;
  {
    let l = doc.line(1), last = -1, lines = 0;
    while (PREAMBLE_LINE.test(l.text)) {
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

  // Figures: #figure(...) spanning one or more lines becomes a rendered figure.
  const blocked: [number, number][] = [];
  let figCount = 0;
  const figRe = /#figure\(/g; let m: RegExpExecArray | null;
  while ((m = figRe.exec(text))) {
    const from = m.index, to = closeOf(text, m.index + m[0].length - 1);
    if (to < 0 || from < preambleEnd) continue;
    // Take the trailing label too, so the row hides completely.
    const tail = /^\s*<[^>\n]*>/.exec(text.slice(to));
    const end = tail ? to + tail[0].length : to;
    figCount++;
    blocked.push([from, end]);
    const inner = text.slice(from + m[0].length, to - 1);
    if (selectionTouches(state, from, end)) { push(from, from + m[0].length, mark("vz-envtag")); push(to - 1, to, mark("vz-envtag")); continue; }
    const file = /image\(\s*"([^"]*)"/.exec(inner)?.[1] ?? null;
    const capAt = inner.indexOf("caption:");
    let caption = "";
    if (capAt >= 0) {
      const open = inner.indexOf("[", capAt);
      const close = open >= 0 ? closeOf(inner, open) : -1;
      caption = close > 0 ? plainCaption(inner.slice(open + 1, close - 1)) : "";
    }
    push(from, end, Decoration.replace({ widget: badge(new FigureWidget(file, caption, figCount, from), from, end), block: true }));
  }
  const inBlocked = (pos: number) => blocked.some(([a, b]) => pos >= a && pos < b);

  for (let i = 1; i <= doc.lines; i++) {
    const l = doc.line(i);
    const s = l.text;
    if (l.to <= preambleEnd) continue;
    if (inBlocked(l.from) && !selectionTouches(state, l.from, l.to)) continue;
    const revealed = cursorOnLine(state, l.from, l.to);

    // Comments
    const cm = /(^|[^:])(\/\/.*)$/.exec(s);
    if (cm && !/https?:$/.test(s.slice(0, cm.index + cm[1].length))) push(l.from + cm.index + cm[1].length, l.to, mark("vz-comment"));

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
    const bibl = /^\s*#bibliography\(\s*"([^"]*)"/.exec(s);
    if (bibl) {
      push(l.from, l.from, line("vz-references"));
      if (!revealed) push(l.from, l.to, Decoration.replace({ widget: new ChipWidget("ref", `References are generated at compile time from ${bibl[1]}`, s, l.from) }));
      continue;
    }

    // List items
    const item = /^(\s*)([-+])\s/.exec(s);
    if (item) { push(l.from, l.from, line("vz-item")); if (!revealed) push(l.from + item[1].length, l.from + item[0].length, Decoration.replace({ widget: new ChipWidget("ref", item[2] === "-" ? "•" : "1.", "list item", l.from) })); }

    if (revealed) continue;

    let mm: RegExpExecArray | null;
    // Math stays as source but reads as math: inline $x$ and display $ x $.
    const im = /\$([^$\n]+)\$/g;
    while ((mm = im.exec(s))) {
      const from = l.from + mm.index, to = from + mm[0].length;
      if (selectionTouches(state, from, to)) continue;
      push(from, from + 1, hide); push(from + 1, to - 1, mark("vz-typ-math")); push(to - 1, to, hide);
    }
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
