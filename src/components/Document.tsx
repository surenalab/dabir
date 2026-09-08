import { useEffect, useMemo } from "react";
import { AlertCircle, CheckCircle2, FolderOpen, FilePlus, GitBranch, Loader2, Circle, Upload } from "lucide-react";
import { parseDocument, type BibEntry } from "../lib/latex";
import { setVisualContext } from "../lib/visual";
import { readBinary, type PdfPos, type Project } from "../lib/backend";
import * as pdfjs from "pdfjs-dist";
import type { ViewMode } from "./Toolbar";
import type { CompileState } from "../App";
import { SourceEditor, type CommentRange } from "./SourceEditor";
import { Problems, groupProblems } from "./Problems";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { PdfView, type PdfPin } from "./PdfView";
import type { Settings } from "../lib/settings";
import type { GrammarMatch } from "../lib/grammar";
import type { CompletionSources } from "../lib/completions";

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
  onOpen: () => void;
  onImport: () => void;
  onClone: () => void;
  onNew: () => void;
  onOutline: (o: ReturnType<typeof parseDocument>["outline"]) => void;
  onSourceChange: (text: string) => void;
  onSave: () => void;
  onCursorLine: (line: number) => void;
  onSelectFile: (path: string) => void;
  onJump: (line: number, inSource?: boolean) => void;
  onPdfClick: (page: number, x: number, y: number, alt: boolean) => void;
  compileOnSave: boolean;
  onToggleCompileOnSave: () => void;
  agentReady: boolean;
  onJumpFile: (file: string | null, line: number) => void;
  onFix: (prompt: string) => void;
  collab: { text: Y.Text; awareness: Awareness } | null;
  comments: CommentRange[];
  onSelection: (from: number, to: number) => void;
  jumpOffset: { pos: number; stamp: number } | null;
  settings: Settings;
  grammar: GrammarMatch[];
  completions: CompletionSources;
  pins: PdfPin[];
  onPin: (id: string) => void;
}

export function Document(p: Props) {
  const { project, source, mode, compileState, showLog, error } = p;
  const macros = useMemo(() => (source ? collectMacros(source) : {}), [source]);

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

  useEffect(() => { p.onOutline(source ? parseDocument(source).outline : []); }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

  const result = compileState.status === "done" ? compileState.result : null;
  const diagnostics = result?.diagnostics ?? [];
  const grouped = groupProblems(diagnostics);
  const errors = grouped.filter((d) => d.severity === "error").length;
  const warnings = grouped.filter((d) => d.severity === "warning").length;
  const mainRel = project?.mainTex ? project.mainTex.replace(project.root + "/", "") : "main.tex";
  const currentRel = p.file && project ? p.file.replace(project.root + "/", "") : null;
  const editorMarks = grouped.filter((d) => d.line != null && (d.file ?? mainRel) === currentRel).map((d) => ({ line: d.line!, severity: d.severity, message: d.message }));

  if (!project || (source == null && mode !== "pdf")) {
    return (
      <main className="document">
        {error && <div className="banner error" role="alert"><span>{error}</span><button onClick={p.onDismissError}>Dismiss</button></div>}
        <div className="doc-empty">
          <div className="card">
            <h1>Open a paper to begin</h1>
            <p>Dabir works on a folder: your manuscript, its figures, and the code that made them. Nothing is uploaded, nothing is converted.</p>
            <div className="actions">
              <button className="btn primary" onClick={p.onOpen}><FolderOpen /> Open Folder…</button>
              <button className="btn" onClick={p.onNew} title="Start from a journal template"><FilePlus /> New Paper…</button>
              <button className="btn" onClick={p.onImport} title="Unpack an Overleaf source zip into a folder"><Upload /> Import from Overleaf…</button>
              <button className="btn" onClick={p.onClone}><GitBranch /> Clone from GitHub…</button>
            </div>
            <div className="hint">Try the bundled sample at <code>examples/score-anchor</code>. Press <kbd>⌘/</kbd> for shortcuts.</div>
          </div>
        </div>
      </main>
    );
  }

  const isTex = !p.file || /\.(tex|sty|cls|bib|md|txt|toml|py|json|typ)$/i.test(p.file);

  return (
    <main className="document">
      {error && <div className="banner error" role="alert"><span>{error}</span><button onClick={p.onDismissError}>Dismiss</button></div>}
      <Problems problems={grouped} mainFile={mainRel} agentReady={p.agentReady}
        onJump={(file, line) => p.onJumpFile(file, line)} onFix={p.onFix} />

      <div className="scroll" hidden={mode === "pdf"}>
        {source != null && isTex && (
          <SourceEditor value={source} visual={mode === "visual" && /\.tex$/i.test(p.file ?? "")} onChange={p.onSourceChange} onSave={p.onSave}
            onCursorLine={p.onCursorLine} jumpLine={p.jumpLine} jumpStamp={p.jumpStamp} findRequest={p.findRequest}
            collab={p.collab} comments={p.comments} onSelection={p.onSelection} jumpOffset={p.jumpOffset} marks={editorMarks}
            settings={p.settings} grammar={p.grammar} completions={p.completions} />
        )}
        {source != null && !isTex && <div className="doc-empty"><div className="card"><p>This file type is not editable in Dabir yet.</p></div></div>}
      </div>
      {mode === "pdf" && (
        <div className="scroll">
          <PdfView path={result?.pdf ?? null} stamp={compileState.status === "done" ? compileState.at : 0} target={p.pdfTarget} onClickAt={p.onPdfClick} pins={p.pins} onPin={p.onPin} />
        </div>
      )}

      {showLog && (
        <section className="log" aria-label="Compile log">
          <header><span>Compile log{result ? ` · ${result.engine}` : ""}</span><button className="btn" onClick={p.onToggleLog} style={{ height: 22 }}>Hide</button></header>
          <pre>{result?.log || "No compile has run yet. Press ⌘B to compile."}</pre>
        </section>
      )}

      <footer className="status" role="status" aria-live="polite">
        {compileState.status === "idle" && <span className="state"><Circle aria-hidden /> Not compiled yet</span>}
        {compileState.status === "running" && <span className="state running"><Loader2 aria-hidden /> {p.progress ? <span className="progress" title={p.progress}>{p.progress}</span> : "Compiling…"}</span>}
        {result && result.ok && errors === 0 && <span className={`state ${warnings ? "warn" : "ok"}`}><CheckCircle2 aria-hidden /> Compiled in {(result.millis / 1000).toFixed(1)} s{warnings ? `, ${warnings} warning${warnings > 1 ? "s" : ""}` : ""}</span>}
        {result && (!result.ok || errors > 0) && <span className="state error"><AlertCircle aria-hidden /> Compile failed{errors ? `, ${errors} error${errors > 1 ? "s" : ""}` : ""}</span>}
        {result && <button onClick={p.onToggleLog}>{showLog ? "Hide log" : "Show log"}</button>}
        <button className={`toggle ${p.compileOnSave ? "on" : ""}`} aria-pressed={p.compileOnSave} onClick={p.onToggleCompileOnSave} title="Compile every time you save (⌘S)">{p.compileOnSave ? "Compiles on save" : "Compile on save"}</button>
        <span className="grow" />
        {mode !== "pdf" && source != null && <span>{source.split("\n").length} lines</span>}
        {mode === "visual" && <span title="Click any equation, figure or citation to edit its source">visual · click to reveal source</span>}
      </footer>
    </main>
  );
}
