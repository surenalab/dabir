// LaTeX assistance the language package does not give: completions that know the whole paper
// (labels with their caption and section, the author's own macros, glyphs beside symbol names,
// snippets with tab stops), `$` that pairs like a bracket, go-to-definition on labels, keys,
// files and macros, and the partner of the \begin or \end under the caret.

import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { EditorView, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { linter, type Diagnostic } from "@codemirror/lint";
import { findMatchingEnvironment, latexLinter, symbolIndex } from "codemirror-lang-latex";
import type { PaperMap, PaperAnchor, Entry } from "./backend";
import type { BibEntry, OutlineItem } from "./latex";

/** The outline of the whole paper from its map, numbered the way the document numbers it; null when the
 * paper is one file (the live buffer's outline is better then, since it follows unsaved edits). */
export function paperOutline(map: PaperMap | null): OutlineItem[] | null {
  if (!map || map.files.length < 2) return null;
  const counters = [0, 0, 0, 0, 0];
  const out: OutlineItem[] = [];
  for (const h of map.headings) {
    const lvl = Math.min(h.level, 4);
    if (lvl < 1 || lvl > 3) continue;
    if (h.numbered) { counters[lvl]++; for (let i = lvl + 1; i < counters.length; i++) counters[i] = 0; }
    const number = h.numbered ? Array.from({ length: lvl }, (_, i) => counters[i + 1]).filter((n) => n > 0).join(".") : "";
    out.push({ level: lvl as 1 | 2 | 3, number, text: h.title, line: h.line, file: h.file });
  }
  return out;
}

/** Every file in the project tree as a path relative to the root. */
export function flattenFiles(entries: Entry[], acc: string[] = [], root?: string): string[] {
  for (const e of entries) {
    if (e.kind === "dir") flattenFiles(e.children, acc, root ?? e.path.slice(0, e.path.length - e.name.length));
    else acc.push(root ? e.path.replace(root, "") : e.name);
  }
  return acc;
}

// ---------------------------------------------------------------- the paper as the editor sees it

export interface LabelInfo { label: string; kind: string; file: string; line: number; detail: string; section: string }
export interface MacroInfo { name: string; file: string; line: number; body: string }

/** Labels and macros across the paper, with the open buffer's labels taking precedence for its own file. */
export function paperSymbols(map: PaperMap | null, currentFile: string | null, currentSource: string | null): { labels: LabelInfo[]; macros: MacroInfo[] } {
  const labels: LabelInfo[] = [];
  const macros: MacroInfo[] = [];
  const sectionOf = (a: PaperAnchor) => (a.section != null && map ? map.headings[a.section]?.title ?? "" : "");
  if (map) {
    for (const a of map.anchors) {
      if (a.kind === "macro") { macros.push({ name: a.name, file: a.file, line: a.line, body: a.detail }); continue; }
      if (!a.name || (currentFile && a.file === currentFile && currentSource != null)) continue;
      labels.push({ label: a.name, kind: a.kind, file: a.file, line: a.line, detail: a.detail, section: sectionOf(a) });
    }
  }
  // The open buffer may hold labels not yet saved: read it directly, with the heading above each label.
  if (currentFile && currentSource != null) {
    let section = "";
    currentSource.split("\n").forEach((l, i) => {
      const h = /\\(?:chapter|section|subsection|subsubsection|paragraph)\*?\{([^}]*)\}/.exec(l);
      if (h) section = h[1];
      const re = /\\label\{([^}]+)\}/g; let m: RegExpExecArray | null;
      while ((m = re.exec(l))) {
        const label = m[1];
        const known = map?.anchors.find((a) => a.name === label && a.file === currentFile);
        labels.push({ label, kind: known?.kind ?? kindFromLabel(label), file: currentFile, line: i + 1, detail: known?.detail ?? "", section: known ? sectionOf(known) : section });
      }
    });
  }
  return { labels, macros };
}

