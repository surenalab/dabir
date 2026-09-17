import { useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { AlertCircle, CheckCircle2, FolderOpen, FilePlus, GitBranch, Loader2, Circle, Upload, Radio, Sparkles, Check, X, Compass } from "lucide-react";
import { parseDocument, type BibEntry } from "../lib/latex";
import { setVisualContext } from "../lib/visual";
import { readBinary, type Diagnostic, type PdfPos, type Project } from "../lib/backend";
import { relTo } from "../lib/path";
import type { ViewMode } from "./Toolbar";
import type { CompileState } from "../App";
import { SourceEditor, type CommentRange, type EditorApi } from "./SourceEditor";
import { FormatBar } from "./FormatBar";
import { TerminalPane } from "./Terminal";
import { FileTabs } from "./FileTabs";
import { CodeBar, type CodeState, type LintReport } from "./CodeBar";
import { documentSymbols } from "../lib/lsp";
import { Notebook, notebookOutline } from "./Notebook";
import { codeOutline } from "../lib/code-outline";
import { fileKind } from "../lib/languages";
import { Problems, groupProblems } from "./Problems";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { PdfPin, PdfZoom } from "./PdfView";
import type { Settings } from "../lib/settings";
import type { GrammarMatch } from "../lib/grammar";
import type { AssistSources } from "../lib/assist";
import { proseWords } from "../lib/spell";
import type { ChangeRange } from "../lib/changes";
import type { ReviewMarks } from "../lib/review";
import { chord } from "../lib/keys";
import { clampSplit, SPLIT_DEFAULT, SPLIT_MAX, SPLIT_MIN } from "../lib/pdf-layout";

const PdfView = lazy(() => import("./PdfView").then((m) => ({ default: m.PdfView })));

/** Pull \newcommand definitions from the preamble so KaTeX can expand them. */
function collectMacros(src: string): Record<string, string> {
  const macros: Record<string, string> = {};
  const re = /\\(?:re)?newcommand\*?\{?(\\[a-zA-Z]+)\}?(?:\[\d+\])?\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) macros[m[1]] = m[2];
  return macros;
}

/** Load a figure as a data URL: images directly, PDFs through the first page. */
async function loadFigure(root: string, rel: string): Promise<string | null> {
  const candidates = [rel, `${rel}.pdf`, `${rel}.png`, `${rel}.jpg`, `${rel}.jpeg`];
  for (const c of candidates) {
    try {
      const bytes = await readBinary(`${root}/${c}`);
      if (!bytes.length) continue;
      if (/\.(png|jpe?g|gif|webp)$/i.test(c)) {
        const mime = /\.png$/i.test(c) ? "image/png" : /\.gif$/i.test(c) ? "image/gif" : /\.webp$/i.test(c) ? "image/webp" : "image/jpeg";
        return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
      }
      if (/\.pdf$/i.test(c)) {
        const pdfjs = await import("pdfjs-dist");
        const doc = await pdfjs.getDocument({ data: bytes }).promise;
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const dpr = window.devicePixelRatio || 1;
        const scale = (640 / base.width) * dpr;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
        return canvas.toDataURL("image/png");
      }
    } catch { /* try the next candidate */ }
  }
  return null;
}

