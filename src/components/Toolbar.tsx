import { PanelLeft, PanelRight, Play, Share2, Square, SquareTerminal, CirclePlay, ChevronDown, FileDown } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import type { Project } from "../lib/backend";
import { Segmented } from "./Segmented";
import { chord, RUN_FILE } from "../lib/keys";
import { isMac } from "../lib/backend";
import { relTo } from "../lib/path";
import { WORD_EXPORTS, WORD_MODES, type WordExport, type WordMode } from "../lib/word";

export type { WordExport } from "../lib/word";

export type ViewMode = "visual" | "source" | "pdf" | "split";

/** Export for a Word document: a pull-down menu in the title bar. Arrow keys move, Escape and Tab close. Opened from
 *  the keyboard, the first item takes focus; opened with the pointer, nothing is highlighted until hovered. */
function ExportMenu({ onExport }: { onExport: (k: WordExport) => void }) {
  const [open, setOpen] = useState<false | "pointer" | "keyboard">(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    if (open === "keyboard") menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    else menu.current?.focus();
    const away = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); button.current?.focus(); }
    else if (e.key === "Tab") setOpen(false);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[i < 0 && e.key === "ArrowUp" ? items.length - 1 : (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus(); }
    else if (e.key === "Home" || e.key === "End") { e.preventDefault(); items[e.key === "Home" ? 0 : items.length - 1]?.focus(); }
  };
  const pick = (k: WordExport) => { setOpen(false); button.current?.focus(); onExport(k); };
  return (
    <span className="tb-menu">
      <button ref={button} className="tb-btn" aria-haspopup="menu" aria-expanded={!!open} onClick={(e) => setOpen((v) => (v ? false : e.detail === 0 ? "keyboard" : "pointer"))} title={chord("Export this document (⌥⌘E)")}>
        <FileDown /> Export <ChevronDown className="chev" />
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Export" ref={menu} tabIndex={-1} onKeyDown={onKey}>
          {WORD_EXPORTS.map((x) => (
            <Fragment key={x.kind}>
              {x.kind === "latex" && <div className="menu-sep" role="separator" />}
              <button role="menuitem" tabIndex={-1} onClick={() => pick(x.kind)} onPointerEnter={(e) => e.currentTarget.focus()}>
                <span className="label">{x.menu}</span><span className="hint">{x.hint}</span>
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </span>
  );
}

interface Props {
  project: Project | null;
  file: string | null;
  dirty: boolean;
  saveLabel?: string | null;
  mode: ViewMode;
  navOpen: boolean;
  inspectorOpen: boolean;
  compiling: boolean;
  onMode: (m: ViewMode) => void;
  onToggleNav: () => void;
  onToggleInspector: () => void;
  onOpen: () => void;
  onCompile: () => void;
  onCancelCompile: () => void;
  onShare: () => void;
  live: boolean;
  peers: { clientId: number; name: string; color: string; file?: string; me: boolean; typing?: boolean }[];
  following: number | null;
  onJumpPeer: (id: number) => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  /** The command that runs the open file, when Dabir has a recipe for it; null hides the Run button. */
  run: { label: string; command: string } | null;
  onRun: () => void;
  /** Set when the open file is a Word document: its editing mode and Export take the place of the view switch and Compile. */
  word?: { mode: WordMode; onMode: (m: WordMode) => void; onExport: (k: WordExport) => void } | null;
}

export function Toolbar({ project, file, dirty, saveLabel, mode, navOpen, inspectorOpen, compiling, onMode, onToggleNav, onToggleInspector, onCompile, onCancelCompile, onShare, live, peers, following, onJumpPeer, terminalOpen, onToggleTerminal, run, onRun, word }: Props) {
  const rel = file && project ? relTo(project.root, file) : null;
  // A Word paper has nothing to compile, even when a .tex file is open in it.
  const canCompile = /\.(tex|typ)$/i.test(project?.mainTex ?? "") && !compiling;
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="leading">
        <button className="tb-btn icon" onClick={onToggleNav} aria-pressed={!navOpen} aria-label={navOpen ? "Hide Sidebar" : "Show Sidebar"} title={chord(`${navOpen ? "Hide" : "Show"} Sidebar (${isMac ? "⌃⌘S" : "⌥⌘S"})`)}>
          <PanelLeft />
        </button>
      </div>
      <div className="center" data-tauri-drag-region>
        <div className="doc-title" data-tauri-drag-region>
          <span className="name">{project ? project.name : "No paper open"}</span>
          {project && <span className="path">{rel ?? "No file selected"}{saveLabel ? <span className="dirty"> · {saveLabel}</span> : dirty ? <span className="dirty"> · edited</span> : null}</span>}
        </div>
      </div>
      <div className="trailing">
        {word ? (
          <>
            <Segmented label="Editing mode" value={word.mode} onChange={(v) => word.onMode(v as WordMode)} options={WORD_MODES.map((m) => ({ ...m, title: chord(m.title) }))} />
            <ExportMenu onExport={word.onExport} />
          </>
        ) : (
          <>
          <Segmented
            label="View"
            value={mode}
            onChange={(v) => onMode(v as ViewMode)}
            options={[
              { value: "visual", label: "Visual", title: chord("Visual (⌘1)") },
              { value: "source", label: "Source", title: chord("Source (⌘2)") },
              { value: "pdf", label: "PDF", title: chord("Compiled PDF (⌘3)"), disabled: !project },
              { value: "split", label: "Split", title: chord("Source next to the PDF (⌘4)"), disabled: !project },
            ]}
          />
          {compiling ? (
            <button className="tb-btn" onClick={onCancelCompile} title="Stop the running compile"><Square /> Stop</button>
          ) : (
            <button className="tb-btn" onClick={onCompile} disabled={!canCompile} title={canCompile || compiling ? chord("Compile (⌘B)") : "Compile needs a .tex file with \\documentclass"}><Play /> Compile</button>
          )}
          </>
        )}
        {run && <button className="tb-btn" onClick={onRun} title={chord(`${run.label} in the terminal (${RUN_FILE})\n${run.command}`)}><CirclePlay /> Run</button>}
        <span className="spacer" />
        <button className="tb-btn icon" onClick={onToggleTerminal} aria-pressed={terminalOpen} aria-label={terminalOpen ? "Hide Terminal" : "Show Terminal"} title={chord(`${terminalOpen ? "Hide" : "Show"} Terminal (⌃\`)`)} disabled={!project}>
          <SquareTerminal />
        </button>
        {live && peers.some((p) => !p.me) && (
          <span className="tb-peers" aria-label="Coauthors in this session">
            {peers.filter((p) => !p.me).slice(0, 4).map((p) => (
              <button
                key={p.clientId}
                type="button"
                className={`tb-peer${p.typing ? " typing" : ""}${following === p.clientId ? " following" : ""}`}
                style={{ background: p.color, "--peer-color": p.color } as CSSProperties}
                title={`${p.name}${p.file ? ` · ${p.file}` : ""}${p.typing ? " · typing" : ""}. Click to go to their caret.`}
                aria-label={`Go to ${p.name}${p.typing ? ", typing" : ""}`}
                onClick={() => onJumpPeer(p.clientId)}
              >{p.name.slice(0, 1).toUpperCase()}</button>
            ))}
          </span>
        )}
        <button className={`tb-btn icon ${live ? "live" : ""}`} aria-label="Share" title={live ? "Live session running. Share…" : "Share: live session or Overleaf"} onClick={onShare} disabled={!project} aria-pressed={live}>
          <Share2 />
        </button>
        <button className="tb-btn icon" onClick={onToggleInspector} aria-pressed={!inspectorOpen} aria-label={inspectorOpen ? "Hide Inspector" : "Show Inspector"} title={chord(`${inspectorOpen ? "Hide" : "Show"} Inspector (⌥⌘I)`)}>
          <PanelRight />
        </button>
      </div>
    </header>
  );
}
