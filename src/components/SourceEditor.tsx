import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, Compartment, StateEffect, StateField } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, Decoration, hoverTooltip, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from "@codemirror/commands";
import { bracketMatching, syntaxHighlighting, HighlightStyle, indentOnInput, foldGutter, foldKeymap } from "@codemirror/language";
import { search, searchKeymap, openSearchPanel, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, startCompletion, completionStatus, currentCompletions, type CompletionSource } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";
import { latex, latexCompletionSource } from "codemirror-lang-latex";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { visualExtensions, remoteCursorsField, setRemoteCursors, type RemoteCursor } from "../lib/visual";
import { typstVisualExtensions } from "../lib/visual-typst";
import { projectSource, commandSource, dollarPairing, matchingEnvironment, goToDefinition, goToDefinitionCommand, paperLint, headingEmphasis, type AssistSources } from "../lib/assist";
import { codeLanguage, fileKind, hasProse, isManuscript, typstLanguage, typstHighlight } from "../lib/languages";
import { typstCompletionSource } from "codemirror-lang-typst/lezer";
import { languageServerFor } from "../lib/lsp";
import { focusMode } from "../lib/focus";
import { markup, headingLine, headingBody, listBlock, type FormatAction, type ManuscriptLang } from "../lib/markup";
import { unicodeToTex } from "../lib/unicode-tex";
import { vim } from "@replit/codemirror-vim";
import type { GrammarMatch } from "../lib/grammar";
import type { Settings } from "../lib/settings";
import { currentGhost, ghostText, prediction, setGhostText } from "../lib/predict";
import { trackChanges, suggestConfig, setChanges, changesIn, resolveChanges, type ChangeRange } from "../lib/changes";
import { reviewField, setReview, type ReviewMarks } from "../lib/review";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { gitGutter, setHeadText } from "../lib/git-gutter";
import { errorLens, lintSource, type LensItem } from "../lib/error-lens";
import { minimalChange } from "../lib/code-tools";
import { spelling, spellConfig } from "../lib/spell";

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.function(tags.variableName), tags.macroName], class: "tok-cmd" },
  { tag: tags.comment, class: "tok-cmt" },
  { tag: [tags.string, tags.special(tags.string)], class: "tok-str" },
  { tag: [tags.number, tags.literal], class: "tok-num" },
  { tag: [tags.tagName, tags.typeName, tags.className, tags.labelName], class: "tok-env" },
  { tag: [tags.operator, tags.special(tags.variableName), tags.processingInstruction], class: "tok-math" },
]);

/** Code files share the manuscript's palette: keywords where LaTeX has commands, names where it has environments. */
const codeHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.moduleKeyword], class: "tok-cmd" },
  { tag: tags.comment, class: "tok-cmt" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], class: "tok-str" },
  { tag: [tags.number, tags.bool, tags.null, tags.literal, tags.atom], class: "tok-num" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName), tags.className, tags.typeName, tags.heading], class: "tok-env" },
  { tag: [tags.propertyName, tags.attributeName, tags.labelName], class: "tok-math" },
  { tag: tags.strong, class: "tok-strong" },
  { tag: tags.emphasis, class: "tok-em" },
]);

// ---- comments
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

