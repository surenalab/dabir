// The terminal panel below the editor, the way an IDE keeps one: several shells as tabs, a drag handle to
// set its height, a shell on the paper's remote host beside the local ones. Each shell has the same PATH
// the agents get, so a command that works for them works here; output is the terminal's own, not a transcript.

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { X, Plus, ChevronDown } from "lucide-react";
import { termOpen, termWrite, termResize, termClose, onTerminalData, onTerminalExit, type Remote } from "../lib/backend";
import { describe, logUi } from "../lib/diag";
import { chord } from "../lib/keys";

interface Props {
  cwd: string;
  /** The host the paper's code runs on, from dabir.toml [remote]; offers a shell there beside the local one. */
  remote?: Remote | null;
  onClose: () => void;
  /** Bumps when the pane should take keyboard focus (opened from the menu or shortcut). */
  focusStamp: number;
  /** A command to type into the active local shell, from Run File; the stamp makes repeats distinct. */
  run?: { command: string; stamp: number } | null;
}

interface ShellTab { key: number; remote: Remote | null; gone: boolean }

const HEIGHT_KEY = "dabir.terminalHeight";
const MIN_H = 120;

/** Read the app's tokens so the terminal is set in the paper's colours, in light and dark. */
function palette() {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  return {
    background: v("--paper", "#fbfaf7"),
    foreground: v("--ink", "#1d1f24"),
    cursor: v("--accent", "#a8322d"),
    cursorAccent: v("--paper", "#fbfaf7"),
    selectionBackground: v("--selection", "rgba(168,50,45,0.18)"),
    selectionInactiveBackground: v("--selection", "rgba(168,50,45,0.12)"),
    black: dark ? "#3a3b40" : "#1d1f24",
    red: v("--diff-del", "#c8102e"),
    green: v("--ok", "#2f6b3a"),
    yellow: v("--warn", "#8a6414"),
    blue: dark ? "#7aa2f7" : "#2b5aa6",
    magenta: dark ? "#c48ad1" : "#7b3f9e",
    cyan: dark ? "#6fc3c9" : "#1f7a80",
    white: v("--ink-3", "#676a74"),
    brightBlack: v("--ink-4", "#7a7c84"),
    brightRed: v("--accent", "#a8322d"),
    brightGreen: v("--ok", "#2f6b3a"),
    brightYellow: v("--warn", "#8a6414"),
    brightBlue: dark ? "#9ab8ff" : "#3a6fc4",
    brightMagenta: dark ? "#d9a6e6" : "#9856b8",
    brightCyan: dark ? "#8fd6db" : "#2a9aa1",
    brightWhite: v("--ink", "#1d1f24"),
  };
}

function shellName(remote: Remote | null) {
  if (remote) return remote.host;
  const s = (navigator.userAgent.includes("Mac") ? "zsh" : "sh");
  return s;
}

