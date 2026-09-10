import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, Loader2, Paperclip, RefreshCw, Square, X, FileText, Pencil, Terminal, Search, Wrench, Brain, FileDiff, PenLine } from "lucide-react";
import {
  agentAccept, agentApply, agentCancel, agentDiff, agentProviders, agentPullRequest, agentReject, agentRun, memoryRead, memorySetup,
  onAgentEvent, provenanceRerun, type Artefact, type Memory, type Pick, type Project, type Provider, type WorktreeDiff,
} from "../lib/backend";
import { Segmented } from "./Segmented";
import type { Comment, Peer } from "../lib/collab";

type Tab = "agent" | "memory" | "people";

/** A pending suggestion in the open file, with the text it covers. */
export interface ChangeItem { id: string; author: string; color: string; kind: "insert" | "delete"; excerpt: string; at: number }

interface Step { kind: "text" | "tool" | "log" | "thinking"; text: string; tool?: string | null; at: number }

/** Which verb and icon a tool row gets, from the vendor's tool name. */
function toolFace(name: string | null | undefined, detail: string): { verb: string; icon: React.ReactNode; kind: string } {
  const n = (name ?? "").toLowerCase();
  if (/read|view|cat|open/.test(n)) return { verb: "Read", icon: <FileText />, kind: "read" };
  if (/edit|write|create|replace|patch|apply|multi/.test(n)) return { verb: "Edited", icon: <Pencil />, kind: "edit" };
  if (/bash|shell|command|exec|terminal|run/.test(n)) return { verb: /tectonic|latexmk|pdflatex|xelatex|typst/.test(detail) ? "Compiled" : "Ran", icon: <Terminal />, kind: "run" };
  if (/grep|glob|search|find|ls|list/.test(n)) return { verb: "Searched", icon: <Search />, kind: "search" };
  return { verb: name ? name.replace(/ToolCall$/, "") : "Used a tool", icon: <Wrench />, kind: "tool" };
}

function fmtElapsed(ms: number): string { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; }

/** The agent's train of thought and work, as a transcript: thinking folded, prose in full, tools as compact rows. */
function Transcript({ steps, running, started }: { steps: Step[]; running: boolean; started: number }) {
  const [, tick] = useState(0);
  useEffect(() => { if (!running) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [running]);
  const shown = steps.filter((s) => s.kind !== "log");
  // group consecutive tool/thinking/text so streamed prose and thought stay one block
  const blocks: { kind: string; steps: Step[] }[] = [];
  for (const st of shown) {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === st.kind && (st.kind === "tool" || st.kind === "thinking" || st.kind === "text")) last.steps.push(st);
    else blocks.push({ kind: st.kind, steps: [st] });
  }
  const lastBlock = blocks[blocks.length - 1];
  return (
    <div className="transcript" role="log" aria-live="polite">
      {blocks.map((b, i) => {
        const isLast = b === lastBlock;
        if (b.kind === "thinking") {
          const text = b.steps.map((x) => x.text).join("");
          const elapsed = Math.max(1000, (running && isLast ? Date.now() : b.steps[b.steps.length - 1].at) - b.steps[0].at);
          if (running && isLast) return <div key={i} className="think live"><Brain aria-hidden /><span>Thought for {fmtElapsed(elapsed)}…</span></div>;
          return <details key={i} className="think"><summary><Brain aria-hidden />Thought for {fmtElapsed(elapsed)}</summary><p>{text}</p></details>;
        }
        if (b.kind === "text") return <div key={i} className="say"><p>{b.steps.map((x) => x.text).join("")}</p></div>;
        return (
          <div key={i} className="tools">
            {b.steps.map((x, j) => { const f = toolFace(x.tool, x.text); return (
              <div key={j} className={`tool ${f.kind}`} title={x.text}>{f.icon}<span className="verb">{f.verb}</span><code>{x.text}</code><span className="at">+{fmtElapsed(x.at - started)}</span></div>
            ); })}
          </div>
        );
      })}
      {running && <div className="tool working"><Loader2 aria-label="Working" /><span className="verb">{shown.length ? "Working" : "Starting"}</span><span className="at">{fmtElapsed(Date.now() - started)}</span></div>}
    </div>
  );
}
type Run =
  | { phase: "idle" }
  | { phase: "running"; runId: string; prompt: string; steps: Step[]; provider: string; started: number }
  | { phase: "review"; runId: string; prompt: string; steps: Step[]; provider: string; ok: boolean; summary: string; diff: WorktreeDiff | null; error?: string; started: number; finished: number }
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

