import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Circle, LoaderCircle, TerminalSquare, TriangleAlert, X } from "lucide-react";
import { onSetupProgress, setupInstallTypst, setupStatus, setupWarmLatex, type Provider, type SetupProgress, type SetupStatus } from "../lib/backend";
import { availableServers, serversFor, type ServerSpec } from "../lib/lsp";
import { setUserName, userName } from "../lib/collab";
import { TerminalPane } from "./Terminal";

/**
 * Setup: what a paper needs on this machine, checked in front of the user, with the fix beside each gap.
 * Nothing here leaves the app: the LaTeX package cache and Typst are fetched by Dabir itself with a progress
 * bar; agent CLIs and language servers are installed by their vendors' own commands, typed into a terminal
 * that opens inside this sheet, so the user watches the command run and signs in where it asks.
 * Shown once on the first launch (skippable), and from Help › Set Up Dabir any time.
 */

const CODE_KINDS: [string, string][] = [["Python", "x.py"], ["Typst", "x.typ"], ["Julia", "x.jl"], ["R", "x.r"], ["JavaScript / TypeScript", "x.ts"], ["C / C++ / CUDA", "x.cpp"], ["Rust", "x.rs"], ["Lua", "x.lua"], ["Shell", "x.sh"], ["YAML", "x.yml"]];

type Task = { message: string; fraction: number | null; running: boolean; done: boolean; ok: boolean };
const IDLE: Task = { message: "", fraction: null, running: false, done: false, ok: true };

interface Props {
  firstRun: boolean;
  onClose: () => void;
  /** Where to land the focus: a row id such as "typst" or "agents". */
  focus?: string | null;
}

