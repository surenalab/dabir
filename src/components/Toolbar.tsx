import { PanelLeft, PanelRight, Play, Share2, Loader2 } from "lucide-react";
import type { Project } from "../lib/backend";
import { Segmented } from "./Segmented";

export type ViewMode = "visual" | "source" | "pdf";

interface Props {
  project: Project | null;
  file: string | null;
  dirty: boolean;
  mode: ViewMode;
  navOpen: boolean;
  inspectorOpen: boolean;
  compiling: boolean;
  onMode: (m: ViewMode) => void;
  onToggleNav: () => void;
  onToggleInspector: () => void;
  onOpen: () => void;
  onCompile: () => void;
}

export function Toolbar({ project, file, dirty, mode, navOpen, inspectorOpen, compiling, onMode, onToggleNav, onToggleInspector, onCompile }: Props) {
  const rel = file && project ? file.replace(project.root + "/", "") : null;
  const canCompile = !!project?.mainTex && !compiling;
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="leading">
        <button className="tb-btn icon" onClick={onToggleNav} aria-pressed={!navOpen} aria-label={navOpen ? "Hide Sidebar" : "Show Sidebar"} title={`${navOpen ? "Hide" : "Show"} Sidebar (⌃⌘S)`}>
          <PanelLeft />
        </button>
      </div>
      <div className="center" data-tauri-drag-region>
        <div className="doc-title" data-tauri-drag-region>
          <span className="name">{project ? project.name : "No paper open"}</span>
          {project && <span className="path">{rel ?? "No file selected"}{dirty && <span className="dirty"> · edited</span>}</span>}
        </div>
      </div>
      <div className="trailing">
        <Segmented
          label="View"
          value={mode}
          onChange={(v) => onMode(v as ViewMode)}
          options={[
            { value: "visual", label: "Visual", title: "Visual (⌘1)" },
            { value: "source", label: "Source", title: "Source (⌘2)" },
            { value: "pdf", label: "PDF", title: "Compiled PDF (⌘3)", disabled: !project },
          ]}
        />
        <button className={`tb-btn ${compiling ? "busy" : ""}`} onClick={onCompile} disabled={!canCompile}
          title={project?.mainTex ? (compiling ? "Compiling…" : "Compile (⌘B)") : "Compile needs a .tex file with \\documentclass"}>
          {compiling ? <Loader2 /> : <Play />} {compiling ? "Compiling" : "Compile"}
        </button>
        <span className="spacer" />
        <button className="tb-btn icon" aria-label="Share" title="Share (coming in phase 3)" disabled>
          <Share2 />
        </button>
        <button className="tb-btn icon" onClick={onToggleInspector} aria-pressed={!inspectorOpen} aria-label={inspectorOpen ? "Hide Inspector" : "Show Inspector"} title={`${inspectorOpen ? "Hide" : "Show"} Inspector (⌥⌘I)`}>
          <PanelRight />
        </button>
      </div>
    </header>
  );
}
