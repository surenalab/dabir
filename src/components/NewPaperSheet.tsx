import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { native, onTemplateProgress, templatesList, type Template, type TemplateListing } from "../lib/backend";

/** The venue's own kit, or a starter Dabir wrote on a class the engine fetches from CTAN. */
function sourceLine(t: Template): string {
  if (!t.kit) return t.engine === "typst" ? "Bundled with Dabir. The Typst package is fetched by the compiler on first use." : "Bundled with Dabir.";
  if (t.cached) return `Official kit from ${t.kit}, already on this Mac.`;
  return `Official kit, fetched from ${t.kit} when you create the paper.`;
}

/** A folder name to offer in the save panel: the venue's label, lower-case, hyphenated. */
function suggestedFolder(t: Template): string {
  const slug = t.label.toLowerCase().replace(/\(typst\)/g, "typst").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? `${slug}-paper` : "paper";
}

/**
 * New Paper: a chooser in the manner of a document template picker. Groups on the left, the group's
 * templates in the middle, the chosen one explained on the right. Create opens the save panel, where
 * the folder is named and placed in one step; `onCreate` resolves false when that panel is cancelled.
 * From Word Document… leaves the chooser for the Word import, which starts from a coauthor's .docx.
 */
export function NewPaperSheet({ onClose, onCreate, onWord, initial }: { onClose: () => void; onCreate: (template: string, suggested: string) => Promise<boolean>; onWord: () => void; initial?: string | null }) {
  const [listing, setListing] = useState<TemplateListing | null>(null);
  const [group, setGroup] = useState<string>("featured");
  const [selected, setSelected] = useState<string | null>(initial ?? null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    templatesList().then((l) => {
      setListing(l);
      const pick = (initial && l.templates.find((t) => t.id === initial)) || l.templates.find((t) => t.featured) || l.templates[0];
      if (pick) { setSelected(pick.id); if (initial) setGroup(pick.group); }
    }).catch((e) => setError(String(e)));
  }, [initial]);
  const [progress, setProgress] = useState<string | null>(null);
  useEffect(() => onTemplateProgress((p) => setProgress(p.message)), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const templates = listing?.templates ?? [];
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    if (q) return templates.filter((t) => `${t.label} ${t.venue} ${t.summary} ${t.engine}`.toLowerCase().includes(q));
    if (group === "featured") return templates.filter((t) => t.featured);
    return templates.filter((t) => t.group === group);
  }, [templates, q, group]);
  const current = templates.find((t) => t.id === selected) ?? null;
  // Keep the selection visible: when the list changes and no longer holds it, take the first row.
  useEffect(() => { if (shown.length && !shown.some((t) => t.id === selected)) setSelected(shown[0].id); }, [shown, selected]);

  const go = async () => {
    if (!current || busy) return;
    setBusy(current.id); setError(null); setProgress(current.kit && !current.cached ? `Fetching the official kit from ${current.kit}…` : "Laying out the paper…");
    try { if (await onCreate(current.id, suggestedFolder(current))) onClose(); } catch (e) { setError(String(e)); } finally { setBusy(null); setProgress(null); }
  };
  const groups = [{ id: "featured", label: "Featured" }, ...(listing?.groups ?? [])].filter((g) => g.id === "featured" || templates.some((t) => t.group === g.id));

  return (
    <div className="sheet-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <div className="sheet chooser" role="dialog" aria-modal="true" aria-labelledby="new-title" onClick={(e) => e.stopPropagation()}>
        <header className="chooser-head">
          <h2 id="new-title">New Paper</h2>
          <label className="chooser-search">
            <Search aria-hidden />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search venues and templates" aria-label="Search templates" />
          </label>
        </header>
        <div className="chooser-body">
          <nav className="chooser-groups" aria-label="Template groups">
            {groups.map((g) => (
              <button key={g.id} className={g.id === group && !q ? "on" : ""} aria-current={g.id === group && !q ? "true" : undefined} onClick={() => { setQuery(""); setGroup(g.id); }}>{g.label}</button>
            ))}
          </nav>
          <div className="chooser-list" role="listbox" aria-label="Templates" tabIndex={0}
            onKeyDown={(e) => {
              const i = shown.findIndex((t) => t.id === selected);
              if (e.key === "ArrowDown" && i < shown.length - 1) { e.preventDefault(); setSelected(shown[i + 1].id); }
              if (e.key === "ArrowUp" && i > 0) { e.preventDefault(); setSelected(shown[i - 1].id); }
              if (e.key === "Enter") { e.preventDefault(); go(); }
            }}>
            {listing == null && !error && <p className="chooser-empty">Loading templates…</p>}
            {listing != null && shown.length === 0 && <p className="chooser-empty">Nothing matches “{query}”.</p>}
            {shown.map((t) => (
              <div key={t.id} role="option" aria-selected={t.id === selected} className={`chooser-row ${t.id === selected ? "on" : ""}`} onClick={() => setSelected(t.id)} onDoubleClick={go}>
                <div className="chooser-row-text">
                  <span className="name">{t.label}</span>
                  <span className="venue">{t.venue}</span>
                </div>
                <span className="marks">
                  {t.official && <span className="mark official">Official</span>}
                  <span className="mark">{t.engine === "typst" ? "Typst" : "LaTeX"}</span>
                </span>
              </div>
            ))}
          </div>
          <aside className="chooser-detail">
            {current ? (
              <>
                <h3>{current.label}</h3>
                <p className="venue">{current.venue}</p>
                <p className="summary">{current.summary}</p>
                <p className="source">{sourceLine(current)}</p>
                {current.notes.length > 0 && (
                  <details className="notes">
                    <summary>What Dabir adjusts in the kit</summary>
                    <ul>{current.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                  </details>
                )}
                {current.site && (
                  <button className="link site" onClick={() => { if (native) openUrl(current.site!); else window.open(current.site!, "_blank"); }}>
                    {current.kit ? "Where the kit comes from" : "About this class"} <ArrowUpRight aria-hidden />
                  </button>
                )}
              </>
            ) : <p className="chooser-empty">Pick a template.</p>}
          </aside>
        </div>
        <footer>
          <button className="btn" onClick={onWord} disabled={!!busy} title="Start from a .docx a coauthor sent: it becomes a LaTeX paper">From Word Document…</button>
          {busy ? <span className="progress" role="status" aria-live="polite">{progress ?? "Working…"}</span> : error ? <span className="progress error" role="alert">{error}</span> : <span className="progress">Create… opens a save panel to name and place the paper's folder. Git and the memory scaffold are set up inside it.</span>}
          <button className="btn" onClick={onClose} disabled={!!busy}>Cancel</button>
          <button className="btn primary" onClick={go} disabled={!current || !!busy} autoFocus>{busy ? "Creating…" : "Create…"}</button>
        </footer>
      </div>
    </div>
  );
}