function ReviewDiff({ patch, excluded, onToggle }: { patch: string; excluded: Set<string>; onToggle: (key: string, on: boolean) => void }) {
  const files = useMemo(() => splitPatch(patch), [patch]);
  return (
    <div className="evidence">
      <div className="evidence-heading">What changed</div>
      <span className="target">Untick a file or a hunk to leave it out of Accept.</span>
      <DiffView files={files} excluded={excluded} onToggle={onToggle} />
    </div>
  );
}

interface Props {
  live: boolean;
  peers: Peer[];
  comments: Comment[];
  currentFile: string | null;
  hasSelection: boolean;
  onAddComment: (text: string) => void;
  onResolveComment: (id: string, resolved: boolean) => void;
  onReplyComment: (id: string, text: string) => void;
  onRemoveComment: (id: string) => void;
  onJumpComment: (c: Comment) => void;
  onShare: () => void;
  changes: ChangeItem[];
  suggesting: boolean;
  onToggleSuggesting: () => void;
  onResolveChanges: (ids: string[] | null, accept: boolean) => void;
  onJumpChange: (id: string) => void;
  project: Project | null;
  gitRepo: boolean;
  askFocus: number;
  prefill: { text: string; stamp: number } | null;
  onProviderReady: (ready: boolean) => void;
  onChanged: () => void;         // git status or files changed; reloads the open buffer from disk
  onOpenFile: (path: string) => void;
  onNote: (text: string) => void;
  /** Preview-only: start a run with this prompt once providers are ready. */
  autoRun?: string | null;
}

