import { useEffect, useState } from "react";
import { templatesList, type Template } from "../lib/backend";

export function NewPaperSheet({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, template: string) => Promise<void> }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [template, setTemplate] = useState("ieee-journal");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { templatesList().then((t) => { setTemplates(t); if (t.length && !t.find((x) => x.id === template)) setTemplate(t[0].id); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const go = async () => {
    if (!name.trim()) { setError("Give the paper a folder name."); return; }
    setBusy(true); setError(null);
    try { await onCreate(name.trim(), template); onClose(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="new-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="new-title">New Paper</h2>
        <p className="memory-note">Pick a starter, name the folder, then choose where it goes. Dabir copies the template, initialises Git, and drafts the memory scaffold so agents can work from the first minute.</p>
        <label className="share-label">Template
          <select className="sheet-input" value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="Template">
            {templates.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        <label className="share-label">Folder name<input className="sheet-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="my-paper" onKeyDown={(e) => { if (e.key === "Enter") go(); }} disabled={busy} /></label>
        {error && <p className="composer-note" role="alert">{error}</p>}
        <footer>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={go} disabled={!name.trim() || busy}>{busy ? "Creating…" : "Choose Location and Create"}</button>
        </footer>
      </div>
    </div>
  );
}
