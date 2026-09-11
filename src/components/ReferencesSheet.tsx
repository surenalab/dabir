import { useEffect, useState } from "react";
import { BookMarked, FileText, Link2, Plus, RefreshCw } from "lucide-react";
import { bibImportFile, pickBibFile, refsAdd, type Project } from "../lib/backend";
import { ago, type useRefSync } from "../lib/refsync";

type Sync = ReturnType<typeof useRefSync>;

/** `~/…/Mendeley Desktop/library.bib`: the home folder collapsed and the middle elided. */
function shortPath(p: string): string {
  const home = p.replace(/^\/Users\/[^/]+/, "~");
  const parts = home.split("/");
  return parts.length > 4 ? `${parts[0]}/…/${parts.slice(-2).join("/")}` : home;
}

/**
 * Paper › References…: where the paper's .bib comes from. Zotero on this machine (a collection,
 * synced now or kept in step), a .bib another manager writes (Mendeley, Paperpile, JabRef, EndNote,
 * a Better BibTeX auto-export), one entry by DOI or arXiv id, or a one-off import.
 */
export function ReferencesSheet({ project, sync, bibCount, onClose, onChanged }: { project: Project; sync: Sync; bibCount: number; onClose: () => void; onChanged: (note: string) => void }) {
  const { cfg, setCfg, zotero, probe, syncZotero, syncLinked, busy } = sync;
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { if (zotero === undefined) probe(); }, [zotero, probe]);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (f: () => Promise<unknown>) => { setError(null); try { await f(); } catch (e) { setError(String(e).replace(/^Error:\s*/, "")); } };
  const add = () => run(async () => { setAdding(true); try { const r = await refsAdd(project.root, id.trim()); onChanged(r.added ? `Added ${r.keys.join(", ")} to ${r.file}.` : r.updated ? `Updated ${r.keys.join(", ")} in ${r.file}.` : `${r.keys.join(", ") || "That entry"} is already in ${r.file}.`); setId(""); } finally { setAdding(false); } });
  const collectionName = cfg.zotero.collection ? (zotero?.collections.find((c) => c.key === cfg.zotero.collection)?.name ?? cfg.zotero.name ?? "a collection") : "the whole library";

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet wide refs" role="dialog" aria-modal="true" aria-labelledby="refs-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="refs-title">References</h2>
        <p className="memory-note">{bibCount} entr{bibCount === 1 ? "y" : "ies"} in the paper's <code>.bib</code>. Entries arriving from a manager are merged by citation key: new ones appended, changed ones replaced, anything only the paper has kept.</p>

        <section className="share-section">
          <h3><BookMarked aria-hidden /> Zotero</h3>
          {zotero == null || busy === "probe" ? <p className="memory-note">Looking for Zotero on this Mac…</p> : !zotero.reachable ? (
            <p className="memory-note">Zotero is not running, or its local API is off. Start Zotero 7 and turn on Settings → Advanced → <em>Allow other applications on this computer to communicate with Zotero</em>, then <button className="link" onClick={probe}>look again</button>.</p>
          ) : (
            <>
              <p className="memory-note">Zotero is running{zotero.betterBibtex ? " with Better BibTeX, so citation keys are the ones you see in Zotero." : ". Install Better BibTeX for stable citation keys; without it Zotero's own keys are used."}</p>
              <label className="share-label">Collection
                <select className="sheet-input" value={cfg.zotero.collection ?? ""} aria-label="Zotero collection"
                  onChange={(e) => { const k = e.target.value || null; const name = zotero.collections.find((c) => c.key === k)?.name ?? null; setCfg((c) => ({ ...c, zotero: { ...c.zotero, collection: k, name } })); }}>
                  <option value="">Whole library</option>
                  {zotero.collections.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                </select>
              </label>
              <div className="actions">
                <button className="btn" onClick={() => run(() => syncZotero())} disabled={busy === "zotero"}><RefreshCw /> {busy === "zotero" ? "Syncing…" : "Sync Now"}</button>
                <label className="refs-toggle"><input type="checkbox" checked={cfg.zotero.auto} onChange={(e) => setCfg((c) => ({ ...c, zotero: { ...c.zotero, auto: e.target.checked } }))} /> Keep in sync while this paper is open</label>
              </div>
              <p className="refs-status" role="status">{cfg.zotero.last ? <>Last sync {ago(cfg.zotero.last)} from {collectionName}: {cfg.zotero.summary}.</> : <>Not synced yet. Sync pulls {collectionName} into the paper's .bib.</>}</p>
            </>
          )}
        </section>

        <section className="share-section">
          <h3><Link2 aria-hidden /> Linked BibTeX file</h3>
          <p className="memory-note">Mendeley, Paperpile, JabRef, EndNote and Better BibTeX can all keep a <code>.bib</code> up to date on disk. Link it and Dabir merges every change into the paper's <code>.bib</code> while the paper is open; the linked file itself is never written.</p>
          {cfg.linked.path ? (
            <>
              <p className="refs-path"><FileText aria-hidden /> <code title={cfg.linked.path}>{shortPath(cfg.linked.path)}</code></p>
              <div className="actions">
                <button className="btn" onClick={() => run(() => syncLinked(true))}><RefreshCw /> Merge Now</button>
                <button className="btn" onClick={() => run(async () => { const p = await pickBibFile(); if (p) setCfg((c) => ({ ...c, linked: { path: p, mtime: 0, last: null, summary: null } })); })}>Change…</button>
                <button className="btn" onClick={() => setCfg((c) => ({ ...c, linked: { path: null, mtime: 0, last: null, summary: null } }))}>Unlink</button>
              </div>
              <p className="refs-status" role="status">{cfg.linked.last ? <>Last change merged {ago(cfg.linked.last)}: {cfg.linked.summary}.</> : <>Watching; nothing merged yet.</>}</p>
            </>
          ) : (
            <div className="actions"><button className="btn" onClick={() => run(async () => { const p = await pickBibFile(); if (p) setCfg((c) => ({ ...c, linked: { path: p, mtime: 0, last: null, summary: null } })); })}><Link2 /> Link a .bib File…</button></div>
          )}
        </section>

        <section className="share-section">
          <h3><Plus aria-hidden /> Add by DOI or arXiv id</h3>
          <div className="refs-add">
            <input className="sheet-input" value={id} onChange={(e) => setId(e.target.value)} placeholder="10.1038/nature14539 or 1706.03762" aria-label="DOI or arXiv id" disabled={adding}
              onKeyDown={(e) => { if (e.key === "Enter" && id.trim() && !adding) { e.preventDefault(); add(); } }} />
            <button className="btn" disabled={!id.trim() || adding} onClick={add}>{adding ? "Fetching…" : "Add"}</button>
          </div>
          <p className="memory-note small">The publisher's record via doi.org, or arXiv's own BibTeX. The key is the one the service gives.</p>
        </section>

        <section className="share-section">
          <h3><FileText aria-hidden /> Import once</h3>
          <div className="actions">
            <button className="btn" disabled={importing} onClick={() => run(async () => { setImporting(true); try { const r = await bibImportFile(project.root); if (r) onChanged(r); } finally { setImporting(false); } })}>{importing ? "Importing…" : "Import a .bib File…"}</button>
          </div>
        </section>

        {error && <p className="composer-note" role="alert">{error}</p>}
        <footer><button className="btn" onClick={onClose}>Done</button></footer>
      </div>
    </div>
  );
}
