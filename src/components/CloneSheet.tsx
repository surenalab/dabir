import { useEffect, useState } from "react";

export function CloneSheet({ onClose, onClone }: { onClose: () => void; onClone: (url: string) => Promise<void> }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const go = async () => {
    if (!url.trim()) return;
    setBusy(true); setError(null);
    try { await onClone(url.trim()); onClose(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="clone-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="clone-title">Clone from GitHub</h2>
        <p className="memory-note">Paste the repository URL. You will then choose the folder to clone into. Private repositories use your SSH agent or Git credential helper.</p>
        <input className="sheet-input" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="git@github.com:you/paper.git or https://github.com/you/paper" aria-label="Repository URL"
          onKeyDown={(e) => { if (e.key === "Enter") go(); }} disabled={busy} />
        {error && <p className="composer-note" role="alert">{error}</p>}
        <footer>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={go} disabled={!url.trim() || busy}>{busy ? "Cloning…" : "Choose Folder and Clone"}</button>
        </footer>
      </div>
    </div>
  );
}
