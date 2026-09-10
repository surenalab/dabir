// Reviewing an agent run in the document: the agent's version of the file is shown read-only,
// with the lines it added washed in the agent's colour and the lines it removed shown struck
// through where they used to be. Positions come from the run's unified diff, so nothing is
// diffed twice and the marks agree with the hunks listed in the Inspector.
import { StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

export interface ReviewMarks {
  /** 1-based line ranges of the new text that the agent added (inclusive). */
  inserted: { from: number; to: number }[];
  /** Text the agent removed, shown before `line` (1-based) of the new text; `line` past the end means at the end. */
  deleted: { line: number; text: string }[];
  /** A line rewritten in place: only the words that differ are marked, removed words shown struck where they were. */
  inline: { line: number; ins: { from: number; to: number }[]; del: { at: number; text: string }[] }[];
}

const words = (s: string) => s.match(/\S+|\s+/g) ?? [];

/** Word-level diff of one line against its replacement, as column marks on the new line; null when they share too little. */
export function wordDiff(oldLine: string, newLine: string): { ins: { from: number; to: number }[]; del: { at: number; text: string }[] } | null {
  const a = words(oldLine), b = words(newLine);
  if (a.length * b.length > 250_000) return null;
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const common = a.filter((w) => /\S/.test(w)).length;
  if (common === 0 || lcs[0][0] < Math.max(1, Math.ceil(Math.max(a.length, b.length) / 2))) return null;
  const ins: { from: number; to: number }[] = [], del: { at: number; text: string }[] = [];
  let i = 0, j = 0, col = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { col += b[j].length; i++; j++; continue; }
    if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      const last = ins[ins.length - 1];
      if (last && last.to === col) last.to = col + b[j].length; else ins.push({ from: col, to: col + b[j].length });
      col += b[j].length; j++;
    } else {
      const last = del[del.length - 1];
      if (last && last.at === col) last.text += a[i]; else del.push({ at: col, text: a[i] });
      i++;
    }
  }
  // Whitespace-only marks are noise.
  return { ins: ins.filter((r) => /\S/.test(newLine.slice(r.from, r.to))), del: del.filter((d) => /\S/.test(d.text)) };
}

/** Marks for one file, from a `git diff` patch that may cover several files. */
export function marksFromPatch(patch: string, file: string): ReviewMarks | null {
  const lines = patch.split("\n");
  let i = lines.findIndex((l) => l.startsWith("diff --git ") && new RegExp(` b/${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(l));
  if (i < 0) return null;
  const marks: ReviewMarks = { inserted: [], deleted: [], inline: [] };
  const newText = new Map<number, string>();  // added lines by line number, for the word-level pass
  let newLine = 0;
  let pendingDel: string[] = [];
  const flushDel = () => { if (pendingDel.length) { marks.deleted.push({ line: newLine, text: pendingDel.join("\n") }); pendingDel = []; } };
  for (i++; i < lines.length && !lines[i].startsWith("diff --git "); i++) {
    const l = lines[i];
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { flushDel(); newLine = parseInt(h[1], 10); continue; }
    if (newLine === 0) continue; // file header
    if (l.startsWith("+")) {
      flushDel();
      const last = marks.inserted[marks.inserted.length - 1];
      if (last && last.to === newLine - 1) last.to = newLine; else marks.inserted.push({ from: newLine, to: newLine });
      newText.set(newLine, l.slice(1));
      newLine++;
    } else if (l.startsWith("-")) {
      pendingDel.push(l.slice(1));
    } else if (l.startsWith("\\")) {
      // "\ No newline at end of file"
    } else {
      flushDel();
      newLine++;
    }
  }
  flushDel();
  return refine(marks, newText);
}

/** Lines replaced one-for-one become word-level marks when old and new share most of their words. */
function refine(marks: ReviewMarks, newText: Map<number, string>): ReviewMarks {
  const deleted: ReviewMarks["deleted"] = [];
  for (const d of marks.deleted) {
    const old = d.text.split("\n");
    const k = marks.inserted.findIndex((r) => r.from === d.line && r.to - r.from + 1 === old.length);
    const diffs = k >= 0 ? old.map((o, n) => wordDiff(o, newText.get(d.line + n) ?? "")) : [];
    if (k < 0 || diffs.some((x) => !x)) { deleted.push(d); continue; }
    marks.inserted.splice(k, 1);
    diffs.forEach((x, n) => marks.inline.push({ line: d.line + n, ...x! }));
  }
  marks.deleted = deleted;
  return marks;
}

/** Apply one file's hunks of a unified diff to `text`, by line numbers (browser preview only; the app applies with git). */
export function applyPatch(text: string, patch: string, file: string): string {
  const lines = patch.split("\n");
  let i = lines.findIndex((l) => l.startsWith("diff --git ") && l.endsWith(` b/${file}`));
  if (i < 0) return text;
  const out = text.split("\n");
  let offset = 0;
  let cur: { at: number; old: number; repl: string[] } | null = null;
  const flush = () => { if (cur) { out.splice(cur.at + offset, cur.old, ...cur.repl); offset += cur.repl.length - cur.old; cur = null; } };
  for (i++; i < lines.length && !lines[i].startsWith("diff --git "); i++) {
    const l = lines[i];
    const h = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(l);
    if (h) { flush(); cur = { at: parseInt(h[1], 10) - 1, old: h[2] == null ? 1 : parseInt(h[2], 10), repl: [] }; continue; }
    if (!cur || l.startsWith("\\")) continue;
    if (!l.startsWith("-")) cur.repl.push(l.slice(1));
  }
  flush();
  return out.join("\n");
}

class DeletedWidget extends WidgetType {
  constructor(readonly text: string, readonly block: boolean) { super(); }
  eq(o: DeletedWidget) { return o.text === this.text && o.block === this.block; }
  toDOM() {
    const el = document.createElement(this.block ? "div" : "span");
    el.className = this.block ? "cm-rev-del" : "cm-rev-del-w";
    el.setAttribute("aria-label", "Removed by the agent");
    el.textContent = this.text;
    return el;
  }
  get estimatedHeight() { return this.block ? 20 * this.text.split("\n").length : -1; }
  ignoreEvent() { return false; }
}

export const setReview = StateEffect.define<ReviewMarks | null>();

function build(marks: ReviewMarks, doc: { lines: number; line: (n: number) => { from: number; to: number }; length: number }): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const r of marks.inserted) {
    for (let n = Math.max(1, r.from); n <= Math.min(r.to, doc.lines); n++) ranges.push(Decoration.line({ class: "cm-rev-ins" }).range(doc.line(n).from));
  }
  for (const d of marks.deleted) {
    const at = d.line >= 1 && d.line <= doc.lines ? doc.line(d.line).from : doc.length;
    ranges.push(Decoration.widget({ widget: new DeletedWidget(d.text, true), block: true, side: -1 }).range(at));
  }
  for (const w of marks.inline) {
    if (w.line < 1 || w.line > doc.lines) continue;
    const line = doc.line(w.line);
    ranges.push(Decoration.line({ class: "cm-rev-edit" }).range(line.from));
    for (const r of w.ins) { const from = line.from + r.from, to = Math.min(line.from + r.to, line.to); if (to > from) ranges.push(Decoration.mark({ class: "cm-rev-ins-w" }).range(from, to)); }
    for (const d of w.del) ranges.push(Decoration.widget({ widget: new DeletedWidget(d.text, false), side: -1 }).range(Math.min(line.from + d.at, line.to)));
  }
  return Decoration.set(ranges, true);
}

export const reviewField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setReview)) return e.value ? build(e.value, tr.state.doc) : Decoration.none;
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
