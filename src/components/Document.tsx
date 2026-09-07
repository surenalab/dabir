import { Fragment, useEffect, useMemo, useRef } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, FolderOpen, GitBranch, Loader2, Circle } from "lucide-react";
import katex from "katex";
import { parseDocument, type Block, type Inline } from "../lib/latex";
import type { Project } from "../lib/backend";
import type { ViewMode } from "./Toolbar";
import type { CompileState } from "../App";
import { SourceEditor } from "./SourceEditor";
import { PdfView } from "./PdfView";

function Math({ tex, display, macros }: { tex: string; display: boolean; macros: Record<string, string> }) {
  const html = useMemo(() => katex.renderToString(tex, { displayMode: display, throwOnError: false, macros, strict: false }), [tex, display, macros]);
  return <span className={display ? "math-display" : "math-inline"} dangerouslySetInnerHTML={{ __html: html }} />;
}

let currentMacros: Record<string, string> = {};

/** Pull \newcommand definitions from the preamble so KaTeX can expand them. */
function collectMacros(src: string): Record<string, string> {
  const macros: Record<string, string> = {};
  const re = /\\(?:re)?newcommand\*?\{?(\\[a-zA-Z]+)\}?(?:\[\d+\])?\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) macros[m[1]] = m[2];
  return macros;
}

/** "candes2006" → "Candès 2006"-ish: capitalised name and year from a BibTeX key. */
function citeLabel(key: string): string {
  const m = /^([a-zA-Z\-]+?)(\d{4})?[a-z]*$/.exec(key);
  if (!m) return key;
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return m[2] ? `${name} ${m[2]}` : name;
}

function Inlines({ items }: { items: Inline[] }) {
  return (
    <>
      {items.map((it, i) => {
        switch (it.kind) {
          case "text": return <Fragment key={i}>{it.text}</Fragment>;
          case "math": return <Math key={i} tex={it.tex} display={false} macros={currentMacros} />;
          case "em": return <em key={i}>{it.text}</em>;
          case "bold": return <b key={i}>{it.text}</b>;
          case "cite": return <span key={i} className="cite" title={`\\cite{${it.keys.join(", ")}}`}>{it.keys.map(citeLabel).join("; ")}</span>;
          case "ref": return <span key={i} className="ref" title={`\\ref{${it.key}}`}>{it.key.replace(/^(fig|eq|sec|tab):/, "")}</span>;
          case "cmd": return <span key={i} className="unknown" title="Shown as source: this command has no visual form yet">{it.tex}</span>;
        }
      })}
    </>
  );
}

function BlockView({ b, project, onSelectFile, figureNumber }: { b: Block; project: Project | null; onSelectFile: (p: string) => void; figureNumber?: number }) {
  switch (b.kind) {
    case "title": return <h1>{b.text}</h1>;
    case "authors": return <div className="authors">{b.text}</div>;
    case "abstract": return <div className="abstract"><b>Abstract. </b><Inlines items={b.inlines} /></div>;
    case "heading": {
      const Tag = b.level === 1 ? "h2" : "h3";
      return <Tag id={`line-${b.line}`}><span className="num">{b.number}</span>{b.text}</Tag>;
    }
    case "para": return <p><Inlines items={b.inlines} /></p>;
    case "equation": return <div className="eq"><Math tex={b.tex} display macros={currentMacros} /><span className="tag">{b.tag}</span></div>;
    case "figure":
      return (
        <figure className="float">
          <div className="placeholder"><span>Figure {figureNumber}</span><code>{b.file ?? "no file"}</code></div>
          <figcaption className="caption"><b>Figure {figureNumber}.</b> <Inlines items={b.caption} /></figcaption>
        </figure>
      );
    case "list": {
      const Tag = b.ordered ? "ol" : "ul";
      return <Tag>{b.items.map((it, i) => <li key={i}><Inlines items={it} /></li>)}</Tag>;
    }
    case "raw": {
      const inp = /^\\(?:input|include)\{([^}]*)\}/.exec(b.tex);
      if (inp && project) {
        const rel = inp[1].endsWith(".tex") ? inp[1] : `${inp[1]}.tex`;
        return (
          <div className="float">
            <button className="placeholder" onClick={() => onSelectFile(`${project.root}/${rel}`)} title="Open this file">
              <span>Included file</span><code>{rel}</code>
            </button>
          </div>
        );
      }
      const bib = /^\\bibliography\{([^}]*)\}/.exec(b.tex);
      if (bib) return <div className="references"><b>References</b>Generated at compile time from <code>{bib[1]}.bib</code>.</div>;
      if (/^\\bibliographystyle/.test(b.tex)) return null;
      return <span className="doc-comment">{b.tex}</span>;
    }
  }
}

