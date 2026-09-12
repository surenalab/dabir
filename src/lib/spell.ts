// Offline, LaTeX-aware spelling. Prose is checked against a Hunspell dictionary bundled with the app;
// commands, maths, comments, verbatim and the arguments that hold keys, paths and lengths are never
// touched, so `\cite{okonkwo2021}` and `\includegraphics{figures/psnr.pdf}` stop lighting up.
// Misspellings get a wavy underline; hovering offers replacements, Add to Dictionary and Ignore.
import { Facet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, hoverTooltip, type DecorationSet, type ViewUpdate } from "@codemirror/view";

/** A dictionary id from public/dict/index.json, such as "en-GB" or "de". */
export type SpellLanguage = string;

export interface Speller { correct(word: string): boolean; suggest(word: string): string[] }
export interface Dictionary { id: SpellLanguage; label: string }

const engines = new Map<string, Promise<Speller>>();
let manifest: Promise<Dictionary[]> | null = null;

/** The dictionaries shipped with the app: drop a Hunspell pair into public/dict and list it in index.json. */
export function dictionaries(): Promise<Dictionary[]> {
  if (!manifest) {
    manifest = fetch("/dict/index.json").then((r) => r.json() as Promise<Dictionary[]>).catch(() => [{ id: "en-GB", label: "English (UK)" }, { id: "en-US", label: "English (US)" }]);
  }
  return manifest;
}

/** The dictionary for one language, loaded once from the app's own files. */
export function loadSpeller(lang: SpellLanguage): Promise<Speller> {
  let p = engines.get(lang);
  if (!p) {
    p = (async () => {
      const file = async (ext: string) => { const r = await fetch(`/dict/${lang}.${ext}`); if (!r.ok) throw new Error(`No ${lang} dictionary`); return r.text(); };
      const [{ default: nspell }, aff, dic] = await Promise.all([import("nspell"), file("aff"), file("dic")]);
      const engine = nspell(aff, dic);
      return { correct: (w) => engine.correct(w), suggest: (w) => rank(w, engine) };
    })();
    engines.set(lang, p);
    p.catch(() => engines.delete(lang));
  }
  return p;
}

/** Damerau–Levenshtein distance: one swap of adjacent letters counts as a single edit. */
function distance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}

/** Hunspell's list misses simple letter swaps (teh → the); add them and order everything by how small the edit is. */
export function rank(word: string, engine: Speller): string[] {
  const seen = new Set<string>(), out: string[] = [];
  const push = (s: string) => { if (s && s !== word && !seen.has(s)) { seen.add(s); out.push(s); } };
  const lower = word.toLowerCase(), cap = word[0] === word[0].toUpperCase();
  const cased = (s: string) => (cap ? s[0].toUpperCase() + s.slice(1) : s);
  for (let i = 0; i + 1 < lower.length; i++) {
    const swapped = lower.slice(0, i) + lower[i + 1] + lower[i] + lower.slice(i + 2);
    if (engine.correct(swapped) || engine.correct(cased(swapped))) push(cased(swapped));
  }
  for (const s of engine.suggest(word)) push(s);
  return out
    .map((s, i) => ({ s, i, d: distance(lower, s.toLowerCase()) }))
    .sort((x, y) => x.d - y.d || x.i - y.i)
    .map((x) => x.s);
}

// ---------------------------------------------------------------- tokeniser

/** Commands whose brace arguments are not prose: how many leading `{}` groups to skip (-1: all). */
const SKIP_ARGS: Record<string, number> = {
  cite: -1, citep: -1, citet: -1, citeauthor: -1, citeyear: -1, citealp: -1, citealt: -1, textcite: -1, parencite: -1, autocite: -1, nocite: -1,
  ref: -1, eqref: -1, autoref: -1, cref: -1, Cref: -1, pageref: -1, nameref: -1, label: -1, hyperref: 1,
  includegraphics: -1, input: -1, include: -1, bibliography: -1, bibliographystyle: -1, addbibresource: -1, graphicspath: -1,
  url: -1, href: 1, path: -1, verb: -1,
  usepackage: -1, documentclass: -1, RequirePackage: -1, newcommand: -1, renewcommand: -1, providecommand: -1, newenvironment: -1, renewenvironment: -1,
  DeclareMathOperator: -1, newtheorem: 1, def: -1, let: -1, begin: -1, end: -1,
  setlength: -1, addtolength: -1, hspace: -1, vspace: -1, rule: -1, resizebox: 2, scalebox: 1, rotatebox: 1, raisebox: 1,
  color: -1, textcolor: 1, definecolor: -1, pagestyle: -1, thispagestyle: -1, hyphenation: -1, selectlanguage: -1, geometry: -1, hypersetup: -1,
  fontsize: -1, fontfamily: -1, setcounter: -1, addtocounter: -1, numberwithin: -1, counterwithin: -1, lstset: -1, tikzset: -1, pgfplotsset: -1,
  bibitem: 1, index: -1, glossaryentry: -1, gls: -1, acrshort: -1, acrlong: -1, si: -1, SI: 1, num: -1, qty: -1, unit: -1, ce: -1,
  todo: 0, footnote: 0, caption: 0, title: 0, author: -1, thanks: 0, section: 0, subsection: 0, subsubsection: 0, paragraph: 0, textbf: 0, emph: 0, textit: 0,
};
const MATH_ENVS = new Set(["equation", "equation*", "align", "align*", "alignat", "alignat*", "gather", "gather*", "multline", "multline*", "eqnarray", "eqnarray*", "displaymath", "math", "flalign", "flalign*", "split", "cases", "array", "matrix", "pmatrix", "bmatrix", "IEEEeqnarray", "IEEEeqnarray*"]);
const RAW_ENVS = new Set(["verbatim", "verbatim*", "lstlisting", "minted", "tikzpicture", "algorithmic", "algorithm2e", "comment", "filecontents", "filecontents*", "Verbatim", "BVerbatim", "pgfplots", "axis", "tabular", "tabular*", "tabularx", "longtable"]);
const isLetter = (ch: string) => /\p{L}/u.test(ch);

