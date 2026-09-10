// Track changes ("suggesting"): edits become marked suggestions instead of silent changes.
// An insertion stays in the text with an underline; a deletion keeps the text with a strike.
// Accepting an insertion drops the mark; accepting a deletion removes the text. Rejecting is the reverse.
// The marks live in a CodeMirror state field and follow the text; App persists them next to the paper
// (.dabir/changes.json) or in the live session document, with the same anchoring comments use.

import { EditorState, StateEffect, StateField, Facet, Transaction, type ChangeSpec, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, type DecorationSet } from "@codemirror/view";
import { invertedEffects } from "@codemirror/commands";

export type ChangeKind = "insert" | "delete";

/** One suggestion inside the open buffer, in document offsets. */
export interface ChangeRange { id: string; author: string; color: string; kind: ChangeKind; from: number; to: number; at: number }

/** A suggestion as stored: same anchoring as comments (Yjs relative positions in a session, offset + quote locally). */
export interface Change { id: string; author: string; color: string; kind: ChangeKind; file: string; anchor: string; head: string; at: number }

export interface SuggestConfig { on: boolean; author: { name: string; color: string } }
export const suggestConfig = Facet.define<SuggestConfig, SuggestConfig>({ combine: (v) => v[v.length - 1] ?? { on: false, author: { name: "me", color: "#8a6414" } } });

export const setChanges = StateEffect.define<ChangeRange[]>();
const restoreChanges = StateEffect.define<ChangeRange[]>(); // undo/redo: like setChanges, but counts as a user change
const addMark = StateEffect.define<{ kind: ChangeKind; from: number; to: number }>();
const removeMarks = StateEffect.define<string[]>();

/** Undo puts the marks back the way they were, together with the text. */
const undoMarks = invertedEffects.of((tr) => {
  const touched = tr.effects.some((e) => e.is(addMark) || e.is(removeMarks) || e.is(restoreChanges));
  const before = tr.startState.field(changesField, false);
  return touched && before ? [restoreChanges.of(before.items)] : [];
});

interface FieldState { items: ChangeRange[]; deco: DecorationSet; marks: number; version: number }

function newId() { return Math.random().toString(36).slice(2, 10); }

function build(items: ChangeRange[]): DecorationSet {
  const sorted = [...items].sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(sorted.map((c) => Decoration.mark({
    class: `cm-sugg ${c.kind === "insert" ? "ins" : "del"}`,
    attributes: { "data-change": c.id, style: `--sugg-color:${c.color}` },
  }).range(c.from, c.to)), true);
}

function sameSet(a: ChangeRange[], b: ChangeRange[]): boolean {
  if (a.length !== b.length) return false;
  const key = (c: ChangeRange) => `${c.id}:${c.kind}:${c.from}:${c.to}`;
  const as = new Set(a.map(key));
  return b.every((c) => as.has(key(c)));
}

