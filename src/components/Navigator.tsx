import { useEffect, useRef, useState } from "react";
import { ChevronRight, FileText, BookMarked, Code2, Image, Database, File, Folder, GitCommitHorizontal, Undo2, History as HistoryIcon } from "lucide-react";
import type { Entry, GitStatus, Project } from "../lib/backend";
import type { OutlineItem } from "../lib/latex";

const ICON = { tex: FileText, bib: BookMarked, code: Code2, figure: Image, data: Database, other: File, dir: Folder } as const;

function Node({ entry, current, onSelect, depth }: { entry: Entry; current: string | null; onSelect: (p: string) => void; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const Icon = ICON[entry.kind];
  const isDir = entry.kind === "dir";
  const onKey = (e: React.KeyboardEvent) => {
    if (!isDir) return;
    if (e.key === "ArrowRight" && !open) { e.preventDefault(); setOpen(true); }
    if (e.key === "ArrowLeft" && open) { e.preventDefault(); setOpen(false); }
  };
  return (
    <li role="treeitem" aria-level={depth + 1} aria-expanded={isDir ? open : undefined} aria-selected={current === entry.path}>
      <button className="tree-row" tabIndex={-1} aria-current={!isDir && current === entry.path ? "true" : undefined}
        onClick={() => (isDir ? setOpen((o) => !o) : onSelect(entry.path))} onKeyDown={onKey}>
        {isDir ? <ChevronRight className={`chev ${open ? "open" : ""}`} aria-hidden /> : <span style={{ width: 12 }} />}
        <Icon aria-hidden />
        <span className="label">{entry.name}</span>
      </button>
      {isDir && open && <ul role="group">{entry.children.map((c) => <Node key={c.path} entry={c} current={current} onSelect={onSelect} depth={depth + 1} />)}</ul>}
    </li>
  );
}

const countFiles = (entries: Entry[]): number => entries.reduce((n, e) => n + (e.kind === "dir" ? countFiles(e.children) : 1), 0);

function ago(when: number): string {
  const s = Math.max(0, Date.now() / 1000 - when);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

interface Props {
  project: Project | null;
  current: string | null;
  outline: OutlineItem[];
  git: GitStatus | null;
  commitFocus: number;
  busy: boolean;
  onSelect: (path: string) => void;
  onJump: (line: number, file?: string) => void;
  onInitGit: () => void;
  onCommit: (message: string) => Promise<void>;
  draftMessage?: string;
  /** Put one uncommitted file back to its committed state; History keeps a step first. */
  onDiscard: (path: string) => void;
  /** Open the History tab in the inspector. */
  onHistory: () => void;
  historyCount: number;
}

export function Navigator({ project, current, outline, git, commitFocus, busy, onSelect, onJump, onInitGit, onCommit, draftMessage, onDiscard, onHistory, historyCount }: Props) {
  const ref = useRef<HTMLElement>(null);
  const commitInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  useEffect(() => { if (draftMessage) { setMessage(draftMessage); commitInput.current?.focus(); } }, [draftMessage]);

  useEffect(() => { if (commitFocus) commitInput.current?.focus(); }, [commitFocus]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const rows = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(".tree-row, .outline-row") ?? []);
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus(); }
  };

  if (!project) {
    return (
      <aside className="navigator" ref={ref}>
        <div className="empty-nav"><strong>No paper open</strong>Open a folder that contains your manuscript and its code. Dabir reads it in place and changes nothing.</div>
      </aside>
    );
  }

  const changes = git?.changes ?? [];
  const submit = async () => { if (!message.trim() || busy) return; await onCommit(message.trim()); setMessage(""); };

  return (
    <aside className="navigator" ref={ref} onKeyDown={onKey}>
      <section className="nav-section">
        <div className="nav-heading"><span>Files</span><span className="count" title={project.treeTruncated ? "This folder holds more files than the sidebar lists. Open the paper's own folder to see all of it." : undefined}>{countFiles(project.tree)}{project.treeTruncated ? "+" : ""}</span></div>
        <ul className="tree" role="tree" aria-label="Project files" tabIndex={0}
          onFocus={(e) => { if (e.target === e.currentTarget) e.currentTarget.querySelector<HTMLButtonElement>('.tree-row[aria-current="true"], .tree-row')?.focus(); }}>
          {project.tree.map((e) => <Node key={e.path} entry={e} current={current} onSelect={onSelect} depth={0} />)}
        </ul>
      </section>

      {outline.length > 0 && (
        <section className="nav-section">
          <div className="nav-heading"><span>Outline</span></div>
          {outline.map((o) => (
            <button key={`${o.file ?? ""}-${o.number}-${o.line}`} className={`outline-row l${o.level}`} onClick={() => onJump(o.line, o.file)} title={o.file ? `${o.file}:${o.line}` : `Line ${o.line}`}>
              <span className="num">{o.number}</span><span>{o.text}</span>
            </button>
          ))}
        </section>
      )}

      <section className="nav-section">
        <div className="nav-heading">
          <span>Changes</span>
          <span className="count">{git?.isRepo ? (git.branch ? `on ${git.branch}` : "no commits") : "no git"}</span>
        </div>
        {!git?.isRepo ? (
          <div className="empty-nav">
            This folder is not a Git repository yet. Agent runs need one, so each run can work on its own branch.
            <div style={{ marginTop: 8 }}><button className="btn" onClick={onInitGit}>Initialise Repository</button></div>
          </div>
        ) : changes.length === 0 ? (
          <div className="empty-nav">No uncommitted changes.</div>
        ) : (
          <>
            <div className="changes">
              {changes.map((c) => (
                <div className="change" key={c.path}>
                  <span className="file" title={c.path}>{c.path}</span>
                  <span className="meta"><span>{c.status}</span>
                    <span className="stat">{c.binary ? <span className="add">binary</span> : <><span className="add">+{c.add}</span><span className="del">−{c.del}</span></>}</span>
                  </span>
                  <button className="discard" onClick={() => onDiscard(c.path)} disabled={busy} title={`Discard the uncommitted changes to ${c.path}. History keeps a step first, so this can be undone.`} aria-label={`Discard changes to ${c.path}`}><Undo2 aria-hidden /></button>
                </div>
              ))}
            </div>
            <div className="commit-box">
              <input ref={commitInput} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message" aria-label="Commit message"
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }} disabled={busy} />
              <button className="btn" onClick={submit} disabled={!message.trim() || busy} title="Commit all changes (⇧⌘C)"><GitCommitHorizontal /> Commit</button>
            </div>
          </>
        )}
        {git?.recent && git.recent.length > 0 && (
          <div className="recent">
            {git.recent.slice(0, 3).map((c) => (
              <div className="commit-row" key={c.id} title={`${c.id} · ${c.author}`}>
                <span className="id">{c.id}</span><span className="summary">{c.summary}</span><span className="when">{ago(c.when)}</span>
              </div>
            ))}
          </div>
        )}
        {git?.isRepo && (
          <button className="versions-toggle" onClick={onHistory} title="Every save and every accepted agent change, readable and reversible, without commits.">
            <HistoryIcon aria-hidden /> History{historyCount > 0 && <span className="count">{historyCount}</span>}
          </button>
        )}
      </section>
    </aside>
  );
}