function kindFromLabel(label: string): string {
  const p = label.split(":")[0].toLowerCase();
  return ({ fig: "figure", tab: "table", tbl: "table", eq: "equation", eqn: "equation", sec: "section", subsec: "section", ch: "section", chap: "section", app: "section", thm: "theorem", lem: "lemma", cor: "corollary", def: "definition", prop: "proposition", alg: "algorithm", lst: "listing", ass: "assumption" } as Record<string, string>)[p] ?? "label";
}

// ---------------------------------------------------------------- completions

/** What the assistance layer needs from the app: the paper's symbols and a way to open a file at a line. */
export interface AssistSources {
  bib: () => Record<string, BibEntry>;
  symbols: () => { labels: LabelInfo[]; macros: MacroInfo[] };
  files: () => string[];
  currentFile: () => string | null;
  /** Open a file of the paper (path relative to its root) at a line: go-to-definition lands here. */
  goTo: (file: string, line: number) => void;
  /** The paper's main file, relative to the root; null when unknown. */
  main: () => string | null;
}

const CITE = /\\(?:cite[tp]?\*?|citeauthor|citeyear|parencite|textcite|autocite|nocite|citealp|citealt)\{([^}]*?)$/;
const REF = /\\(?:ref|eqref|autoref|cref|Cref|pageref|nameref|vref|labelcref)\*?\{([^}]*?)$/;
const FILE = /\\(?:input|include|subfile|includegraphics(?:\[[^\]]*\])?|bibliography|addbibresource|lstinputlisting|includepdf(?:\[[^\]]*\])?)\{([^}]*?)$/;

const KIND_ICON: Record<string, string> = { figure: "fig", table: "tab", equation: "eq", section: "§", theorem: "thm", lemma: "lem", corollary: "cor", definition: "def", proposition: "prop", algorithm: "alg", listing: "lst", assumption: "ass", label: "" };

/** Completion inside \ref-like, \cite-like and file-taking commands, from the whole paper. */
export function projectSource(src: AssistSources): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.state.doc.sliceString(Math.max(0, ctx.pos - 200), ctx.pos);
    let m: RegExpExecArray | null;
    if ((m = CITE.exec(before))) {
      const typed = m[1].split(",").pop()!.trim();
      const from = ctx.pos - typed.length;
      const options: Completion[] = Object.values(src.bib()).map((e) => ({ label: e.key, detail: e.label, info: e.title, type: "constant" }));
      return { from, options, validFor: /^[\w:\-.]*$/ };
    }
    if ((m = REF.exec(before))) {
      const typed = m[1].split(",").pop()!.trim();
      const from = ctx.pos - typed.length;
      const wantsEq = /\\eqref/.test(m[0]);
      const here = src.currentFile();
      const options: Completion[] = src.symbols().labels.map((l) => {
        const where = l.file === here ? `line ${l.line}` : `${l.file}:${l.line}`;
        const detail = [KIND_ICON[l.kind] ?? l.kind, l.section ? `in ${l.section}` : ""].filter(Boolean).join(" · ");
        const info = [l.detail, where].filter(Boolean).join("\n");
        let boost = l.file === here ? 1 : 0;
        if (wantsEq && l.kind === "equation") boost += 2;
        return { label: l.label, detail, info, type: "variable", boost };
      });
      return { from, options, validFor: /^[\w:\-.+]*$/ };
    }
    if ((m = FILE.exec(before))) {
      const typed = m[1];
      const from = ctx.pos - typed.length;
      const graphics = /includegraphics|includepdf/.test(m[0]);
      const bib = /bibliography|addbibresource/.test(m[0]);
      const files = src.files().filter((f) => (graphics ? /\.(pdf|png|jpe?g|eps|svg)$/i.test(f) : bib ? /\.bib$/i.test(f) : /\.(tex|typ|txt|py|csv)$/i.test(f)));
      const options: Completion[] = files.map((f) => ({ label: bib ? f.replace(/\.bib$/i, "") : f.replace(/\.tex$/, ""), detail: f.split("/").pop(), type: "text" }));
      return { from, options, validFor: /^[\w/.-]*$/ };
    }
    return null;
  };
}

