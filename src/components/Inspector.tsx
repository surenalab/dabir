import { useState } from "react";
import { ArrowUp, Check, Loader2, Paperclip } from "lucide-react";
import type { Project } from "../lib/backend";

type Tab = "agent" | "memory" | "people";

const PROVIDERS = [
  { id: "claude", label: "Claude Code", hint: "Claude Pro or Max" },
  { id: "codex", label: "Codex", hint: "ChatGPT Plus or Pro" },
  { id: "cursor", label: "Cursor", hint: "Cursor subscription" },
  { id: "grok", label: "Grok Build", hint: "SuperGrok" },
  { id: "opencode", label: "OpenCode", hint: "Any model, including local" },
];

export function Inspector({ project }: { project: Project | null }) {
  const [tab, setTab] = useState<Tab>("agent");
  const [provider, setProvider] = useState("claude");
  const [draft, setDraft] = useState("");
  const current = PROVIDERS.find((p) => p.id === provider)!;

  return (
    <aside className="inspector">
      <nav className="inspector-tabs" role="tablist">
        {(["agent", "memory", "people"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === "agent" ? "Agent" : t === "memory" ? "Memory" : "People"}
          </button>
        ))}
      </nav>

      {tab === "agent" && (
        <div className="inspector-body">
          <div className="provider">
            <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Agent provider">
              {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <span className="hint">{current.hint}</span>
          </div>

          {project && (
            <div className="run">
              <div className="prompt">Rerun the noise sweep with σ up to 0.3 and update Figure 3 and Table 2.</div>
              <div className="steps">
                <div className="step done"><Check /><span>ran <code>python code/sweep.py --sigma 0.3</code></span><span className="t">41 s</span></div>
                <div className="step done"><Check /><span>wrote <code>figures/psnr-vs-noise.pdf</code></span><span className="t"></span></div>
                <div className="step done"><Check /><span>edited <code>main.tex</code></span><span className="t">+6 −4</span></div>
                <div className="step running"><Loader2 /><span>compiling</span><span className="t"></span></div>
              </div>
              <div className="diff">
                <header>
                  <span className="file">main.tex</span>
                  <span className="stat"><span className="add">+6</span><span className="del">−4</span></span>
                </header>
                <pre>
                  <span className="l ctx">{"  reports PSNR against noise level for three"}</span>
                  <span className="l del">{"- baselines; the proposed method holds a 1.6 dB margin."}</span>
                  <span className="l add">{"+ baselines; the proposed method holds a 1.8 dB margin"}</span>
                  <span className="l add">{"+ up to $\\sigma = 0.3$."}</span>
                  <span className="l ctx">{"  "}</span>
                  <span className="l add">{"+ \\input{tables/psnr-sweep}"}</span>
                </pre>
              </div>
              <div className="actions">
                <button className="btn primary">Accept and commit</button>
                <button className="btn">Open pull request</button>
              </div>
            </div>
          )}

          <div className="composer">
            <textarea
              placeholder={project ? `Ask ${current.label} to change the paper or rerun an experiment…` : "Open a paper first"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={!project}
            />
            <div className="bar">
              <span className="scope"><Paperclip /> whole repo · runs on a worktree</span>
              <button className="send" disabled={!draft.trim()} aria-label="Send"><ArrowUp /></button>
            </div>
          </div>
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
          <div className="coauthors">
            <div className="coauthor"><span className="avatar" style={{ background: "var(--accent)" }}>SS</span><span className="name">Sadegh</span><span className="where">editing §2.2</span></div>
            <div className="coauthor"><span className="avatar" style={{ background: "var(--ink-3)" }}>MR</span><span className="name">Marta</span><span className="where">via Overleaf, synced 4 min ago</span></div>
          </div>
          <p className="memory-note">Live sessions and Overleaf sync arrive in phases 2 and 3. Until then, collaboration is through Git.</p>
        </div>
      )}
    </aside>
  );
}
