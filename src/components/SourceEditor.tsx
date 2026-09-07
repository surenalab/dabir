import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, syntaxHighlighting, HighlightStyle, indentOnInput } from "@codemirror/language";
import { search, searchKeymap, openSearchPanel, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";
import { latex } from "codemirror-lang-latex";
import { visualExtensions } from "../lib/visual";
import { yCollab } from "y-codemirror.next";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";

export interface CommentRange { id: string; from: number; to: number; resolved: boolean; color: string }
const setComments = StateEffect.define<CommentRange[]>();
const commentField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setComments)) {
      const ranges = e.value.filter((c) => c.to > c.from && c.to <= tr.state.doc.length).sort((a, b) => a.from - b.from)
        .map((c) => Decoration.mark({ class: `cm-comment ${c.resolved ? "resolved" : ""}`, attributes: { "data-comment": c.id, style: `--comment-color:${c.color}` } }).range(c.from, c.to));
      deco = Decoration.set(ranges, true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.function(tags.variableName), tags.macroName], class: "tok-cmd" },
  { tag: tags.comment, class: "tok-cmt" },
  { tag: [tags.string, tags.special(tags.string)], class: "tok-str" },
  { tag: [tags.number, tags.literal], class: "tok-num" },
  { tag: [tags.tagName, tags.typeName, tags.className, tags.labelName], class: "tok-env" },
  { tag: [tags.operator, tags.special(tags.variableName), tags.processingInstruction], class: "tok-math" },
]);

interface Props {
  value: string;
  visual: boolean;
  collab: { text: Y.Text; awareness: Awareness } | null;
  comments: CommentRange[];
  onSelection: (from: number, to: number) => void;
  jumpOffset: { pos: number; stamp: number } | null;
  onChange: (text: string) => void;
  onSave: () => void;
  onCursorLine: (line: number) => void;
  jumpLine: number | null;
  jumpStamp: number;
  findRequest: number;
}

const sourceOnly = () => [lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), syntaxHighlighting(highlight)];

export function SourceEditor({ value, visual, collab, comments, onSelection, jumpOffset, onChange, onSave, onCursorLine, jumpLine, jumpStamp, findRequest }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const modeComp = useRef(new Compartment());
  const collabComp = useRef(new Compartment());
  const onSelRef = useRef(onSelection); onSelRef.current = onSelection;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave); onSaveRef.current = onSave;
  const onCursorRef = useRef(onCursorLine); onCursorRef.current = onCursorLine;
  const loading = useRef(false);

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(), drawSelection(), dropCursor(), rectangularSelection(), crosshairCursor(),
        indentOnInput(), bracketMatching(), closeBrackets(), highlightSelectionMatches(),
        autocompletion(), search({ top: true }),
        latex(),
        EditorView.lineWrapping,
        modeComp.current.of(visual ? visualExtensions() : sourceOnly()),
        collabComp.current.of([]),
        commentField,
        keymap.of([
          { key: "Mod-s", run: () => { onSaveRef.current(); return true; } },
          ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !loading.current) onChangeRef.current(u.state.doc.toString());
          if (u.selectionSet || u.docChanged) {
            onCursorRef.current(u.state.doc.lineAt(u.state.selection.main.head).number);
            onSelRef.current(u.state.selection.main.from, u.state.selection.main.to);
          }
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    (host.current as HTMLDivElement & { __view?: EditorView }).__view = v; // for automated tests
    return () => { v.destroy(); view.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: modeComp.current.reconfigure(visual ? visualExtensions() : sourceOnly()) });
  }, [visual]);

  // Live session: bind the shared text. The editor takes the shared content as its own.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (!collab) { v.dispatch({ effects: collabComp.current.reconfigure([]) }); return; }
    const shared = collab.text.toString();
    const current = v.state.doc.toString();
    if (shared !== current) {
      loading.current = true;
      v.dispatch({ changes: { from: 0, to: current.length, insert: shared } });
      loading.current = false;
      onChangeRef.current(shared);
    }
    v.dispatch({ effects: collabComp.current.reconfigure(yCollab(collab.text, collab.awareness)) });
  }, [collab]);

  useEffect(() => { view.current?.dispatch({ effects: setComments.of(comments) }); }, [comments]);

  useEffect(() => {
    const v = view.current;
    if (!v || !jumpOffset) return;
    const pos = Math.min(jumpOffset.pos, v.state.doc.length);
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    v.focus();
  }, [jumpOffset]);

  // Replace the document only when a different file is loaded.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (collab) return; // the shared text owns the document during a session
    if (current !== value) { loading.current = true; v.dispatch({ changes: { from: 0, to: current.length, insert: value }, selection: { anchor: 0 } }); loading.current = false; v.scrollDOM.scrollTop = 0; }
  }, [value, collab]);

  useEffect(() => {
    const v = view.current;
    if (!v || jumpLine == null) return;
    const line = v.state.doc.line(Math.max(1, Math.min(jumpLine, v.state.doc.lines)));
    v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 48 }) });
    v.focus();
  }, [jumpLine, jumpStamp]);

  useEffect(() => { if (findRequest && view.current) openSearchPanel(view.current); }, [findRequest]);

  return <div className={`editor ${visual ? "visual" : ""}`} ref={host} />;
}
