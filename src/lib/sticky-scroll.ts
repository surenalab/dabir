// Sticky scroll: the headers of the blocks that enclose the first visible line (the `def`, the `class`, the
// `for`) stay pinned at the top of the editor while their bodies scroll, as in VS Code. Scope is read from
// indentation, which every language here uses for its blocks, so no grammar is needed: a header is a
// non-blank line whose next non-blank line is indented deeper. Up to three headers; clicking one jumps to it.

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { EditorSelection, type Extension, type Line } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import { syntaxTree, type HighlightStyle } from "@codemirror/language";

const MAX = 3;

const indentOf = (l: Line) => l.text.length - l.text.trimStart().length;
const blank = (l: Line) => l.text.trim() === "";

function nextNonBlank(view: EditorView, n: number): Line | null {
  const doc = view.state.doc;
  for (let i = n + 1; i <= doc.lines; i++) { const l = doc.line(i); if (!blank(l)) return l; }
  return null;
}

/** The headers enclosing line `n`, outermost first. */
function headersFor(view: EditorView, n: number): Line[] {
  const doc = view.state.doc;
  const start = doc.line(n);
  let minIndent = blank(start) ? Infinity : indentOf(start);
  const out: Line[] = [];
  for (let i = n - 1; i >= 1 && out.length < MAX; i--) {
    const l = doc.line(i);
    if (blank(l)) continue;
    const ind = indentOf(l);
    if (ind < minIndent) {
      const next = nextNonBlank(view, i);
      if (next && indentOf(next) > ind) out.unshift(l);
      minIndent = ind;
      if (ind === 0) break;
    }
  }
  return out;
}

function render(view: EditorView, line: Line, style: HighlightStyle): HTMLElement {
  const el = document.createElement("div");
  el.className = "cm-sticky-line";
  el.style.paddingLeft = getComputedStyle(view.contentDOM).paddingLeft;
  let pos = line.from;
  const put = (from: number, to: number, classes: string) => {
    if (from > pos) el.appendChild(document.createTextNode(view.state.sliceDoc(pos, from)));
    const s = document.createElement("span"); s.className = classes; s.textContent = view.state.sliceDoc(from, to); el.appendChild(s);
    pos = to;
  };
  highlightTree(syntaxTree(view.state), style, put, line.from, line.to);
  if (pos < line.to) el.appendChild(document.createTextNode(view.state.sliceDoc(pos, line.to)));
  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    view.dispatch({ selection: EditorSelection.cursor(line.from + indentOf(line)), effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 0 }) });
    view.focus();
  });
  return el;
}

export function stickyScroll(style: HighlightStyle): Extension {
  return [
    ViewPlugin.fromClass(class {
      panel: HTMLElement;
      shown = "";
      onScroll = () => this.refresh();
      constructor(readonly view: EditorView) {
        this.panel = document.createElement("div");
        this.panel.className = "cm-sticky";
        this.panel.setAttribute("aria-hidden", "true");
        view.dom.appendChild(this.panel);
        view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
        this.refresh();
      }
      update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged || u.geometryChanged) this.refresh(); }
      refresh() {
        const { view } = this;
        // Heights for lineBlockAtHeight are measured from the top of the document, below the scroller's padding.
        const top = Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top);
        const first = view.state.doc.lineAt(view.lineBlockAtHeight(top).from);
        let headers = headersFor(view, first.number);
        if (headers.length) {
          // The panel hides as many lines as it shows; recompute for the line that is actually under it.
          const under = Math.min(view.state.doc.lines, first.number + headers.length);
          const again = headersFor(view, under);
          // A header that is itself the line under the panel is not pinned yet.
          headers = again.filter((h) => h.number < under);
        }
        // Nothing to pin while the outermost header is still on screen at its own place.
        const key = headers.map((h) => h.number).join(",");
        if (key === this.shown) return;
        this.shown = key;
        this.panel.replaceChildren(...headers.map((h) => render(view, h, style)));
        this.panel.style.left = `${view.contentDOM.getBoundingClientRect().left - view.dom.getBoundingClientRect().left}px`;
        this.panel.classList.toggle("on", headers.length > 0);
      }
      destroy() { this.view.scrollDOM.removeEventListener("scroll", this.onScroll); this.panel.remove(); }
    }),
    EditorView.baseTheme({
      ".cm-sticky": { position: "absolute", top: "0", right: "0", zIndex: "6", display: "none", flexDirection: "column", background: "var(--paper, #fff)", borderBottom: "1px solid var(--line, #ddd)", boxShadow: "0 4px 10px -6px rgba(0,0,0,.18)", fontFamily: "inherit", fontSize: "inherit", lineHeight: "inherit" },
      ".cm-sticky.on": { display: "flex" },
      ".cm-sticky-line": { whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis", cursor: "pointer", color: "var(--ink-2, inherit)" },
      ".cm-sticky-line:hover": { background: "var(--paper-2, #f3f1ec)" },
    }),
  ];
}
