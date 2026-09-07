import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, Loader2, Paperclip, X } from "lucide-react";
import type { Project } from "../lib/backend";
import { Segmented } from "./Segmented";

type Tab = "agent" | "memory" | "people";

const PROVIDERS = [
  { id: "claude", label: "Claude Code", hint: "Claude Pro or Max" },
  { id: "codex", label: "Codex", hint: "ChatGPT Plus or Pro" },
  { id: "cursor", label: "Cursor", hint: "Cursor subscription" },
  { id: "grok", label: "Grok Build", hint: "SuperGrok" },
  { id: "opencode", label: "OpenCode", hint: "Any model, including local" },
];

type StepState = "done" | "running" | "failed";
interface Step { state: StepState; text: React.ReactNode; t?: string }

// Sample run so the review surface can be seen before real agents land in phase 2.
const SAMPLE_STEPS: Step[] = [
  { state: "done", text: <>ran <code>python code/sweep.py --sigma 0.3</code></>, t: "41 s" },
  { state: "done", text: <>wrote <code>figures/psnr-vs-noise.pdf</code></> },
  { state: "done", text: <>wrote <code>tables/psnr-sweep.tex</code></> },
  { state: "done", text: <>edited <code>main.tex</code></>, t: "+6 −4" },
  { state: "done", text: <>compiled, 0 errors, 1 warning</>, t: "2.3 s" },
];

