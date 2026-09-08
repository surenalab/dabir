import { useEffect } from "react";
import { DEFAULTS, resetSettings, updateSettings, useSettings } from "../lib/settings";

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="setting">
      <div className="setting-text"><span className="setting-label">{label}</span>{hint && <span className="setting-hint">{hint}</span>}</div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)}><span className="knob" /></button>;
}

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet wide" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="settings-title">Settings</h2>

        <section className="share-section">
          <h3>Writing</h3>
          <Row label="Spelling" hint="Uses the system spell checker; misspellings are underlined and right-click offers corrections. LaTeX commands are skipped.">
            <Toggle on={s.spellcheck} onChange={(v) => updateSettings({ spellcheck: v })} label="Spelling" />
          </Row>
          <Row label="Grammar" hint="Checks the selection or current paragraph on demand (⇧⌘G) through a LanguageTool server. Text is sent to that server, so this is off until you choose one.">
            <select className="sheet-input compact" value={s.grammar} onChange={(e) => updateSettings({ grammar: e.target.value as "off" | "languagetool" })} aria-label="Grammar">
              <option value="off">Off</option>
              <option value="languagetool">LanguageTool</option>
            </select>
          </Row>
          {s.grammar === "languagetool" && (
            <>
              <Row label="LanguageTool server" hint="The public api.languagetool.org is rate limited and sees your text. Self-host with `docker run -p 8010:8010 erikvl87/languagetool` and use http://localhost:8010.">
                <input className="sheet-input compact" value={s.languageToolUrl} onChange={(e) => updateSettings({ languageToolUrl: e.target.value })} aria-label="LanguageTool server URL" />
              </Row>
              <Row label="Language">
                <select className="sheet-input compact" value={s.grammarLanguage} onChange={(e) => updateSettings({ grammarLanguage: e.target.value })} aria-label="Grammar language">
                  {["auto", "en-GB", "en-US", "de-DE", "fr", "es", "it", "nl", "pt-PT", "pt-BR", "fa"].map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </Row>
            </>
          )}
        </section>

        <section className="share-section">
          <h3>Live sessions</h3>
          <Row label="Signalling server" hint="Optional. Only for the “signalling server” mode in Share; the direct and same-network modes need nothing. relay/signaling-worker.js deploys one to Cloudflare's free tier.">
            <input className="sheet-input compact" value={s.signalingUrl} onChange={(e) => updateSettings({ signalingUrl: e.target.value.trim() })} placeholder="wss://dabir-signal.you.workers.dev" aria-label="Signalling server URL" />
          </Row>
        </section>

        <section className="share-section">
          <h3>Completion</h3>
          <Row label="LaTeX commands and snippets" hint="Environments, commands and snippets from the LaTeX language package.">
            <Toggle on={s.autocomplete} onChange={(v) => updateSettings({ autocomplete: v })} label="Command completion" />
          </Row>
          <Row label="Citations, labels and files" hint="Keys from your .bib inside \cite, labels inside \ref, and project files inside \input and \includegraphics.">
            <Toggle on={s.citeComplete} onChange={(v) => updateSettings({ citeComplete: v })} label="Project completion" />
          </Row>
        </section>

        <section className="share-section">
          <h3>Editor</h3>
          <Row label="Document text size" hint="Visual view">
            <input type="range" min={14} max={22} step={0.5} value={s.fontSize} onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })} aria-label="Document text size" /><span className="setting-value">{s.fontSize} px</span>
          </Row>
          <Row label="Source text size">
            <input type="range" min={11} max={18} step={1} value={s.monoSize} onChange={(e) => updateSettings({ monoSize: Number(e.target.value) })} aria-label="Source text size" /><span className="setting-value">{s.monoSize} px</span>
          </Row>
          <Row label="Wrap long lines">
            <Toggle on={s.lineWrap} onChange={(v) => updateSettings({ lineWrap: v })} label="Wrap long lines" />
          </Row>
          <Row label="Click a widget to reveal its source" hint="In the visual view. Off means widgets reveal only when the cursor is placed inside them with the keyboard.">
            <Toggle on={s.revealOnClick} onChange={(v) => updateSettings({ revealOnClick: v })} label="Reveal on click" />
          </Row>
          <Row label="Compile on save">
            <Toggle on={s.compileOnSave} onChange={(v) => updateSettings({ compileOnSave: v })} label="Compile on save" />
          </Row>
        </section>

        <footer>
          <button className="btn" onClick={() => resetSettings()} title={`Defaults: ${Object.keys(DEFAULTS).length} settings`}>Reset to Defaults</button>
          <button className="btn primary" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  );
}
