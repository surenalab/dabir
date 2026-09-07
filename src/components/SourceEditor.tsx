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
  onChange: (text: string) => void;
  onSave: () => void;
  onCursorLine: (line: number) => void;
  jumpLine: number | null;
  jumpStamp: number;
  findRequest: number;
}

const sourceOnly = () => [lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), syntaxHighlighting(highlight)];

export function SourceEditor({ value, visual, onChange, onSave, onCursorLine, jumpLine, jumpStamp, findRequest }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const modeComp = useRef(new Compartment());
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave); onSaveRef.current = onSave;
  const onCursorRef = useRef(onCursorLine); onCursorRef.current = onCursorLine;

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
        keymap.of([
          { key: "Mod-s", run: () => { onSaveRef.current(); return true; } },
          ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          if (u.selectionSet || u.docChanged) onCursorRef.current(u.state.doc.lineAt(u.state.selection.main.head).number);
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: modeComp.current.reconfigure(visual ? visualExtensions() : sourceOnly()) });
  }, [visual]);

  // Replace the document only when a different file is loaded.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

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
