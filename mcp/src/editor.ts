// The panel's Source tab: CodeMirror with the app's LaTeX grammar and highlight classes (src/components/SourceEditor.tsx).
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { latex } from 'codemirror-lang-latex'

// The same classes as the app's manuscript highlight, so tokens.css colours them the same way.
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.function(tags.variableName), tags.macroName], class: 'tok-cmd' },
  { tag: tags.comment, class: 'tok-cmt' },
  { tag: [tags.string, tags.special(tags.string)], class: 'tok-str' },
  { tag: [tags.number, tags.literal], class: 'tok-num' },
  { tag: [tags.tagName, tags.typeName, tags.className, tags.labelName], class: 'tok-env' },
  { tag: [tags.operator, tags.special(tags.variableName), tags.processingInstruction], class: 'tok-math' },
])

export function createEditor(parent: HTMLElement, onEdit: () => void, onSave: () => void) {
  const locked = new Compartment()
  const view = new EditorView({
    parent,
    state: EditorState.create({
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), history(), bracketMatching(),
        search({ top: true }), highlightSelectionMatches(), EditorView.lineWrapping,
        latex({ enableAutocomplete: false, autoCloseBrackets: false, enableLinting: false }), syntaxHighlighting(highlight),
        keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (onSave(), true) }, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        locked.of([]),
        EditorView.updateListener.of((u) => { if (u.docChanged && u.transactions.some((t) => t.annotation(Transaction.userEvent) !== undefined)) onEdit() }),
      ],
    }),
  })
  return {
    text: () => view.state.doc.toString(),
    /** Replace the text without counting it as the author's edit; the cursor stays where it can. */
    load(text: string) {
      const at = Math.min(view.state.selection.main.head, text.length)
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: at }, annotations: Transaction.addToHistory.of(false) })
    },
    lock(isLocked: boolean) {
      view.dispatch({ effects: locked.reconfigure(isLocked ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []) })
    },
    goTo(line: number) {
      const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)))
      view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) })
      view.focus()
    },
  }
}
