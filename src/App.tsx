import { useCallback, useEffect, useRef, useState } from "react";
import { Toolbar, type ViewMode } from "./components/Toolbar";
import { Navigator } from "./components/Navigator";
import { Document } from "./components/Document";
import { Inspector } from "./components/Inspector";
import { ShortcutSheet } from "./components/ShortcutSheet";
import {
  compile as runCompile, native, onMenu, onWindowFocus, openProject, pickFolder, readText,
  setWindowTitle, writeText, type CompileResult, type Project,
} from "./lib/backend";
import type { OutlineItem } from "./lib/latex";

export type CompileState =
  | { status: "idle" }
  | { status: "running"; startedAt: number }
  | { status: "done"; result: CompileResult; at: number };

const NAV_W = 232, INSP_W = 380;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<ViewMode>("visual");
  const [navOpen, setNavOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [navW, setNavW] = useState(NAV_W);
  const [inspW, setInspW] = useState(INSP_W);
  const [dragging, setDragging] = useState<"nav" | "inspector" | null>(null);
  const [animating, setAnimating] = useState(false);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [jumpLine, setJumpLine] = useState<number | null>(null);
  const [compileState, setCompileState] = useState<CompileState>({ status: "idle" });
  const [showLog, setShowLog] = useState(false);
  const [focused, setFocused] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [askFocus, setAskFocus] = useState(0);
  const [findRequest, setFindRequest] = useState(0);
  const autoCollapsed = useRef(false);
  const sourceRef = useRef<string | null>(null);
  sourceRef.current = source;

  const selectFile = useCallback(async (path: string) => {
    try {
      const text = await readText(path);
      setFile(path); setSource(text); setDirty(false); setJumpLine(null);
      if (mode === "pdf") setMode("visual");
    } catch (e) { setError(String(e)); }
  }, [mode]);

  const open = useCallback(async () => {
    try {
      const folder = await pickFolder();
      if (!folder) return;
      const p = await openProject(folder);
      setProject(p); setCompileState({ status: "idle" }); setError(null);
      setWindowTitle(p.name);
      if (p.mainTex) await selectFile(p.mainTex); else { setFile(null); setSource(null); }
    } catch (e) { setError(String(e)); }
  }, [selectFile]);

  const save = useCallback(async () => {
    if (!file || sourceRef.current == null) return;
    try { await writeText(file, sourceRef.current); setDirty(false); }
    catch (e) { setError(String(e)); }
  }, [file]);

  const compile = useCallback(async () => {
    if (!project?.mainTex || compileState.status === "running") return;
    if (dirty) await save();
    setCompileState({ status: "running", startedAt: Date.now() });
    try {
      const result = await runCompile(project.mainTex);
      setCompileState({ status: "done", result, at: Date.now() });
      if (result.ok && result.pdf) setMode("pdf");
    } catch (e) {
      setCompileState({ status: "done", at: Date.now(), result: { ok: false, pdf: null, log: String(e), engine: "", millis: 0, diagnostics: [{ severity: "error", file: null, line: null, message: String(e) }] } });
    }
  }, [project, dirty, save, compileState.status]);

  const toggleNav = useCallback(() => { setAnimating(true); setNavOpen((v) => !v); }, []);
  const toggleInspector = useCallback(() => { setAnimating(true); autoCollapsed.current = false; setInspectorOpen((v) => !v); }, []);

  // One command router for the native menu bar and the browser keyboard fallback.
  const command = useCallback((id: string) => {
    switch (id) {
      case "open": open(); break;
      case "save": save(); break;
      case "compile": compile(); break;
      case "show-log": setShowLog((v) => !v); break;
      case "view-visual": setMode("visual"); break;
      case "view-source": setMode("source"); break;
      case "view-pdf": setMode("pdf"); break;
      case "toggle-sidebar": toggleNav(); break;
      case "toggle-inspector": toggleInspector(); break;
      case "ask-agent": if (!inspectorOpen) toggleInspector(); setAskFocus((n) => n + 1); break;
      case "find": setMode("source"); setFindRequest((n) => n + 1); break;
      case "shortcuts": setSheet((v) => !v); break;
    }
  }, [open, save, compile, toggleNav, toggleInspector, inspectorOpen]);

  useEffect(() => onMenu(command), [command]);
  useEffect(() => onWindowFocus(setFocused), []);

  // Keyboard fallback for the browser preview only; the native app owns accelerators through its menu.
  useEffect(() => {
    if (native) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const k = e.key.toLowerCase();
      const map: Record<string, string> = {
        o: "open", s: "save", b: "compile", "1": "view-visual", "2": "view-source", "3": "view-pdf",
        k: "ask-agent", f: "find", "/": "shortcuts",
      };
      if (e.ctrlKey && k === "s") { e.preventDefault(); command("toggle-sidebar"); return; }
      if (e.altKey && (k === "i" || e.code === "KeyI")) { e.preventDefault(); command("toggle-inspector"); return; }
      if (e.shiftKey && k === "l") { e.preventDefault(); command("show-log"); return; }
      if (!e.altKey && !e.ctrlKey && !e.shiftKey && map[k]) { e.preventDefault(); command(map[k]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [command]);

  // Auto-hide the inspector in narrow windows, and bring it back when there is room.
  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth;
      if (w < 1100 && inspectorOpen) { autoCollapsed.current = true; setInspectorOpen(false); }
      else if (w >= 1100 && autoCollapsed.current) { autoCollapsed.current = false; setInspectorOpen(true); }
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [inspectorOpen]);

  useEffect(() => {
    if (!animating) return;
    const t = setTimeout(() => setAnimating(false), 260);
    return () => clearTimeout(t);
  }, [animating]);

  // Divider dragging
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      if (dragging === "nav") setNavW(clamp(e.clientX, 180, 340));
      else setInspW(clamp(window.innerWidth - e.clientX, 280, 480));
    };
    const up = () => setDragging(null);
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [dragging]);

  const onSourceChange = useCallback((text: string) => { setSource(text); setDirty(true); }, []);
  const jumpTo = useCallback((line: number, inSource?: boolean) => { if (inSource) setMode("source"); setJumpLine(line); }, []);

  const cls = [
    "app", native ? "native" : "", navOpen ? "" : "nav-hidden", inspectorOpen ? "" : "inspector-hidden",
    animating ? "animating" : "", focused ? "" : "inactive",
  ].join(" ").trim();

  return (
    <div className={cls} style={{ "--nav-w": `${navW}px`, "--inspector-w": `${inspW}px` } as React.CSSProperties}>
      <Toolbar
        project={project} file={file} dirty={dirty} mode={mode}
        navOpen={navOpen} inspectorOpen={inspectorOpen}
        compiling={compileState.status === "running"}
        onMode={setMode} onToggleNav={toggleNav} onToggleInspector={toggleInspector}
        onOpen={open} onCompile={compile}
      />
      <Navigator project={project} current={file} outline={outline} onSelect={selectFile} onJump={(l) => jumpTo(l)} />
      <Document
        project={project} file={file} source={source} mode={mode} jumpLine={jumpLine}
        compileState={compileState} showLog={showLog} onToggleLog={() => setShowLog((v) => !v)}
        findRequest={findRequest} error={error} onDismissError={() => setError(null)}
        onOpen={open} onOutline={setOutline} onSourceChange={onSourceChange} onSave={save}
        onSelectFile={selectFile} onJump={jumpTo} onCompile={compile}
      />
      <Inspector project={project} askFocus={askFocus} />
      <div className={`divider nav ${dragging === "nav" ? "dragging" : ""}`} onPointerDown={() => setDragging("nav")} role="separator" aria-orientation="vertical" aria-label="Resize sidebar" />
      <div className={`divider inspector ${dragging === "inspector" ? "dragging" : ""}`} onPointerDown={() => setDragging("inspector")} role="separator" aria-orientation="vertical" aria-label="Resize inspector" />
      {sheet && <ShortcutSheet onClose={() => setSheet(false)} />}
    </div>
  );
}
