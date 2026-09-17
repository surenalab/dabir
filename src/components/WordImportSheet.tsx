import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { exportTools, importWord, pickWordDocument, revealPath, type WordImport } from "../lib/backend";

/** Where the new paper goes: the save panel's folder, split into its parent and name; null when cancelled. */
export type ChooseFolder = (suggested: string) => Promise<{ parent: string; name: string } | null>;

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** A folder name to offer: the document's name without the extension, lower-case, hyphenated. */
function suggestedFolder(docx: string): string {
  const slug = fileName(docx).replace(/\.docx$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "word-paper";
}

/** LaTeX commands and file names in a note, set in code so they read as what to look for. */
function withCode(note: string) {
  return note.split(/(\\[a-zA-Z]+\*?(?:\{[^}]*\})?|\b[\w-]+\.(?:tex|bib|docx)\b|\bfigures\/|\bequation\*)/g)
    .map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>));
}

/**
 * With `convert`, the sheet is Export › Convert to LaTeX Paper… for the open Word document: no file panel, and the
 * save panel starts at `convert.folder`, beside the Word paper.
 *
 * File › Import Word Document… (and From Word Document… in New Paper): a .docx from a coauthor becomes a
 * LaTeX paper in a new folder. `autoPick` opens the file panel at once when pandoc is there; the sheet
 * stays behind it to say what happens, show progress, and list what to check once the paper is open.
 */
export function WordImportSheet({ onClose, chooseFolder, onImported, onSetup, autoPick, convert }: {
  onClose: () => void;
  chooseFolder: ChooseFolder;
  /** Opens the new paper; resolves once it is on screen. */
  onImported: (r: WordImport, parent: string) => Promise<void>;
  onSetup: () => void;
  autoPick: boolean;
  convert?: { docx: string; folder: string } | null;
}) {
  const [pandoc, setPandoc] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<WordImport | null>(null);
  const picked = useRef(false);
  const choosing = useRef(false);
  useEffect(() => { exportTools().then((t) => setPandoc(t.pandoc)).catch(() => setPandoc(null)); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const choose = useCallback(async () => {
    if (choosing.current) return;
    choosing.current = true;
    setError(null);
    try {
      const docx = convert?.docx ?? await pickWordDocument();
      if (!docx) return;
      const dest = await chooseFolder(convert?.folder ?? suggestedFolder(docx));
      if (!dest) return;
      setBusy(fileName(docx));
      const r = await importWord(docx, dest.parent, dest.name);
      await onImported(r, dest.parent);
      setDone(r);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(null);
      choosing.current = false;
    }
  }, [chooseFolder, onImported, convert]);

  useEffect(() => {
    if (!autoPick || !pandoc || picked.current) return;
    picked.current = true;
    void choose();
  }, [autoPick, pandoc, choose]);

  return (
    <div className="sheet-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <div className="sheet word-import" role="dialog" aria-modal="true" aria-labelledby="word-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="word-title">{done ? `${convert ? "Converted" : "Imported"} ${done.source}` : convert ? `Convert ${fileName(convert.docx)} to LaTeX` : "Import a Word Document"}</h2>
        {done ? (
          <div className="word-done">
            <p className="word-summary" role="status">
              <Check aria-hidden />
              <span>{done.summary} Saved as <code>{done.path.replace(/^\/Users\/[^/]+/, "~")}</code> and opened. <button className="link" onClick={() => revealPath(done.main)}>Reveal</button></span>
            </p>
            {done.notes.length > 0 && (
              <>
                <h3>Check against the Word file</h3>
                <ul className="word-notes">{done.notes.map((n, i) => <li key={i}>{withCode(n)}</li>)}</ul>
              </>
            )}
          </div>
        ) : (
          <>
            <p className="word-lede">{convert ? "A LaTeX copy of the document goes in a new folder beside this paper, with Git and the memory scaffold set up as for any new paper, and opens when it is ready. The Word document is not changed and stays a paper of its own." : "The document becomes a LaTeX paper in a new folder, with Git and the memory scaffold set up as for any new paper. The Word file itself is not changed."}</p>
            <dl className="word-carry">
              <dt>Comes across</dt>
              <dd>Title, authors and abstract; headings, text, lists, footnotes and links; tables, equations and images; citations inserted with Zotero, Mendeley or EndNote, with their references in <code>refs.bib</code>.</dd>
              <dt>Stays in Word</dt>
              <dd>Page layout, fonts and colours, and comments. Tracked changes are accepted as they stand.</dd>
            </dl>
            {pandoc === null && <p className="word-hint">Word import needs <code>pandoc</code>, which is not installed. <button className="link" onClick={onSetup}>Install it from Setup…</button></p>}
          </>
        )}
        {error && <p className="word-error" role="alert">{error}</p>}
        <footer>
          {busy && <span className="progress" role="status" aria-live="polite">Converting {busy}…</span>}
          {done ? (
            <button className="btn primary" onClick={onClose} autoFocus>Done</button>
          ) : (
            <>
              <button className="btn" onClick={onClose} disabled={!!busy}>Cancel</button>
              <button className="btn primary" onClick={() => void choose()} disabled={!pandoc || !!busy} autoFocus>{busy ? "Converting…" : convert ? "Choose Folder…" : "Choose Document…"}</button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