export interface Word { from: number; to: number; word: string }

/** Every prose word in a LaTeX source, with its offsets. */
export function proseWords(text: string): Word[] {
  const out: Word[] = [];
  const n = text.length;
  let i = 0;
  const skipGroup = (open: string, close: string): void => {
    // i is at `open`; skip to the matching `close`, honouring nesting and escapes
    let depth = 0;
    for (; i < n; i++) {
      const c = text[i];
      if (c === "\\") { i++; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) { i++; return; }
    }
  };
  const skipUntil = (needle: string): void => { const j = text.indexOf(needle, i); i = j < 0 ? n : j + needle.length; };
  const skipArgs = (count: number): void => {
    // optional [...] and star, then `count` brace groups (-1: all consecutive)
    let taken = 0;
    for (;;) {
      while (i < n && (text[i] === " " || text[i] === "*")) i++;
      if (text[i] === "[") { skipGroup("[", "]"); continue; }
      if (text[i] === "{" && (count < 0 || taken < count)) { skipGroup("{", "}"); taken++; continue; }
      return;
    }
  };
  while (i < n) {
    const c = text[i];
    if (c === "%") { skipUntil("\n"); continue; }
    if (c === "$") {
      if (text[i + 1] === "$") { i += 2; skipUntil("$$"); } else { i++; skipUntil("$"); }
      continue;
    }
    if (c === "\\") {
      const next = text[i + 1] ?? "";
      if (next === "(") { i += 2; skipUntil("\\)"); continue; }
      if (next === "[") { i += 2; skipUntil("\\]"); continue; }
      if (!isLetter(next)) { i += 2; continue; } // \%, \&, \\, \{ …
      let j = i + 1;
      while (j < n && /[A-Za-z@]/.test(text[j])) j++;
      const name = text.slice(i + 1, j);
      i = j;
      if (name === "begin" || name === "end") {
        // environment name, and whole body for maths and raw environments
        const m = /^\s*\{([^}]*)\}/.exec(text.slice(i));
        if (m) {
          i += m[0].length;
          const env = m[1].trim();
          if (name === "begin" && (MATH_ENVS.has(env) || RAW_ENVS.has(env))) skipUntil(`\\end{${env}}`);
        }
        continue;
      }
      if (name === "verb") { const d = text[i]; if (d) { i++; skipUntil(d); } continue; }
      const skip = SKIP_ARGS[name];
      if (skip === undefined) { skipArgs(0); continue; } // options skipped, brace content stays prose
      skipArgs(skip);
      continue;
    }
    if (isLetter(c)) {
      let j = i + 1;
      while (j < n && (isLetter(text[j]) || ((text[j] === "'" || text[j] === "’") && isLetter(text[j + 1] ?? "")))) j++;
      const w = text.slice(i, j);
      // words glued to a digit or a subscript are not prose (x2, 3rd, x_i)
      const before = text[i - 1] ?? " ", after = text[j] ?? " ";
      if (!/[\p{N}_^@]/u.test(before) && !/[\p{N}_^@]/u.test(after)) out.push({ from: i, to: j, word: w });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/** Whether a token is worth checking at all: acronyms, mixed case and one-letter tokens are left alone. */
export function checkable(word: string): boolean {
  if (word.length < 2) return false;
  const body = word.slice(1);
  if (/\p{Lu}/u.test(body)) return false;          // PSNR, CamelCase, McDonald
  return true;
}

/** A word passes when the dictionary knows it, or its lowercase form at a sentence start, or, for elisions
 *  such as l'image and dell'acqua, both halves around the apostrophe. */
function accept(sp: Speller, word: string): boolean {
  if (sp.correct(word)) return true;
  if (word[0] === word[0].toUpperCase() && sp.correct(word.toLowerCase())) return true;
  const cut = word.indexOf("'");
  if (cut > 0 && cut < word.length - 1) {
    const a = word.slice(0, cut + 1), b = word.slice(cut + 1);
    return (sp.correct(a) || sp.correct(a.toLowerCase()) || sp.correct(a.slice(0, -1)) || sp.correct(a.slice(0, -1).toLowerCase())) && (sp.correct(b) || sp.correct(b.toLowerCase()));
  }
  return false;
}

// ---------------------------------------------------------------- editor extension

export interface SpellConfig {
  on: boolean;
  lang: SpellLanguage;
  words: string[];                        // the paper's own dictionary, .dabir/dictionary.txt
  onAddWord: (word: string) => void;
}
export const spellConfig = Facet.define<SpellConfig, SpellConfig>({ combine: (v) => v[v.length - 1] ?? { on: false, lang: "en-GB", words: [], onAddWord: () => {} } });

const setMisspellings = StateEffect.define<{ from: number; to: number }[]>();
const spellField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setMisspellings)) return Decoration.set(e.value.map((r) => Decoration.mark({ class: "cm-misspelled" }).range(r.from, r.to)), true);
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const ignored = new Set<string>();  // this session, across files

