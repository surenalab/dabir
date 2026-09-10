// Predictive text: grey ghost text after the cursor that finishes the word or
// phrase you are typing, learned from this paper alone. Nothing leaves the
// machine. Tab accepts, Escape or typing on dismisses. It stays quiet unless
// the paper itself gives it a confident continuation, so it never nags.

import { StateField, StateEffect, Prec } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, keymap, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { completionStatus } from "@codemirror/autocomplete";

class GhostWidget extends WidgetType {
  constructor(readonly text: string, readonly pending: boolean) { super(); }
  eq(o: GhostWidget) { return o.text === this.text && o.pending === this.pending; }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.pending ? "cm-ghost pending" : "cm-ghost";
    el.textContent = this.text;
    el.setAttribute("aria-hidden", "true");
    if (this.pending) el.title = "Asking the agent…";
    return el;
  }
  ignoreEvent() { return true; }
}

/** Ghost text after the caret. `pending` marks a placeholder while the agent is asked; `source` says who wrote it. */
export interface Ghost { pos: number; text: string; pending?: boolean; source?: "paper" | "agent" }

const setGhost = StateEffect.define<Ghost | null>();

const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value;
    if (tr.docChanged || tr.selection) return null;
    return v;
  },
  provide: (f) => EditorView.decorations.from(f, (v): DecorationSet => v ? Decoration.set([Decoration.widget({ widget: new GhostWidget(v.text, !!v.pending), side: 1 }).range(v.pos)]) : Decoration.none),
});

/** Show, replace or clear ghost text from outside the predictor (the agent continuation). */
export function setGhostText(view: EditorView, ghost: Ghost | null) { view.dispatch({ effects: setGhost.of(ghost) }); }
export function currentGhost(view: EditorView): Ghost | null { return view.state.field(ghostField, false) ?? null; }

// ---------------------------------------------------------------- the model

const WORD = /[A-Za-z][A-Za-z'-]{1,}/g;

interface Model { built: number; length: number; freq: Map<string, number>; next: Map<string, Map<string, number>>; next2: Map<string, Map<string, number>> }

function buildModel(text: string): Model {
  const freq = new Map<string, number>();
  const next = new Map<string, Map<string, number>>();
  const next2 = new Map<string, Map<string, number>>();
  const bump = (m: Map<string, Map<string, number>>, k: string, w: string) => { let inner = m.get(k); if (!inner) { inner = new Map(); m.set(k, inner); } inner.set(w, (inner.get(w) ?? 0) + 1); };
  // Strip commands, math and comments so the model learns prose, not markup.
  const prose = text
    .replace(/%[^\n]*/g, " ")
    .replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, " ")
    .replace(/\\begin\{(equation|align|gather|multline|tabular|verbatim|lstlisting)\*?\}[\s\S]*?\\end\{\1\*?\}/g, " ")
    .replace(/\\[A-Za-z@]+\*?(\[[^\]]*\])?/g, " ")
    .replace(/[{}]/g, " ");
  let p1 = "", p2 = "";
  for (const m of prose.matchAll(WORD)) {
    const w = m[0];
    freq.set(w, (freq.get(w) ?? 0) + 1);
    if (p1) bump(next, p1.toLowerCase(), w);
    if (p1 && p2) bump(next2, `${p2.toLowerCase()} ${p1.toLowerCase()}`, w);
    p2 = p1; p1 = w;
  }
  return { built: Date.now(), length: text.length, freq, next, next2 };
}

function best(m: Map<string, number> | undefined, filter: (w: string) => boolean, min: number): [string, number] | null {
  if (!m) return null;
  let top: [string, number] | null = null;
  for (const [w, n] of m) if (n >= min && filter(w) && (!top || n > top[1])) top = [w, n];
  return top;
}

/** Continue a phrase word by word while the paper strongly agrees. */
function extend(model: Model, p2: string, p1: string, words: string[], max = 4) {
  while (words.length < max) {
    const tri = best(model.next2.get(`${p2.toLowerCase()} ${p1.toLowerCase()}`), () => true, 2);
    if (!tri) break;
    words.push(tri[0]); p2 = p1; p1 = tri[0];
  }
}

