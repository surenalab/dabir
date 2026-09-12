import { useEffect, useState } from "react";
import { DEFAULTS, resetSettings, updateSettings, useSettings } from "../lib/settings";
import { dictionaries, type Dictionary } from "../lib/spell";
import { availableServers, serversFor } from "../lib/lsp";

const CODE_KINDS: [string, string][] = [["Python", "x.py"], ["Typst", "x.typ"], ["Shell", "x.sh"], ["YAML", "x.yml"], ["Julia", "x.jl"], ["R", "x.r"]];

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
  const [dicts, setDicts] = useState<Dictionary[]>([{ id: "en-GB", label: "English (UK)" }, { id: "en-US", label: "English (US)" }]);
  useEffect(() => { dictionaries().then(setDicts); }, []);
  const [servers, setServers] = useState<Set<string> | null>(null);
  useEffect(() => { availableServers().then(setServers).catch(() => setServers(new Set())); }, []);
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
          <Row label="Spelling" hint="Dabir's own dictionary works offline and reads LaTeX: commands, maths, keys and paths are never flagged. Hover a word for replacements; Add to Dictionary keeps the word with the paper in .dabir/dictionary.txt. Dictionaries for English (UK and US), German, Spanish and French ship with the app; the system checker covers other languages.">
            <Toggle on={s.spellcheck} onChange={(v) => updateSettings({ spellcheck: v })} label="Spelling" />
          </Row>
          {s.spellcheck && (
            <Row label="Dictionary">
              <select className="sheet-input compact" value={s.spellLanguage} onChange={(e) => updateSettings({ spellLanguage: e.target.value })} aria-label="Spelling dictionary">
                {dicts.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                <option value="system">System checker</option>
              </select>
            </Row>
          )}
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
          <Row label="Predictive text" hint="Grey text after the cursor finishes the word or phrase from this paper's own wording. Tab accepts all of it, ⌘→ one word, Escape dismisses. Nothing leaves the machine. For a whole sentence from the chosen agent, press ⇧⌘Space at any point; that one request goes to the agent's CLI.">
            <Toggle on={s.prediction} onChange={(v) => updateSettings({ prediction: v })} label="Predictive text" />
          </Row>
        </section>

        <section className="share-section">
          <h3>Code files</h3>
          <Row label="Language servers" hint="Python, Typst, shell, YAML and the rest open with their own grammar. When a language server is installed, its completion, errors, hover and go-to-definition (F12, ⇧F12 references, F2 rename) appear too. Servers are found on the same PATH the agents use.">
            <ul className="server-list" aria-label="Language servers">
              {CODE_KINDS.map(([name, sample]) => {
                const specs = serversFor(sample);
                const have = servers ? specs.find((sp) => servers.has(sp.command)) : null;
                return <li key={name}><span>{name}</span><span className={have ? "ok" : "off"}>{servers === null ? "…" : have ? have.command : `not installed · ${specs[0]?.install}`}</span></li>;
              })}
            </ul>
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
          <Row label="Keyboard" hint="Vim gives the source view modal editing: Escape for normal mode, i to insert, : for commands. The app's own shortcuts keep working.">
            <select className="sheet-input compact" value={s.keymap} onChange={(e) => updateSettings({ keymap: e.target.value as "standard" | "vim" })} aria-label="Keyboard">
              <option value="standard">Standard</option>
              <option value="vim">Vim</option>
            </select>
          </Row>
          <Row label="Focus mode" hint="Only the paragraph you are in is fully inked, the line you type stays near the middle of the window, and the sidebar and inspector step aside. ⌥⌘F toggles it.">
            <Toggle on={s.focusMode} onChange={(v) => updateSettings({ focusMode: v })} label="Focus mode" />
          </Row>
          <Row label="Wrap long lines">
            <Toggle on={s.lineWrap} onChange={(v) => updateSettings({ lineWrap: v })} label="Wrap long lines" />
          </Row>
          <Row label="Click a widget to reveal its source" hint="In the visual view. Off means widgets reveal only when the cursor is placed inside them with the keyboard.">
            <Toggle on={s.revealOnClick} onChange={(v) => updateSettings({ revealOnClick: v })} label="Reveal on click" />
          </Row>
          <Row label="Autosave" hint="Writes the file about a second after you stop typing, like Word. A snapshot of the whole paper is taken every five minutes and after each accepted agent change; Versions in the sidebar restores any of them. Your Git history is untouched until you commit.">
            <Toggle on={s.autosave} onChange={(v) => updateSettings({ autosave: v })} label="Autosave" />
          </Row>
          <Row label={s.autosave ? "Compile after changes settle" : "Compile on save"}>
            <Toggle on={s.compileOnSave} onChange={(v) => updateSettings({ compileOnSave: v })} label="Compile on save" />
          </Row>
          <Row label="Suggest changes" hint="Track changes for coauthors who do not use Git. Your insertions are underlined and your deletions struck through in your colour until someone accepts or rejects them, from the People tab or by hovering the text. Suggestions are saved in .dabir/changes.json and shared in live sessions. Also in the formatting bar.">
            <Toggle on={s.suggesting} onChange={(v) => updateSettings({ suggesting: v })} label="Suggest changes" />
          </Row>
        </section>

        <footer>
          <span className="build" title="Commit and day this copy of Dabir was built from">Dabir {__DABIR_BUILD__}</span>
          <button className="btn" onClick={() => resetSettings()} title={`Defaults: ${Object.keys(DEFAULTS).length} settings`}>Reset to Defaults</button>
          <button className="btn primary" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  );
}
