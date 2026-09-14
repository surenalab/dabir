// Bracket pairs coloured by nesting depth, as Xcode and VS Code do it: three quiet tones that repeat, so the
// eye can find the partner of a bracket three levels deep without the matcher. Only the visible ranges are
// scanned, and brackets inside strings and comments (by the syntax tree) are left alone. Code files only.

import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSE = new Set([")", "]", "}"]);
const SKIP = /String|Comment|Template|Regexp|Char|Docstring|Interpolation/;
const LEVELS = 3;
const marks = Array.from({ length: LEVELS }, (_, i) => Decoration.mark({ class: `cm-bracket cm-bracket-${i + 1}` }));
const bad = Decoration.mark({ class: "cm-bracket cm-bracket-bad" });

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    // Depth carries over from the text above the viewport, so colours stay stable while scrolling a long body.
    const stack: string[] = [];
    if (from > 0) {
      const before = doc.sliceString(Math.max(0, from - 20000), from);
      for (const ch of before) {
        if (OPEN[ch]) stack.push(OPEN[ch]);
        else if (CLOSE.has(ch) && stack[stack.length - 1] === ch) stack.pop();
      }
    }
    const text = doc.sliceString(from, to);
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (!OPEN[ch] && !CLOSE.has(ch)) continue;
      const pos = from + i;
      if (SKIP.test(tree.resolveInner(pos, 1).name)) continue;
      if (OPEN[ch]) {
        b.add(pos, pos + 1, marks[stack.length % LEVELS]);
        stack.push(OPEN[ch]);
      } else if (stack.length && stack[stack.length - 1] === ch) {
        stack.pop();
        b.add(pos, pos + 1, marks[stack.length % LEVELS]);
      } else {
        b.add(pos, pos + 1, bad);
      }
    }
  }
  return b.finish();
}

export function bracketColours(): Extension {
  return [
    ViewPlugin.fromClass(class {
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = build(view); }
      update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view); }
    }, { decorations: (v) => v.decorations }),
    EditorView.baseTheme({
      ".cm-bracket-1": { color: "var(--bracket-1, inherit)" },
      ".cm-bracket-2": { color: "var(--bracket-2, inherit)" },
      ".cm-bracket-3": { color: "var(--bracket-3, inherit)" },
      ".cm-bracket-bad": { color: "var(--diff-del, #c8102e)", textDecoration: "underline wavy", textUnderlineOffset: "3px" },
    }),
  ];
}