interface Props {
  project: Project | null;
  file: string | null;
  source: string | null;
  /** Prose words per manuscript file (relative paths), when the paper spans more than one; null otherwise. */
  paperWords: Record<string, number> | null;
  /** Files opened this session, shown as tabs when there is more than one. */
  openFiles: string[];
  dirty: boolean;
  onCloseFile: (path: string) => void;
  /** The open file as HEAD has it, for the change gutter; null when new or not under Git. */
  headText: string | null;
  bib: Record<string, BibEntry>;
  mode: ViewMode;
  jumpLine: number | null;
  jumpStamp: number;
  compileState: CompileState;
  progress: string | null;
  showLog: boolean;
  findRequest: number;
  error: string | null;
  pdfTarget: (PdfPos & { stamp: number }) | null;
  onDismissError: () => void;
  onToggleLog: () => void;
  /** The terminal pane: shown or not, and a stamp that bumps when it should take focus. */
  terminal: { open: boolean; focusStamp: number; run?: { command: string; stamp: number } | null };
  onToggleTerminal: () => void;
  onOpen: () => void;
  onImport: () => void;
  onClone: () => void;
  onNew: (template?: string) => void;
  /** Featured templates for the welcome card, label and id. */
  onTour: () => void;
  onSetup: (focus?: string) => void;
  onJoin: () => void;
  hostAway: boolean;
  onOutline: (o: ReturnType<typeof parseDocument>["outline"]) => void;
  onSourceChange: (text: string) => void;
  onSave: () => void;
  onCursorLine: (line: number, col: number) => void;
  /** The code bar's state and actions, for code files. */
  code: CodeState & { onRun: () => void; onRunSelection: (text?: string) => void; onRepl: () => void; onFormat: () => void; onServer: (s: { command: string } | null) => void; onLint: (r: LintReport) => void };
  onSelectFile: (path: string) => void;
  onJump: (line: number, inSource?: boolean) => void;
  onPdfClick: (page: number, x: number, y: number) => void;
  compileOnSave: boolean;
  onToggleCompileOnSave: () => void;
  agentReady: boolean;
  onJumpFile: (file: string | null, line: number) => void;
  onFix: (prompt: string) => void;
  collab: { text: Y.Text; awareness: Awareness; host: boolean } | null;
  comments: CommentRange[];
  changes: ChangeRange[];
  author: { name: string; color: string };
  onChanges: (ranges: ChangeRange[], doc: string, marksChanged: boolean) => void;
  onToggleSuggesting: () => void;
  onSelection: (from: number, to: number) => void;
  jumpOffset: { pos: number; stamp: number } | null;
  followOffset: { pos: number; stamp: number } | null;
  onLocalEdit?: () => void;
  settings: Settings;
  grammar: GrammarMatch[];
  assist: AssistSources;
  pins: PdfPin[];
  onPin: (id: string) => void;
  pdfZoom: PdfZoom;
  onPdfZoom: (z: PdfZoom) => void;
  /** The PDF's scale on screen, for the zoom commands to step from when the zoom is a fit mode. */
  onPdfScale?: (scale: number) => void;
  onOpenSettings: () => void;
  onPdfComment: (page: number, x: number, y: number) => void;
  pdfFindRequest: number;
  editorRef: React.RefObject<EditorApi | null>;
  onFind: () => void;
  onCommentSelection: () => void;
  hasSelection: boolean;
  splitRatio: number;
  onSplitRatio: (r: number) => void;
  review: DocReview | null;
  dictionary: string[];
  onAddWord: (word: string) => void;
  onContinue?: (before: string) => Promise<string | null>;
}

/** An agent run under review, as the document shows it. */
export interface DocReview {
  label: string;            // "Claude Code"
  files: string[];          // paper-relative paths the run changed
  text: string | null;      // the agent's version of the open file, when it changed it
  marks: ReviewMarks | null;
  showing: boolean;         // the editor shows the agent's version
  canShow: boolean;         // false in a live session, where the shared text is the only text
  busy: boolean;
  working: boolean;         // a follow-up request is still changing this version
  onToggle: () => void;
  onOpenFile: (rel: string) => void;
  onAccept: () => void;
  onReject: () => void;
}