export const changesField = StateField.define<FieldState>({
  create: () => ({ items: [], deco: Decoration.none, marks: 0, version: 0 }),
  update(v, tr) {
    let items = v.items;
    let marks = v.marks;
    let version = v.version;
    let replaced = false;
    if (tr.docChanged) {
      items = items.map((c) => ({ ...c, from: tr.changes.mapPos(c.from, 1), to: tr.changes.mapPos(c.to, -1) })).filter((c) => c.to > c.from);
      version++;
    }
    const cfg = tr.state.facet(suggestConfig);
    for (const e of tr.effects) {
      if (e.is(setChanges)) {
        if (sameSet(items, e.value)) continue;
        items = e.value; replaced = true;
      } else if (e.is(restoreChanges)) {
        items = e.value.filter((c) => c.to <= tr.state.doc.length); replaced = true; marks++; version++;
      } else if (e.is(addMark)) {
        const m = e.value;
        const mine = items.find((c) => c.kind === m.kind && c.author === cfg.author.name && c.from <= m.to && c.to >= m.from);
        if (mine) items = items.map((c) => (c === mine ? { ...c, from: Math.min(c.from, m.from), to: Math.max(c.to, m.to) } : c));
        else items = [...items, { id: newId(), author: cfg.author.name, color: cfg.author.color, kind: m.kind, from: m.from, to: m.to, at: Date.now() }];
        marks++; version++;
      } else if (e.is(removeMarks)) {
        const ids = new Set(e.value);
        items = items.filter((c) => !ids.has(c.id));
        marks++; version++;
      }
    }
    if (items === v.items && !replaced) return v;
    return { items, deco: build(items), marks, version };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** Turns a user's edit into suggestions while suggesting is on. Programmatic dispatches (loading a file,
 *  remote Yjs updates, undo) carry no input/delete user event and pass through untouched. */
const suggestFilter = EditorState.transactionFilter.of((tr) => {
  const cfg = tr.startState.facet(suggestConfig);
  if (!cfg.on || !tr.docChanged) return tr;
  const ue = tr.annotation(Transaction.userEvent);
  if (!ue || !(ue.startsWith("input") || ue.startsWith("delete") || ue.startsWith("move"))) return tr;
  const st = tr.startState.field(changesField, false);
  if (!st) return tr;

  const specs: ChangeSpec[] = [];
  const inserts: { at: number }[] = [];
  const deletes: { from: number; to: number }[] = [];
  let anyDelete = false;
  let newHead: number | null = null;
  const startHead = tr.startState.selection.main.head;

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const ins = inserted.toString();
    if (toA > fromA) {
      // Deleting inside one's own pending insertion really deletes it.
      const own = st.items.find((c) => c.kind === "insert" && c.author === cfg.author.name && c.from <= fromA && c.to >= toA);
      if (own) { specs.push({ from: fromA, to: toA, insert: ins }); if (ins) inserts.push({ at: fromA }); return; }
      anyDelete = true;
      deletes.push({ from: fromA, to: toA });
      if (ins) { specs.push({ from: toA, insert: ins }); inserts.push({ at: toA }); newHead = toA; }
      else newHead = startHead >= toA ? fromA : toA;
    } else if (ins) {
      specs.push({ from: fromA, insert: ins });
      inserts.push({ at: fromA });
    }
  });

  if (!anyDelete) {
    // Keep the original transaction; only record where text was inserted.
    const effects = inserts.map((i) => addMark.of({ kind: "insert", from: tr.changes.mapPos(i.at, -1), to: tr.changes.mapPos(i.at, 1) }));
    return effects.length ? [tr, { effects }] : tr;
  }

  const cs = tr.startState.changes(specs);
  const effects: StateEffect<unknown>[] = [
    ...deletes.map((d) => addMark.of({ kind: "delete", from: cs.mapPos(d.from, 1), to: cs.mapPos(d.to, -1) })),
    ...inserts.map((i) => addMark.of({ kind: "insert", from: cs.mapPos(i.at, -1), to: cs.mapPos(i.at, 1) })),
  ];
  const head = newHead == null ? cs.mapPos(startHead, 1) : (inserts.length ? cs.mapPos(newHead, 1) : cs.mapPos(newHead, -1));
  return { changes: cs, selection: { anchor: head }, effects, annotations: Transaction.userEvent.of(ue), scrollIntoView: true };
});

function mergeRanges(rs: { from: number; to: number }[]): { from: number; to: number }[] {
  const s = [...rs].sort((a, b) => a.from - b.from);
  const out: { from: number; to: number }[] = [];
  for (const r of s) { const last = out[out.length - 1]; if (last && r.from <= last.to) last.to = Math.max(last.to, r.to); else out.push({ ...r }); }
  return out;
}

/** Accept or reject a set of suggestions in one transaction. */
export function resolveChanges(view: EditorView, ids: string[] | null, accept: boolean) {
  const st = view.state.field(changesField, false);
  if (!st) return;
  const targets = ids ? st.items.filter((c) => ids.includes(c.id)) : st.items;
  if (!targets.length) return;
  const cut = targets.filter((c) => (accept ? c.kind === "delete" : c.kind === "insert"));
  view.dispatch({
    changes: mergeRanges(cut).map((r) => ({ from: r.from, to: r.to })),
    effects: removeMarks.of(targets.map((c) => c.id)),
    annotations: Transaction.userEvent.of(accept ? "resolve.accept" : "resolve.reject"),
  });
}

export function changesIn(state: EditorState): { items: ChangeRange[]; marks: number; version: number } {
  const f = state.field(changesField, false);
  return f ? { items: f.items, marks: f.marks, version: f.version } : { items: [], marks: 0, version: 0 };
}

const changeHover = hoverTooltip((view, pos) => {
  const st = view.state.field(changesField, false);
  const c = st?.items.find((x) => pos >= x.from && pos <= x.to);
  if (!c) return null;
  return {
    pos: c.from, end: c.to, above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "grammar-card change-card";
      dom.style.setProperty("--sugg-color", c.color);
      const msg = document.createElement("div"); msg.className = "gc-msg";
      const who = document.createElement("b"); who.textContent = c.author; msg.appendChild(who);
      msg.appendChild(document.createTextNode(` suggests ${c.kind === "insert" ? "inserting" : "deleting"} this`));
      dom.appendChild(msg);
      const row = document.createElement("div"); row.className = "gc-row";
      for (const [label, accept] of [["Accept", true], ["Reject", false]] as const) {
        const b = document.createElement("button"); b.textContent = label; b.className = `gc-fix ${accept ? "" : "reject"}`;
        b.onmousedown = (e) => { e.preventDefault(); resolveChanges(view, [c.id], accept); };
        row.appendChild(b);
      }
      dom.appendChild(row);
      return { dom };
    },
  };
});

export function trackChanges(): Extension { return [changesField, suggestFilter, changeHover, undoMarks]; }
