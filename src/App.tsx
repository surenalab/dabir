import { useCallback, useEffect, useRef, useState } from "react";
import { Toolbar, type ViewMode } from "./components/Toolbar";
import { Navigator } from "./components/Navigator";
import { Document } from "./components/Document";
import { Inspector } from "./components/Inspector";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { CloneSheet } from "./components/CloneSheet";
import {
  compile as runCompile, compileCancel, gitClone, gitCommit, gitInit, gitStatus, importOverleaf, native, onMenu, onWindowFocus,
  openProject, pickFolder, readText, setWindowTitle, synctexForward, synctexInverse, writeText,
  type CompileResult, type GitStatus, type PdfPos, type Project,
} from "./lib/backend";
import { parseBib, type BibEntry, type OutlineItem } from "./lib/latex";

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
  const [jumpStamp, setJumpStamp] = useState(0);
  const [cursorLine, setCursorLine] = useState(1);
  const [compileState, setCompileState] = useState<CompileState>({ status: "idle" });
  const [pdfTarget, setPdfTarget] = useState<(PdfPos & { stamp: number }) | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [focused, setFocused] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"shortcuts" | "clone" | null>(null);
  const [askFocus, setAskFocus] = useState(0);
  const [commitFocus, setCommitFocus] = useState(0);
  const [findRequest, setFindRequest] = useState(0);
  const [bib, setBib] = useState<Record<string, BibEntry>>({});
  const [git, setGit] = useState<GitStatus | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [compileOnSave, setCompileOnSave] = useState<boolean>(() => { try { return localStorage.getItem("dabir.compileOnSave") === "1"; } catch { return false; } });
  const compileRef = useRef<() => void>(() => {});
  const autoCollapsed = useRef(false);
  const sourceRef = useRef<string | null>(null);
  sourceRef.current = source;

  const refreshGit = useCallback(async (p: Project | null = project) => {
    if (!p) { setGit(null); return; }
    try { setGit(await gitStatus(p.root)); } catch { setGit(null); }
  }, [project]);

  const selectFile = useCallback(async (path: string) => {
    try {
      const text = await readText(path);
      setFile(path); setSource(text); setDirty(false); setJumpLine(null);
      if (mode === "pdf") setMode("visual");
    } catch (e) { setError(String(e)); }
  }, [mode]);

  const loadBib = useCallback(async (p: Project) => {
    const bibs: string[] = [];
    const walk = (es: Project["tree"]) => es.forEach((e) => (e.kind === "dir" ? walk(e.children) : e.kind === "bib" && bibs.push(e.path)));
    walk(p.tree);
    const merged: Record<string, BibEntry> = {};
    for (const b of bibs) { try { Object.assign(merged, parseBib(await readText(b))); } catch { /* unreadable bib is not fatal */ } }
    setBib(merged);
  }, []);

  const openFolder = useCallback(async (folder: string) => {
    const p = await openProject(folder);
    setProject(p); setCompileState({ status: "idle" }); setError(null); setPdfTarget(null);
    setWindowTitle(p.name);
    loadBib(p);
    refreshGit(p);
    if (p.mainTex) await selectFile(p.mainTex); else { setFile(null); setSource(null); }
  }, [selectFile, loadBib, refreshGit]);

  const reloadProject = useCallback(async () => {
    if (!project) return;
    try { const p = await openProject(project.root); setProject(p); loadBib(p); refreshGit(p); } catch (e) { setError(String(e)); }
  }, [project, loadBib, refreshGit]);

  const open = useCallback(async () => {
    try { const folder = await pickFolder(); if (folder) await openFolder(folder); } catch (e) { setError(String(e)); }
  }, [openFolder]);

  const importFromOverleaf = useCallback(async () => {
    try { const folder = await importOverleaf(); if (folder) await openFolder(folder); } catch (e) { setError(String(e)); }
  }, [openFolder]);

  const cloneRepo = useCallback(async (url: string) => {
    const parent = await pickFolder("Choose where to clone");
    if (!parent) return;
    const name = url.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() || "paper";
    const dest = await gitClone(url, `${parent}/${name}`);
    await openFolder(dest);
  }, [openFolder]);

  const save = useCallback(async () => {
    if (!file || sourceRef.current == null) return;
    try { await writeText(file, sourceRef.current); setDirty(false); refreshGit(); if (compileOnSave) compileRef.current(); }
    catch (e) { setError(String(e)); }
  }, [file, refreshGit, compileOnSave]);

  const compile = useCallback(async () => {
    if (!project?.mainTex || compileState.status === "running") return;
    if (dirty && sourceRef.current != null && file) { try { await writeText(file, sourceRef.current); setDirty(false); } catch (e) { setError(String(e)); return; } }
    setCompileState({ status: "running", startedAt: Date.now() });
    try {
      const result = await runCompile(project.mainTex);
      setCompileState({ status: "done", result, at: Date.now() });
      if (result.ok && result.pdf) setMode("pdf");
    } catch (e) {
      setCompileState({ status: "done", at: Date.now(), result: { ok: false, pdf: null, log: String(e), engine: "", millis: 0, diagnostics: [{ severity: "error", file: null, line: null, message: String(e) }] } });
    }
  }, [project, dirty, file, compileState.status]);
  compileRef.current = compile;
  const toggleCompileOnSave = useCallback(() => { setCompileOnSave((v) => { try { localStorage.setItem("dabir.compileOnSave", v ? "0" : "1"); } catch { /* private mode */ } return !v; }); }, []);

  const showInPdf = useCallback(async () => {
    if (!project?.mainTex || !file) return;
    if (compileState.status !== "done" || !compileState.result.pdf) { setNote("Compile first (⌘B), then Show Line in PDF."); return; }
    try {
      const pos = await synctexForward(project.mainTex, file, cursorLine);
      if (!pos) { setNote(`No PDF position recorded for line ${cursorLine}.`); return; }
      setMode("pdf"); setPdfTarget({ ...pos, stamp: Date.now() });
    } catch (e) { setNote(String(e)); }
  }, [project, file, cursorLine, compileState]);

  const onPdfClick = useCallback(async (page: number, x: number, y: number) => {
    if (!project?.mainTex) return;
    try {
      const pos = await synctexInverse(project.mainTex, page, x, y);
      if (!pos) return;
      const target = pos.file.startsWith("/") ? pos.file : `${project.root}/${pos.file.replace(/^\.\//, "")}`;
      if (target !== file) await selectFile(target);
      setMode("source"); setJumpLine(pos.line); setJumpStamp(Date.now());
    } catch (e) { setNote(String(e)); }
  }, [project, file, selectFile]);

  const initGit = useCallback(async () => {
    if (!project) return;
    try { await gitInit(project.root); await reloadProject(); setNote("Initialised an empty Git repository. Make a first commit so agents can branch from it."); }
    catch (e) { setError(String(e)); }
  }, [project, reloadProject]);

  const commitAll = useCallback(async (message: string) => {
    if (!project) return;
    setGitBusy(true);
    try { if (dirty) await save(); const id = await gitCommit(project.root, message); setNote(`Committed ${id}.`); await refreshGit(); }
    catch (e) { setError(String(e)); } finally { setGitBusy(false); }
  }, [project, dirty, save, refreshGit]);

  const toggleNav = useCallback(() => { setAnimating(true); setNavOpen((v) => !v); }, []);
  const toggleInspector = useCallback(() => { setAnimating(true); autoCollapsed.current = false; setInspectorOpen((v) => !v); }, []);

  // One command router for the native menu bar and the browser keyboard fallback.
  const command = useCallback((id: string) => {
    switch (id) {
      case "open": open(); break;
      case "import-overleaf": importFromOverleaf(); break;
      case "clone": setSheet("clone"); break;
      case "save": save(); break;
      case "compile": compile(); break;
      case "show-log": setShowLog((v) => !v); break;
      case "sync-pdf": showInPdf(); break;
      case "commit": if (!navOpen) toggleNav(); setCommitFocus((n) => n + 1); break;
      case "view-visual": setMode("visual"); break;
      case "view-source": setMode("source"); break;
      case "view-pdf": setMode("pdf"); break;
      case "toggle-sidebar": toggleNav(); break;
      case "toggle-inspector": toggleInspector(); break;
      case "ask-agent": if (!inspectorOpen) toggleInspector(); setAskFocus((n) => n + 1); break;
      case "find": setMode("source"); setFindRequest((n) => n + 1); break;
      case "shortcuts": setSheet((v) => (v === "shortcuts" ? null : "shortcuts")); break;
    }
  }, [open, importFromOverleaf, save, compile, showInPdf, toggleNav, toggleInspector, inspectorOpen, navOpen]);

  useEffect(() => onMenu(command), [command]);
  useEffect(() => onWindowFocus((f) => { setFocused(f); if (f) refreshGit(); }), [refreshGit]);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 6000); return () => clearTimeout(t); }, [note]);

  // Keyboard fallback for the browser preview only; the native app owns accelerators through its menu.
  useEffect(() => {
    if (native) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const k = e.key.toLowerCase();
      const map: Record<string, string> = { o: "open", s: "save", b: "compile", "1": "view-visual", "2": "view-source", "3": "view-pdf", k: "ask-agent", f: "find", "/": "shortcuts" };
      if (e.ctrlKey && k === "s") { e.preventDefault(); command("toggle-sidebar"); return; }
      if (e.altKey && (k === "i" || e.code === "KeyI")) { e.preventDefault(); command("toggle-inspector"); return; }
      if (e.shiftKey && k === "l") { e.preventDefault(); command("show-log"); return; }
      if (e.shiftKey && k === "j") { e.preventDefault(); command("sync-pdf"); return; }
      if (e.shiftKey && k === "c") { e.preventDefault(); command("commit"); return; }
      if (e.shiftKey && k === "o") { e.preventDefault(); command("clone"); return; }
      if (!e.altKey && !e.ctrlKey && !e.shiftKey && map[k]) { e.preventDefault(); command(map[k]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [command]);

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

  useEffect(() => { if (!animating) return; const t = setTimeout(() => setAnimating(false), 260); return () => clearTimeout(t); }, [animating]);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => { if (dragging === "nav") setNavW(clamp(e.clientX, 180, 340)); else setInspW(clamp(window.innerWidth - e.clientX, 280, 480)); };
    const up = () => setDragging(null);
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [dragging]);

  const onSourceChange = useCallback((text: string) => { setSource(text); setDirty(true); }, []);
  const jumpTo = useCallback((line: number, inSource?: boolean) => { if (inSource) setMode("source"); setJumpLine(line); setJumpStamp(Date.now()); }, []);
  const onChanged = useCallback(() => { refreshGit(); reloadProject(); if (file) readText(file).then((t) => { if (!dirty) setSource(t); }).catch(() => {}); }, [refreshGit, reloadProject, file, dirty]);

  const cls = ["app", native ? "native" : "", navOpen ? "" : "nav-hidden", inspectorOpen ? "" : "inspector-hidden", animating ? "animating" : "", focused ? "" : "inactive"].join(" ").trim();

  return (
    <div className={cls} style={{ "--nav-w": `${navW}px`, "--inspector-w": `${inspW}px` } as React.CSSProperties}>
      <Toolbar project={project} file={file} dirty={dirty} mode={mode} navOpen={navOpen} inspectorOpen={inspectorOpen}
        compiling={compileState.status === "running"} onMode={setMode} onToggleNav={toggleNav} onToggleInspector={toggleInspector} onOpen={open} onCompile={compile} onCancelCompile={() => compileCancel()} />
      <Navigator project={project} current={file} outline={outline} git={git} commitFocus={commitFocus} busy={gitBusy}
        onSelect={selectFile} onJump={(l) => jumpTo(l)} onInitGit={initGit} onCommit={commitAll} />
      <Document project={project} file={file} source={source} bib={bib} mode={mode} jumpLine={jumpLine} jumpStamp={jumpStamp}
        compileState={compileState} showLog={showLog} onToggleLog={() => setShowLog((v) => !v)} findRequest={findRequest}
        error={error ?? note} onDismissError={() => { setError(null); setNote(null); }} pdfTarget={pdfTarget}
        onOpen={open} onImport={importFromOverleaf} onClone={() => setSheet("clone")} onOutline={setOutline}
        onSourceChange={onSourceChange} onSave={save} onCursorLine={setCursorLine} onSelectFile={selectFile} onJump={jumpTo} onPdfClick={onPdfClick}
        compileOnSave={compileOnSave} onToggleCompileOnSave={toggleCompileOnSave} />
      <Inspector project={project} askFocus={askFocus} onChanged={onChanged} onOpenFile={selectFile} onNote={setNote} />
      <div className={`divider nav ${dragging === "nav" ? "dragging" : ""}`} onPointerDown={() => setDragging("nav")} role="separator" aria-orientation="vertical" aria-label="Resize sidebar" />
      <div className={`divider inspector ${dragging === "inspector" ? "dragging" : ""}`} onPointerDown={() => setDragging("inspector")} role="separator" aria-orientation="vertical" aria-label="Resize inspector" />
      {sheet === "shortcuts" && <ShortcutSheet onClose={() => setSheet(null)} />}
      {sheet === "clone" && <CloneSheet onClose={() => setSheet(null)} onClone={cloneRepo} />}
    </div>
  );
}