const checker = ViewPlugin.fromClass(class {
  timer: number | null = null;
  speller: Speller | null = null;
  lang: SpellLanguage | null = null;
  cache = new Map<string, boolean>();
  gen = 0;
  constructor(readonly view: EditorView) { this.schedule(0); }
  update(u: ViewUpdate) {
    const cfg = u.state.facet(spellConfig), prev = u.startState.facet(spellConfig);
    if (cfg !== prev && (cfg.on !== prev.on || cfg.lang !== prev.lang || cfg.words !== prev.words)) { if (cfg.lang !== this.lang) this.cache.clear(); this.schedule(0); return; }
    if (u.docChanged || u.selectionSet) this.schedule(u.docChanged ? 350 : 700);
  }
  schedule(ms: number) { if (this.timer) clearTimeout(this.timer); this.timer = window.setTimeout(() => this.run(), ms); }
  async run() {
    const cfg = this.view.state.facet(spellConfig);
    if (!cfg.on) { if (this.view.state.field(spellField).size) this.view.dispatch({ effects: setMisspellings.of([]) }); return; }
    if (!this.speller || this.lang !== cfg.lang) {
      const gen = ++this.gen;
      try { const sp = await loadSpeller(cfg.lang); if (gen !== this.gen) return; this.speller = sp; this.lang = cfg.lang; this.cache.clear(); }
      catch { return; }
    }
    const sp = this.speller;
    const text = this.view.state.doc.toString();
    const own = new Set(cfg.words.map((w) => w.toLowerCase()));
    const head = this.view.state.selection.main.head;
    const bad: { from: number; to: number }[] = [];
    for (const w of proseWords(text)) {
      if (w.to === head || (w.from <= head && head < w.to)) continue;  // being typed
      const word = w.word.replace(/’/g, "'");
      if (!checkable(word) || own.has(word.toLowerCase()) || ignored.has(word.toLowerCase())) continue;
      let ok = this.cache.get(word);
      if (ok === undefined) { ok = accept(sp, word); this.cache.set(word, ok); }
      if (!ok) bad.push({ from: w.from, to: w.to });
    }
    this.view.dispatch({ effects: setMisspellings.of(bad) });
  }
  destroy() { if (this.timer) clearTimeout(this.timer); }
});

/** Hover a marked word: replacements, Add to Dictionary, Ignore. */
const spellHover = hoverTooltip((view, pos) => {
  const deco = view.state.field(spellField, false);
  if (!deco) return null;
  let hit: { from: number; to: number } | null = null;
  deco.between(pos, pos, (from, to) => { hit = { from, to }; return false; });
  if (!hit) return null;
  const { from, to } = hit;
  const word = view.state.doc.sliceString(from, to);
  const cfg = view.state.facet(spellConfig);
  return {
    pos: from, end: to, above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "spell-card";
      const plugin = view.plugin(checker);
      const suggestions = plugin?.speller ? plugin.speller.suggest(word).slice(0, 6) : [];
      const list = document.createElement("div"); list.className = "spell-suggestions";
      if (!suggestions.length) { const none = document.createElement("span"); none.className = "spell-none"; none.textContent = "No suggestions"; list.appendChild(none); }
      for (const s of suggestions) {
        const b = document.createElement("button"); b.className = "spell-fix"; b.textContent = s;
        b.onmousedown = (e) => { e.preventDefault(); view.dispatch({ changes: { from, to, insert: s }, userEvent: "input.spell" }); view.focus(); };
        list.appendChild(b);
      }
      dom.appendChild(list);
      const row = document.createElement("div"); row.className = "spell-actions";
      const add = document.createElement("button"); add.className = "spell-act"; add.textContent = "Add to Dictionary"; add.title = "Saved with the paper in .dabir/dictionary.txt";
      add.onmousedown = (e) => { e.preventDefault(); cfg.onAddWord(word); };
      const ign = document.createElement("button"); ign.className = "spell-act"; ign.textContent = "Ignore"; ign.title = "For this session";
      ign.onmousedown = (e) => { e.preventDefault(); ignored.add(word.toLowerCase()); view.plugin(checker)?.schedule(0); };
      row.append(add, ign);
      dom.appendChild(row);
      return { dom };
    },
  };
}, { hoverTime: 250 });

export function spelling(): Extension { return [spellField, checker, spellHover]; }