export function Document(p: Props) {
  const { project, source, mode, compileState, showLog, error, terminal, onToggleTerminal, paperWords, file, openFiles, dirty: fileDirty, onCloseFile, onSelectFile, headText, code, splitRatio } = p;
  const macros = useMemo(() => (source ? collectMacros(source) : {}), [source]);
  const [dragging, setDragging] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  /** Set the editor's share of the split, keeping both panes at their minimum width (tokens.css) when there is room. */
  const splitTo = (ratio: number) => {
    const el = splitRef.current;
    if (!el) return;
    const css = getComputedStyle(el), px = (name: string) => parseFloat(css.getPropertyValue(name)) || 0;
    p.onSplitRatio(clampSplit(ratio, el.clientWidth, px("--split-editor-min"), px("--split-pdf-min")));
  };
  const onDividerKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const to = e.key === "ArrowLeft" ? splitRatio - step : e.key === "ArrowRight" ? splitRatio + step
      : e.key === "Home" ? SPLIT_MIN : e.key === "End" ? SPLIT_MAX : e.key === "Enter" ? SPLIT_DEFAULT : null;
    if (to == null) return;
    e.preventDefault();
    splitTo(to);
  };
  // The PDF on screen: the last build stays up while the next one compiles, so the reader keeps their place.
  const [shownPdf, setShownPdf] = useState<{ path: string | null; at: number }>({ path: null, at: 0 });
  if (compileState.status === "done" && compileState.at !== shownPdf.at) setShownPdf({ path: compileState.result.pdf, at: compileState.at });
  else if (compileState.status === "idle" && shownPdf.at !== 0) setShownPdf({ path: null, at: 0 });

  useEffect(() => {
    setVisualContext({
      revealOnClick: p.settings.revealOnClick,
      root: project?.root ?? "",
      bib: p.bib,
      macros,
      loadImage: (rel) => (project ? loadFigure(project.root, rel) : Promise.resolve(null)),
      openFile: (rel) => project && p.onSelectFile(`${project.root}/${rel}`),
    });
  }, [project, p.bib, macros, p.onSelectFile, p.settings.revealOnClick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { p.onOutline(source ? (fileKind(file) === "notebook" ? notebookOutline(source) : fileKind(file) === "code" || /\.(md|markdown)$/i.test(file ?? "") ? codeOutline(file, source) : parseDocument(source).outline) : []); }, [source, file]); // eslint-disable-line react-hooks/exhaustive-deps
  // When a language server is attached, its symbols replace the regex outline once they arrive (nesting, methods,
  // names the patterns miss). Asked shortly after each edit, and again when the server first attaches.
  const serverCommand = p.code.server?.command ?? null;
  useEffect(() => {
    if (!source || !file || !project || !serverCommand || fileKind(file) !== "code") return;
    let alive = true;
    const t = window.setTimeout(() => {
      documentSymbols(project.root, file).then((items) => { if (alive && items && items.length) p.onOutline(items); }).catch(() => { /* the regex outline stays */ });
    }, 700);
    return () => { alive = false; clearTimeout(t); };
  }, [source, file, project, serverCommand]); // eslint-disable-line react-hooks/exhaustive-deps
  // Prose words only: commands, math, comments and the arguments of \cite, \ref and paths do not count.
  const wordCount = useMemo(() => (source ? proseWords(source).length : 0), [source]);
  // The whole paper: every manuscript file's saved count, with the open file's live count in place of its saved one.
  const openFile = file;
  const paperTotal = useMemo(() => {
    if (!paperWords || !project) return null;
    const rel = openFile ? relTo(project.root, openFile) : openFile;
    const total = Object.values(paperWords).reduce((a, b) => a + b, 0);
    return rel && rel in paperWords ? total - paperWords[rel] + wordCount : null;
  }, [paperWords, project, openFile, wordCount]);

  const result = compileState.status === "done" ? compileState.result : null;
  const currentRelForLint = p.file && project ? relTo(project.root, p.file) : null;
  // The language server's findings for the open code file sit beside the compile's, under the "code" category.
  const codeDiagnostics: Diagnostic[] = fileKind(p.file) === "code" && currentRelForLint
    ? p.code.lint.items.map((i) => ({ severity: i.severity, category: "code", file: currentRelForLint, line: i.line, message: i.message, context: null }))
    : [];
  const diagnostics = [...(result?.diagnostics ?? []), ...codeDiagnostics];
  const grouped = groupProblems(diagnostics);
  const errors = grouped.filter((d) => d.severity === "error").length;
  const warnings = grouped.filter((d) => d.severity === "warning").length;
  const mainRel = project?.mainTex ? relTo(project.root, project.mainTex) : "main.tex";
  const currentRel = p.file && project ? relTo(project.root, p.file) : null;
  // Code diagnostics already live in the editor through the language server; only compile marks are added.
  const editorMarks = grouped.filter((d) => d.category !== "code" && d.line != null && (d.file ?? mainRel) === currentRel).map((d) => ({ line: d.line!, severity: d.severity, message: d.message }));

  if (project && !p.file && mode !== "pdf") {
    // A folder is open but holds no manuscript: say so, rather than showing the welcome card over a full sidebar.
    return (
      <main className="document">
        {error && <div className="banner error" role="alert"><span>{error}</span><button onClick={p.onDismissError}>Dismiss</button></div>}
        <div className="doc-empty">
          <div className="card">
            <h1>No manuscript in {project.name}</h1>
            <p>Dabir looked for <code>main.tex</code>, <code>main.typ</code> or a <code>.tex</code> file with <code>\documentclass</code>, here and one folder down, and found none.{project.treeTruncated ? " This folder is large; the sidebar lists its first few thousand files." : ""}</p>
            <div className="actions">
              <button className="btn primary" onClick={p.onOpen}><FolderOpen /> Open the Paper's Folder…</button>
              <button className="btn" onClick={() => p.onNew()} title="Start from a journal template"><FilePlus /> New Paper…</button>
            </div>
            <div className="hint">Or pick any text file in the sidebar to edit it.</div>
          </div>
        </div>
      </main>
    );
  }

  if (!project || (source == null && mode !== "pdf")) {
    return (
      <main className="document">
        {error && <div className="banner error" role="alert"><span>{error}</span><button onClick={p.onDismissError}>Dismiss</button></div>}
      {p.hostAway && <div className="banner" role="status"><span>The host has left. Your edits stay in this mirror and rejoin when they are back.</span></div>}
        <div className="doc-empty">
          <div className="card">
            <h1>Open a paper to begin</h1>
            <p>Dabir works on a folder: your manuscript, its figures, and the code that made them. Nothing is uploaded, nothing is converted.</p>
            <div className="actions">
              <button className="btn primary" onClick={p.onOpen}><FolderOpen /> Open Folder…</button>
              <button className="btn" onClick={() => p.onNew()} title="Start from a journal template"><FilePlus /> New Paper…</button>
              <button className="btn" onClick={p.onImport} title="Unpack an Overleaf source zip into a folder"><Upload /> Import from Overleaf…</button>
              <button className="btn" onClick={p.onClone}><GitBranch /> Clone from GitHub…</button>
              <button className="btn" onClick={p.onJoin} title="Paste a coauthor's link or invite code; their paper is mirrored here"><Radio /> Join a Live Session…</button>
            </div>
            <div className="tour-offer">
              <div className="tour-offer-text">
                <b>New here?</b> A three-minute tour on a sample paper: the manuscript, its figures, and the code that made them, with an agent and the terminal along the way.
              </div>
              <button className="btn tour-start" onClick={p.onTour}><Compass /> Take the tour</button>
            </div>
            <div className="hint">Press <kbd>{chord("⌘/")}</kbd> for shortcuts.</div>
          </div>
        </div>
      </main>
    );
  }

  // Anything textual opens in the editor; the LaTeX formatting bar and the word count belong to manuscript and notes.
  const isTex = !p.file || /\.(tex|sty|cls|bib|md|txt|toml|py|json|typ|jl|r|sh|bash|zsh|yml|yaml|csv|tsv|cfg|ini|rst|markdown|ltx|dtx|bbx|cbx)$/i.test(p.file);
  const isProse = !file || /\.(tex|sty|cls|bib|typ|md|txt|rst|markdown|ltx)$/i.test(file);
  const markupLang = /\.typ$/i.test(file ?? "") ? "typst" as const : "tex" as const;
  const showEditor = mode !== "pdf";
  const showPdf = mode === "pdf" || mode === "split";
  const rv = p.review;
  const previewing = !!rv && rv.showing && rv.canShow && rv.text != null;
  const editor = source != null && isTex ? (
    <SourceEditor ref={p.editorRef} value={previewing ? rv!.text! : source} visual={mode === "visual" && /\.tex$/i.test(p.file ?? "") ? "tex" : mode === "visual" && /\.typ$/i.test(p.file ?? "") ? "typst" : false} onChange={p.onSourceChange} onSave={p.onSave}
      onCursorLine={p.onCursorLine} jumpLine={p.jumpLine} jumpStamp={p.jumpStamp} findRequest={p.findRequest}
      collab={p.collab} comments={p.comments} onSelection={p.onSelection} jumpOffset={p.jumpOffset} followOffset={p.followOffset} onLocalEdit={p.onLocalEdit} marks={editorMarks}
      changes={previewing ? [] : p.changes} suggesting={p.settings.suggesting} author={p.author} onChanges={p.onChanges}
      review={previewing ? rv!.marks : null} dictionary={p.dictionary} onAddWord={p.onAddWord} onContinue={p.onContinue}
      settings={p.settings} grammar={p.grammar} assist={p.assist} headText={headText} onRunSelection={code.onRunSelection} onLanguageServer={code.onServer} onLint={code.onLint} />
  ) : source != null && fileKind(p.file) === "notebook" ? (
    <Notebook source={source} path={p.file!} jumpLine={p.jumpLine} jumpStamp={p.jumpStamp} onRunCode={project ? (text) => code.onRunSelection(text) : undefined} onRepl={project && code.repl ? code.onRepl : null} />
  ) : source != null ? <div className="doc-empty"><div className="card"><p>This file type is not editable in Dabir yet.</p></div></div> : null;
  const pdf = showPdf ? (
    <Suspense fallback={<div className="doc-empty"><div className="card"><p>Loading PDF…</p></div></div>}>
      <PdfView path={shownPdf.path} stamp={shownPdf.at} target={p.pdfTarget} onJump={p.onPdfClick} onComment={p.onPdfComment} pins={p.pins} onPin={p.onPin} zoom={p.pdfZoom} onZoom={p.onPdfZoom} onScale={p.onPdfScale} findRequest={p.pdfFindRequest} />
    </Suspense>
  ) : null;

  return (
    <main className="document">
      {error && <div className="banner error" role="alert"><span>{error}</span><button onClick={p.onDismissError}>Dismiss</button></div>}
      {p.hostAway && <div className="banner" role="status"><span>The host has left. Your edits stay in this mirror and rejoin when they are back.</span></div>}
      <Problems problems={grouped} mainFile={mainRel} agentReady={p.agentReady}
        onJump={(file, line) => p.onJumpFile(file, line)} onFix={p.onFix} />

      {rv && (
        <div className={`banner review ${previewing ? "showing" : ""}`} role="status">
          <Sparkles aria-hidden />
          <span className="what">
            {rv.working ? (
              <>{rv.label} is working on its version{rv.text != null && previewing ? "; you are reading it as it stood" : ""}.</>
            ) : rv.text != null ? (
              <>{rv.label} changed this file{rv.files.length > 1 ? ` and ${rv.files.length - 1} other${rv.files.length > 2 ? "s" : ""}` : ""}.{previewing ? chord(" You are reading its version; ⌘B compiles it.") : rv.canShow ? " Showing your version." : ""}</>
            ) : (
              <>{rv.label} changed {rv.files.slice(0, 3).map((f, i) => <span key={f}>{i ? ", " : ""}<button className="link" onClick={() => rv.onOpenFile(f)}>{f}</button></span>)}{rv.files.length > 3 ? ` and ${rv.files.length - 3} more` : ""}, not this file.</>
            )}
          </span>
          <span className="grow" />
          {rv.text != null && rv.canShow && (
            <button className={`toggle ${previewing ? "on" : ""}`} aria-pressed={previewing} onClick={rv.onToggle} title="Switch between your version and the agent's">{previewing ? "Agent's version" : "Your version"}</button>
          )}
          <button className="btn primary" disabled={rv.busy} onClick={rv.onAccept} title="The change lands in your files and is saved. A snapshot is taken; commit whenever you like."><Check aria-hidden /> Accept</button>
          <button className="btn" disabled={rv.busy} onClick={rv.onReject}><X aria-hidden /> Reject</button>
        </div>
      )}
      {project && <FileTabs root={project.root} files={openFiles} active={file} dirty={fileDirty} onSelect={onSelectFile} onClose={onCloseFile} />}
      {showEditor && !isProse && !previewing && file && project && fileKind(file) !== "notebook" && <CodeBar rel={relTo(project.root, file)} state={code} onRun={code.onRun} onRunSelection={() => code.onRunSelection()} onRepl={code.onRepl} onFormat={code.onFormat} onNextProblem={() => p.editorRef.current?.nextDiagnostic()} />}
      {showEditor && isProse && !previewing && <FormatBar api={p.editorRef.current} lang={markupLang} onFind={p.onFind} onComment={p.onCommentSelection} canComment={p.hasSelection} suggesting={p.settings.suggesting} onToggleSuggesting={p.onToggleSuggesting} pending={p.changes.length} />}
      <div className={`panes ${mode === "split" ? "split" : ""}`} ref={splitRef} style={mode === "split" ? { "--split": `${Math.round(splitRatio * 100)}%` } as React.CSSProperties : undefined}>
        <div className="scroll" hidden={!showEditor}>{editor}</div>
        {mode === "split" && (
          <div className={`vdivider ${dragging ? "dragging" : ""}`} role="separator" aria-orientation="vertical" aria-label="Resize editor and PDF" tabIndex={0}
            aria-valuemin={Math.round(SPLIT_MIN * 100)} aria-valuemax={Math.round(SPLIT_MAX * 100)} aria-valuenow={Math.round(splitRatio * 100)} aria-valuetext={`Editor ${Math.round(splitRatio * 100)} percent`}
            title="Drag to resize, double-click to reset"
            onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); }}
            onPointerMove={(e) => { if (!dragging) return; const r = splitRef.current?.getBoundingClientRect(); if (r) splitTo((e.clientX - r.left) / r.width); }}
            onPointerUp={() => setDragging(false)} onLostPointerCapture={() => setDragging(false)}
            onDoubleClick={() => splitTo(SPLIT_DEFAULT)} onKeyDown={onDividerKey} />
        )}
        {showPdf && <div className="scroll pdfpane">{pdf}</div>}
      </div>

      {terminal.open && project && <TerminalPane cwd={project.root} remote={project.remote ?? null} onClose={onToggleTerminal} focusStamp={terminal.focusStamp} run={terminal.run ?? null} />}

      {showLog && (
        <section className="log" aria-label="Compile log">
          <header><span>Compile log{result ? ` · ${result.engine}` : ""}</span><button className="btn" onClick={p.onToggleLog} style={{ height: 22 }}>Hide</button></header>
          <pre>{result?.log || chord("No compile has run yet. Press ⌘B to compile.")}</pre>
        </section>
      )}

      <footer className="status" role="status" aria-live="polite">
        {compileState.status === "idle" && <span className="state"><Circle aria-hidden /> Not compiled yet</span>}
        {compileState.status === "running" && <span className="state running"><Loader2 aria-hidden /> {p.progress ? <span className="progress" title={p.progress}>{p.progress}</span> : "Compiling…"}</span>}
        {result && result.ok && errors === 0 && <span className={`state ${warnings ? "warn" : "ok"}`}><CheckCircle2 aria-hidden /> Compiled {compileState.status === "done" && compileState.agent ? `${compileState.agent}'s version ` : ""}in {(result.millis / 1000).toFixed(1)} s{warnings ? `, ${warnings} warning${warnings > 1 ? "s" : ""}` : ""}</span>}
        {result && (!result.ok || errors > 0) && <span className="state error"><AlertCircle aria-hidden /> {compileState.status === "done" && compileState.agent ? `${compileState.agent}'s version failed to compile` : "Compile failed"}{errors ? `, ${errors} error${errors > 1 ? "s" : ""}` : ""}</span>}
        {result && result.engine === "none" && <button className="btn small" onClick={() => p.onSetup(file?.endsWith(".typ") ? "typst" : "latex")}>Install the compiler…</button>}
        {result && <button onClick={p.onToggleLog} data-p="2">{showLog ? "Hide log" : "Show log"}</button>}
        {project && <button onClick={onToggleTerminal} data-p="2" title={chord("A shell in the paper's folder (⌃`)")}>{terminal.open ? "Hide terminal" : "Terminal"}</button>}
        <button data-p="1" className={`toggle ${p.compileOnSave ? "on" : ""}`} aria-pressed={p.compileOnSave} onClick={p.onToggleCompileOnSave} title={chord("Compile every time you save (⌘S)")}>{p.compileOnSave ? "Compiles on save" : "Compile on save"}</button>
        <span className="grow" />
        {mode !== "pdf" && source != null && (isProse ? <span data-p="3" title={`${source.split("\n").length} lines`}>{wordCount.toLocaleString()} words{paperTotal != null && <span className="paper-words" title={Object.entries(paperWords!).map(([f, n]) => `${f}: ${n.toLocaleString()}`).join("\n")}> · {paperTotal.toLocaleString()} in paper</span>}</span> : <span data-p="3">{fileKind(file) === "notebook" ? `${(source.match(/"cell_type"/g) ?? []).length} cells` : `${source.split("\n").length} lines`}</span>)}
        {mode !== "pdf" && (
          <button data-p="2" className="toggle writing" onClick={p.onOpenSettings} title={chord("Spelling, grammar, completion and prediction. Click to change in Settings (⌘,)")}>
            {[p.settings.spellcheck ? "spelling" : null, p.settings.grammar !== "off" ? "grammar" : null, p.settings.autocomplete || p.settings.citeComplete ? "completion" : null, p.settings.prediction ? "prediction" : null].filter(Boolean).join(" · ") || "writing aids off"}
          </button>
        )}
        {mode === "visual" && <span data-p="4" title="Click any equation, figure or citation to edit its source">click to reveal source</span>}
        {mode === "split" && <span data-p="4" title="The PDF follows the cursor; double-click the PDF to go to the source line">PDF follows the cursor</span>}
      </footer>
    </main>
  );
}
