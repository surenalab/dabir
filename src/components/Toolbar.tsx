import { PanelLeft, PanelRight, Play, Share2, FolderOpen } from "lucide-react";
import type { Project } from "../lib/backend";

export type ViewMode = "visual" | "source";

interface Props {
  project: Project | null;
  file: string | null;
  mode: ViewMode;
  navOpen: boolean;
  inspectorOpen: boolean;
  onMode: (m: ViewMode) => void;
  onToggleNav: () => void;
  onToggleInspector: () => void;
  onOpen: () => void;
}

export function Toolbar({ project, file, mode, navOpen, inspectorOpen, onMode, onToggleNav, onToggleInspector, onOpen }: Props) {
  const rel = file && project ? file.replace(project.root + "/", "") : null;
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="leading">
        <button className={`tb-btn icon ${navOpen ? "" : "active"}`} onClick={onToggleNav} aria-label="Toggle navigator" title="Toggle navigator (⌘1)">
          <PanelLeft />
        </button>
        <button className="tb-btn icon" onClick={onOpen} aria-label="Open paper" title="Open a paper (⌘O)">
          <FolderOpen />
        </button>
      </div>
      <div className="center" data-tauri-drag-region>
        {project ? (
          <div className="doc-title" data-tauri-drag-region>
            <span className="name">{project.name}</span>
            <span className="path">{rel ?? "No file open"}</span>
          </div>
        ) : (
          <div className="doc-title"><span className="name">Dabir</span></div>
        )}
      </div>
      <div className="trailing">
        <div className="seg" role="group" aria-label="View">
          <button aria-pressed={mode === "visual"} onClick={() => onMode("visual")}>Visual</button>
          <button aria-pressed={mode === "source"} onClick={() => onMode("source")}>Source</button>
        </div>
        <button className="tb-btn primary" disabled={!project?.mainTex} title="Compile with Tectonic (⌘B)">
          <Play /> Compile
        </button>
        <button className="tb-btn icon" aria-label="Share" title="Share">
          <Share2 />
        </button>
        <button className={`tb-btn icon ${inspectorOpen ? "" : "active"}`} onClick={onToggleInspector} aria-label="Toggle inspector" title="Toggle inspector (⌘⌥0)">
          <PanelRight />
        </button>
      </div>
    </header>
  );
}
