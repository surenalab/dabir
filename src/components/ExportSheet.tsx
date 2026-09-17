import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { exportPaper, exportTools, pickSavePath, revealPath, type ExportKind, type ExportReport, type Project } from "../lib/backend";
import { WORD_EXPORTS, type WordExport } from "../lib/word";

interface Row { kind: ExportKind; label: string; detail: string; ext: string; filter: string; suffix: string; needsPandoc?: boolean; latexOnly?: boolean }

const ROWS: Row[] = [
  { kind: "pdf", label: "PDF", detail: "The compiled paper as it stands in the PDF view. Compiles first if it has not been built yet.", ext: "pdf", filter: "PDF", suffix: "" },
  { kind: "arxiv", label: "Source for arXiv", detail: "Sources, styles, figures and the compiled bibliography (.bbl), which arXiv needs since it does not run BibTeX. Code, data and Dabir's own files stay out.", ext: "zip", filter: "Zip archive", suffix: "-arxiv", latexOnly: true },
  { kind: "source", label: "Source zip", detail: "The whole folder except .dabir, .git and build residue: for Overleaf's Upload Project, a journal's submission system, or a coauthor.", ext: "zip", filter: "Zip archive", suffix: "-source" },
  { kind: "docx", label: "Word", detail: "Through pandoc: headings, text, equations and a reference list from the .bib. Layout, custom macros and some environments come through simplified.", ext: "docx", filter: "Word document", suffix: "", needsPandoc: true },
  { kind: "html", label: "HTML", detail: "Through pandoc: one self-contained page with MathJax for the equations.", ext: "html", filter: "Web page", suffix: "", needsPandoc: true },
];

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** File › Export…: one list of formats, what each holds, and Export. */
export function ExportSheet({ project, onClose, ensurePdf, onNote, onSetup, word }: { project: Project; onClose: () => void; ensurePdf: () => Promise<boolean>; onNote: (s: string) => void; onSetup: () => void; word?: { name: string; onExport: (k: WordExport) => void } | null }) {
  if (word) return <WordExportSheet name={word.name} onClose={onClose} onExport={word.onExport} />;
  return <PaperExportSheet project={project} onClose={onClose} ensurePdf={ensurePdf} onNote={onNote} onSetup={onSetup} />;
}

function WordExportSheet({ name, onClose, onExport }: { name: string; onClose: () => void; onExport: (k: WordExport) => void }) {
  const [kind, setKind] = useState<WordExport>("docx");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet export" role="dialog" aria-modal="true" aria-labelledby="export-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="export-title">Export {name}</h2>
        <div className="export-rows" role="radiogroup" aria-label="Format">
          {WORD_EXPORTS.map((r) => (
            <label key={r.kind} className={`export-row ${r.kind === kind ? "on" : ""}`}>
              <input type="radio" name="export-kind" value={r.kind} checked={r.kind === kind} onChange={() => setKind(r.kind)} />
              <span className="text"><span className="name">{r.sheet}</span><span className="detail">{r.detail}</span></span>
            </label>
          ))}
        </div>
        <footer>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => { onClose(); onExport(kind); }} autoFocus>{WORD_EXPORTS.find((r) => r.kind === kind)?.action ?? "Export…"}</button>
        </footer>
      </div>
    </div>
  );
}

function PaperExportSheet({ project, onClose, ensurePdf, onNote, onSetup }: { project: Project; onClose: () => void; ensurePdf: () => Promise<boolean>; onNote: (s: string) => void; onSetup: () => void }) {
  const isTypst = /\.typ$/i.test(project.mainTex ?? "");
  const [kind, setKind] = useState<ExportKind>("pdf");
  const [pandoc, setPandoc] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ExportReport | null>(null);
  useEffect(() => { exportTools().then((t) => setPandoc(t.pandoc)).catch(() => setPandoc(null)); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const rows = ROWS.filter((r) => !(r.latexOnly && isTypst));
  const row = rows.find((r) => r.kind === kind) ?? rows[0];
  const canRun = !!project.mainTex && !(row.needsPandoc && pandoc === null);

  const go = async () => {
    if (!project.mainTex) return;
    setError(null); setDone(null);
    const dest = await pickSavePath(`${project.name}${row.suffix}.${row.ext}`, row.filter, [row.ext]);
    if (!dest) return;
    setBusy(true);
    try {
      if (kind === "pdf" && !(await ensurePdf())) { setError("The paper did not compile, so there is no PDF to export. Fix the errors in the Problems list and try again."); return; }
      const r = await exportPaper(project.root, project.mainTex, dest, kind);
      setDone(r);
      onNote(`Exported ${r.files === 1 ? "" : `${r.files} files, `}${fmtBytes(r.bytes)} to ${r.path.split("/").pop()}`);
    } catch (e) { setError(String(e).replace(/^Error:\s*/, "")); } finally { setBusy(false); }
  };

  return (
    <div className="sheet-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <div className="sheet export" role="dialog" aria-modal="true" aria-labelledby="export-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="export-title">Export {project.name}</h2>
        <div className="export-rows" role="radiogroup" aria-label="Format">
          {rows.map((r) => {
            const missing = r.needsPandoc && pandoc === null;
            return (
              <label key={r.kind} className={`export-row ${r.kind === kind ? "on" : ""} ${missing ? "missing" : ""}`}>
                <input type="radio" name="export-kind" value={r.kind} checked={r.kind === kind} onChange={() => { setKind(r.kind); setError(null); setDone(null); }} disabled={busy} />
                <span className="text">
                  <span className="name">{r.label}{r.needsPandoc && pandoc ? <span className="via"> · {pandoc}</span> : null}</span>
                  <span className="detail">{r.detail}</span>
                </span>
              </label>
            );
          })}
        </div>
        {pandoc === null && <p className="export-hint">Word and HTML need <code>pandoc</code>, which is not installed. <button className="link" onClick={onSetup}>Install it from Setup…</button></p>}
        {done && (
          <p className="export-done" role="status">
            <Check aria-hidden /> <span>Exported {done.files === 1 ? "" : `${done.files} files, `}{fmtBytes(done.bytes)} to <code>{done.path.replace(/^\/Users\/[^/]+/, "~")}</code>.
              {done.notes.map((n, i) => <span key={i} className="note"> {n}</span>)}
              <button className="link" onClick={() => revealPath(done.path)}>Reveal</button></span>
          </p>
        )}
        {error && <p className="composer-note" role="alert">{error}</p>}
        <footer>
          <button className="btn" onClick={onClose} disabled={busy}>{done ? "Done" : "Cancel"}</button>
          <button className="btn primary" onClick={go} disabled={!canRun || busy}>{busy ? (kind === "pdf" ? "Compiling and exporting…" : "Exporting…") : "Export…"}</button>
        </footer>
      </div>
    </div>
  );
}
