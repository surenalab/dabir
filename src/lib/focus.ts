// Focus mode: the paragraph under the cursor is ink, the rest of the page recedes, and the line
// being typed stays near the middle of the window. Paragraphs are runs of non-blank lines.

import { EditorView, ViewPlugin, Decoration, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { RangeSetBuilder } from "@codemirror/state";

const dim = Decoration.line({ class: "cm-dim" });

/** First and last line numbers of the paragraph around `pos`. */
export function paragraphAt(doc: Text, pos: number): { from: number; to: number } {
  const here = doc.lineAt(pos);
  let from = here.number;
  let to = here.number;
  if (here.text.trim() === "") return { from, to };
  while (from > 1 && doc.line(from - 1).text.trim() !== "") from--;
  while (to < doc.lines && doc.line(to + 1).text.trim() !== "") to++;
  return { from, to };
}

function dimOthers(view: EditorView): DecorationSet {
  const { from, to } = paragraphAt(view.state.doc, view.state.selection.main.head);
  const b = new RangeSetBuilder<Decoration>();
  for (const r of view.visibleRanges) {
    let line = view.state.doc.lineAt(r.from);
    for (;;) {
      if (line.number < from || line.number > to) b.add(line.from, line.from, dim);
      if (line.to >= r.to || line.number >= view.state.doc.lines) break;
      line = view.state.doc.line(line.number + 1);
    }
  }
  return b.finish();
}

export function focusMode() {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = dimOthers(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = dimOthers(u.view);
      // Typewriter scrolling for typing and keyboard movement; a click keeps the page where it is.
      const typed = u.transactions.some((t) => t.isUserEvent("input") || t.isUserEvent("delete") || (t.isUserEvent("select") && !t.isUserEvent("select.pointer")));
      if (typed && u.selectionSet) {
        const head = u.state.selection.main.head;
        setTimeout(() => { if (u.view.state.selection.main.head === head) u.view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) }); }, 0);
      }
    }
  }, { decorations: (v) => v.decorations });
}
