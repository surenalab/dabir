// A shell in the paper's folder, below the editor. The same PATH the agents get, so a command that
// works for them works here; output is the terminal's own, not a transcript.

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { X, Plus } from "lucide-react";
import { termOpen, termWrite, termResize, termClose, onTerminalData, onTerminalExit, type Remote } from "../lib/backend";
import { Segmented } from "./Segmented";

interface Props {
  cwd: string;
  /** The host the paper's code runs on, from dabir.toml [remote]; offers a shell there beside the local one. */
  remote?: Remote | null;
  onClose: () => void;
  /** Bumps when the pane should take keyboard focus (opened from the menu or shortcut). */
  focusStamp: number;
}

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

export function TerminalPane({ cwd, remote, onClose, focusStamp }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const id = useRef<number | null>(null);
  const [gone, setGone] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [where, setWhere] = useState<"local" | "remote">("local");
  const onHost = where === "remote" && remote ? remote : null;

  useEffect(() => {
    const el = host.current; if (!el) return;
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "ui-monospace, Menlo, monospace";
    const x = new XTerm({ fontFamily: mono, fontSize: 12.5, lineHeight: 1.3, cursorBlink: true, cursorStyle: "bar", scrollback: 5000, allowProposedApi: true, theme: palette(), macOptionIsMeta: true });
    const f = new FitAddon();
    x.loadAddon(f);
    x.open(el);
    f.fit();
    term.current = x; fit.current = f;
    setGone(false);
    let alive = true;
    let opened: number | null = null;
    termOpen(cwd, x.cols, x.rows, onHost).then((got) => {
      if (!alive) { if (got != null) termClose(got); return; }
      opened = got; id.current = got;
      if (got == null) x.writeln("\x1b[2mThe terminal runs in the app; the browser preview has no shell.\x1b[0m");
    });
    const offData = onTerminalData((e) => { if (e.id === id.current) x.write(e.data); });
    const offExit = onTerminalExit((e) => { if (e.id === id.current) { setGone(true); x.writeln("\r\n\x1b[2m[shell exited]\x1b[0m"); } });
    const onInput = x.onData((d) => { if (id.current != null) termWrite(id.current, d); });
    const ro = new ResizeObserver(() => {
      if (!el.isConnected) return;
      try { f.fit(); } catch { /* not laid out yet */ }
      if (id.current != null) termResize(id.current, x.cols, x.rows);
    });
    ro.observe(el);
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const recolour = () => { x.options.theme = palette(); };
    scheme.addEventListener("change", recolour);
    return () => {
      alive = false;
      scheme.removeEventListener("change", recolour);
      ro.disconnect(); onInput.dispose(); offData(); offExit();
      const closing = id.current ?? opened; if (closing != null) termClose(closing);
      id.current = null;
      x.dispose(); term.current = null; fit.current = null;
    };
  }, [cwd, generation, onHost]);

  useEffect(() => { term.current?.focus(); }, [focusStamp]);

  const folder = cwd.split("/").filter(Boolean).pop() ?? cwd;
  return (
    <section className="terminal" aria-label="Terminal">
      <header>
        <span className="title">Terminal <span className="where" title={onHost ? `${onHost.host}:${onHost.dir}` : cwd}>{onHost ? `${onHost.host}:${onHost.dir}` : folder}</span></span>
        <span className="grow" />
        {remote && <Segmented label="Where the shell runs" value={where} onChange={(v) => setWhere(v as "local" | "remote")} options={[{ value: "local", label: "This Mac", title: cwd }, { value: "remote", label: remote.host, title: `ssh ${remote.host}, in ${remote.dir}` }]} />}
        {gone && <button className="btn" onClick={() => setGeneration((g) => g + 1)} title="Start a new shell"><Plus aria-hidden /> New shell</button>}
        <button className="btn icon" onClick={onClose} title="Hide terminal (⌃`)" aria-label="Hide terminal"><X aria-hidden /></button>
      </header>
      <div className="term-host" ref={host} onMouseDown={() => term.current?.focus()} />
    </section>
  );
}
