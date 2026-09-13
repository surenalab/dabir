// The change gutter an IDE shows beside the line numbers: a bar where the buffer differs from HEAD (green
// added, blue changed, a red mark where lines were removed). Live, against the buffer, not the saved file.

import { StateEffect, StateField, RangeSet, type Extension } from "@codemirror/state";
import { gutter, GutterMarker, EditorView } from "@codemirror/view";
import { diffLines } from "diff";

export type ChangeKind = "added" | "changed" | "removed";
export interface LineChange { line: number; kind: ChangeKind }

/** Where `now` differs from `head`, per line of `now`. A removal is marked on the line that follows it. */
export function lineChanges(head: string, now: string): LineChange[] {
  const out: LineChange[] = [];
  let line = 1;
  let pendingRemoved = 0;
  for (const part of diffLines(head, now)) {
    const n = part.count ?? part.value.split("\n").length - (part.value.endsWith("\n") ? 1 : 0);
    if (part.removed) { pendingRemoved += n; continue; }
    if (part.added) {
      const changed = Math.min(pendingRemoved, n);
      for (let i = 0; i < n; i++) out.push({ line: line + i, kind: i < changed ? "changed" : "added" });
      pendingRemoved = 0;
      line += n;
      continue;
    }
    if (pendingRemoved) { out.push({ line, kind: "removed" }); pendingRemoved = 0; }
    line += n;
  }
  if (pendingRemoved) out.push({ line: Math.max(1, line - 1), kind: "removed" });
  return out;
}

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: ChangeKind) { super(); }
  eq(other: ChangeMarker) { return other.kind === this.kind; }
  toDOM() { const el = document.createElement("div"); el.className = `cm-git-mark ${this.kind}`; return el; }
}
const MARKERS: Record<ChangeKind, ChangeMarker> = { added: new ChangeMarker("added"), changed: new ChangeMarker("changed"), removed: new ChangeMarker("removed") };

/** Set (or clear, with null) the HEAD text the buffer is compared with. */
export const setHeadText = StateEffect.define<string | null>();

interface GitState { head: string | null; marks: RangeSet<GutterMarker> }

function compute(head: string | null, doc: { toString(): string; lines: number; line(n: number): { from: number } }): RangeSet<GutterMarker> {
  if (head == null) return RangeSet.empty;
  if (doc.lines > 20000) return RangeSet.empty;   // a diff of that size is not worth the keystroke latency
  const changes = lineChanges(head, doc.toString());
  const ranges = changes.filter((c) => c.line >= 1 && c.line <= doc.lines).map((c) => MARKERS[c.kind].range(doc.line(c.line).from));
  return RangeSet.of(ranges, true);
}

const gitField = StateField.define<GitState>({
  create: () => ({ head: null, marks: RangeSet.empty }),
  update(v, tr) {
    let head = v.head;
    let reset = false;
    for (const e of tr.effects) if (e.is(setHeadText)) { head = e.value; reset = true; }
    if (!reset && !tr.docChanged) return v;
    if (!reset && head == null) return v;
    return { head, marks: compute(head, tr.state.doc) };
  },
});

/** The gutter and its state; call `view.dispatch({ effects: setHeadText.of(text) })` when a file opens or HEAD moves. */
export function gitGutter(): Extension {
  return [
    gitField,
    gutter({ class: "cm-gitGutter", markers: (view) => view.state.field(gitField).marks, initialSpacer: () => MARKERS.added }),
    EditorView.baseTheme({
      ".cm-gitGutter": { width: "4px", marginLeft: "1px" },
      ".cm-gitGutter .cm-gutterElement": { padding: "0" },
      ".cm-git-mark": { width: "3px", height: "100%", borderRadius: "1px" },
      ".cm-git-mark.added": { background: "var(--ok, #2f6b3a)" },
      ".cm-git-mark.changed": { background: "var(--info, #2b5aa6)" },
      // A small triangle pointing at the gap where lines were removed.
      ".cm-git-mark.removed": { width: "5px", height: "8px", background: "var(--diff-del, #c8102e)", clipPath: "polygon(0 0, 100% 50%, 0 100%)", borderRadius: "0" },
    }),
  ];
}
