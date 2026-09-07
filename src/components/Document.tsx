import { useEffect, useMemo } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, FolderOpen, GitBranch, Loader2, Circle, Upload } from "lucide-react";
import { parseDocument, type BibEntry } from "../lib/latex";
import { setVisualContext } from "../lib/visual";
import { readBinary, type PdfPos, type Project } from "../lib/backend";
import * as pdfjs from "pdfjs-dist";
import type { ViewMode } from "./Toolbar";
import type { CompileState } from "../App";
import { SourceEditor } from "./SourceEditor";
import { PdfView } from "./PdfView";

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
  showLog: boolean;
  findRequest: number;
  error: string | null;
  pdfTarget: (PdfPos & { stamp: number }) | null;
  onDismissError: () => void;
  onToggleLog: () => void;
  onOpen: () => void;
  onImport: () => void;
  onClone: () => void;
  onOutline: (o: ReturnType<typeof parseDocument>["outline"]) => void;
  onSourceChange: (text: string) => void;
  onSave: () => void;
  onCursorLine: (line: number) => void;
  onSelectFile: (path: string) => void;
  onJump: (line: number, inSource?: boolean) => void;
  onPdfClick: (page: number, x: number, y: number) => void;
}

export function Document(p: Props) {
  const { project, source, mode, compileState, showLog, error } = p;
  const macros = useMemo(() => (source ? collectMacros(source) : {}), [source]);

  useEffect(() => {
    setVisualContext({
      root: project?.root ?? "",
      bib: p.bib,
      macros,
      loadImage: (rel) => (project ? loadFigure(project.root, rel) : Promise.resolve(null)),
      openFile: (rel) => project && p.onSelectFile(`${project.root}/${rel}`),
    });
  }, [project, p.bib, macros, p.onSelectFile]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { p.onOutline(source ? parseDocument(source).outline : []); }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

  const result = compileState.status === "done" ? compileState.result : null;
  const diagnostics = result?.diagnostics ?? [];
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;

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
              <button className="btn" onClick={p.onImport} title="Unpack an Overleaf source zip into a folder"><Upload /> Import from Overleaf…</button>
              <button className="btn" onClick={p.onClone}><GitBranch /> Clone from GitHub…</button>
            </div>
            <div className="hint">Try the bundled sample at <code>examples/isgd-tci</code>. Press <kbd>⌘/</kbd> for shortcuts.</div>
          </div>
        </div>
      </main>
    );
  }

  const isTex = !p.file || /\.(tex|sty|cls|bib|md|txt|toml|py|json)$/i.test(p.file);

  return (
    <main className="document">
      {error && <div className="banner error" role="alert"><span>{error}</span><button onClick={p.onDismissError}>Dismiss</button></div>}
      {diagnostics.length > 0 && (
        <div className="diagnostics" role="list" aria-label="Compile diagnostics">
          {diagnostics.map((d, i) => (
            <button key={i} className={`diag ${d.severity}`} role="listitem" onClick={() => d.line != null && p.onJump(d.line, true)} title={d.line != null ? "Go to line in Source" : undefined}>
              {d.severity === "error" ? <AlertCircle aria-label="Error" /> : <AlertTriangle aria-label="Warning" />}
              <span className="where">{d.file ?? ""}{d.line != null ? `:${d.line}` : ""}</span>
              <span className="msg">{d.message}</span>
            </button>
          ))}
        </div>
      )}

      <div className="scroll" hidden={mode === "pdf"}>
        {source != null && isTex && (
          <SourceEditor value={source} visual={mode === "visual" && /\.tex$/i.test(p.file ?? "")} onChange={p.onSourceChange} onSave={p.onSave}
            onCursorLine={p.onCursorLine} jumpLine={p.jumpLine} jumpStamp={p.jumpStamp} findRequest={p.findRequest} />
        )}
        {source != null && !isTex && <div className="doc-empty"><div className="card"><p>This file type is not editable in Dabir yet.</p></div></div>}
      </div>
      {mode === "pdf" && (
        <div className="scroll">
          <PdfView path={result?.pdf ?? null} stamp={compileState.status === "done" ? compileState.at : 0} target={p.pdfTarget} onClickAt={p.onPdfClick} />
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
        {compileState.status === "running" && <span className="state running"><Loader2 aria-hidden /> Compiling…</span>}
        {result && result.ok && errors === 0 && <span className={`state ${warnings ? "warn" : "ok"}`}><CheckCircle2 aria-hidden /> Compiled in {(result.millis / 1000).toFixed(1)} s{warnings ? `, ${warnings} warning${warnings > 1 ? "s" : ""}` : ""}</span>}
        {result && (!result.ok || errors > 0) && <span className="state error"><AlertCircle aria-hidden /> Compile failed{errors ? `, ${errors} error${errors > 1 ? "s" : ""}` : ""}</span>}
        {result && <button onClick={p.onToggleLog}>{showLog ? "Hide log" : "Show log"}</button>}
        <span className="grow" />
        {mode !== "pdf" && source != null && <span>{source.split("\n").length} lines</span>}
        {mode === "visual" && <span title="Click any equation, figure or citation to edit its source">visual · click to reveal source</span>}
      </footer>
    </main>
  );
}