export function Inspector({ project, gitRepo, askFocus, prefill, onProviderReady, onChanged, onOpenFile, onNote, live, peers, comments, currentFile, hasSelection, onAddComment, onResolveComment, onReplyComment, onRemoveComment, onJumpComment, onShare, autoRun, changes, suggesting, onToggleSuggesting, onResolveChanges, onJumpChange }: Props) {
  const [commentDraft, setCommentDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const sendReply = (id: string) => { const t = replyDraft.trim(); if (!t) return; onReplyComment(id, t); setReplyDraft(""); setReplyTo(null); };
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
  useEffect(() => { if (prefill) { setTab("agent"); setDraft(prefill.text); setTimeout(() => textarea.current?.focus(), 50); } }, [prefill]);
  useEffect(() => { onProviderReady(!!providers.find((p) => p.id === provider)?.installed); }, [providers, provider, onProviderReady]);

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
      setRun({ phase: "review", runId: r.runId, prompt: r.prompt, steps: r.steps, provider: r.provider, ok: e.ok ?? true, summary, diff, error, started: r.started, finished: Date.now() });
      setMessage(r.prompt.length > 72 ? r.prompt.slice(0, 69) + "…" : r.prompt);
      setExcluded(new Set());
    } else if (e.kind === "error") {
      setRun({ phase: "review", runId: r.runId, prompt: r.prompt, steps: r.steps, provider: r.provider, ok: false, summary: e.text, diff: null, started: r.started, finished: Date.now() });
    } else if (e.kind === "thinking") {
      const last = r.steps[r.steps.length - 1];
      // Keep the original `at` so "Thought for n s" measures the whole burst, not the last chunk.
      if (last && last.kind === "thinking" && Date.now() - last.at < 30_000) setRun({ ...r, steps: [...r.steps.slice(0, -1), { ...last, text: last.text + e.text }] });
      else setRun({ ...r, steps: [...r.steps, { kind: "thinking", text: e.text, at: Date.now() }] });
    } else if (e.kind === "text") {
      const last = r.steps[r.steps.length - 1];
      if (last && last.kind === "text") setRun({ ...r, steps: [...r.steps.slice(0, -1), { ...last, text: last.text + e.text }] });
      else setRun({ ...r, steps: [...r.steps, { kind: "text", text: e.text, at: Date.now() }] });
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

  // Preview-only: start a run automatically so screenshots can show the transcript.
  const autoRan = useRef(false);
  useEffect(() => {
    if (!autoRun || autoRan.current || !project || !providers.length || run.phase !== "idle") return;
    autoRan.current = true; setTab("agent");
    (async () => { try { const started = await agentRun(project.root, provider, autoRun); setRun({ phase: "running", runId: started.runId, prompt: autoRun, steps: [], provider, started: Date.now() }); } catch { /* preview only */ } })();
  }, [autoRun, project, providers, provider, run.phase]);

  const cancel = async () => { if (run.phase === "running") { await agentCancel(run.runId); } };

  const selection = (): { picks: Pick[]; partial: boolean } => {
    const files = splitPatch(run.phase === "review" ? run.diff?.patch ?? "" : "");
    const picks: Pick[] = [];
    let partial = false;
    for (const f of files) {
      if (excluded.has(f.name)) { partial = true; continue; }
      const hunks = f.hunks.map((_, i) => i).filter((i) => !excluded.has(`${f.name}#${i}`));
      if (hunks.length === f.hunks.length) picks.push({ path: f.name, hunks: null });
      else { partial = true; if (hunks.length) picks.push({ path: f.name, hunks }); }
    }
    return { picks, partial };
  };
  // Accept: the changes land in the checkout and a snapshot is taken; you commit when the paper is ready.
  const apply = async () => {
    if (run.phase !== "review" || !project) return;
    const { picks, partial } = selection();
    if (picks.length === 0) { onNote("Nothing selected to accept."); return; }
    setBusy(true);
    try { const files = await agentApply(project.root, run.runId, partial ? picks : undefined, run.prompt, run.provider); setRun({ phase: "done", text: `Applied to ${files.length} file${files.length === 1 ? "" : "s"} and saved${partial ? " (only the selected changes)" : ""}. A snapshot was taken; commit whenever you like.` }); onChanged(); refreshMemory(); }
    catch (e) { onNote(String(e)); } finally { setBusy(false); }
  };
  const accept = async () => {
    if (run.phase !== "review" || !project) return;
    const { picks, partial } = selection();
    if (picks.length === 0) { onNote("Nothing selected to accept."); return; }
    setBusy(true);
    try { const id = await agentAccept(project.root, run.runId, message.trim() || run.prompt, partial ? picks : undefined, run.provider, run.prompt); setRun({ phase: "done", text: `Committed ${id} to your checkout${partial ? " (only the selected changes; the rest was discarded)" : ""}.` }); onChanged(); refreshMemory(); }
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
            {current && !current.installed && <span className="hint">Install the {current.bin} CLI and sign in</span>}
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
              <Transcript steps={run.steps} running={run.phase === "running"} started={run.started} />
              {run.phase === "running" && <div className="actions"><button className="btn" onClick={cancel}><Square /> Stop</button></div>}
              {run.steps.some((s) => s.kind === "log") && (
                <details className="log-details"><summary>{run.steps.filter((s) => s.kind === "log").length} log lines</summary>
                  <pre>{run.steps.filter((s) => s.kind === "log").map((s) => s.text).join("\n")}</pre></details>
              )}

              {run.phase === "review" && (
                <>
                  <div className={`result ${run.ok ? "ok" : "failed"}`}>
                    {run.ok ? <Check aria-hidden /> : <X aria-hidden />}
                    <div>
                      <b>{run.ok ? "Finished" : "Stopped with an error"}</b>
                      <span>
                        {fmtElapsed(run.finished - run.started)}
                        {run.diff && run.diff.changes.length > 0 && <> · {run.diff.changes.length} file{run.diff.changes.length === 1 ? "" : "s"} · <em className="add">+{run.diff.changes.reduce((a, c) => a + c.add, 0)}</em> <em className="del">−{run.diff.changes.reduce((a, c) => a + c.del, 0)}</em></>}
                        {run.steps.some((x) => x.kind === "tool" && /tectonic|latexmk|pdflatex|xelatex|typst/.test(x.text)) && <> · compiled</>}
                      </span>
                      {!run.ok && run.summary && <p>{run.summary}</p>}
                    </div>
                  </div>
                  {run.error && <p className="composer-note" role="alert">{run.error}</p>}
                  {run.diff && run.diff.changes.length > 0 ? (
                    <ReviewDiff patch={run.diff.patch} excluded={excluded} onToggle={(key, on) => setExcluded((x) => { const n = new Set(x); if (on) n.delete(key); else n.add(key); return n; })} />
                  ) : (
                    <p className="composer-note">The agent made no file changes.</p>
                  )}
                  <div className="commit">
                    <div className="actions">
                      <button className="btn primary" disabled={busy || !run.diff || run.diff.changes.length === 0} onClick={apply} title="The changes land in your files and are saved. A snapshot is taken. Commit whenever the paper is ready."><FileDiff /> {excluded.size ? "Accept Selected" : "Accept"}</button>
                      <button className="btn danger" disabled={busy} onClick={reject}>{run.diff && run.diff.changes.length ? "Reject" : "Dismiss"}</button>
                    </div>
                    <details className="commit-now">
                      <summary>Commit or open a pull request now</summary>
                      <input value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Commit message" placeholder="Commit message" />
                      <div className="actions">
                        <button className="btn" disabled={busy || !run.diff || run.diff.changes.length === 0 || !message.trim()} onClick={accept}>{excluded.size ? "Accept Selected and Commit" : "Accept and Commit"}</button>
                        <button className="btn wide" disabled={busy || !run.diff || run.diff.changes.length === 0 || !message.trim()} onClick={pr} title="Commit on the run's branch, push it, and open a pull request with gh">Open Pull Request…</button>
                      </div>
                    </details>
                  </div>
                </>
              )}
            </div>
          )}
          {run.phase === "done" && (
            <p className="composer-note" role="status">{run.text} <button className="btn" style={{ height: 22, marginLeft: 6 }} onClick={() => setRun({ phase: "idle" })}>OK</button></p>
          )}
          {run.phase === "idle" && project && !finishedRun && (
            <p className="composer-note">Runs happen on a Git worktree. You review the diff, then Accept (lands the change and takes a snapshot), Reject, or open a pull request.{gitRepo ? "" : " This folder needs a Git repository first."}</p>
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
                <label>Identity</label>
                <button className="brief" onClick={() => onOpenFile(memory.briefPath)} title="Open .dabir/PROJECT.md">
                  {memory.identity ?? memory.brief.split("\n").filter((l) => l.trim() && !l.startsWith("#")).slice(0, 2).join(" ").slice(0, 220)}
                </button>
                <span className="target">Every run starts with this line, a pointer to the brief, the environment prefix{memory.envPrefix ? <> <code>{memory.envPrefix}</code></> : " (none set)"}, and the passages most relevant to the request. Read by {memory.pointers.length ? memory.pointers.join(", ") : "no agent yet"}.</span>
              </div>
              <div className="field">
                <label>Skills</label>
                <div className="skills">
                  {memory.skills.map((sk) => <button key={sk.path} className="skill" onClick={() => onOpenFile(sk.path)} title={sk.description}>{sk.name.replace(/^dabir-/, "")}</button>)}
                  {memory.skills.length === 0 && <span className="target">No skills yet. Set Up Memory adds six playbooks.</span>}
                </div>
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
              {memory.runs.length > 0 && (
                <div className="field">
                  <label>Accepted runs</label>
                  {memory.runs.map((r, i) => <span key={i} className="runline">{r}</span>)}
                </div>
              )}
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
          {!live && (
            <>
              <p className="memory-note">Nobody else is here yet. Comments below are saved with the paper in <code>.dabir/comments.json</code>; start a live session to edit together with presence.</p>
              <div className="actions"><button className="btn primary" onClick={onShare} disabled={!project}>Share…</button></div>
            </>
          )}
          {project && (
            <>
              {live && <div className="field">
                <label>In this session</label>
                <div className="peers">
                  {peers.map((pr) => (
                    <div className="peer" key={pr.clientId}>
                      <span className="avatar" style={{ background: pr.color }}>{pr.name.slice(0, 2).toUpperCase()}</span>
                      <span className="name">{pr.name}{pr.me ? " (you)" : ""}</span>
                      <span className="where">{pr.file ?? ""}</span>
                    </div>
                  ))}
                </div>
              </div>}
              <div className="field">
                <label>Suggested changes{currentFile ? <> in <code>{currentFile}</code></> : ""}</label>
                <div className="suggest-head">
                  <button className={`btn ${suggesting ? "primary" : ""}`} aria-pressed={suggesting} onClick={onToggleSuggesting} title="While on, your edits are recorded as suggestions instead of changing the text outright."><PenLine /> {suggesting ? "Suggesting" : "Suggest changes"}</button>
                  {changes.length > 1 && (
                    <span className="suggest-all">
                      <button className="btn" onClick={() => onResolveChanges(null, true)}>Accept all</button>
                      <button className="btn" onClick={() => onResolveChanges(null, false)}>Reject all</button>
                    </span>
                  )}
                </div>
                <div className="suggs">
                  {changes.map((c) => (
                    <div className={`sugg ${c.kind}`} key={c.id} style={{ "--sugg-color": c.color } as React.CSSProperties}>
                      <div className="who"><b>{c.author}</b><span>{c.kind === "insert" ? "inserted" : "deleted"}</span></div>
                      <button className="excerpt" onClick={() => onJumpChange(c.id)} title="Show in the source">{c.excerpt || "(whitespace)"}</button>
                      <div className="row">
                        <button onClick={() => onResolveChanges([c.id], true)}>Accept</button>
                        <button onClick={() => onResolveChanges([c.id], false)}>Reject</button>
                      </div>
                    </div>
                  ))}
                  {changes.length === 0 && <span className="target">{suggesting ? "Type to suggest. Deletions stay struck through in the text until they are accepted." : "No suggestions in this file."}</span>}
                </div>
              </div>
              <div className="field">
                <label>Comments{currentFile ? <> on <code>{currentFile}</code></> : ""}</label>
                <div className="comment-box">
                  <input value={commentDraft} onChange={(e) => setCommentDraft(e.target.value)} placeholder={hasSelection ? "Comment on the selection" : "Select text, then comment"} aria-label="New comment"
                    onKeyDown={(e) => { if (e.key === "Enter" && commentDraft.trim()) { onAddComment(commentDraft.trim()); setCommentDraft(""); } }} disabled={!currentFile} />
                  <button className="btn" onClick={() => { if (commentDraft.trim()) { onAddComment(commentDraft.trim()); setCommentDraft(""); } }} disabled={!commentDraft.trim() || !currentFile}>Add</button>
                </div>
                <div className="comments">
                  {comments.filter((c) => !currentFile || c.file === currentFile).sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.at - a.at).map((c) => (
                    <div className={`comment ${c.resolved ? "resolved" : ""}`} key={c.id} style={{ "--comment-color": c.color } as React.CSSProperties}>
                      <div className="who"><b>{c.author}</b><span>{new Date(c.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
                      <div className="text">{c.text}</div>
                      {(c.replies ?? []).map((r, i) => (
                        <div className="reply" key={i} style={{ "--comment-color": r.color } as React.CSSProperties}>
                          <div className="who"><b>{r.author}</b><span>{new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
                          <div className="text">{r.text}</div>
                        </div>
                      ))}
                      {replyTo === c.id ? (
                        <div className="comment-box reply-box">
                          <input autoFocus value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)} placeholder="Reply" aria-label="Reply"
                            onKeyDown={(e) => { if (e.key === "Enter") sendReply(c.id); if (e.key === "Escape") { setReplyTo(null); setReplyDraft(""); } }} />
                          <button className="btn" onClick={() => sendReply(c.id)} disabled={!replyDraft.trim()}>Send</button>
                        </div>
                      ) : null}
                      <div className="row">
                        <button onClick={() => onJumpComment(c)}>Show</button>
                        <button onClick={() => { setReplyTo(replyTo === c.id ? null : c.id); setReplyDraft(""); }}>Reply</button>
                        <button onClick={() => onResolveComment(c.id, !c.resolved)}>{c.resolved ? "Reopen" : "Resolve"}</button>
                        <button onClick={() => onRemoveComment(c.id)}>Delete</button>
                      </div>
                    </div>
                  ))}
                  {comments.length === 0 && <span className="target">No comments yet.</span>}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
