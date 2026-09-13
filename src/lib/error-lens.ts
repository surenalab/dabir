// Diagnostics written at the end of the line they belong to, so an error is read where it is rather than
// found by hovering a squiggle: what the Error Lens extension does in VS Code. One message per line, the
// worst severity first; the line itself gets a faint wash of the same colour.

import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import { forEachDiagnostic } from "@codemirror/lint";

export interface LensItem { line: number; severity: "error" | "warning" | "info" | "hint"; message: string }
export type LensSource = (state: EditorState) => LensItem[];

const RANK: Record<LensItem["severity"], number> = { error: 0, warning: 1, info: 2, hint: 3 };

class LensWidget extends WidgetType {
  constructor(readonly severity: string, readonly message: string, readonly more: number) { super(); }
  eq(other: LensWidget) { return other.severity === this.severity && other.message === this.message && other.more === this.more; }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-lens ${this.severity}`;
    el.textContent = this.message.split("\n")[0].slice(0, 160) + (this.more ? `  +${this.more}` : "");
    el.title = this.message;
    return el;
  }
  ignoreEvent() { return true; }
}

/** The lint diagnostics of the editor (language servers, linters) as lens items. */
export const lintSource: LensSource = (state) => {
  const out: LensItem[] = [];
  forEachDiagnostic(state, (d, from) => { out.push({ line: state.doc.lineAt(from).number, severity: d.severity, message: d.message }); });
  return out;
};

/** Show the items from `sources` inline. Recomputed when the document, the viewport or the diagnostics change. */
export function errorLens(...sources: LensSource[]): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view, sources); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.effects.length > 0 || tr.reconfigured)) this.decorations = build(u.view, sources);
    }
  }, { decorations: (v) => v.decorations });
  return [plugin, EditorView.baseTheme({
    ".cm-lens": { marginLeft: "2em", padding: "0 6px", borderRadius: "3px", fontSize: "0.85em", opacity: "0.9", whiteSpace: "pre", fontStyle: "italic" },
    ".cm-lens.error": { color: "var(--diff-del, #c8102e)", background: "color-mix(in srgb, var(--diff-del, #c8102e) 10%, transparent)" },
    ".cm-lens.warning": { color: "var(--warn, #8a6414)", background: "color-mix(in srgb, var(--warn, #8a6414) 12%, transparent)" },
    ".cm-lens.info, .cm-lens.hint": { color: "var(--ink-3, #676a74)", background: "color-mix(in srgb, var(--ink-3, #676a74) 10%, transparent)" },
    ".cm-lens-line.error": { background: "color-mix(in srgb, var(--diff-del, #c8102e) 5%, transparent)" },
    ".cm-lens-line.warning": { background: "color-mix(in srgb, var(--warn, #8a6414) 6%, transparent)" },
  })];
}

function build(view: EditorView, sources: LensSource[]): DecorationSet {
  const byLine = new Map<number, LensItem[]>();
  for (const s of sources) for (const it of s(view.state)) {
    if (it.line < 1 || it.line > view.state.doc.lines) continue;
    const list = byLine.get(it.line); if (list) list.push(it); else byLine.set(it.line, [it]);
  }
  if (!byLine.size) return Decoration.none;
  const b = new RangeSetBuilder<Decoration>();
  const lines = [...byLine.keys()].sort((x, y) => x - y);
  for (const n of lines) {
    const line = view.state.doc.line(n);
    if (line.to < view.viewport.from || line.from > view.viewport.to) continue;
    const items = byLine.get(n)!.sort((x, y) => RANK[x.severity] - RANK[y.severity]);
    const top = items[0];
    b.add(line.from, line.from, Decoration.line({ class: `cm-lens-line ${top.severity}` }));
    b.add(line.to, line.to, Decoration.widget({ widget: new LensWidget(top.severity, top.message, items.length - 1), side: 1 }));
  }
  return b.finish();
}