export function SetupSheet({ firstRun, onClose, focus }: Props) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [servers, setServers] = useState<Set<string> | null>(null);
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const [shell, setShell] = useState<{ command: string; stamp: number; label: string } | null>(null);
  const [shellOpen, setShellOpen] = useState(false);
  const [name, setName] = useState(() => userName());
  const watching = useRef(0);
  const rowRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try { setStatus(await setupStatus()); } catch { /* the sheet shows what it has */ }
  }, []);
  useEffect(() => { refresh(); availableServers().then(setServers).catch(() => setServers(new Set())); }, [refresh]);

  // After a command was typed into the shell, watch for the tool to appear (the installer needs a while), for up to
  // five minutes; also whenever the window comes back to the front, since sign-in happens in the browser.
  useEffect(() => {
    if (!shell) return;
    watching.current = Date.now();
    const t = window.setInterval(() => { if (Date.now() - watching.current > 5 * 60_000) { clearInterval(t); return; } refresh(); }, 3000);
    return () => clearInterval(t);
  }, [shell, refresh]);
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useEffect(() => onSetupProgress((p: SetupProgress) => {
    setTasks((t) => ({ ...t, [p.task]: { message: p.message, fraction: p.fraction, running: !p.done, done: p.done, ok: p.ok } }));
    if (p.done) refresh();
  }), [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!focus || !status) return;
    const el = rowRef.current?.querySelector<HTMLElement>(`[data-row="${focus}"]`);
    el?.scrollIntoView({ block: "center" });
    el?.querySelector<HTMLElement>("button")?.focus();
  }, [focus, status]);

  const runInShell = useCallback((command: string, label: string) => {
    setShellOpen(true);
    setShell({ command, stamp: Date.now(), label });
  }, []);

  const start = useCallback(async (task: "latex" | "typst") => {
    setTasks((t) => ({ ...t, [task]: { ...IDLE, running: true, message: task === "latex" ? "Starting the LaTeX engine…" : "Finding the latest release…" } }));
    try { if (task === "latex") await setupWarmLatex(); else await setupInstallTypst(); }
    catch (e) { setTasks((t) => ({ ...t, [task]: { message: String(e), fraction: null, running: false, done: true, ok: false } })); }
    refresh();
  }, [refresh]);

  const finish = () => { setUserName(name.trim()); onClose(); };

  const latex = tasks.latex ?? IDLE, typst = tasks.typst ?? IDLE;
  const agentsInstalled = status?.agents.filter((a) => a.installed && a.signedIn !== false).length ?? 0;
  const ready = useMemo(() => {
    if (!status) return null;
    const parts = [status.latexReady, !!status.typst.path, agentsInstalled > 0];
    return parts.filter(Boolean).length;
  }, [status, agentsInstalled]);

  return (
    <div className="sheet-backdrop" onClick={firstRun ? undefined : onClose}>
      <div className={`sheet setup ${shellOpen ? "with-shell" : ""}`} role="dialog" aria-modal="true" aria-labelledby="setup-title" onClick={(e) => e.stopPropagation()}>
        <header className="setup-head">
          <div>
            <h2 id="setup-title">{firstRun ? "Welcome to Dabir" : "Set up Dabir"}</h2>
            <p className="setup-deck">
              {firstRun
                ? "A minute to check what this machine has for writing a paper. Nothing is installed unless you choose it, and everything that runs, runs where you can see it."
                : "What this machine has for writing a paper, and the fix beside anything missing."}
            </p>
          </div>
          {!firstRun && <button className="btn icon" aria-label="Close" onClick={onClose}><X aria-hidden /></button>}
        </header>

        <div className="setup-rows" ref={rowRef}>
          <section aria-labelledby="setup-writing">
            <h3 id="setup-writing">Writing</h3>

            <Row id="latex" state={!status ? "wait" : latex.running ? "busy" : status.latexError ? "warn" : status.latexReady ? "ok" : "todo"} title="LaTeX"
              detail={!status ? "Checking…"
                : status.latexError ? <>The bundled Tectonic does not start on this machine: <code>{status.latexError}</code>. LaTeX papers cannot compile until a build for this system is installed.</>
                : status.latexReady ? <>Ready. Tectonic {status.latex.version ?? ""} is built in and its packages are on this machine{status.latexCacheMb ? ` (${status.latexCacheMb} MB)` : ""}, so a compile starts at once.</>
                : latex.done && !latex.ok ? <>The engine stopped: <code>{latex.message}</code>. Compiling a paper will try again.</>
                : <>Tectonic {status.latex.version ?? ""} is built in. Its packages download at the first compile, which takes a minute or two; fetch them now so that wait never happens in the middle of writing.</>}
              progress={latex.running ? latex : null}
              action={status && !status.latexReady && !status.latexError && !latex.running ? <button className="btn" onClick={() => start("latex")}>{latex.done && !latex.ok ? "Try again" : "Fetch packages"}</button> : null} />

            <Row id="typst" state={!status ? "wait" : typst.running ? "busy" : status.typst.path ? "ok" : "todo"} title="Typst"
              detail={!status ? "Checking…"
                : status.typst.path ? <>Ready. Typst {status.typst.version ?? ""}{status.typst.managed ? " installed by Dabir" : <>, from <code>{status.typst.path}</code></>}.</>
                : typst.done && !typst.ok ? <>Could not install: <code>{typst.message}</code>.</>
                : <>Only for Typst papers. Dabir can download the compiler ({status.typstSizeMb} MB, from Typst's own release) and keep it inside the app.</>}
              progress={typst.running ? typst : null}
              action={status && !status.typst.path && !typst.running ? <button className="btn" onClick={() => start("typst")}>{typst.done && !typst.ok ? "Try again" : "Download Typst"}</button> : null} />
            <Row id="pandoc" small state={!status ? "wait" : status.pandoc ? "ok" : "todo"} title="Word and HTML export"
              detail={!status ? "Checking…"
                : status.pandoc ? <>Ready. <code>pandoc</code> at <code>{status.pandoc}</code>.</>
                : status.pandocInstall ? <>Only for File › Export to Word or HTML. Installs <code>pandoc</code> with <code>{status.pandocInstall}</code>, shown as it runs.</>
                : <>Only for File › Export to Word or HTML. Install <code>pandoc</code> from <a href="https://pandoc.org/installing.html" target="_blank" rel="noreferrer">pandoc.org</a>, then check again.</>}
              action={status && !status.pandoc && status.pandocInstall ? <button className="btn small" onClick={() => runInShell(status.pandocInstall!, "the pandoc installer")}>Install pandoc</button> : null} />
          </section>

          <section aria-labelledby="setup-agents" data-row="agents">
            <h3 id="setup-agents">Agents</h3>
            <p className="setup-note">Dabir runs the agent's own command-line tool on your own subscription; no model is proxied and no key is stored here. Install the ones you use, then sign in where the tool asks. The command is shown in the shell as it runs.</p>
            <Row id="git" small state={!status ? "wait" : status.git ? "ok" : "todo"} title="Git"
              detail={!status ? "Checking…"
                : status.git ? <>Ready. <code>git</code> at <code>{status.git}</code>. Every run works on its own branch in a worktree; the paper's folder becomes a repository on the first run if it is not one.</>
                : status.gitInstall ? <>Agent runs work on a Git worktree, which needs the <code>git</code> command. Installs it with <code>{status.gitInstall}</code>, shown as it runs.</>
                : <>Agent runs work on a Git worktree, which needs the <code>git</code> command. Install it from <a href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">git-scm.com</a>, then check again.</>}
              action={status && !status.git && status.gitInstall ? <button className="btn small" onClick={() => runInShell(status.gitInstall!, "the Git installer")}>Install Git</button> : null} />
            {!status && <div className="setup-row"><span className="setup-state wait"><LoaderCircle aria-hidden /></span><div className="setup-text"><span className="setup-title">Looking for installed agents…</span></div></div>}
            {status?.agents.map((a) => <AgentRow key={a.id} a={a} onRun={runInShell} />)}
          </section>

          <section aria-labelledby="setup-code">
            <h3 id="setup-code">Code</h3>
            <details className="setup-details">
              <summary>Language servers for the code behind the figures <span className="setup-count">{servers ? `${CODE_KINDS.filter(([, f]) => serversFor(f).some((s) => servers.has(s.command))).length} of ${CODE_KINDS.length} languages` : ""}</span></summary>
              <p className="setup-note">Optional. With a server installed, a code file gets completion, errors, hover, go-to-definition and rename. Each installs with one command from its own project.</p>
              {CODE_KINDS.map(([label, f]) => {
                const specs = serversFor(f);
                const have = servers ? specs.find((s) => servers.has(s.command)) : undefined;
                const first: ServerSpec | undefined = specs[0];
                return (
                  <Row key={label} id={`lsp-${label}`} small state={!servers ? "wait" : have ? "ok" : "todo"} title={label}
                    detail={!servers ? "Checking…" : have ? <code>{have.command}</code> : first ? <code>{first.install}</code> : "No server known"}
                    action={servers && !have && first ? <button className="btn small" onClick={() => runInShell(first.install, `${label} language server`)}>Install</button> : null} />
                );
              })}
            </details>
          </section>

          <section aria-labelledby="setup-you">
            <h3 id="setup-you">You</h3>
            <Row id="name" state={name.trim() ? "ok" : "todo"} title="Your name"
              detail="On the comments and suggested changes you leave for coauthors, and in a live session. Kept on this machine only."
              action={<input className="sheet-input compact setup-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" aria-label="Your name" autoComplete="name" />} />
          </section>
        </div>

        {shellOpen && status && (
          <div className="setup-shell" aria-label="Setup shell">
            <div className="setup-shell-head">
              <TerminalSquare aria-hidden />
              <span>{shell ? <>Running <b>{shell.label}</b> in a shell in your home folder. Answer its prompts here; a sign-in opens the browser and comes back.</> : "A shell in your home folder."}</span>
              <button className="btn small" onClick={() => setShellOpen(false)}>Hide</button>
            </div>
            <TerminalPane cwd={status.home} remote={null} onClose={() => setShellOpen(false)} focusStamp={shell?.stamp ?? 0} run={shell ? { command: shell.command, stamp: shell.stamp } : null} />
          </div>
        )}

        <footer className="setup-foot">
          <span className="setup-summary" aria-live="polite">
            {ready == null ? "" : ready === 3 ? "Everything a paper needs is here." : `${ready} of 3 ready · LaTeX, Typst, an agent`}
          </span>
          <button className="btn" onClick={refresh}>Check again</button>
          <button className="btn primary" onClick={finish}>{firstRun ? "Continue" : "Done"}</button>
        </footer>
      </div>
    </div>
  );
}

function AgentRow({ a, onRun }: { a: Provider & { signedIn: boolean | null }; onRun: (command: string, label: string) => void }) {
  // Installed and signed in is the only green; installed but signed out is the case that otherwise fails
  // at the first message with a cryptic CLI error, so it gets the warning and the primary action.
  const state = !a.installed ? "todo" : a.signedIn === false ? "warn" : "ok";
  return (
    <Row id={`agent-${a.id}`} state={state} title={a.label}
      detail={!a.installed ? <>Needs {a.plan}. One command from the vendor, shown as it runs.</>
        : a.signedIn === false ? <>Installed, but not signed in: a message to it would fail. Sign in opens the browser and comes back.</>
        : a.signedIn ? <>Installed and signed in{a.path ? <>, <code>{a.path}</code></> : null}.</>
        : <>Installed{a.path ? <>, <code>{a.path}</code></> : null}. Sign in once if you have not; it opens the browser.</>}
      action={!a.installed
        ? <button className="btn" onClick={() => onRun(a.install, `the ${a.label} installer`)}>Install</button>
        : <button className={`btn small ${a.signedIn === false ? "primary" : ""}`} onClick={() => onRun(a.login, `${a.label} sign-in`)}>{a.signedIn ? "Sign in again" : "Sign in"}</button>} />
  );
}

function Row({ id, state, title, detail, action, progress, small }: { id: string; state: "ok" | "todo" | "busy" | "wait" | "warn"; title: string; detail: React.ReactNode; action?: React.ReactNode; progress?: Task | null; small?: boolean }) {
  return (
    <div className={`setup-row ${small ? "small" : ""} ${state}`} data-row={id}>
      <span className={`setup-state ${state}`} aria-hidden>
        {state === "ok" ? <Check /> : state === "warn" ? <TriangleAlert /> : state === "busy" || state === "wait" ? <LoaderCircle /> : <Circle />}
      </span>
      <div className="setup-text">
        <span className="setup-title">{title}<span className="sr-only">{state === "ok" ? ", ready" : state === "warn" ? ", needs attention" : state === "busy" ? ", working" : state === "wait" ? ", checking" : ""}</span></span>
        <span className="setup-detail">{progress ? progress.message : detail}</span>
        {progress && <span className="setup-bar" role="progressbar" aria-valuemin={0} aria-valuemax={1} aria-valuenow={progress.fraction ?? undefined} aria-label={`${title} progress`}><span className={progress.fraction == null ? "indeterminate" : ""} style={progress.fraction != null ? { transform: `scaleX(${Math.max(0.02, progress.fraction)})` } : undefined} /></span>}
      </div>
      <div className="setup-action">{action}</div>
    </div>
  );
}