/** Snippets with tab stops: Tab moves between the fields, Escape leaves. */
const SNIPPETS: Completion[] = [
  snippetCompletion("\\begin{figure}[${t}]\n  \\centering\n  \\includegraphics[width=${0.8}\\linewidth]{${file}}\n  \\caption{${caption}}\n  \\label{fig:${name}}\n\\end{figure}\n", { label: "\\begin{figure}", detail: "figure with caption and label", type: "keyword", boost: 3 }),
  snippetCompletion("\\begin{table}[${t}]\n  \\centering\n  \\caption{${caption}}\n  \\label{tab:${name}}\n  \\begin{tabular}{${lcc}}\n    \\toprule\n    ${Header} \\\\\n    \\midrule\n    ${row} \\\\\n    \\bottomrule\n  \\end{tabular}\n\\end{table}\n", { label: "\\begin{table}", detail: "table with booktabs rules", type: "keyword", boost: 3 }),
  snippetCompletion("\\begin{equation}\n  ${math}\n  \\label{eq:${name}}\n\\end{equation}\n", { label: "\\begin{equation}", detail: "numbered equation with label", type: "keyword", boost: 3 }),
  snippetCompletion("\\begin{align}\n  ${lhs} &= ${rhs} \\\\\n  ${} &= ${}\n\\end{align}\n", { label: "\\begin{align}", detail: "aligned equations", type: "keyword", boost: 2 }),
  snippetCompletion("\\begin{itemize}\n  \\item ${first}\n  \\item ${second}\n\\end{itemize}\n", { label: "\\begin{itemize}", detail: "bulleted list", type: "keyword", boost: 2 }),
  snippetCompletion("\\begin{enumerate}\n  \\item ${first}\n  \\item ${second}\n\\end{enumerate}\n", { label: "\\begin{enumerate}", detail: "numbered list", type: "keyword", boost: 2 }),
  snippetCompletion("\\begin{${theorem}}[${title}]\n  \\label{thm:${name}}\n  ${statement}\n\\end{${theorem}}\n", { label: "\\begin{theorem}", detail: "theorem-like environment", type: "keyword", boost: 1 }),
  snippetCompletion("\\begin{subfigure}[b]{${0.48}\\textwidth}\n  \\includegraphics[width=\\linewidth]{${file}}\n  \\caption{${caption}}\n  \\label{fig:${name}}\n\\end{subfigure}\n", { label: "\\begin{subfigure}", detail: "subfigure (subcaption)", type: "keyword", boost: 1 }),
  snippetCompletion("\\begin{algorithm}[t]\n  \\caption{${caption}}\n  \\label{alg:${name}}\n  \\begin{algorithmic}[1]\n    \\State ${step}\n  \\end{algorithmic}\n\\end{algorithm}\n", { label: "\\begin{algorithm}", detail: "algorithm (algpseudocode)", type: "keyword", boost: 1 }),
  snippetCompletion("\\begin{${env}}\n  ${}\n\\end{${env}}", { label: "\\begin{…}", detail: "environment", type: "keyword", boost: 1 }),
  snippetCompletion("\\section{${title}}\n\\label{sec:${name}}\n", { label: "\\section{…}", detail: "section with label", type: "keyword", boost: 1 }),
  snippetCompletion("\\subsection{${title}}\n\\label{sec:${name}}\n", { label: "\\subsection{…}", detail: "subsection with label", type: "keyword", boost: 1 }),
  snippetCompletion("\\newcommand{\\${name}}{${body}}", { label: "\\newcommand", detail: "define a macro", type: "keyword", boost: 1 }),
  snippetCompletion("\\frac{${num}}{${den}}", { label: "\\frac{…}{…}", detail: "fraction", type: "keyword", boost: 1 }),
];

/** Wrap the language package's source: glyphs beside symbols, the paper's own macros, snippets with
 * tab stops in place of the package's cursor-parking ones. */