export function predictAt(model: Model, line: string, col: number): string | null {
  const before = line.slice(0, col), after = line.slice(col);
  if (/^[A-Za-z]/.test(after)) return null;                       // in the middle of a word
  if ((before.match(/\$/g) ?? []).length % 2 === 1) return null;   // inside inline math
  if (/%/.test(before.replace(/\\%/g, ""))) return null;           // in a comment
  if (/\\[A-Za-z]*$/.test(before)) return null;                    // typing a command
  if (/\\(cite[a-z]*|ref|eqref|autoref|cref|label|input|include|includegraphics|url|href|bibliography|begin|end|usepackage|documentclass|newcommand)\*?(\[[^\]]*\])?\{[^{}]*$/.test(before)) return null; // keys, paths and names are not prose
  const m = /(?:^|[^A-Za-z\\])([A-Za-z][A-Za-z'-]*)?$/.exec(before);
  if (!m) return null;
  const partial = m[1] ?? "";
  const ctx = before.slice(0, before.length - partial.length).match(/([A-Za-z][A-Za-z'-]*)\W+([A-Za-z][A-Za-z'-]*)\W*$/) ?? before.slice(0, before.length - partial.length).match(/()([A-Za-z][A-Za-z'-]*)\W*$/);
  const p2 = ctx?.[1] ?? "", p1 = ctx?.[2] ?? "";
  const words: string[] = [];
  if (partial.length >= 2) {
    const lower = partial.toLowerCase();
    const fits = (w: string) => w.length > partial.length && w.toLowerCase().startsWith(lower);
    const fromTri = p1 && p2 ? best(model.next2.get(`${p2.toLowerCase()} ${p1.toLowerCase()}`), fits, 1) : null;
    const fromBi = !fromTri && p1 ? best(model.next.get(p1.toLowerCase()), fits, 1) : null;
    let pick = fromTri?.[0] ?? fromBi?.[0] ?? null;
    if (!pick) {
      let top: [string, number] | null = null;
      for (const [w, n] of model.freq) if (n >= 2 && fits(w) && (!top || n > top[1])) top = [w, n];
      pick = top?.[0] ?? null;
    }
    if (!pick) return null;
    const rest = pick.slice(partial.length);
    words.push(rest);
    const tail: string[] = [];
    extend(model, p1, pick, tail, 3);
    return rest + (tail.length ? " " + tail.join(" ") : "");
  }
  if (!p1 || !/\s$/.test(before)) return null;
  // No partial word: only speak when a trigram or a strong bigram exists.
  const tri = p2 ? best(model.next2.get(`${p2.toLowerCase()} ${p1.toLowerCase()}`), () => true, 2) : null;
  const bi = !tri ? best(model.next.get(p1.toLowerCase()), () => true, 3) : null;
  const first = tri?.[0] ?? bi?.[0];
  if (!first) return null;
  words.push(first);
  extend(model, p1, first, words, 4);
  return words.join(" ");
}

// ---------------------------------------------------------------- the extension

const predictor = ViewPlugin.fromClass(class {
  model: Model | null = null;
  timer: number | null = null;
  constructor(readonly view: EditorView) {}
  update(u: ViewUpdate) {
    if (!(u.docChanged || u.selectionSet)) return;
    if (!u.docChanged && !u.transactions.some((t) => t.isUserEvent("select"))) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.compute(), u.docChanged ? 90 : 250);
  }
  compute() {
    const v = this.view;
    if (!v.hasFocus || completionStatus(v.state) === "active") return;
    const sel = v.state.selection.main;
    if (!sel.empty) return;
    const doc = v.state.doc;
    if (!this.model || (Date.now() - this.model.built > 2000 && doc.length !== this.model.length)) this.model = buildModel(doc.toString());
    const line = doc.lineAt(sel.head);
    const text = predictAt(this.model, line.text, sel.head - line.from);
    const cur = v.state.field(ghostField, false);
    if (cur && cur.source === "agent") return;  // the agent's sentence stays until the caret or text moves
    v.dispatch({ effects: setGhost.of(text ? { pos: sel.head, text, source: "paper" } : null) });
  }
  destroy() { if (this.timer) clearTimeout(this.timer); }
});

export function acceptPrediction(view: EditorView): boolean {
  const g = view.state.field(ghostField, false);
  if (!g || g.pending) return false;
  view.dispatch({ changes: { from: g.pos, insert: g.text }, selection: { anchor: g.pos + g.text.length }, userEvent: "input.complete" });
  return true;
}
export function acceptPredictionWord(view: EditorView): boolean {
  const g = view.state.field(ghostField, false);
  if (!g || g.pending) return false;
  const word = /^\S*\s?/.exec(g.text)?.[0] ?? g.text;
  const rest = g.text.slice(word.length);
  view.dispatch({ changes: { from: g.pos, insert: word }, selection: { anchor: g.pos + word.length }, effects: rest ? setGhost.of({ pos: g.pos + word.length, text: rest }) : setGhost.of(null), userEvent: "input.complete" });
  return true;
}
export function hasPrediction(view: EditorView): boolean { return !!view.state.field(ghostField, false); }

/** The ghost text field and its keys, without the statistical predictor; the agent continuation needs these on their own. */
export function ghostText() {
  return [
    ghostField,
    Prec.highest(keymap.of([
      { key: "Tab", run: acceptPrediction },
      { key: "Mod-ArrowRight", run: acceptPredictionWord },
      { key: "Escape", run: (v) => { if (!hasPrediction(v)) return false; v.dispatch({ effects: setGhost.of(null) }); return true; } },
    ])),
    EditorView.domEventHandlers({ blur: (_, v) => { if (hasPrediction(v)) v.dispatch({ effects: setGhost.of(null) }); return false; } }),
  ];
}

/** Predictive text from the paper itself, on top of the ghost field. */
export function prediction() { return [predictor]; }