interface Props {
  project: Project | null;
  file: string | null;
  source: string | null;
  mode: ViewMode;
  jumpLine: number | null;
  compileState: CompileState;
  showLog: boolean;
  findRequest: number;
  error: string | null;
  onDismissError: () => void;
  onToggleLog: () => void;
  onOpen: () => void;
  onOutline: (o: ReturnType<typeof parseDocument>["outline"]) => void;
  onSourceChange: (text: string) => void;
  onSave: () => void;
  onSelectFile: (path: string) => void;
  onJump: (line: number, inSource?: boolean) => void;
  onCompile: () => void;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Document(p: Props) {
  const { project, source, mode, jumpLine, compileState, showLog, error } = p;
  const parsed = useMemo(() => (source && mode === "visual" ? parseDocument(source) : null), [source, mode]);
  currentMacros = useMemo(() => (source ? collectMacros(source) : {}), [source]);
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => { if (source) p.onOutline(parseDocument(source).outline); else p.onOutline([]); }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (jumpLine == null || mode !== "visual" || !scroll.current) return;
    const el = scroll.current.querySelector(`#line-${jumpLine}`);
    el?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  }, [jumpLine, mode]);

  const result = compileState.status === "done" ? compileState.result : null;
  const diagnostics = result?.diagnostics ?? [];
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const unknown = parsed ? parsed.blocks.filter((b) => b.kind === "raw" && !/^\\(input|include|bibliography)/.test(b.tex)).length : 0;

  if (!project || (!source && mode !== "pdf")) {
    return (
      <main className="document">
        {error && <div className="banner error" role="alert"><span>{error}</span><button onClick={p.onDismissError}>Dismiss</button></div>}
        <div className="doc-empty">
          <div className="card">
            <h1>Open a paper to begin</h1>
            <p>Dabir works on a folder: your manuscript, its figures, and the code that made them. Nothing is uploaded, nothing is converted.</p>
            <div className="actions">
              <button className="btn primary" onClick={p.onOpen}><FolderOpen /> Open Folder…</button>
              <button className="btn" disabled title="Coming in phase 2"><GitBranch /> Clone from GitHub…</button>
            </div>
            <div className="hint">Try the bundled sample at <code>examples/isgd-tci</code>. Press <kbd>⌘/</kbd> for shortcuts.</div>
          </div>
        </div>
      </main>
    );
  }

  let figureNo = 0;

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

      <div className="scroll" ref={scroll}>
        {mode === "visual" && parsed && (
          <article className="page">
            {unknown > 0 && <div className="fidelity" title="Commands without a visual form are shown as source">{unknown} command{unknown > 1 ? "s" : ""} shown as source</div>}
            {parsed.blocks.map((b, i) => {
              const fig = b.kind === "figure" ? ++figureNo : undefined;
              return <BlockView key={i} b={b} project={project} onSelectFile={p.onSelectFile} figureNumber={fig} />;
            })}
          </article>
        )}
        {mode === "source" && source != null && (
          <SourceEditor value={source} onChange={p.onSourceChange} onSave={p.onSave} jumpLine={jumpLine} findRequest={p.findRequest} diagnostics={diagnostics} />
        )}
        {mode === "pdf" && <PdfView path={result?.pdf ?? null} stamp={compileState.status === "done" ? compileState.at : 0} />}
      </div>

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
        {source && <span>{source.split("\n").length} lines</span>}
        {parsed && <span>{parsed.outline.length} sections</span>}
      </footer>
    </main>
  );
}
