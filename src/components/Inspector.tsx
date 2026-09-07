import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Check, Loader2, Paperclip, RefreshCw, Square, X } from "lucide-react";
import {
  agentAccept, agentCancel, agentDiff, agentProviders, agentPullRequest, agentReject, agentRun, memoryRead, memorySetup,
  onAgentEvent, provenanceRerun, type Artefact, type Memory, type Pick, type Project, type Provider, type WorktreeDiff,
} from "../lib/backend";
import { Segmented } from "./Segmented";

type Tab = "agent" | "memory" | "people";

interface Step { kind: "text" | "tool" | "log"; text: string; tool?: string | null; at: number }
type Run =
  | { phase: "idle" }
  | { phase: "running"; runId: string; prompt: string; steps: Step[]; provider: string; started: number }
  | { phase: "review"; runId: string; prompt: string; steps: Step[]; provider: string; ok: boolean; summary: string; diff: WorktreeDiff | null; error?: string }
  | { phase: "done"; text: string };

interface Hunk { header: string; lines: string[] }
interface FileDiff { name: string; hunks: Hunk[]; binary: boolean }

/** Split a unified diff into files and hunks so each can be picked. */
export function splitPatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  for (const l of patch.split("\n")) {
    const m = /^diff --git a\/(.*?) b\//.exec(l);
    if (m) { files.push({ name: m[1], hunks: [], binary: false }); continue; }
    const f = files[files.length - 1];
    if (!f) continue;
    if (/^(GIT binary patch|Binary files)/.test(l)) { f.binary = true; continue; }
    if (/^(index |--- |\+\+\+ |literal|delta|old mode|new mode|similarity|rename|new file|deleted file)/.test(l)) continue;
    if (l.startsWith("@@")) { f.hunks.push({ header: l, lines: [] }); continue; }
    if (f.hunks.length) f.hunks[f.hunks.length - 1].lines.push(l);
  }
  return files;
}

function DiffView({ files, excluded, onToggle }: { files: FileDiff[]; excluded: Set<string>; onToggle: (key: string, on: boolean) => void }) {
  return (
    <>
      {files.map((f) => {
        const fileOff = excluded.has(f.name);
        return (
          <div className={`diff ${fileOff ? "off" : ""}`} key={f.name}>
            <header>
              <label className="pickfile"><input type="checkbox" checked={!fileOff} onChange={(e) => onToggle(f.name, e.target.checked)} aria-label={`Include ${f.name}`} /><span className="file">{f.name}</span></label>
              <span className="stat">{f.binary ? <span className="add">binary</span> : <><span className="add">+{f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith("+")).length, 0)}</span><span className="del">−{f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith("-")).length, 0)}</span></>}</span>
            </header>
            {f.hunks.map((h, i) => {
              const key = `${f.name}#${i}`;
              const off = fileOff || excluded.has(key);
              return (
                <div className={`hunk ${off ? "off" : ""}`} key={key}>
                  {f.hunks.length > 1 && (
                    <label className="pickhunk"><input type="checkbox" checked={!off} disabled={fileOff} onChange={(e) => onToggle(key, e.target.checked)} aria-label={`Include hunk ${i + 1} of ${f.name}`} /><span>{h.header.replace(/@@ (.*?) @@.*/, "$1")}</span></label>
                  )}
                  <pre>{h.lines.slice(0, 200).map((l, j) => <span key={j} className={`l ${l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "ctx"}`}>{l || " "}</span>)}
                    {h.lines.length > 200 && <span className="l ctx">… {h.lines.length - 200} more lines</span>}</pre>
                </div>
              );
            })}
            {f.binary && <pre><span className="l ctx">binary file</span></pre>}
          </div>
        );
      })}
    </>
  );
}

interface Props {
  project: Project | null;
  askFocus: number;
  onChanged: () => void;         // git status or files changed
  onOpenFile: (path: string) => void;
  onNote: (text: string) => void;
}