// ---- compile diagnostics on lines
export interface LineMark { line: number; severity: string; message: string }
const setMarks = StateEffect.define<LineMark[]>();
const marksList = StateField.define<LineMark[]>({
  create: () => [],
  update(v, tr) { for (const e of tr.effects) if (e.is(setMarks)) return e.value; return v; },
});
// Compile problems inline, errors and warnings only: the box and font notices would line the whole file.
const marksSource = (state: EditorState): LensItem[] => (state.field(marksList, false) ?? []).filter((m) => m.severity === "error" || m.severity === "warning").map((m) => ({ line: m.line, severity: m.severity as LensItem["severity"], message: m.message }));
const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setMarks)) {
      const ranges = e.value.filter((m) => m.line >= 1 && m.line <= tr.state.doc.lines).sort((a, b) => a.line - b.line)
        .map((m) => Decoration.line({ class: `cm-diag ${m.severity}`, attributes: { title: m.message } }).range(tr.state.doc.line(m.line).from));
      deco = Decoration.set(ranges, true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---- grammar matches with a hover card offering replacements
const setGrammar = StateEffect.define<GrammarMatch[]>();
const grammarField = StateField.define<{ deco: DecorationSet; matches: GrammarMatch[] }>({
  create: () => ({ deco: Decoration.none, matches: [] }),
  update(v, tr) {
    let deco = v.deco.map(tr.changes);
    let matches = v.matches;
    for (const e of tr.effects) if (e.is(setGrammar)) {
      matches = e.value;
      const ranges = matches.filter((m) => m.to > m.from && m.to <= tr.state.doc.length).sort((a, b) => a.from - b.from)
        .map((m) => Decoration.mark({ class: `cm-grammar ${m.category.toLowerCase()}`, attributes: { title: m.message } }).range(m.from, m.to));
      deco = Decoration.set(ranges, true);
    }
    if (tr.docChanged && !tr.effects.some((e) => e.is(setGrammar))) {
      matches = matches.map((m) => ({ ...m, from: tr.changes.mapPos(m.from), to: tr.changes.mapPos(m.to) }));
    }
    return { deco, matches };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});
const grammarHover = hoverTooltip((view, pos) => {
  const m = view.state.field(grammarField).matches.find((x) => pos >= x.from && pos <= x.to);
  if (!m) return null;
  return {
    pos: m.from, end: m.to, above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "grammar-card";
      const msg = document.createElement("div"); msg.className = "gc-msg"; msg.textContent = m.message; dom.appendChild(msg);
      if (m.replacements.length) {
        const row = document.createElement("div"); row.className = "gc-row";
        for (const r of m.replacements) {
          const b = document.createElement("button"); b.textContent = r || "(remove)"; b.className = "gc-fix";
          b.onmousedown = (e) => { e.preventDefault(); view.dispatch({ changes: { from: m.from, to: m.to, insert: r } }); };
          row.appendChild(b);
        }
        dom.appendChild(row);
      }
      const rule = document.createElement("div"); rule.className = "gc-rule"; rule.textContent = m.rule; dom.appendChild(rule);
      return { dom };
    },
  };
});


interface Props {
  value: string;
  /** Visual layer to use, or false for plain source. */
  visual: false | "tex" | "typst";
  settings: Settings;
  assist: AssistSources;
  collab: { text: Y.Text; awareness: Awareness } | null;
  comments: CommentRange[];
  changes: ChangeRange[];
  suggesting: boolean;
  author: { name: string; color: string };
  onChanges: (ranges: ChangeRange[], doc: string, marksChanged: boolean) => void;
  grammar: GrammarMatch[];
  marks: LineMark[];
  /** Reviewing an agent run: the text is the agent's version, shown read-only with its changes marked. */
  review?: ReviewMarks | null;
  /** The paper's own words (.dabir/dictionary.txt) and how to add one. */
  dictionary: string[];
  onAddWord: (word: string) => void;
  /** Asks the agent for the text that should follow `before`; null when no agent is available. */
  onContinue?: (before: string) => Promise<string | null>;
  onSelection: (from: number, to: number) => void;
  jumpOffset: { pos: number; stamp: number } | null;
  onChange: (text: string) => void;
  onSave: () => void;
  onCursorLine: (line: number) => void;
  jumpLine: number | null;
  jumpStamp: number;
  findRequest: number;
  /** The file as HEAD has it, for the change gutter. */
  headText?: string | null;
}

const sourceOnly = (path: string | null) => [
  lineNumbers(), gitGutter(), foldGutter({ openText: "⌄", closedText: "›" }), highlightActiveLineGutter(), highlightActiveLine(),
  syntaxHighlighting(isManuscript(path) ? highlight : codeHighlight),
  errorLens(lintSource, marksSource),
  ...(fileKind(path) === "tex" ? [matchingEnvironment(), headingEmphasis()] : []),
  // Code files: guides down each indentation level, as an IDE draws them.
  ...(fileKind(path) === "code" || fileKind(path) === "data" ? [indentationMarkers({ hideFirstIndent: true, thickness: 1, colors: { light: "rgba(29,31,36,0.12)", dark: "rgba(255,255,255,0.12)", activeLight: "rgba(29,31,36,0.3)", activeDark: "rgba(255,255,255,0.3)" } })] : []),
];

/** The grammar and the helpers that belong to it. LaTeX (and .bib, .sty) keep the LaTeX language, `$` pairing and
 * the paper-aware linter; code and data files get their own grammar and none of the LaTeX helpers. */
const languageExt = (path: string | null, assist: () => AssistSources) => {
  const code = codeLanguage(path);
  if (code && !isManuscript(path)) return [code];
  if (fileKind(path) === "typst") return [typstLanguage(), syntaxHighlighting(typstHighlight)];
  return [latex({ enableAutocomplete: false, autoCloseBrackets: false, enableLinting: false }), paperLint(assist), dollarPairing()];
};

export interface EditorApi {
  wrap: (pre: string, post: string) => void;      // wrap the selection, or insert and place the cursor inside
  block: (pre: string, post: string) => void;     // insert on its own lines
  list: (env: "itemize" | "enumerate") => void;
  heading: (kind: string) => void;                // section | subsection | subsubsection | paragraph | plain
  complete: (pre: string, post: string) => void;  // insert and open completion inside
  format: (action: FormatAction) => void;         // bold, figure, citation…: LaTeX or Typst markup by the open file
  undo: () => void;
  redo: () => void;
  focus: () => void;
  resolveChanges: (ids: string[] | null, accept: boolean) => void;  // accept or reject suggestions; null means all
  continueSentence: () => void;                   // ask the agent for the next sentence as ghost text
  unicodeToTex: () => number;                     // rewrite pasted symbols in the selection (or the file) as LaTeX; how many changed
  replaceAll: (text: string) => boolean;          // swap the whole text (a formatter's output) as one small change; false when identical
  setHead: (text: string | null) => void;         // the file as HEAD has it, for the change gutter
  text: () => string;
}

const modeExt = (visual: Props["visual"], path: string | null) => (visual === "typst" ? typstVisualExtensions() : visual ? visualExtensions() : sourceOnly(path));

export const SourceEditor = forwardRef<EditorApi, Props>(function SourceEditor({ value, visual, settings, assist, collab, comments, changes, suggesting, author, onChanges, grammar, marks, review, dictionary, onAddWord, onContinue, onSelection, jumpOffset, onChange, onSave, onCursorLine, jumpLine, jumpStamp, findRequest, headText = null }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const modeComp = useRef(new Compartment());
  const readOnlyComp = useRef(new Compartment());
  const spellComp = useRef(new Compartment());
  const onAddWordRef = useRef(onAddWord); onAddWordRef.current = onAddWord;
  const onContinueRef = useRef(onContinue); onContinueRef.current = onContinue;
  /** Ghost placeholder now, the agent's sentence when it arrives, nothing if the caret moved meanwhile. */
  const continueSentence = async () => {
    const v = view.current; if (!v || !onContinueRef.current) return;
    if (currentGhost(v)?.pending) return;
    const head = v.state.selection.main.head;
    const before = v.state.doc.sliceString(Math.max(0, head - 3000), head);
    setGhostText(v, { pos: head, text: "…", pending: true, source: "agent" });
    const text = await onContinueRef.current(before).catch(() => null);
    const still = currentGhost(v);
    if (!still || !still.pending || still.pos !== head || v.state.selection.main.head !== head) return;
    if (!text) { setGhostText(v, null); return; }
    const sep = /\S$/.test(before) && /^[\p{L}\p{N}(\\$]/u.test(text) ? " " : "";
    setGhostText(v, { pos: head, text: sep + text, source: "agent" });
  };
  const spellCfg = (s: Settings, words: string[], path: string | null) => spellConfig.of({ on: s.spellcheck && s.spellLanguage !== "system" && hasProse(path), lang: s.spellLanguage === "system" ? "en-GB" : s.spellLanguage, words, onAddWord: (w) => onAddWordRef.current(w) });
  const collabComp = useRef(new Compartment());
  const prefsComp = useRef(new Compartment());
  const keysComp = useRef(new Compartment());
  const completeComp = useRef(new Compartment());
  const suggestComp = useRef(new Compartment());
  const onChangesRef = useRef(onChanges); onChangesRef.current = onChanges;
  const changesSeen = useRef({ version: 0, marks: 0 });
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave); onSaveRef.current = onSave;
  const onCursorRef = useRef(onCursorLine); onCursorRef.current = onCursorLine;
  const onSelRef = useRef(onSelection); onSelRef.current = onSelection;
  const assistRef = useRef(assist); assistRef.current = assist;
  const langComp = useRef(new Compartment());
  const lspComp = useRef(new Compartment());
  const pathRef = useRef<string | null>(assist.currentFile());
  const loading = useRef(false);

  const prefs = (s: Settings) => [
    EditorView.contentAttributes.of({ spellcheck: s.spellcheck && s.spellLanguage === "system" ? "true" : "false", autocorrect: "off", autocapitalize: "off" }),
    s.lineWrap ? EditorView.lineWrapping : [],
    EditorView.theme({ "&": { "--doc-size": `${s.fontSize}px`, "--mono-size": `${s.monoSize}px` } }),
    ghostText(),
    s.prediction ? prediction() : [],
    s.focusMode ? focusMode() : [],
  ];
  const completionExt = (s: Settings) => {
    if (!s.autocomplete && !s.citeComplete) return [];
    const live: AssistSources = { bib: () => assistRef.current.bib(), symbols: () => assistRef.current.symbols(), files: () => assistRef.current.files(), currentFile: () => assistRef.current.currentFile(), goTo: (f, l) => assistRef.current.goTo(f, l), main: () => assistRef.current.main(), root: () => assistRef.current.root() };
    // The LaTeX sources apply to manuscript files only; code files complete from their grammar and language server.
    if (!isManuscript(pathRef.current)) return autocompletion({ activateOnTyping: true, maxRenderedOptions: 40, icons: true });
    // Typst completes from its own grammar: functions, symbols and math names, plus a language server when tinymist is installed.
    if (fileKind(pathRef.current) === "typst") return autocompletion({ override: s.autocomplete ? [typstCompletionSource] : [], activateOnTyping: true, maxRenderedOptions: 40, icons: true });
    const override: CompletionSource[] = [];
    if (s.citeComplete) override.push(projectSource(live));
    if (s.autocomplete) override.push(commandSource(latexCompletionSource(true) as CompletionSource, live));
    return autocompletion({ override, activateOnTyping: true, maxRenderedOptions: 40, icons: true });
  };

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(), drawSelection(), dropCursor(), rectangularSelection(), crosshairCursor(),
        indentOnInput(), bracketMatching(), closeBrackets(), highlightSelectionMatches(),
        goToDefinition(() => assistRef.current),
        completeComp.current.of(completionExt(settings)), search({ top: true }),
        langComp.current.of(languageExt(pathRef.current, () => assistRef.current)), lspComp.current.of([]),
        keysComp.current.of(settings.keymap === "vim" ? vim() : []),
        prefsComp.current.of(prefs(settings)),
        modeComp.current.of(modeExt(visual, pathRef.current)),
        collabComp.current.of([]),
        suggestComp.current.of(suggestConfig.of({ on: suggesting, author })),
        trackChanges(),
        readOnlyComp.current.of([]),
        reviewField, remoteCursorsField,
        spellComp.current.of(spellCfg(settings, dictionary, pathRef.current)), spelling(),
        commentField, marksList, markField, grammarField, grammarHover,
        keymap.of([
          { key: "Mod-s", run: () => { onSaveRef.current(); return true; } },
          { key: "Mod-Shift-Space", run: () => { void continueSentence(); return true; } },
          { key: "F12", run: goToDefinitionCommand(() => assistRef.current) },
          { key: "Mod-Alt-ArrowDown", run: goToDefinitionCommand(() => assistRef.current) },
          ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, ...foldKeymap, indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !loading.current) onChangeRef.current(u.state.doc.toString());
          if (u.selectionSet || u.docChanged) {
            onCursorRef.current(u.state.doc.lineAt(u.state.selection.main.head).number);
            onSelRef.current(u.state.selection.main.from, u.state.selection.main.to);
          }
          if (!loading.current) {
            const c = changesIn(u.state);
            if (c.version !== changesSeen.current.version) {
              const marksChanged = c.marks !== changesSeen.current.marks;
              changesSeen.current = { version: c.version, marks: c.marks };
              if (c.items.length || marksChanged) onChangesRef.current(c.items, u.state.doc.toString(), marksChanged);
            }
          }
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    const h = host.current as HTMLDivElement & { __view?: EditorView; __complete?: () => unknown };
    h.__view = v; // for automated tests
    h.__complete = () => { startCompletion(v); return { status: completionStatus(v.state), count: currentCompletions(v.state).length }; };
    return () => { v.destroy(); view.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { view.current?.dispatch({ effects: modeComp.current.reconfigure(modeExt(visual, pathRef.current)) }); }, [visual]);
  // A different file may be a different language: swap the grammar, the LaTeX helpers, the mode's highlighting and spelling.
  useEffect(() => {
    const path = assist.currentFile();
    if (path === pathRef.current) return;
    pathRef.current = path;
    view.current?.dispatch({ effects: [langComp.current.reconfigure(languageExt(path, () => assistRef.current)), lspComp.current.reconfigure([]), modeComp.current.reconfigure(modeExt(visual, path)), spellComp.current.reconfigure(spellCfg(settings, dictionary, path)), completeComp.current.reconfigure(completionExt(settings))] });
    // A language server, when one is installed for this kind of file; the answer may arrive after another file opened.
    const root = assist.root();
    if (path && root && !isManuscript(path)) {
      languageServerFor(root, `${root}/${path}`).then((got) => {
        if (got && pathRef.current === path) view.current?.dispatch({ effects: lspComp.current.reconfigure(got.extension) });
      }).catch(() => {});
    }
  }, [assist]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { view.current?.dispatch({ effects: [prefsComp.current.reconfigure(prefs(settings)), keysComp.current.reconfigure(settings.keymap === "vim" ? vim() : []), completeComp.current.reconfigure(completionExt(settings))] }); }, [settings]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { view.current?.dispatch({ effects: spellComp.current.reconfigure(spellCfg(settings, dictionary, pathRef.current)) }); }, [settings, dictionary]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Coauthors' carets as offsets, so Visual widgets can show who is inside the source they hide.
    const sync = () => {
      const view_ = view.current; if (!view_) return;
      const out: RemoteCursor[] = [];
      const doc = collab.text.doc; if (!doc) return;
      collab.awareness.getStates().forEach((st, clientId) => {
        if (clientId === collab.awareness.clientID) return;
        const cur = (st as { cursor?: { head?: unknown } }).cursor, u = (st as { user?: { name?: string; color?: string } }).user;
        if (!cur?.head || !u?.name) return;
        try {
          const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cur.head), doc);
          if (abs && abs.type === collab.text) out.push({ pos: abs.index, name: u.name, color: u.color ?? "#888888" });
        } catch { /* stale position */ }
      });
      view_.dispatch({ effects: setRemoteCursors.of(out) });
    };
    collab.awareness.on("change", sync); sync();
    return () => { collab.awareness.off("change", sync); view.current?.dispatch({ effects: setRemoteCursors.of([]) }); };
  }, [collab]);

  useEffect(() => { view.current?.dispatch({ effects: setComments.of(comments) }); }, [comments]);
  useEffect(() => { view.current?.dispatch({ effects: suggestComp.current.reconfigure(suggestConfig.of({ on: suggesting, author })) }); }, [suggesting, author]);
  useEffect(() => { view.current?.dispatch({ effects: setMarks.of(marks) }); }, [marks, value]);
  useEffect(() => { view.current?.dispatch({ effects: setHeadText.of(headText) }); }, [headText, value]);
  useEffect(() => { view.current?.dispatch({ effects: setGrammar.of(grammar) }); }, [grammar]);
  useEffect(() => {
    view.current?.dispatch({ effects: readOnlyComp.current.reconfigure(review ? [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.editorAttributes.of({ class: "cm-reviewing" })] : []) });
  }, [!!review]);

  useEffect(() => {
    const v = view.current;
    if (!v || !jumpOffset) return;
    const pos = Math.min(jumpOffset.pos, v.state.doc.length);
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    v.focus();
  }, [jumpOffset]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (collab) return;
    const current = v.state.doc.toString();
    if (current !== value) { loading.current = true; v.dispatch({ changes: { from: 0, to: current.length, insert: value }, selection: { anchor: 0 } }); loading.current = false; v.scrollDOM.scrollTop = 0; }
  }, [value, collab]);
  // After the document is the agent's version: mark its lines and open on the first change.
  useEffect(() => {
    const v = view.current; if (!v) return;
    v.dispatch({ effects: setReview.of(review ?? null) });
    if (!review) return;
    const first = Math.min(...review.inserted.map((r) => r.from), ...review.deleted.map((d) => d.line));
    if (Number.isFinite(first) && first >= 1) {
      const pos = v.state.doc.line(Math.min(first, v.state.doc.lines)).from;
      v.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    }
  }, [review, value]);
  // After the document is current, so ranges resolved against the new text land on the new text.
  useEffect(() => {
    const v = view.current; if (!v) return;
    const len = v.state.doc.length;
    v.dispatch({ effects: setChanges.of(changes.filter((c) => c.to <= len)) });
  }, [changes]);

  useEffect(() => {
    const v = view.current;
    if (!v || jumpLine == null) return;
    const line = v.state.doc.line(Math.max(1, Math.min(jumpLine, v.state.doc.lines)));
    v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 48 }) });
    v.focus();
  }, [jumpLine, jumpStamp]);

  useEffect(() => { if (findRequest && view.current) openSearchPanel(view.current); }, [findRequest]);

  const lang = (): ManuscriptLang => (fileKind(pathRef.current) === "typst" ? "typst" : "tex");
  useImperativeHandle(ref, () => ({
    wrap(pre, post) {
      const v = view.current; if (!v) return;
      const { from, to } = v.state.selection.main;
      const sel = v.state.doc.sliceString(from, to);
      v.dispatch({ changes: { from, to, insert: pre + sel + post }, selection: sel ? { anchor: from + pre.length, head: from + pre.length + sel.length } : { anchor: from + pre.length }, userEvent: "input.format" });
      v.focus();
    },
    block(pre, post) {
      const v = view.current; if (!v) return;
      const { from, to } = v.state.selection.main;
      const line = v.state.doc.lineAt(from);
      const sel = v.state.doc.sliceString(from, to);
      const lead = line.from === from ? "" : "\n";
      const text = `${lead}${pre}${sel}${post}\n`;
      v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + lead.length + pre.length }, userEvent: "input.format" });
      v.focus();
    },
    list(env) {
      const v = view.current; if (!v) return;
      const { from, to } = v.state.selection.main;
      const { text, caret } = listBlock(lang(), env, v.state.doc.sliceString(from, to));
      v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + caret }, userEvent: "input.format" });
      v.focus();
    },
    heading(kind) {
      const v = view.current; if (!v) return;
      const line = v.state.doc.lineAt(v.state.selection.main.from);
      const { text, caret } = headingLine(lang(), kind, headingBody(lang(), line.text));
      v.dispatch({ changes: { from: line.from, to: line.to, insert: text }, selection: { anchor: line.from + caret }, userEvent: "input.format" });
      v.focus();
    },
    format(action) {
      const op = markup(lang(), action);
      this[op.kind](op.pre, op.post);
    },
    complete(pre, post) {
      const v = view.current; if (!v) return;
      const { from, to } = v.state.selection.main;
      v.dispatch({ changes: { from, to, insert: pre + post }, selection: { anchor: from + pre.length }, userEvent: "input.format" });
      v.focus();
      startCompletion(v);
    },
    undo() { if (view.current) { undo(view.current); view.current.focus(); } },
    redo() { if (view.current) { redo(view.current); view.current.focus(); } },
    focus() { view.current?.focus(); },
    resolveChanges(ids, accept) { if (view.current) resolveChanges(view.current, ids, accept); },
    continueSentence() { void continueSentence(); },
    replaceAll(text) {
      const v = view.current; if (!v) return false;
      const ch = minimalChange(v.state.doc.toString(), text);
      if (!ch) return false;
      v.dispatch({ changes: ch, userEvent: "input.format", scrollIntoView: true });
      return true;
    },
    setHead(text) { view.current?.dispatch({ effects: setHeadText.of(text) }); },
    text() { return view.current?.state.doc.toString() ?? ""; },
    unicodeToTex() {
      const v = view.current; if (!v || lang() === "typst") return 0;
      const sel = v.state.selection.main;
      const [from, to] = sel.empty ? [0, v.state.doc.length] : [sel.from, sel.to];
      const { text, count } = unicodeToTex(v.state.doc.sliceString(from, to));
      if (count) v.dispatch({ changes: { from, to, insert: text }, userEvent: "input.format" });
      v.focus();
      return count;
    },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className={`editor ${visual ? "visual" : ""}`} ref={host} />;
});