export function commandSource(base: CompletionSource, src: AssistSources): CompletionSource {
  return (ctx) => {
    const got = base(ctx);
    if (!got || got instanceof Promise) return got;
    const cmd = ctx.matchBefore(/\\[a-zA-Z]*$/);
    if (!cmd) return got;
    const seen = new Set<string>();
    const options: Completion[] = [];
    for (const o of got.options) {
      if (o.type === "keyword") continue; // the package's snippets: replaced by tab-stop versions below
      const sym = symbolIndex.get(o.label);
      const withGlyph = sym ? { ...o, detail: sym.glyph, info: sym.package ? `${o.label} · ${sym.package}` : undefined } : o;
      seen.add(o.label);
      options.push(withGlyph);
    }
    for (const mac of src.symbols().macros) {
      if (seen.has(mac.name)) continue;
      seen.add(mac.name);
      options.push({ label: mac.name, detail: mac.body ? `= ${mac.body}` : "your macro", info: `${mac.file}:${mac.line}`, type: "variable", boost: 4 });
    }
    return { ...got, options: [...options, ...SNIPPETS] };
  };
}

// ---------------------------------------------------------------- $ pairs like a bracket

/** `$` inserts a pair and steps over a closing one; a selection gets wrapped. Escaped `\$` and comments are left alone. */
export function dollarPairing(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== "$") return false;
    const { state } = view;
    const line = state.doc.lineAt(from);
    const before = state.doc.sliceString(line.from, from);
    if (/\\$/.test(before) || /(^|[^\\])%/.test(before)) return false;
    const after = state.doc.sliceString(to, to + 1);
    if (from === to && after === "$") { view.dispatch({ selection: { anchor: to + 1 }, userEvent: "input.type" }); return true; }
    if (from !== to) {
      const sel = state.doc.sliceString(from, to);
      view.dispatch({ changes: { from, to, insert: `$${sel}$` }, selection: { anchor: from + 1, head: from + 1 + sel.length }, userEvent: "input.type" });
      return true;
    }
    // Inside math already (odd count of unescaped $ on the line before the caret): a bare closing $.
    const opens = (before.match(/(^|[^\\])\$/g) ?? []).length;
    if (opens % 2 === 1) return false;
    view.dispatch({ changes: { from, insert: "$$" }, selection: { anchor: from + 1 }, userEvent: "input.type" });
    return true;
  });
}

// ---------------------------------------------------------------- go to definition

export interface Target { file: string | null; line: number; what: string }

/** What the caret is on and where it is defined: a label, a citation key, an included file or a macro. */
export function definitionAt(state: EditorState, pos: number, src: AssistSources): Target | null {
  const line = state.doc.lineAt(pos);
  const col = pos - line.from;
  const text = line.text;
  // Argument of a command: find the enclosing {...} and the command before it.
  const open = text.lastIndexOf("{", col);
  const close = text.indexOf("}", col);
  const inArg = open >= 0 && close >= 0 && close >= col && !text.slice(open + 1, col).includes("}") && !text.slice(col, close).includes("{");
  if (inArg) {
    const cmdMatch = /\\([a-zA-Z]+\*?)(?:\[[^\]]*\])?$/.exec(text.slice(0, open));
    const arg = text.slice(open + 1, close);
    if (cmdMatch) {
      const cmd = cmdMatch[1];
      // Which comma-separated item the caret is on.
      let start = open + 1;
      for (const part of arg.split(",")) {
        const end = start + part.length;
        if (col >= start && col <= end) {
          const item = part.trim();
          if (/^(ref|eqref|autoref|cref|Cref|pageref|nameref|vref|labelcref)$/.test(cmd.replace("*", ""))) {
            const l = src.symbols().labels.find((x) => x.label === item);
            return l ? { file: l.file, line: l.line, what: `\\label{${item}}` } : null;
          }
          if (/^(cite[tp]?|citeauthor|citeyear|parencite|textcite|autocite|nocite|citealp|citealt)$/.test(cmd.replace("*", ""))) {
            const e = src.bib()[item];
            return e && e.file ? { file: e.file, line: e.line ?? 1, what: `@${item}` } : null;
          }
          if (/^(input|include|subfile|includegraphics|bibliography|addbibresource|lstinputlisting|includepdf)$/.test(cmd)) {
            const files = src.files();
            const hit = files.find((f) => f === item) ?? files.find((f) => f.replace(/\.(tex|bib)$/, "") === item) ?? files.find((f) => f.startsWith(item));
            return hit ? { file: hit, line: 1, what: hit } : null;
          }
        }
        start = end + 1;
      }
    }
  }
  // A macro name under the caret.
  const left = text.slice(0, col), right = text.slice(col);
  const lm = /\\([a-zA-Z]*)$/.exec(left), rm = /^([a-zA-Z]*)/.exec(right);
  if (lm) {
    const name = `\\${lm[1]}${rm ? rm[1] : ""}`;
    const mac = src.symbols().macros.find((m) => m.name === name);
    if (mac) return { file: mac.file, line: mac.line, what: `\\newcommand${name}` };
  }
  return null;
}