export function Inspector({ project, askFocus, onChanged, onOpenFile, onNote }: Props) {
  const [tab, setTab] = useState<Tab>("agent");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [provider, setProvider] = useState("claude");
  const [draft, setDraft] = useState("");
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [memory, setMemory] = useState<Memory | null>(null);
  const [rerunOut, setRerunOut] = useState<Record<string, string>>({});
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const textarea = useRef<HTMLTextAreaElement>(null);
  const runRef = useRef(run); runRef.current = run;

  useEffect(() => { agentProviders().then((ps) => { setProviders(ps); const first = ps.find((p) => p.installed); if (first && !ps.find((p) => p.id === provider)?.installed) setProvider(first.id); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (askFocus) { setTab("agent"); textarea.current?.focus(); } }, [askFocus]);

  const refreshMemory = useCallback(() => { if (project) memoryRead(project.root).then(setMemory).catch(() => setMemory(null)); else setMemory(null); }, [project]);
  useEffect(() => { refreshMemory(); }, [refreshMemory]);

  // Agent event stream
  useEffect(() => onAgentEvent(async (e) => {
    const r = runRef.current;
    if (r.phase !== "running" || r.runId !== e.runId) return;
    if (e.kind === "done") {
      let diff: WorktreeDiff | null = null, error: string | undefined;
      if (project) { try { diff = await agentDiff(project.root, r.runId); } catch (err) { error = String(err); } }
      const summary = e.text || r.steps.filter((s) => s.kind === "text").map((s) => s.text).join("\n");
      setRun({ phase: "review", runId: r.runId, prompt: r.prompt, steps: r.steps, provider: r.provider, ok: e.ok ?? true, summary, diff, error });
      setMessage(r.prompt.length > 72 ? r.prompt.slice(0, 69) + "…" : r.prompt);
      setExcluded(new Set());
    } else if (e.kind === "error") {
      setRun({ phase: "review", runId: r.runId, prompt: r.prompt, steps: r.steps, provider: r.provider, ok: false, summary: e.text, diff: null });
    } else {
      setRun({ ...r, steps: [...r.steps, { kind: e.kind as Step["kind"], text: e.text, tool: e.tool, at: Date.now() }] });
    }
  }), [project]);

  const current = providers.find((p) => p.id === provider);
  const finishedRun = run.phase === "review";

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt || !project || run.phase === "running") return;
    try {
      const started = await agentRun(project.root, provider, prompt);
      setRun({ phase: "running", runId: started.runId, prompt, steps: [], provider, started: Date.now() });
      setDraft("");
    } catch (e) { onNote(String(e)); }
  };

  const cancel = async () => { if (run.phase === "running") { await agentCancel(run.runId); } };

  const accept = async () => {
    if (run.phase !== "review" || !project) return;
    setBusy(true);
    const files = splitPatch(run.diff?.patch ?? "");
    const picks: Pick[] = [];
    let partial = false;
    for (const f of files) {
      if (excluded.has(f.name)) { partial = true; continue; }
      const hunks = f.hunks.map((_, i) => i).filter((i) => !excluded.has(`${f.name}#${i}`));
      if (hunks.length === f.hunks.length) picks.push({ path: f.name, hunks: null });
      else { partial = true; if (hunks.length) picks.push({ path: f.name, hunks }); }
    }
    if (picks.length === 0) { onNote("Nothing selected to accept."); setBusy(false); return; }
    try { const id = await agentAccept(project.root, run.runId, message.trim() || run.prompt, partial ? picks : undefined); setRun({ phase: "done", text: `Committed ${id} to your checkout${partial ? " (only the selected changes; the rest was discarded)" : ""}.` }); onChanged(); refreshMemory(); }
    catch (e) { onNote(String(e)); } finally { setBusy(false); }
  };
  const reject = async () => {
    if (run.phase !== "review" || !project) return;
    setBusy(true);
    try { await agentReject(project.root, run.runId); setRun({ phase: "done", text: "Run discarded. Your files were not touched." }); }
    catch (e) { onNote(String(e)); } finally { setBusy(false); }
  };
  const pr = async () => {
    if (run.phase !== "review" || !project) return;
    setBusy(true);
    try { const out = await agentPullRequest(project.root, run.runId, message.trim() || run.prompt); setRun({ phase: "done", text: out || "Pull request opened." }); }
    catch (e) { onNote(String(e)); } finally { setBusy(false); }
  };

  const setup = async () => {
    if (!project) return;
    try { const files = await memorySetup(project.root, project.mainTex); onNote(`Wrote ${files.join(", ")}. Review them like any other change.`); refreshMemory(); onChanged(); }
    catch (e) { onNote(String(e)); }
  };
  const rerun = async (a: Artefact) => {
    if (!project) return;
    setRerunOut((o) => ({ ...o, [a.artefact]: "running…" }));
    try { const r = await provenanceRerun(project.root, a.artefact); setRerunOut((o) => ({ ...o, [a.artefact]: (r.ok ? "" : "Failed. ") + r.output.trim().split("\n").slice(-3).join("\n") })); refreshMemory(); onChanged(); }
    catch (e) { setRerunOut((o) => ({ ...o, [a.artefact]: String(e) })); }
  };

  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="inspector-tabs">
        <Segmented label="Inspector pane" value={tab} onChange={(v) => setTab(v as Tab)}
          options={[{ value: "agent", label: "Agent" }, { value: "memory", label: "Memory" }, { value: "people", label: "People" }]} />
      </div>

      {tab === "agent" && (
        <div className="inspector-body">
          <div className="provider">
            <label htmlFor="provider">Agent</label>
            <select id="provider" value={provider} onChange={(e) => setProvider(e.target.value)} title={current?.hint}>
              {providers.map((p) => <option key={p.id} value={p.id} disabled={!p.installed}>{p.label}{p.installed ? "" : " (not installed)"}</option>)}
            </select>
            <span className="hint">{current ? (current.installed ? current.hint : `Install the ${current.bin} CLI and sign in`) : ""}</span>
          </div>

          <div className="composer">
            <textarea ref={textarea}
              placeholder={project ? (current?.installed ? `Ask ${current.label} to change the paper or rerun an experiment…` : "Choose an installed agent first") : "Open a paper first"}
              value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && e.metaKey) { e.preventDefault(); send(); } }}
              disabled={!project || !current?.installed || run.phase === "running"} aria-label="Message to the agent" />
            <div className="bar">
              <span className="scope" title="The agent sees the whole repository and works on a Git worktree on its own branch, with permission prompts bypassed inside that worktree. Your checkout is untouched until you accept."><Paperclip aria-hidden /> whole repo · worktree · <kbd>⌘↩</kbd></span>
              <button className="send" disabled={!draft.trim() || run.phase === "running"} aria-label="Send to agent" onClick={send}><ArrowUp /></button>
            </div>
          </div>

          {(run.phase === "running" || run.phase === "review") && (
            <div className="run">
              <div className="prompt"><b>You asked {providers.find((p) => p.id === run.provider)?.label ?? run.provider}</b>{run.prompt}</div>
              <div className="steps" role="status" aria-live="polite">
                {run.steps.filter((s) => s.kind !== "log").map((s, i) => (
                  <div key={i} className={`step ${s.kind === "text" ? "text" : "done"}`}>
                    {s.kind === "tool" ? <Check aria-label="Done" /> : <span />}
                    <span>{s.kind === "tool" ? <>{(s.tool ?? "tool").toLowerCase()} <code>{s.text}</code></> : s.text}</span>
                    <span className="t"></span>
                  </div>
                ))}
                {run.phase === "running" && <div className="step running"><Loader2 aria-label="Running" /><span>{run.steps.length ? "working" : `starting ${providers.find((p) => p.id === run.provider)?.label ?? ""}`}</span><span className="t"></span></div>}
                {run.phase === "review" && !run.ok && <div className="step failed"><X aria-label="Failed" /><span>{run.summary || "The agent reported an error."}</span><span className="t"></span></div>}
              </div>
              {run.phase === "running" && <div className="actions"><button className="btn" onClick={cancel}><Square /> Stop</button></div>}
              {run.steps.some((s) => s.kind === "log") && (
                <details className="log-details"><summary>{run.steps.filter((s) => s.kind === "log").length} log lines</summary>
                  <pre>{run.steps.filter((s) => s.kind === "log").map((s) => s.text).join("\n")}</pre></details>
              )}

              {run.phase === "review" && (
                <>
                  {run.error && <p className="composer-note" role="alert">{run.error}</p>}
                  {run.diff && run.diff.changes.length > 0 ? (
                    <div className="evidence">
                      <div className="evidence-heading">What changed</div>
                      <span className="target">Untick a file or a hunk to leave it out of the commit.</span>
                      <DiffView files={splitPatch(run.diff.patch)} excluded={excluded} onToggle={(key, on) => setExcluded((x) => { const n = new Set(x); if (on) n.delete(key); else n.add(key); return n; })} />
                    </div>
                  ) : (
                    <p className="composer-note">The agent made no file changes.</p>
                  )}
                  <div className="commit">
                    <input value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Commit message" placeholder="Commit message" />
                    <span className="target">Accept applies the changes to your checkout and commits. Nothing is pushed.</span>
                    <div className="actions">
                      <button className="btn primary" disabled={busy || !run.diff || run.diff.changes.length === 0 || !message.trim()} onClick={accept}>{excluded.size ? "Accept Selected and Commit" : "Accept and Commit"}</button>
                      <button className="btn danger" disabled={busy} onClick={reject}>{run.diff && run.diff.changes.length ? "Reject" : "Dismiss"}</button>
                      <button className="btn wide" disabled={busy || !run.diff || run.diff.changes.length === 0 || !message.trim()} onClick={pr} title="Commit on the run's branch, push it, and open a pull request with gh">Open Pull Request…</button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          {run.phase === "done" && (
            <p className="composer-note" role="status">{run.text} <button className="btn" style={{ height: 22, marginLeft: 6 }} onClick={() => setRun({ phase: "idle" })}>OK</button></p>
          )}
          {run.phase === "idle" && project && !finishedRun && (
            <p className="composer-note">Runs happen on a Git worktree on their own branch. You review the diff, then accept, reject, or open a pull request.{project.hasGit ? "" : " This folder needs a Git repository first."}</p>
          )}
        </div>
      )}

      {tab === "memory" && (
        <div className="inspector-body">
          {!project ? <p className="memory-note">Open a paper to see its memory.</p> : !memory?.brief ? (
            <>
              <p className="memory-note">This paper has no memory yet. Dabir can draft <code>.dabir/PROJECT.md</code> from the manuscript, add a provenance file, and write pointer files so Claude Code, Codex and Cursor all read the same brief.</p>
              <div className="actions"><button className="btn primary" onClick={setup}>Set Up Memory</button></div>
            </>
          ) : (
            <>
              <div className="field">
                <label>Project brief</label>
                <button className="brief" onClick={() => onOpenFile(memory.briefPath)} title="Open .dabir/PROJECT.md">
                  {memory.brief.split("\n").filter((l) => l.trim() && !l.startsWith("#")).slice(0, 3).join(" ").slice(0, 220)}…
                </button>
                <span className="target">Read by {memory.pointers.length ? memory.pointers.join(", ") : "no agent yet"}.</span>
              </div>
              <div className="field">
                <label>Provenance</label>
                {memory.provenance.length === 0 && <span className="target">No generated artefacts recorded. Add <code>[provenance]</code> entries to <code>dabir.toml</code>.</span>}
                {memory.provenance.map((a) => (
                  <div className="artefact" key={a.artefact}>
                    <div className="row">
                      <span className="file" title={a.artefact}>{a.artefact}</span>
                      {a.missing ? <span className="badge missing">missing</span> : a.stale ? <span className="badge stale">stale</span> : <span className="badge fresh">fresh</span>}
                      <button className="tb-btn icon" onClick={() => rerun(a)} title={`Rerun: ${a.command}`} aria-label="Rerun" disabled={!a.command}><RefreshCw /></button>
                    </div>
                    <code className="cmd">{a.command || "no command"}</code>
                    {(a.producedAt || a.commit) && <span className="target">{a.producedAt ?? ""}{a.commit ? ` · ${a.commit}` : ""}</span>}
                    {rerunOut[a.artefact] && <pre className="out">{rerunOut[a.artefact]}</pre>}
                  </div>
                ))}
              </div>
              <div className="field">
                <label>Facts</label>
                {memory.facts.length === 0 && <span className="target">No facts yet. Agents add one file per durable decision under <code>.dabir/memory/</code>.</span>}
                {memory.facts.map((f) => (
                  <button className="fact" key={f.path} onClick={() => onOpenFile(f.path)} title={f.path}>
                    <span className="name">{f.name}</span><span className="desc">{f.description || f.body.slice(0, 120)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {tab === "people" && (
        <div className="inspector-body">
          <p className="memory-note">Collaboration is through Git for now: commit, push, and pull request. Live sessions with presence and comments, and Overleaf sync, arrive in phase 3.</p>
        </div>
      )}
    </aside>
  );
}
