import { PanelLeft, PanelRight, Play, Share2, Square, SquareTerminal, CirclePlay } from "lucide-react";
import type { Project } from "../lib/backend";
import { Segmented } from "./Segmented";
import { chord, RUN_FILE } from "../lib/keys";
import { isMac } from "../lib/backend";
import { relTo } from "../lib/path";

export type ViewMode = "visual" | "source" | "pdf" | "split";

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
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  /** The command that runs the open file, when Dabir has a recipe for it; null hides the Run button. */
  run: { label: string; command: string } | null;
  onRun: () => void;
}

export function Toolbar({ project, file, dirty, saveLabel, mode, navOpen, inspectorOpen, compiling, onMode, onToggleNav, onToggleInspector, onCompile, onCancelCompile, onShare, live, terminalOpen, onToggleTerminal, run, onRun }: Props) {
  const rel = file && project ? relTo(project.root, file) : null;
  const canCompile = !!project?.mainTex && !compiling;
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
          <button className="tb-btn" onClick={onCompile} disabled={!canCompile} title={project?.mainTex ? chord("Compile (⌘B)") : "Compile needs a .tex file with \\documentclass"}><Play /> Compile</button>
        )}
        {run && <button className="tb-btn" onClick={onRun} title={chord(`${run.label} in the terminal (${RUN_FILE})\n${run.command}`)}><CirclePlay /> Run</button>}
        <span className="spacer" />
        <button className="tb-btn icon" onClick={onToggleTerminal} aria-pressed={terminalOpen} aria-label={terminalOpen ? "Hide Terminal" : "Show Terminal"} title={chord(`${terminalOpen ? "Hide" : "Show"} Terminal (⌃\`)`)} disabled={!project}>
          <SquareTerminal />
        </button>
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