/** F12 or ⌘-click jumps to the definition; the callback receives a path relative to the paper's root. */
export function goToDefinition(src: () => AssistSources): Extension {
  const jump = (view: EditorView, pos: number) => {
    const t = definitionAt(view.state, pos, src());
    if (!t || !t.file) return false;
    src().goTo(t.file, t.line);
    return true;
  };
  return [
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        if (jump(view, pos)) { e.preventDefault(); return true; }
        return false;
      },
    }),
  ];
}

export function goToDefinitionCommand(src: () => AssistSources) {
  return (view: EditorView) => {
    const t = definitionAt(view.state, view.state.selection.main.head, src());
    if (!t || !t.file) return false;
    src().goTo(t.file, t.line);
    return true;
  };
}

// ---------------------------------------------------------------- matching environment

/** When the caret sits in `\begin{x}` or `\end{x}`, both ends of the environment are marked. */
export function matchingEnvironment(): Extension {
  const mark = Decoration.mark({ class: "cm-env-match" });
  return ViewPlugin.fromClass(class {
    deco: DecorationSet = Decoration.none;
    constructor(view: EditorView) { this.deco = this.compute(view); }
    update(u: ViewUpdate) { if (u.selectionSet || u.docChanged || u.viewportChanged) this.deco = this.compute(u.view); }
    compute(view: EditorView): DecorationSet {
      const { state } = view;
      const pos = state.selection.main.head;
      const line = state.doc.lineAt(pos);
      const col = pos - line.from;
      // Only when the caret is inside a \begin{...} or \end{...} on this line.
      const re = /\\(begin|end)\{([^}]*)\}/g; let m: RegExpExecArray | null; let hit: { from: number; to: number; env: string; kind: string } | null = null;
      while ((m = re.exec(line.text))) { if (col >= m.index && col <= m.index + m[0].length) { hit = { from: line.from + m.index, to: line.from + m.index + m[0].length, env: m[2], kind: m[1] }; break; } }
      if (!hit || !hit.env) return Decoration.none;
      let partner: { from: number; to: number } | null;
      try { partner = findMatchingEnvironment(state.doc.toString(), hit.from + 1, syntaxTree(state)); } catch { partner = null; }
      partner ??= scanPartner(state.doc.toString(), hit);
      const ranges = [mark.range(hit.from, hit.to)];
      if (partner && partner.to <= state.doc.length && (partner.from < hit.from || partner.from > hit.to)) ranges.push(mark.range(partner.from, partner.to));
      ranges.sort((a, b) => a.from - b.from);
      return Decoration.set(ranges);
    }
  }, { decorations: (v) => v.deco });
}