export function Inspector({ project, askFocus }: { project: Project | null; askFocus: number }) {
  const [tab, setTab] = useState<Tab>("agent");
  const [provider, setProvider] = useState("claude");
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [message, setMessage] = useState("Rerun noise sweep to σ = 0.3; update Figure 3 and Table 2");
  const [decided, setDecided] = useState<"accepted" | "rejected" | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const current = PROVIDERS.find((p) => p.id === provider)!;
  const finished = SAMPLE_STEPS.every((s) => s.state !== "running");

  useEffect(() => { if (askFocus) { setTab("agent"); textarea.current?.focus(); } }, [askFocus]);

  const send = () => {
    if (!draft.trim()) return;
    setNote(`Kept for phase 2: “${draft.trim()}”. Agent runs are not wired yet, so nothing was sent to ${current.label}.`);
    setDraft("");
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
            <select id="provider" value={provider} onChange={(e) => setProvider(e.target.value)} title={current.hint}>
              {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <span className="hint">{current.hint}</span>
          </div>

          <div className="composer">
            <textarea
              ref={textarea}
              placeholder={project ? `Ask ${current.label} to change the paper or rerun an experiment…` : "Open a paper first"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && e.metaKey) { e.preventDefault(); send(); } }}
              disabled={!project}
              aria-label="Message to the agent"
            />
            <div className="bar">
              <span className="scope" title="The agent sees the whole repository and works on a Git worktree, so your checkout is untouched until you accept"><Paperclip aria-hidden /> whole repo · worktree · <kbd>⌘↩</kbd></span>
              <button className="send" disabled={!draft.trim()} aria-label="Send to agent" onClick={send}><ArrowUp /></button>
            </div>
          </div>
          {note && <p className="composer-note" role="status">{note}</p>}

          {project && !decided && (
            <div className="run" aria-label="Sample agent run">
              <div className="prompt"><b>You asked<span className="sample-tag">sample</span></b>Rerun the noise sweep with σ up to 0.3 and update Figure 3 and Table 2.</div>
              <div className="steps" role="status" aria-live="polite">
                {SAMPLE_STEPS.map((s, i) => (
                  <div key={i} className={`step ${s.state}`}>
                    {s.state === "done" ? <Check aria-label="Done" /> : s.state === "failed" ? <X aria-label="Failed" /> : <Loader2 aria-label="Running" />}
                    <span>{s.text}</span><span className="t">{s.t ?? ""}</span>
                  </div>
                ))}
              </div>

              <div className="evidence">
                <div className="evidence-heading">What changed</div>
                <div className="figure-card">
                  <div className="thumb" aria-label="Regenerated figure preview">
                    <svg viewBox="0 0 64 40" aria-hidden><polyline points="4,34 14,28 24,22 34,17 44,13 54,11 60,10" fill="none" stroke="var(--accent)" strokeWidth="1.5" /><polyline points="4,36 14,32 24,29 34,27 44,26 54,25 60,25" fill="none" stroke="var(--ink-3)" strokeWidth="1.2" /></svg>
                  </div>
                  <div className="about"><code>figures/psnr-vs-noise.pdf</code><br />7 noise levels, 5 seeds. Was 5 levels to σ = 0.2.</div>
                </div>
                <div className="diff">
                  <header><span className="file">tables/psnr-sweep.tex</span><span className="stat"><span className="add">+2</span></span></header>
                  <pre>
                    <span className="l ctx">{"0.2 & 28.9 & 28.1 & 30.7 \\\\"}</span>
                    <span className="l add">{"+0.25 & 27.0 & 26.2 & 28.9 \\\\"}</span>
                    <span className="l add">{"+0.3 & 25.4 & 24.6 & 27.2 \\\\"}</span>
                  </pre>
                </div>
                <div className="diff">
                  <header><span className="file">main.tex</span><span className="stat"><span className="add">+6</span><span className="del">−4</span></span></header>
                  <pre>
                    <span className="l ctx">{" reports PSNR against noise level for three"}</span>
                    <span className="l del">{"-baselines; the proposed method holds a 1.6 dB margin."}</span>
                    <span className="l add">{"+baselines; the proposed method holds a 1.8 dB margin up to $\\sigma = 0.3$."}</span>
                    <span className="l ctx">{" "}</span>
                    <span className="l add">{"+\\input{tables/psnr-sweep}"}</span>
                  </pre>
                </div>
              </div>

              <div className="commit">
                <input value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Commit message" disabled={!finished} />
                <span className="target">Commits to <code>main</code> in your checkout. Nothing is pushed.</span>
                <div className="actions">
                  <button className="btn primary" disabled={!finished || !message.trim()} onClick={() => setDecided("accepted")}>Accept and Commit</button>
                  <button className="btn danger" disabled={!finished} onClick={() => setDecided("rejected")}>Reject</button>
                  <button className="btn wide" disabled={!finished || !project.hasGit} title={project.hasGit ? "Push to a branch and open a pull request on GitHub" : "This folder is not a Git repository"}>Open Pull Request…</button>
                </div>
              </div>
            </div>
          )}
          {decided && (
            <p className="composer-note" role="status">
              {decided === "accepted" ? "Sample run accepted. Real commits arrive with Git support in phase 2." : "Sample run rejected. The worktree would be discarded and your files left untouched."}
              {" "}<button className="btn" style={{ height: 22, marginLeft: 6 }} onClick={() => setDecided(null)}>Show again</button>
            </p>
          )}
        </div>
      )}

      {tab === "memory" && (
        <div className="inspector-body">
          {project?.hasMemory ? (
            <>
              <div className="field">
                <label>Project brief</label>
                <dl className="kv">
                  <dt>File</dt><dd>.dabir/PROJECT.md</dd>
                  <dt>Venue</dt><dd>IEEE TCI, 12 pages</dd>
                  <dt>Updated</dt><dd>2 days ago by Claude Code</dd>
                </dl>
              </div>
              <div className="field">
                <label>Provenance</label>
                <dl className="kv">
                  <dt>Figure 3</dt><dd>code/sweep.py --sigma 0.3</dd>
                  <dt>Table 2</dt><dd>code/sweep.py --sigma 0.3</dd>
                  <dt>Data</dt><dd>fastmri-knee-val sha256:9f2c…</dd>
                </dl>
              </div>
              <p className="memory-note">Memory is plain Markdown and JSON in <code>.dabir/</code>, committed with the paper, so every coauthor's agent shares it whichever vendor they use.</p>
            </>
          ) : (
            <p className="memory-note">{project ? "This paper has no memory yet. The first agent run will draft .dabir/PROJECT.md for you to review." : "Open a paper to see its memory."}</p>
          )}
        </div>
      )}

      {tab === "people" && (
        <div className="inspector-body">
          <div className="coauthors" aria-label="Sample coauthors">
            <div className="coauthor"><span className="avatar" style={{ background: "var(--accent)" }}>SS</span><span className="name">Sadegh</span><span className="where">editing §2.2</span></div>
            <div className="coauthor"><span className="avatar" style={{ background: "var(--ink-3)" }}>MR</span><span className="name">Marta</span><span className="where">via Overleaf, synced 4 min ago</span></div>
          </div>
          <p className="memory-note">Sample data. Live sessions and Overleaf sync arrive in phases 2 and 3. Until then, collaboration is through Git.</p>
        </div>
      )}
    </aside>
  );
}
