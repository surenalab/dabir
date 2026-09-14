import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Play } from "lucide-react";
import { highlightCode } from "@lezer/highlight";
import { LanguageSupport } from "@codemirror/language";
import { codeLanguage } from "../lib/languages";
import { renderMarkdown } from "../lib/md";
import { codeHighlight } from "./SourceEditor";
import type { OutlineItem } from "../lib/latex";

/**
 * A Jupyter notebook, read as the paper's coauthor would read it: markdown cells as text, code cells set in
 * the editor's mono with the same highlighting, and the saved outputs (text, tables as text, images, errors)
 * under each. Read-only: a notebook is edited in Jupyter; a code cell can be sent to the terminal from here.
 * No HTML output is interpreted, so a notebook cannot inject markup into the app.
 */

interface Cell { cell_type: string; source: string | string[]; outputs?: Output[]; execution_count?: number | null }
interface Output { output_type: string; name?: string; text?: string | string[]; data?: Record<string, string | string[]>; ename?: string; evalue?: string; traceback?: string[] }
interface Nb { cells?: Cell[]; metadata?: { kernelspec?: { display_name?: string; language?: string; name?: string }; language_info?: { name?: string } } }

const join = (s: string | string[] | undefined) => (Array.isArray(s) ? s.join("") : s ?? "");
// Terminal colour codes in tracebacks; built from the escape's code point so the source holds no control character.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

export function parseNotebook(text: string): { nb: Nb; language: string } | null {
  try {
    const nb = JSON.parse(text) as Nb;
    if (!nb || !Array.isArray(nb.cells)) return null;
    const language = (nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language ?? nb.metadata?.kernelspec?.name ?? "python").toLowerCase();
    return { nb, language };
  } catch { return null; }
}

/** Markdown headings across the cells; `line` is the cell's index so the sidebar can scroll to it. */
export function notebookOutline(text: string): OutlineItem[] {
  const parsed = parseNotebook(text);
  if (!parsed) return [];
  const out: OutlineItem[] = [];
  parsed.nb.cells!.forEach((c, i) => {
    if (c.cell_type !== "markdown") return;
    for (const l of join(c.source).split("\n")) {
      const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(l);
      if (m) out.push({ level: m[1].length as 1 | 2 | 3, number: "#", text: m[2], line: i + 1 });
    }
  });
  return out;
}

const EXT: Record<string, string> = { python: "py", julia: "jl", r: "r", javascript: "js", typescript: "ts", rust: "rs", bash: "sh", sh: "sh" };

function Highlighted({ code, language }: { code: string; language: string }) {
  const nodes = useMemo(() => {
    const support = codeLanguage(`x.${EXT[language] ?? language}`);
    if (!(support instanceof LanguageSupport)) return [code];
    const tree = support.language.parser.parse(code);
    const out: ReactNode[] = [];
    let k = 0;
    highlightCode(code, tree, codeHighlight, (text, classes) => out.push(classes ? <span key={k++} className={classes}>{text}</span> : text), () => out.push("\n"));
    return out;
  }, [code, language]);
  return <>{nodes}</>;
}

function OutputView({ o }: { o: Output }) {
  if (o.output_type === "stream") return <pre className={`nb-out ${o.name === "stderr" ? "err" : ""}`}>{join(o.text).replace(ANSI, "")}</pre>;
  if (o.output_type === "error") return <pre className="nb-out err"><b>{o.ename}: {o.evalue}</b>{"\n"}{(o.traceback ?? []).join("\n").replace(ANSI, "")}</pre>;
  const d = o.data ?? {};
  if (d["image/png"]) return <img className="nb-img" alt="Cell output" src={`data:image/png;base64,${join(d["image/png"]).replace(/\n/g, "")}`} />;
  if (d["image/jpeg"]) return <img className="nb-img" alt="Cell output" src={`data:image/jpeg;base64,${join(d["image/jpeg"]).replace(/\n/g, "")}`} />;
  if (d["image/svg+xml"]) return <img className="nb-img" alt="Cell output" src={`data:image/svg+xml;utf8,${encodeURIComponent(join(d["image/svg+xml"]))}`} />;
  if (d["text/markdown"]) return <div className="nb-md">{renderMarkdown(join(d["text/markdown"]))}</div>;
  if (d["text/plain"]) return <pre className="nb-out">{join(d["text/plain"]).replace(ANSI, "")}</pre>;
  if (d["text/html"]) return <pre className="nb-out quiet">HTML output (shown as text in Dabir): {join(d["text/html"]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000)}</pre>;
  return null;
}

interface Props {
  source: string;
  path: string;
  /** Scroll to this cell (1-based), when the sidebar outline asks. */
  jumpLine: number | null;
  jumpStamp: number;
  onRunCode?: (code: string) => void;
  /** Start the language's REPL in the terminal, so a cell has somewhere to run. */
  onRepl?: (() => void) | null;
}

export function Notebook({ source, path, jumpLine, jumpStamp, onRunCode, onRepl }: Props) {
  const parsed = useMemo(() => parseNotebook(source), [source]);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!jumpLine || !root.current) return;
    root.current.querySelector<HTMLElement>(`[data-cell="${jumpLine}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [jumpLine, jumpStamp]);
  if (!parsed) return <div className="doc-empty"><div className="card"><p>This notebook could not be read: the file is not valid notebook JSON.</p></div></div>;
  const { nb, language } = parsed;
  const cells = nb.cells ?? [];
  const kernel = nb.metadata?.kernelspec?.display_name ?? language;
  const codeCount = cells.filter((c) => c.cell_type === "code").length;
  return (
    <div className="notebook" ref={root} aria-label={`Notebook ${path.split("/").pop()}`}>
      <header className="nb-head">
        <span>{kernel} · {codeCount} code cell{codeCount === 1 ? "" : "s"}{cells.length - codeCount ? `, ${cells.length - codeCount} text` : ""}</span>
        <span className="nb-hint">Read-only here; edit in Jupyter. Outputs are the ones saved in the file.</span>
        {onRepl && <button className="btn small" onClick={onRepl} title="Start the REPL in the terminal; ▶ on a cell then types the cell into it">Open REPL</button>}
      </header>
      {cells.map((c, i) => {
        const text = join(c.source);
        if (c.cell_type === "markdown") return <section key={i} className="nb-cell md" data-cell={i + 1}><div className="nb-md">{renderMarkdown(text)}</div></section>;
        if (c.cell_type === "raw") return <section key={i} className="nb-cell raw" data-cell={i + 1}><pre className="nb-out quiet">{text}</pre></section>;
        return (
          <section key={i} className="nb-cell code" data-cell={i + 1}>
            <div className="nb-gutter">
              <span className="nb-count">[{c.execution_count ?? " "}]</span>
              {onRunCode && text.trim() && <button className="btn icon small" title="Run this cell in the terminal" aria-label="Run this cell in the terminal" onClick={() => onRunCode(text)}><Play aria-hidden /></button>}
            </div>
            <div className="nb-body">
              <pre className="nb-code"><Highlighted code={text} language={language} /></pre>
              {(c.outputs ?? []).map((o, j) => <OutputView key={j} o={o} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}