/** Text scan for the partner of a \begin or \end, honouring nesting of the same environment. */
function scanPartner(doc: string, hit: { from: number; to: number; env: string; kind: string }): { from: number; to: number } | null {
  const esc = hit.env.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\\\(begin|end)\\{${esc}\\}`, "g");
  let depth = 0;
  if (hit.kind === "begin") {
    re.lastIndex = hit.to;
    let m: RegExpExecArray | null;
    while ((m = re.exec(doc))) { if (m[1] === "begin") depth++; else if (depth === 0) return { from: m.index, to: m.index + m[0].length }; else depth--; }
  } else {
    const all: { from: number; to: number; kind: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(doc)) && m.index < hit.from) all.push({ from: m.index, to: m.index + m[0].length, kind: m[1] });
    for (let i = all.length - 1; i >= 0; i--) { if (all[i].kind === "end") depth++; else if (depth === 0) return all[i]; else depth--; }
  }
  return null;
}

// ---------------------------------------------------------------- lint that knows the paper has more than one file

const MACRO_DEF = /\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator\*?|DeclarePairedDelimiter|NewDocumentCommand|def|let|newenvironment|renewenvironment)\b/;

/** The language package's linter, minus what is only wrong when a file is read alone: a section file has
 * no \begin{document}, its \ref targets live in other files, its \cite has its bibliography in main.tex,
 * and math commands inside a macro's body are fine. Typst files are not linted as LaTeX at all. */
export function paperLint(src: () => AssistSources): Extension {
  return linter((view) => paperDiagnostics(view, src()), { delay: 600 });
}

const baseLinter = latexLinter();

export function paperDiagnostics(view: EditorView, s: AssistSources): Diagnostic[] {
  {
    const file = s.currentFile();
    if (file && /\.typ$/i.test(file)) return [];
    const main = s.main();
    const isMain = !main || !file || file === main;
    const known = new Set(s.symbols().labels.map((l) => l.label));
    const doc = view.state.doc;
    const out: Diagnostic[] = [];
    for (const d of baseLinter(view)) {
      const m = d.message;
      if (!isMain && m.startsWith("Missing document environment")) continue;
      if (!isMain && m.startsWith("\\cite used but no \\bibliography")) continue;
      const ref = /^(?:Reference to undefined label: |Label ')([^']+?)'?(?: not defined in this file)?$/.exec(m);
      if (ref && known.has(ref[1])) continue;
      if (m.endsWith("can only be used in math mode")) {
        const line = doc.lineAt(d.from);
        if (MACRO_DEF.test(line.text.slice(0, d.from - line.from))) continue;
      }
      out.push(d);
    }
    return out;
  }
}

// ---------------------------------------------------------------- headings read as headings

/** In source view the title inside \section{...} and its kin is set heavier, so the structure of the file
 * shows at a glance without leaving the markup. */
export function headingEmphasis(): Extension {
  const marks = [1, 2, 3, 4].map((l) => Decoration.mark({ class: `cm-heading cm-heading-${l}` }));
  const LEVEL: Record<string, number> = { part: 1, chapter: 1, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 4 };
  const compute = (view: EditorView): DecorationSet => {
    const ranges: ReturnType<Decoration["range"]>[] = [];
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = view.state.doc.lineAt(pos);
        const re = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]]*\])?\{/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line.text))) {
          // The title runs to the brace that closes the one just matched, honouring nested braces.
          let depth = 1, i = m.index + m[0].length;
          for (; i < line.text.length && depth > 0; i++) { const c = line.text[i]; if (c === "{") depth++; else if (c === "}") depth--; }
          const start = line.from + m.index + m[0].length, end = line.from + (depth === 0 ? i - 1 : line.text.length);
          if (end > start) ranges.push(marks[(LEVEL[m[1]] ?? 4) - 1].range(start, end));
        }
        pos = line.to + 1;
      }
    }
    return Decoration.set(ranges, true);
  };
  return ViewPlugin.fromClass(class {
    deco: DecorationSet;
    constructor(view: EditorView) { this.deco = compute(view); }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.deco = compute(u.view); }
  }, { decorations: (v) => v.deco });
}
