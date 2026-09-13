// TODO, FIXME and their kin in comments, set in a small badge so they can be found by eye, as the
// Todo Highlight extension does in VS Code. Only inside comments: a string that says "TODO" is left alone.

import { Decoration, EditorView, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

const OPENERS = /(#|\/\/|\/\*|\*|%|--|;|<!--|"""|''')/;

const matcher = new MatchDecorator({
  regexp: /\b(TODO|FIXME|XXX|HACK|BUG|NOTE)\b:?/g,
  decorate(add, from, to, match, view) {
    const line = view.state.doc.lineAt(from);
    const before = line.text.slice(0, from - line.from);
    if (!OPENERS.test(before)) return;
    const kind = match[1] === "TODO" || match[1] === "NOTE" ? "todo" : "fix";
    add(from, to, Decoration.mark({ class: `cm-todo ${kind}` }));
  },
});

export function todoHighlight(): Extension {
  return [
    ViewPlugin.fromClass(class {
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = matcher.createDeco(view); }
      update(u: ViewUpdate) { this.decorations = matcher.updateDeco(u, this.decorations); }
    }, { decorations: (v) => v.decorations }),
    EditorView.baseTheme({
      ".cm-todo": { borderRadius: "3px", padding: "0 3px", fontWeight: "700" },
      ".cm-todo.todo": { color: "var(--paper, #fff)", background: "var(--info, #2b5aa6)" },
      ".cm-todo.fix": { color: "var(--paper, #fff)", background: "var(--warn, #8a6414)" },
    }),
  ];
}