export function TerminalPane({ cwd, remote, onClose, focusStamp, run }: Props) {
  const next = useRef(2);
  const [shells, setShells] = useState<ShellTab[]>([{ key: 1, remote: null, gone: false }]);
  const [active, setActive] = useState(1);
  const [height, setHeight] = useState(() => { const n = Number(localStorage.getItem(HEIGHT_KEY)); return n >= MIN_H ? n : 240; });
  const [dragging, setDragging] = useState(false);
  const [hostMenu, setHostMenu] = useState(false);
  const focusRef = useRef<Map<number, () => void>>(new Map());
  const typeRef = useRef<Map<number, (text: string) => void>>(new Map());
  const ranStamp = useRef(0);
  const [pendingRun, setPendingRun] = useState<{ key: number; command: string } | null>(null);

  const add = useCallback((on: Remote | null) => {
    const key = next.current++;
    setShells((s) => [...s, { key, remote: on, gone: false }]);
    setActive(key);
    setHostMenu(false);
  }, []);
  const remove = useCallback((key: number) => {
    const i = shells.findIndex((t) => t.key === key);
    if (i < 0) return;
    const rest = shells.filter((t) => t.key !== key);
    if (rest.length === 0) { onClose(); return; }
    setShells(rest);
    if (active === key) setActive(rest[Math.max(0, Math.min(i, rest.length - 1))].key);
  }, [shells, active, onClose]);
  const exited = useCallback((key: number) => setShells((s) => s.map((t) => (t.key === key ? { ...t, gone: true } : t))), []);

  // Run File: type the command into a local shell, opening one when every tab is remote or gone.
  useEffect(() => {
    if (!run || run.stamp === ranStamp.current) return;
    ranStamp.current = run.stamp;
    queueMicrotask(() => {
      const current = shells.find((t) => t.key === active);
      const target = current && !current.remote && !current.gone ? current : shells.find((t) => !t.remote && !t.gone);
      if (!target) { setPendingRun({ key: next.current, command: run.command }); add(null); return; }   // the new shell runs it once it has a pty
      setActive(target.key);
      typeRef.current.get(target.key)?.(run.command);
    });
  }, [run]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { focusRef.current.get(active)?.(); }, [focusStamp, active]);

  // Drag the top edge to set the height; the choice is kept for the next time the panel opens.
  const onHandle = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY, startH = height;
    setDragging(true);
    const move = (ev: PointerEvent) => setHeight(Math.max(MIN_H, Math.min(window.innerHeight * 0.8, startH + (startY - ev.clientY))));
    const up = () => { setDragging(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); setHeight((h) => { localStorage.setItem(HEIGHT_KEY, String(Math.round(h))); return h; }); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  const folder = cwd.split("/").filter(Boolean).pop() ?? cwd;
  return (
    <section className={`terminal ${dragging ? "dragging" : ""}`} aria-label="Terminal" style={{ height }}>
      <div className="hdivider" role="separator" aria-orientation="horizontal" aria-label="Resize terminal" onPointerDown={onHandle} />
      <header>
        <div className="shelltabs" role="tablist" aria-label="Shells">
          {shells.map((t, i) => (
            <div key={t.key} role="tab" aria-selected={t.key === active} className={`shelltab ${t.key === active ? "active" : ""} ${t.gone ? "gone" : ""}`}
              onClick={() => setActive(t.key)} onAuxClick={(e) => { if (e.button === 1) remove(t.key); }}
              title={t.remote ? `ssh ${t.remote.host}, in ${t.remote.dir}` : cwd}>
              <span className="name">{shellName(t.remote)}{shells.filter((o) => (o.remote?.host ?? "") === (t.remote?.host ?? "")).length > 1 ? ` ${i + 1}` : ""}{t.gone ? " · exited" : ""}</span>
              <button className="close" aria-label="Close shell" title="Close shell" onClick={(e) => { e.stopPropagation(); remove(t.key); }} tabIndex={-1}><X aria-hidden /></button>
            </div>
          ))}
          <button className="btn icon" onClick={() => add(null)} title="New shell on this Mac" aria-label="New shell"><Plus aria-hidden /></button>
          {remote && (
            <span className="hostpick">
              <button className="btn icon" onClick={() => setHostMenu((v) => !v)} title={`New shell on ${remote.host}`} aria-label="New shell on the remote host" aria-expanded={hostMenu}><ChevronDown aria-hidden /></button>
              {hostMenu && (
                <div className="menu" role="menu">
                  <button role="menuitem" onClick={() => add(null)}>This Mac <span className="hint">{folder}</span></button>
                  <button role="menuitem" onClick={() => add(remote)}>{remote.host} <span className="hint">ssh, in {remote.dir}</span></button>
                </div>
              )}
            </span>
          )}
        </div>
        <span className="grow" />
        <span className="where" title={cwd}>{folder}</span>
        <button className="btn icon" onClick={onClose} title={chord("Hide terminal (⌃`)")} aria-label="Hide terminal"><X aria-hidden /></button>
      </header>
      <div className="shells">
        {shells.map((t) => (
          <ShellView key={t.key} cwd={cwd} remote={t.remote} visible={t.key === active}
            onExit={() => exited(t.key)}
            register={(f) => { if (f) focusRef.current.set(t.key, f); else focusRef.current.delete(t.key); }}
            registerType={(f) => { if (f) typeRef.current.set(t.key, f); else typeRef.current.delete(t.key); }}
            initialCommand={pendingRun?.key === t.key ? pendingRun.command : null} />
        ))}
      </div>
    </section>
  );
}

interface ShellProps {
  cwd: string;
  remote: Remote | null;
  visible: boolean;
  onExit: () => void;
  register: (focus: (() => void) | null) => void;
  registerType: (type: ((text: string) => void) | null) => void;
  /** A command to run as soon as the shell is up (a Run File that had to open a shell first). */
  initialCommand: string | null;
}

/** One shell: an xterm bound to one pty in the app. Stays mounted while its tab is hidden so scrollback survives. */
function ShellView({ cwd, remote, visible, onExit, register, registerType, initialCommand }: ShellProps) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const id = useRef<number | null>(null);
  const [generation, setGeneration] = useState(0);
  const [gone, setGone] = useState(false);
  const exitRef = useRef(onExit);
  useEffect(() => { exitRef.current = onExit; }, [onExit]);
  const queued = useRef<string[]>(initialCommand ? [initialCommand] : []);

  useEffect(() => {
    const el = host.current; if (!el) return;
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "ui-monospace, Menlo, monospace";
    const x = new XTerm({ fontFamily: mono, fontSize: 12.5, lineHeight: 1.3, cursorBlink: true, cursorStyle: "bar", scrollback: 5000, allowProposedApi: true, theme: palette(), macOptionIsMeta: true });
    const f = new FitAddon();
    x.loadAddon(f);
    x.open(el);
    try { f.fit(); } catch { /* not laid out yet */ }
    term.current = x;
    register(() => x.focus());
    setGone(false);
    let alive = true;
    let opened: number | null = null;
    // Typed input, or the Run File command: sent to the pty once it exists, with a return to run it.
    let noShell = false;   // the browser preview: echo what would have been typed
    const type = (text: string) => { if (id.current != null) termWrite(id.current, text + "\r"); else if (noShell) x.writeln(`$ ${text.replace(/\r/g, "\r\n$ ")}`); else queued.current.push(text); };
    registerType(type);
    termOpen(cwd, Math.max(2, x.cols), Math.max(1, x.rows), remote).then((got) => {
      if (!alive) { if (got != null) termClose(got); return; }
      opened = got; id.current = got;
      if (got == null) { noShell = true; x.writeln("\x1b[2mThe terminal runs in the app; the browser preview has no shell.\x1b[0m"); for (const c of queued.current.splice(0)) type(c); return; }
      // Let the shell print its prompt before the command lands, so the transcript reads in order.
      const pending = queued.current.splice(0);
      if (pending.length) setTimeout(() => { for (const c of pending) type(c); }, 250);
    }).catch((e: unknown) => {
      // The shell could not start: say why in the pane instead of leaving it blank, and log it.
      const why = describe(e);
      x.writeln(`\x1b[31mCould not start a shell:\x1b[0m ${why}`);
      x.writeln(`\x1b[2m${remote ? `ssh ${remote.host}` : "login shell"} in ${cwd}, ${x.cols}×${x.rows}\x1b[0m`);
      logUi(`terminal: term_open failed in ${cwd} (${x.cols}x${x.rows}${remote ? `, ssh ${remote.host}` : ""}): ${why}`);
      setGone(true); exitRef.current();
    });
    const offData = onTerminalData((e) => { if (e.id === id.current) x.write(e.data); });
    const offExit = onTerminalExit((e) => { if (e.id === id.current) { setGone(true); exitRef.current(); x.writeln("\r\n\x1b[2m[shell exited]\x1b[0m"); } });
    const onInput = x.onData((d) => { if (id.current != null) termWrite(id.current, d); });
    const ro = new ResizeObserver(() => {
      if (!el.isConnected || el.clientHeight === 0) return;
      try { f.fit(); } catch { /* hidden */ }
      if (id.current != null) termResize(id.current, x.cols, x.rows);
    });
    ro.observe(el);
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const recolour = () => { x.options.theme = palette(); };
    scheme.addEventListener("change", recolour);
    return () => {
      alive = false;
      register(null); registerType(null);
      scheme.removeEventListener("change", recolour);
      ro.disconnect(); onInput.dispose(); offData(); offExit();
      const closing = id.current ?? opened; if (closing != null) termClose(closing);
      id.current = null;
      x.dispose(); term.current = null;
    };
  }, [cwd, generation, remote]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (visible) term.current?.focus(); }, [visible]);

  return (
    <div className="shell" hidden={!visible}>
      <div className="term-host" ref={host} onMouseDown={() => term.current?.focus()} />
      {gone && <button className="btn restart" onClick={() => setGeneration((g) => g + 1)} title="Start a new shell in this tab"><Plus aria-hidden /> New shell</button>}
    </div>
  );
}
