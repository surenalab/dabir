import { useCallback, useEffect, useState } from "react";
import { Toolbar, type ViewMode } from "./components/Toolbar";
import { Navigator } from "./components/Navigator";
import { Document } from "./components/Document";
import { Inspector } from "./components/Inspector";
import { openProject, pickFolder, readText, type Project } from "./lib/backend";
import type { OutlineItem } from "./lib/latex";

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("visual");
  const [navOpen, setNavOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [jumpLine, setJumpLine] = useState<number | null>(null);

  const selectFile = useCallback(async (path: string) => {
    setFile(path);
    setSource(await readText(path));
    setJumpLine(null);
  }, []);

  const open = useCallback(async () => {
    const folder = await pickFolder();
    if (!folder) return;
    const p = await openProject(folder);
    setProject(p);
    if (p.mainTex) await selectFile(p.mainTex);
    else { setFile(null); setSource(null); }
  }, [selectFile]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "o") { e.preventDefault(); open(); }
      if (e.key === "1") { e.preventDefault(); setNavOpen((v) => !v); }
      if (e.key === "0" && e.altKey) { e.preventDefault(); setInspectorOpen((v) => !v); }
      if (e.key === "e" && e.shiftKey) { e.preventDefault(); setMode((m) => (m === "visual" ? "source" : "visual")); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const cls = ["app", navOpen ? "" : "nav-hidden", inspectorOpen ? "" : "inspector-hidden"].join(" ").trim();

  return (
    <div className={cls}>
      <Toolbar
        project={project} file={file} mode={mode}
        navOpen={navOpen} inspectorOpen={inspectorOpen}
        onMode={setMode} onToggleNav={() => setNavOpen((v) => !v)}
        onToggleInspector={() => setInspectorOpen((v) => !v)} onOpen={open}
      />
      <Navigator project={project} current={file} outline={outline} onSelect={selectFile} onJump={setJumpLine} />
      <Document source={source} mode={mode} jumpLine={jumpLine} onOpen={open} onOutline={setOutline} />
      <Inspector project={project} />
    </div>
  );
}
