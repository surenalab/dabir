import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toolbar, type ViewMode } from "./components/Toolbar";
import { Navigator } from "./components/Navigator";
import { Document, type DocReview } from "./components/Document";
import { Inspector, type ReviewHandle, type Tab as InspectorTab } from "./components/Inspector";
import { Tour, type TourStep } from "./components/Tour";
import { marksFromPatch } from "./lib/review";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { CloneSheet } from "./components/CloneSheet";
import { ShareSheet, type LiveState } from "./components/ShareSheet";
import { NewPaperSheet } from "./components/NewPaperSheet";
import { ExportSheet } from "./components/ExportSheet";
import { ReferencesSheet } from "./components/ReferencesSheet";
import { useRefSync } from "./lib/refsync";
import { SettingsSheet } from "./components/SettingsSheet";
import type { EditorApi } from "./components/SourceEditor";
import { useSettings, updateSettings, getSettings } from "./lib/settings";
import { checkGrammar, type GrammarMatch } from "./lib/grammar";
import { paperSymbols, paperOutline, flattenFiles, type AssistSources } from "./lib/assist";
import { stopLanguageServers } from "./lib/lsp";
import type { PdfPin, PdfZoom } from "./components/PdfView";
import type { ManualProvider } from "./lib/manual";
import { addComment as yAddComment, connect as yConnect, decodeRange, disconnect as yDisconnect, encodeRange, peers as yPeers, randomRoom, removeComment as yRemoveComment, resolveComment as yResolveComment, setCurrentFile, textFor, whenSynced, type Comment, type Peer, type Session, type Transport, replyComment as yReplyComment, userName, colorFor, markHost, hostPresent, publishProject, republishChanged, awaitSnapshot, sharedTexts, persist, setFileChanges } from "./lib/collab";
import type { CommentRange } from "./components/SourceEditor";
import { safeColor, type Change, type ChangeRange } from "./lib/changes";
import { proseWords } from "./lib/spell";
import {
  agentComplete, checkForUpdates, projectSnapshot, sessionMaterialize, checkpoint, checkpoints, checkpointRestore, checkpointUndo, gitDiscard, type Checkpoint, newPaper, compile as runCompile, compileCancel, gitClone, gitPull, gitPush, gitRemoteAdd, gitRemoteUrl, isMac, onCompileProgress, relayStart, relayStop, gitCommit, gitInit, gitStatus, importOverleaf, native, onMenu, onWindowFocus,
  openProject, pickFolder, pickNewPaperPath, readText, setWindowTitle, synctexForward, synctexInverse, writeText, openSample, openGuide,
  type CompileResult, type GitStatus, type PdfPos, type Project, type Focus, paperMap, type PaperMap, gitHeadText } from "./lib/backend";
import { runRecipe, replCommand, formattersFor, formatText } from "./lib/code-tools";
import { serversFor } from "./lib/lsp";
import { fileKind } from "./lib/languages";
import { parseBib, type BibEntry, type OutlineItem } from "./lib/latex";

export type CompileState =
  | { status: "idle" }
  | { status: "running"; startedAt: number }
  | { status: "done"; result: CompileResult; at: number; agent?: string };  // agent: the run's label when the agent's version was compiled

const NAV_W = 232, INSP_W = 380;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved" | null>(null);
  const [versions, setVersions] = useState<Checkpoint[]>([]);
  const autosaveTimer = useRef<number | null>(null);
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
  const [cursorCol, setCursorCol] = useState(1);
  const onCursor = useCallback((line: number, col: number) => { setCursorLine(line); setCursorCol(col); }, []);
  const [codeServer, setCodeServer] = useState<{ command: string } | null | undefined>(undefined);
  const [codeLint, setCodeLint] = useState({ errors: 0, warnings: 0 });
  const [compileState, setCompileState] = useState<CompileState>({ status: "idle" });
  // An agent run under review: the document can show the agent's version and ⌘B compiles it, before anything lands.
  const [review, setReview] = useState<ReviewHandle | null>(null);
  const [reviewShowing, setReviewShowing] = useState(true);
  const [reviewText, setReviewText] = useState<{ file: string; runId: string; text: string } | null>(null);
  // The paper's own words, one per line in .dabir/dictionary.txt, shared with coauthors through the repository.
  const [dictionary, setDictionary] = useState<string[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [pdfTarget, setPdfTarget] = useState<(PdfPos & { stamp: number }) | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [terminal, setTerminal] = useState<{ open: boolean; focusStamp: number; run?: { command: string; stamp: number } | null }>({ open: false, focusStamp: 0, run: null });
  // Find in Paper lives at the top of the sidebar; ⇧⌘F opens or refocuses it.
  const [findPaper, setFindPaper] = useState({ open: false, stamp: 0 });
  // Focus mode is a setting so it survives restarts; turning it on folds the panels away, turning it off brings them back.
  const toggleFocusMode = useCallback(() => {
    const on = !getSettings().focusMode;
    updateSettings({ focusMode: on });
    setAnimating(true); setNavOpen(!on); setInspectorOpen(!on);
    if (on && mode === "pdf") setMode("source");
  }, [mode]);
  const openFindPaper = useCallback(() => { setFindPaper({ open: true, stamp: Date.now() }); setNavOpen(true); }, []);
  const closeFindPaper = useCallback(() => setFindPaper((f) => ({ ...f, open: false })), []);
  const toggleTerminal = useCallback(() => setTerminal((t) => ({ ...t, open: !t.open, focusStamp: Date.now() })), []);
  const [focused, setFocused] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"shortcuts" | "clone" | "share" | "new" | "settings" | "export" | "refs" | null>(null);
  // The template the New Paper chooser opens on, when a welcome-card starter was clicked.
  const [newTemplate, setNewTemplate] = useState<string | null>(null);
  // The guided tour: which stop is open, and the inspector tab it asks for.
  const [tour, setTour] = useState<number | null>(null);
  const [tabRequest, setTabRequest] = useState<{ tab: InspectorTab; stamp: number } | null>(null);
  const openNew = useCallback((template?: string) => { setNewTemplate(template ?? null); setSheet("new"); }, []);
  const settings = useSettings();
  const [grammar, setGrammar] = useState<GrammarMatch[]>([]);
  const [localComments, setLocalComments] = useState<Comment[]>([]);
  const [localChanges, setLocalChanges] = useState<Change[]>([]);
  const [sessChanges, setSessChanges] = useState<Change[]>([]);
  const [pins, setPins] = useState<PdfPin[]>([]);
  const [pdfZoom, setPdfZoom] = useState<PdfZoom>("fit");
  const [pdfFindRequest, setPdfFindRequest] = useState(0);
  const [splitRatio, setSplitRatio] = useState(0.55);
  const editorRef = useRef<EditorApi | null>(null);
  const addCommentRef = useRef<(text: string, at?: { from: number; to: number }) => void>(() => {});
  const [directPeers, setDirectPeers] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [live, setLive] = useState<LiveState>(null);
  const [hostAway, setHostAway] = useState(false);
  const [commitDraft, setCommitDraft] = useState("");
  const seenHost = useRef(false);
  const unpersist = useRef<(() => void) | null>(null);
  const projectRef = useRef<Project | null>(null);
  const fileRef = useRef<string | null>(null);
  const [liveBusy, setLiveBusy] = useState<string | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [selection, setSelection] = useState<{ from: number; to: number }>({ from: 0, to: 0 });
  const [jumpOffset, setJumpOffset] = useState<{ pos: number; stamp: number } | null>(null);
  const [overleafUrl, setOverleafUrl] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; stamp: number } | null>(null);
  const [agentReady, setAgentReady] = useState(false);
  const [askFocus, setAskFocus] = useState(0);
  const [commitFocus, setCommitFocus] = useState(0);
  const [findRequest, setFindRequest] = useState(0);
  const [bib, setBib] = useState<Record<string, BibEntry>>({});
  const [git, setGit] = useState<GitStatus | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const compileOnSave = settings.compileOnSave;
  const compileRef = useRef<() => void>(() => {});
  const autoCollapsed = useRef(false);
  // The buffer as the disk should see it. `file`, `source` and `dirty` are React state, so a callback created before
  // the last render can lag them; these refs are kept current synchronously (in render and in onSourceChange) and
  // every write pairs the path and the text from the same moment.
  const sourceRef = useRef<string | null>(null);
  sourceRef.current = source;
  fileRef.current = file;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const refreshGit = useCallback(async (p: Project | null = project) => {
    if (!p) { setGit(null); return; }
    try { setGit(await gitStatus(p.root)); } catch { setGit(null); }
  }, [project]);

  // Files opened this session, as tabs above the editor.
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const flushRef = useRef<() => Promise<void>>(async () => {});
  // Close Paper needs the live session and its stop routine, both defined further down.
  const sessionRef = useRef<Session | null>(null);
  const stopSessionRef = useRef<() => Promise<void>>(async () => {});
  const selectFile = useCallback(async (path: string) => {
    try {
      await flushRef.current();   // an edit made in the last second must not be lost to the switch
      const text = await readText(path);
      setFile(path); setSource(text); setDirty(false); setJumpLine(null);
      setOpenFiles((o) => (o.includes(path) ? o : [...o, path]));
      if (mode === "pdf") setMode("visual");
    } catch (e) { setError(String(e)); }
  }, [mode]);
  const closeFile = useCallback((path: string) => {
    const i = openFiles.indexOf(path);
    if (i < 0) return;
    const rest = openFiles.filter((f) => f !== path);
    setOpenFiles(rest);
    if (path === file) { const next = rest[Math.min(i, rest.length - 1)]; if (next) void selectFile(next); }
  }, [openFiles, file, selectFile]);
  const cycleFile = useCallback((dir: 1 | -1) => {
    if (!file || openFiles.length < 2) return;
    const i = openFiles.indexOf(file);
    void selectFile(openFiles[(i + dir + openFiles.length) % openFiles.length]);
  }, [file, openFiles, selectFile]);

  const loadBib = useCallback(async (p: Project) => {
    const bibs: string[] = [];
    const walk = (es: Project["tree"]) => es.forEach((e) => (e.kind === "dir" ? walk(e.children) : e.kind === "bib" && bibs.push(e.path)));
    walk(p.tree);
    const merged: Record<string, BibEntry> = {};
    for (const b of bibs) { try { Object.assign(merged, parseBib(await readText(b), b.replace(p.root + "/", ""))); } catch { /* unreadable bib is not fatal */ } }
    setBib(merged);
  }, []);
  // The paper's structure across its files (sections, labels, floats, macros): what \ref completion,
  // go-to-definition and the outline read. Rebuilt when the paper opens and after every save.
  const [map, setMap] = useState<PaperMap | null>(null);
  const loadMap = useCallback((root: string) => { paperMap(root).then(setMap).catch(() => setMap(null)); }, []);
  // Prose words per manuscript file, for the whole-paper count in the status bar; recounted when the map reloads (every save).
  const [paperWords, setPaperWords] = useState<{ root: string; words: Record<string, number> } | null>(null);
  useEffect(() => {
    if (!project || !map || map.files.length < 2) return;
    let live = true;
    const root = project.root;
    Promise.all(map.files.map(async ([rel]) => [rel, proseWords(await readText(`${root}/${rel}`).catch(() => "")).length] as const))
      .then((pairs) => { if (live) setPaperWords({ root, words: Object.fromEntries(pairs) }); });
    return () => { live = false; };
  }, [project, map]);
  const paperWordsNow = project && map && map.files.length > 1 && paperWords?.root === project.root ? paperWords.words : null;

  const openFolder = useCallback(async (folder: string) => {
    stopLanguageServers();
    const p = await openProject(folder);
    setProject(p); setCompileState({ status: "idle" }); setError(null); setPdfTarget(null);
    setOpenFiles([]);
    try { localStorage.setItem("dabir.lastPaper", p.root); } catch { /* private mode */ }
    setWindowTitle(p.name);
    loadBib(p);
    loadMap(p.root);
    refreshGit(p);
    gitRemoteUrl(p.root, "overleaf").then(setOverleafUrl).catch(() => setOverleafUrl(null));
    // Files shared through the repository are as untrusted as peers: colours are validated before they reach a style.
    readText(`${p.root}/.dabir/comments.json`).then((t) => setLocalComments(t ? (JSON.parse(t) as Comment[]).map((c) => ({ ...c, color: safeColor(c.color), replies: c.replies?.map((r) => ({ ...r, color: safeColor(r.color) })) })) : [])).catch(() => setLocalComments([]));
    readText(`${p.root}/.dabir/changes.json`).then((t) => setLocalChanges(t ? JSON.parse(t) : [])).catch(() => setLocalChanges([]));
    readText(`${p.root}/.dabir/dictionary.txt`).then((t) => setDictionary(t.split("\n").map((w) => w.trim()).filter(Boolean))).catch(() => setDictionary([]));
    if (p.mainTex) await selectFile(p.mainTex); else { setFile(null); setSource(null); }
  }, [selectFile, loadBib, loadMap, refreshGit]);

  // File › Close Paper: back to the welcome screen, and the paper is no longer the one reopened at launch. This is
  // the way to reach the first-run path (the tour offer) again without clearing the app's data.
  const closePaper = useCallback(async () => {
    try { await flushRef.current(); } catch (e) { setError(String(e)); return; }
    if (sessionRef.current) await stopSessionRef.current();
    stopLanguageServers();
    setTour(null); setSheet(null);
    setProject(null); setFile(null); setSource(null); setOpenFiles([]); setDirty(false);
    setCompileState({ status: "idle" }); setPdfTarget(null); setError(null);
    setTerminal({ open: false, focusStamp: 0, run: null });
    try { localStorage.removeItem("dabir.lastPaper"); } catch { /* private mode */ }
    setWindowTitle("Dabir");
  }, []);

  const reloadProject = useCallback(async () => {
    if (!project) return;
    try { const p = await openProject(project.root); setProject(p); loadBib(p); loadMap(p.root); refreshGit(p); } catch (e) { setError(String(e)); }
  }, [project, loadBib, loadMap, refreshGit]);

  // Browser preview only: ?open=sample&view=split&inspector=1&file=code/sweep.py&demo=run opens the sample in a given state,
  // so documentation screenshots can be taken headlessly. Ignored in the native app.
  const [autoRun, setAutoRun] = useState<string | null>(null);
  useEffect(() => {
    if (native) return;
    const q = new URLSearchParams(location.search);
    if (q.get("open") !== "sample") return;
    (async () => {
      const folder = await pickFolder(); if (!folder) return;
      await openFolder(folder);
      const v = q.get("view"); if (v === "visual" || v === "source" || v === "pdf" || v === "split") setMode(v);
      if (q.get("inspector") === "1") setInspectorOpen(true);
      if (q.get("nav") === "0") setNavOpen(false);
      const f = q.get("file"); if (f) await selectFile(`${folder}/${f}`);
      if (q.get("terminal") === "1") setTerminal({ open: true, focusStamp: 0 });
      if (q.get("focus") === "1") { updateSettings({ focusMode: true }); setNavOpen(false); setInspectorOpen(false); }
      if (q.get("demo") === "run") setTimeout(() => setAutoRun("Rerun the sweep with a finer noise grid and update Table 1 and the abstract."), 400);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Come back to the paper that was open last time, as an IDE does; a folder that has gone is forgotten quietly.
  useEffect(() => {
    if (!native) return;
    const last = (() => { try { return localStorage.getItem("dabir.lastPaper"); } catch { return null; } })();
    if (!last) return;
    const t = window.setTimeout(() => { openFolder(last).catch(() => { try { localStorage.removeItem("dabir.lastPaper"); } catch { /* ignore */ } }); }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = useCallback(async () => {
    try { const folder = await pickFolder(); if (folder) await openFolder(folder); } catch (e) { setError(String(e)); }
  }, [openFolder]);

  const importFromOverleaf = useCallback(async () => {
    try { const folder = await importOverleaf(); if (folder) await openFolder(folder); } catch (e) { setError(String(e)); }
  }, [openFolder]);

  // The save panel names and places the folder in one step; false means the author cancelled.
  const createPaper = useCallback(async (template: string, suggested: string): Promise<boolean> => {
    const last = localStorage.getItem("dabir.papersDir");
    const path = await pickNewPaperPath(last ? `${last}/${suggested}` : suggested);
    if (!path) return false;
    const cut = path.replace(/[\\/]+$/, "").lastIndexOf(path.includes("\\") && !path.includes("/") ? "\\" : "/");
    const parent = path.slice(0, cut);
    const name = path.slice(cut + 1);
    if (!parent || !name) throw new Error("Choose a folder name inside a location.");
    const dest = await newPaper(parent, name, template);
    localStorage.setItem("dabir.papersDir", parent);
    await openFolder(dest);
    setNote("New paper created with Git and memory set up.");
    return true;
  }, [openFolder]);
  // Reference sync runs while the paper is open; when entries land, say so and reload the bibliography.
  const onRefsChanged = useCallback((summary: string) => { setNote(summary); reloadProject(); }, [reloadProject]);
  const refSync = useRefSync(project?.root ?? null, onRefsChanged);

  const cloneRepo = useCallback(async (url: string) => {
    const parent = await pickFolder("Choose where to clone");
    if (!parent) return;
    const name = url.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() || "paper";
    const dest = await gitClone(url, `${parent}/${name}`);
    await openFolder(dest);
  }, [openFolder]);

  // Every save is a step in History; saves of the same file within a few minutes fold into one step.
  const versionsRef = useRef<(root: string) => void>(() => {});
  const recordStep = useCallback((path: string) => {
    if (!project) return;
    const rel = path.startsWith(project.root + "/") ? path.slice(project.root.length + 1) : path;
    checkpoint(project.root, `You edited ${rel}`, true).then((id) => { if (id) versionsRef.current(project.root); }).catch(() => {});
    loadMap(project.root);
    if (/\.bib$/.test(rel)) loadBib(project);
  }, [project, loadMap, loadBib]);
  const save = useCallback(async () => {
    const path = fileRef.current, text = sourceRef.current;
    if (!path || text == null) return;
    try { await writeText(path, text); if (fileRef.current === path) setDirty(false); refreshGit(); recordStep(path); if (compileOnSave) compileRef.current(); }
    catch (e) { setError(String(e)); }
  }, [refreshGit, compileOnSave, recordStep]);

  const compile = useCallback(async () => {
    if (!project?.mainTex || compileState.status === "running") return;
    // While reading the agent's version, compile that version from its worktree; nothing lands in the checkout.
    const agentBuild = review && reviewShowing && !session;
    const mainTex = agentBuild ? `${review.worktree}/${project.mainTex.slice(project.root.length + 1)}` : project.mainTex;
    if (!agentBuild && dirtyRef.current) { try { await flushRef.current(); } catch (e) { setError(String(e)); return; } }
    setCompileState({ status: "running", startedAt: Date.now() });
    try {
      const result = await runCompile(mainTex);
      setCompileState({ status: "done", result, at: Date.now(), agent: agentBuild ? review.label : undefined });
      if (result.ok && result.pdf) setMode("pdf");
    } catch (e) {
      setCompileState({ status: "done", at: Date.now(), result: { ok: false, pdf: null, log: String(e), engine: "", millis: 0, diagnostics: [{ severity: "error", category: "other", file: null, line: null, message: String(e), context: null }] } });
    }
  }, [project, compileState.status, review, reviewShowing, session]);
  compileRef.current = compile;
  /** For Export: the checked-in paper's PDF exists, compiling it now if it does not. */
  const ensurePdf = useCallback(async (): Promise<boolean> => {
    if (!project?.mainTex) return false;
    if (compileState.status === "done" && compileState.result.pdf && !compileState.agent) return true;
    if (dirty && sourceRef.current != null && file) { try { await writeText(file, sourceRef.current); setDirty(false); } catch (e) { setError(String(e)); return false; } }
    setCompileState({ status: "running", startedAt: Date.now() });
    try {
      const result = await runCompile(project.mainTex);
      setCompileState({ status: "done", result, at: Date.now() });
      return result.ok && !!result.pdf;
    } catch (e) {
      setCompileState({ status: "done", at: Date.now(), result: { ok: false, pdf: null, log: String(e), engine: "", millis: 0, diagnostics: [{ severity: "error", category: "other", file: null, line: null, message: String(e), context: null }] } });
      return false;
    }
  }, [project, compileState, dirty, file]);
  const toggleCompileOnSave = useCallback(() => updateSettings({ compileOnSave: !settings.compileOnSave }), [settings.compileOnSave]);

  const showInPdf = useCallback(async () => {
    if (!project?.mainTex || !file) return;
    if (compileState.status !== "done" || !compileState.result.pdf) { setNote("Compile first (⌘B), then Show Line in PDF."); return; }
    try {
      const pos = await synctexForward(project.mainTex, file, cursorLine);
      if (!pos) { setNote(`No PDF position recorded for line ${cursorLine}.`); return; }
      setMode("pdf"); setPdfTarget({ ...pos, stamp: Date.now() });
    } catch (e) { setNote(String(e)); }
  }, [project, file, cursorLine, compileState]);

  const onPdfClick = useCallback(async (page: number, x: number, y: number, alt = false) => {
    if (!project?.mainTex) return;
    try {
      const pos = await synctexInverse(project.mainTex, page, x, y);
      if (!pos) return;
      const target = pos.file.startsWith("/") ? pos.file : `${project.root}/${pos.file.replace(/^\.\//, "")}`;
      if (target !== file) await selectFile(target);
      if (alt) {
        // Option-click: comment on that line without leaving the PDF.
        const text = window.prompt(`Comment on line ${pos.line}:`);
        const src = target === file ? source : await readText(target);
        if (text && src != null) {
          const lines = src.split("\n"); const from = lines.slice(0, pos.line - 1).join("\n").length + (pos.line > 1 ? 1 : 0);
          const to = from + (lines[pos.line - 1]?.length ?? 1);
          addCommentRef.current(text.trim(), { from, to });
        }
        return;
      }
      if (mode !== "split") setMode("source");
      setJumpLine(pos.line); setJumpStamp(Date.now());
    } catch (e) { setNote(String(e)); }
  }, [project, file, source, selectFile, mode]);
  const onPdfComment = useCallback((page: number, x: number, y: number) => onPdfClick(page, x, y, true), [onPdfClick]);

  // Split view: the PDF follows the cursor line (debounced), without stealing focus.
  useEffect(() => {
    if (mode !== "split" || !project?.mainTex || !file || compileState.status !== "done" || !compileState.result.pdf) return;
    const t = setTimeout(async () => {
      try { const pos = await synctexForward(project.mainTex!, file, cursorLine); if (pos) setPdfTarget({ ...pos, stamp: Date.now() }); } catch { /* no synctex yet */ }
    }, 350);
    return () => clearTimeout(t);
  }, [mode, project, file, cursorLine, compileState]);

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

  // ---- live sessions
  const rel = useCallback((path: string | null) => (path && project ? path.replace(project.root + "/", "") : null), [project]);
  // The editor position that rides along with every agent request, so "this paragraph" has a referent.
  const agentFocus = useMemo<Focus | null>(() => {
    const f = rel(file);
    if (!f) return null;
    if (source != null && selection.to > selection.from) {
      const line = source.slice(0, selection.from).split("\n").length;
      const endLine = source.slice(0, selection.to).split("\n").length;
      return { file: f, line, endLine, selection: source.slice(selection.from, selection.to).slice(0, 1200) };
    }
    return { file: f, line: cursorLine };
  }, [file, rel, selection, source, cursorLine]);

  const attachSession = useCallback((sess: Session) => {
    setSession(sess);
    (window as unknown as { __session?: Session }).__session = sess; // for automated tests
    seenHost.current = sess.host;
    setHostAway(false);
    persist(sess).then((u) => { unpersist.current = u; }).catch(() => {});
    const refresh = () => {
      // Colours arrive from peers and end up in style attributes: only a hex colour gets through.
      setPeers(yPeers(sess).map((p) => ({ ...p, color: safeColor(p.color) })));
      if (!sess.host) { const here = hostPresent(sess); if (here) seenHost.current = true; setHostAway(seenHost.current && !here); }
    };
    sess.awareness.on("change", refresh);
    const onComments = () => setComments(sess.comments.toArray().map((c) => ({ ...c, color: safeColor(c.color), replies: c.replies?.map((r) => ({ ...r, color: safeColor(r.color) })) })));
    sess.comments.observe(onComments);
    const onChanges = () => setSessChanges(sess.changes.toArray());
    sess.changes.observe(onChanges);
    refresh(); onComments(); onChanges();
    (sess.provider as unknown as { on: (e: string, f: (x: { status?: string; connected?: boolean }) => void) => void }).on("status", (e) => { if (e.status === "disconnected" || e.connected === false) setNote("Live session: connection lost, retrying…"); });
  }, []);

  const startSession = useCallback(async (name: string, transport: Transport) => {
    if (!project) throw new Error("Open a paper first; joining needs no paper, hosting does.");
    setLiveBusy("start");
    try {
      const room = randomRoom(project.name);
      const password = transport === "p2p" ? Math.random().toString(36).slice(2, 12) : undefined;
      if (transport === "p2p" && !settings.signalingUrl) throw new Error("Set a signalling server in Settings first, or use the direct mode.");
      const info = transport === "relay" ? await relayStart(1234) : { url: transport === "p2p" ? settings.signalingUrl : "", lanUrl: "" };
      const sess = yConnect(info.url, room, name, true, transport, password);
      // The host seeds the shared text with the open file once the relay confirms an empty doc.
      const seed = () => {
        if (file && source != null) { const t = textFor(sess, rel(file)!); if (t.length === 0 && source.length > 0) t.insert(0, source); }
        setCurrentFile(sess, rel(file));
      };
      if (transport === "relay") (sess.provider as { once: (e: string, f: () => void) => void }).once("sync", seed); else seed();
      if (transport === "direct") (sess.provider as ManualProvider).on("peers", () => setDirectPeers((sess.provider as ManualProvider).peerCount));
      attachSession(sess);
      markHost(sess);
      setLive({ url: info.url, lanUrl: info.lanUrl, room, host: true, transport, password });
      // Every joiner rebuilds this working tree locally, so figures, tables and the .bib match.
      const snap = await projectSnapshot(project.root);
      await publishProject(sess, snap.files, snap.skipped);
      setNote(transport === "direct" ? "Direct session ready. Make an invite code for each coauthor." : "Live session started. Share the link from the Share sheet." + (snap.skipped.length ? ` ${snap.skipped.length} large file${snap.skipped.length > 1 ? "s" : ""} stay on this machine.` : ""));
    } finally { setLiveBusy(null); }
  }, [project, file, source, rel, attachSession, settings.signalingUrl]);

  // Direct mode as a guest: answer an invite, then wait for the host to connect.
  // A joiner works in a local mirror of the host's tree (~/Dabir Sessions/<room>), so compiles and figures match.
  const mirrorFromHost = useCallback(async (sess: Session, room: string) => {
    const snap = await awaitSnapshot(sess, 45000);
    const root = await sessionMaterialize(room, snap.files);
    if (root) { await openFolder(root); setNote(`Working in a mirror of the host's paper${snap.skipped.length ? `; ${snap.skipped.length} large file${snap.skipped.length > 1 ? "s" : ""} did not travel` : ""}.`); }
    setCurrentFile(sess, rel(fileRef.current));
  }, [openFolder, rel]);

  const answerDirect = useCallback(async (name: string, invite: string): Promise<string> => {
    const sess = session?.transport === "direct" ? session : yConnect("", "direct", name, false, "direct");
    const prov = sess.provider as ManualProvider;
    const code = await prov.answerInvite(invite);
    if (sess !== session) {
      prov.on("peers", () => setDirectPeers(prov.peerCount));
      prov.once("synced", () => { setNote("Connected to the host. Receiving the paper…"); mirrorFromHost(sess, `direct-${name}`).catch((e) => setError(String(e))); });
      attachSession(sess);
      setLive({ url: "", lanUrl: "", room: "direct", host: false, transport: "direct" });
    }
    return code;
  }, [session, attachSession, mirrorFromHost]);
  const directApi = session?.transport === "direct" ? {
    invite: () => (session.provider as ManualProvider).createInvite(),
    accept: (answer: string) => (session.provider as ManualProvider).acceptAnswer(answer),
    answer: answerDirect,
    peers: directPeers,
  } : { invite: async () => { throw new Error("Start a direct session first."); }, accept: async () => {}, answer: answerDirect, peers: 0 };

  const joinSession = useCallback(async (name: string, url: string, room: string, transport: Transport, password?: string) => {
    setLiveBusy("join");
    try {
      const sess = yConnect(url, room, name, false, transport, password);
      try { await whenSynced(sess, transport === "p2p" ? 20000 : 8000); } catch (e) { yDisconnect(sess); throw e; }
      attachSession(sess);
      setLive({ url, lanUrl: url, room, host: false, transport, password });
      setNote("Joined. Receiving the host's paper…");
      await mirrorFromHost(sess, room);
    } finally { setLiveBusy(null); }
  }, [attachSession, mirrorFromHost]);

  const stopSession = useCallback(async () => {
    const names = peers.filter((p) => !p.me).map((p) => p.name);
    if (session) yDisconnect(session);
    unpersist.current?.(); unpersist.current = null;
    setSession(null); setPeers([]); setComments([]); setSessChanges([]); setLive(null); setHostAway(false);
    (window as unknown as { __session?: Session }).__session = undefined;
    if (live?.host && live.transport === "relay") await relayStop();
    // The host's checkout is the record of the session: suggest the commit.
    if (live?.host) { setCommitDraft(`Live session${names.length ? ` with ${names.join(", ")}` : ""}`); setNavOpen(true); }
  }, [session, live, peers]);
  useEffect(() => { sessionRef.current = session; stopSessionRef.current = stopSession; }, [session, stopSession]);

  // Every client writes shared files it does not have open to its own disk, so the host's checkout
  // and each joiner's mirror stay complete even for files only somebody else is editing.
  useEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => {
    if (!session) return;
    const written = new Map<string, string>();
    let timer: number | null = null;
    const flush = () => {
      const root = projectRef.current?.root; if (!root) return;
      const openRel = rel(fileRef.current);
      for (const { rel: r, text } of sharedTexts(session)) {
        if (r === openRel || r.includes("..")) continue;
        const content = text.toString();
        if (!content || written.get(r) === content) continue;
        written.set(r, content);
        writeText(`${root}/${r}`, content).catch(() => {});
      }
    };
    const onUpdate = () => { if (timer) clearTimeout(timer); timer = window.setTimeout(flush, 800); };
    session.doc.on("update", onUpdate);
    return () => { session.doc.off("update", onUpdate); if (timer) clearTimeout(timer); };
  }, [session, rel]);

  // The host seeds any file a joiner opens that nobody has seeded yet.
  useEffect(() => {
    if (!session || !live?.host || !project) return;
    const seedFor = async () => {
      for (const p of yPeers(session)) {
        if (p.me || !p.file) continue;
        const t = textFor(session, p.file);
        if (t.length > 0) continue;
        try { const content = await readText(`${project.root}/${p.file}`); if (content && t.length === 0) t.insert(0, content); } catch { /* not a text file the host has */ }
      }
    };
    session.awareness.on("change", seedFor);
    seedFor();
    return () => session.awareness.off("change", seedFor);
  }, [session, live, project]);

  // After a compile, figures and tables may have changed: send only what changed.
  useEffect(() => {
    if (!session || !live?.host || !project || compileState.status !== "done") return;
    projectSnapshot(project.root).then((snap) => republishChanged(session, snap.files)).catch(() => {});
  }, [compileState, session, live, project]);

  useEffect(() => { if (session) setCurrentFile(session, rel(file)); }, [session, file, rel]);

  const collab = session && file && rel(file) ? { text: textFor(session, rel(file)!), awareness: session.awareness } : null;
  // When a joiner opens a file the host has not seeded yet, seed from their own copy.
  useEffect(() => {
    if (!session || !file || source == null) return;
    const t = textFor(session, rel(file)!);
    if (t.length === 0 && source.length > 0 && live?.host) t.insert(0, source);
  }, [session, file, source, rel, live]);

  // Comments live in the shared doc during a session, otherwise in .dabir/comments.json next to the paper.
  // Local anchors are plain offsets plus the quoted text, re-found by search when the offset drifts.
  const allComments: Comment[] = session ? comments : localComments;
  const persistLocal = useCallback((next: Comment[]) => {
    setLocalComments(next);
    if (project) writeText(`${project.root}/.dabir/comments.json`, JSON.stringify(next, null, 2)).catch((e) => setError(String(e)));
  }, [project]);
  const localRange = useCallback((c: { anchor: string; head: string }): { from: number; to: number } | null => {
    if (source == null) return null;
    try {
      const { from, quote } = JSON.parse(c.anchor) as { from: number; quote: string };
      const len = Number(c.head) || quote.length;
      if (quote && source.slice(from, from + quote.length) === quote) return { from, to: from + quote.length };
      const near = quote ? source.indexOf(quote, Math.max(0, from - 2000)) : -1;
      if (near >= 0) return { from: near, to: near + quote.length };
      const any = quote ? source.indexOf(quote) : -1;
      if (any >= 0) return { from: any, to: any + quote.length };
      return from <= source.length ? { from, to: Math.min(source.length, from + len) } : null;
    } catch { return null; }
  }, [source]);
  const rangeOf = useCallback((c: { anchor: string; head: string }) => (session ? decodeRange(session.doc, c) : localRange(c)), [session, localRange]);

  // Track changes. The editor's marks are the truth while a file is open; they are stored like comments:
  // .dabir/changes.json when working alone, the shared "changes" array in a session.
  const me = useMemo(() => { const name = userName() || "me"; return { name, color: colorFor(name) }; }, [sheet]); // eslint-disable-line react-hooks/exhaustive-deps -- the Share sheet is where the name is set
  const allChanges: Change[] = session ? sessChanges : localChanges;
  const changeRanges: ChangeRange[] = useMemo(() => (file ? allChanges.filter((c) => c.file === rel(file)) : []).map((c) => {
    const r = rangeOf(c);
    return r && r.to > r.from ? { id: c.id, author: c.author, color: safeColor(c.color), kind: c.kind, from: r.from, to: r.to, at: c.at } : null;
  }).filter((x): x is ChangeRange => !!x), [file, allChanges, rel, rangeOf]);
  // Ids the editor has been handed, so a session sync only removes records this client has actually seen.
  const knownChangeIds = useRef(new Set<string>());
  useEffect(() => { knownChangeIds.current = new Set(changeRanges.map((c) => c.id)); }, [changeRanges]);
  const changesWrite = useRef<{ timer: number; json: string; root: string } | null>(null);
  const onEditorChanges = useCallback((ranges: ChangeRange[], doc: string, marksChanged: boolean) => {
    if (!file || !project) return;
    const f = rel(file)!;
    if (session) {
      if (!marksChanged) return; // relative positions follow the text on their own
      queueMicrotask(() => { const t = textFor(session, f); setFileChanges(session, f, ranges.map((r) => ({ id: r.id, author: r.author, color: r.color, kind: r.kind, file: f, at: r.at, ...encodeRange(t, r.from, r.to) })), knownChangeIds.current); });
      return;
    }
    setLocalChanges((prev) => {
      const next = [...prev.filter((c) => c.file !== f), ...ranges.map((r) => ({ id: r.id, author: r.author, color: r.color, kind: r.kind, file: f, at: r.at, anchor: JSON.stringify({ from: r.from, quote: doc.slice(r.from, r.to) }), head: String(r.to - r.from) }))];
      // Positions shift on every keystroke; write the sidecar once typing settles.
      const json = JSON.stringify(next, null, 2);
      if (changesWrite.current) clearTimeout(changesWrite.current.timer);
      const root = project.root;
      changesWrite.current = { json, root, timer: window.setTimeout(() => { writeText(`${root}/.dabir/changes.json`, json).catch((e) => setError(String(e))); changesWrite.current = null; }, marksChanged ? 0 : 800) };
      return next;
    });
  }, [file, project, rel, session]);
  const resolveChange = useCallback((ids: string[] | null, accept: boolean) => { editorRef.current?.resolveChanges(ids, accept); }, []);
  const toggleSuggesting = useCallback(() => {
    const on = !settings.suggesting;
    updateSettings({ suggesting: on });
    setNote(on ? `Suggesting as ${me.name}. Your edits are marked in your colour until a coauthor accepts them; set your name in Share if it is not right.` : null);
  }, [settings.suggesting, me]);
  const jumpToChange = useCallback((id: string) => { const r = changeRanges.find((c) => c.id === id); if (r) { setMode("source"); setJumpOffset({ pos: r.from, stamp: Date.now() }); } }, [changeRanges]);
  const changeItems = useMemo(() => changeRanges.map((r) => ({ ...r, excerpt: (source ?? "").slice(r.from, Math.min(r.to, r.from + 80)).replace(/\s+/g, " ") })), [changeRanges, source]);

  const commentRanges: CommentRange[] = (file ? allComments.filter((c) => c.file === rel(file)) : []).map((c) => {
    const r = rangeOf(c);
    return r ? { id: c.id, from: r.from, to: r.to, resolved: c.resolved, color: c.color } : null;
  }).filter((x): x is CommentRange => !!x);

  const addCommentAtSelection = useCallback((text: string, at?: { from: number; to: number }) => {
    if (!file || source == null) return;
    const { from, to } = at ?? selection;
    const end = to === from ? Math.min(source.length, from + 1) : to;
    if (session) {
      const me = yPeers(session).find((p) => p.me);
      const t = textFor(session, rel(file)!);
      yAddComment(session, { author: me?.name ?? "me", color: me?.color ?? "#8a6414", text, file: rel(file)!, ...encodeRange(t, from, end) });
    } else {
      const name = (() => { try { return localStorage.getItem("dabir.name") || "me"; } catch { return "me"; } })();
      const quote = source.slice(from, end);
      persistLocal([...localComments, { id: Math.random().toString(36).slice(2, 10), author: name, color: "#8a6414", text, file: rel(file)!, anchor: JSON.stringify({ from, quote }), head: String(end - from), at: Date.now(), resolved: false }]);
    }
  }, [session, file, source, rel, selection, localComments, persistLocal]);
  addCommentRef.current = addCommentAtSelection;
  const resolveAnyComment = useCallback((id: string, resolved: boolean) => { if (session) yResolveComment(session, id, resolved); else persistLocal(localComments.map((c) => (c.id === id ? { ...c, resolved } : c))); }, [session, localComments, persistLocal]);
  const replyAnyComment = useCallback((id: string, text: string) => {
    const name = userName() || "me";
    if (session) yReplyComment(session, id, { author: name, color: colorFor(name), text });
    else persistLocal(localComments.map((c) => (c.id === id ? { ...c, replies: [...(c.replies ?? []), { author: name, color: colorFor(name), text, at: Date.now() }] } : c)));
  }, [session, localComments, persistLocal]);
  const removeAnyComment = useCallback((id: string) => { if (session) yRemoveComment(session, id); else persistLocal(localComments.filter((c) => c.id !== id)); }, [session, localComments, persistLocal]);

  const jumpToComment = useCallback(async (c: Comment) => {
    if (!project) return;
    if (rel(file) !== c.file) await selectFile(`${project.root}/${c.file}`);
    const r = rangeOf(c);
    if (r) { setMode("source"); setJumpOffset({ pos: r.from, stamp: Date.now() }); }
  }, [project, file, rel, selectFile, rangeOf]);

  // PDF pins: map each comment's line to a page position through SyncTeX.
  useEffect(() => {
    if (mode !== "pdf" || !project?.mainTex || !file || source == null || compileState.status !== "done" || !compileState.result.pdf) { setPins([]); return; }
    let cancelled = false;
    (async () => {
      const out: PdfPin[] = [];
      const mine = allComments.filter((c) => c.file === rel(file));
      for (let i = 0; i < mine.length; i++) {
        const r = rangeOf(mine[i]);
        if (!r) continue;
        const line = source.slice(0, r.from).split("\n").length;
        try { const pos = await synctexForward(project.mainTex!, file!, line); if (pos) out.push({ id: mine[i].id, page: pos.page, y: pos.y, color: mine[i].color, n: i + 1, resolved: mine[i].resolved, title: `${mine[i].author}: ${mine[i].text}` }); } catch { /* no synctex yet */ }
      }
      if (!cancelled) setPins(out);
    })();
    return () => { cancelled = true; };
  }, [mode, project, file, source, compileState, allComments, rel, rangeOf]);

  // Grammar: check the selection, or the paragraph around the cursor, through LanguageTool.
  const runGrammar = useCallback(async () => {
    if (source == null) return;
    if (settings.grammar === "off") { setNote("Grammar checking is off. Turn it on in Settings (⌘,) and choose a LanguageTool server."); return; }
    let { from, to } = selection;
    if (to === from) {
      const before = source.lastIndexOf("\n\n", from); const after = source.indexOf("\n\n", from);
      from = before < 0 ? 0 : before + 2; to = after < 0 ? source.length : after;
    }
    try {
      const matches = await checkGrammar(settings.languageToolUrl, settings.grammarLanguage, source.slice(from, to), from);
      setGrammar(matches);
      setNote(matches.length ? `${matches.length} grammar suggestion${matches.length > 1 ? "s" : ""}. Hover an underline to see it.` : "No grammar issues found in that passage.");
      if (mode !== "source" && matches.length) setMode("source");
    } catch (e) { setNote(String(e)); }
  }, [source, selection, settings, mode]);
  useEffect(() => { setGrammar([]); }, [file]);

  const setOverleaf = useCallback(async (url: string) => {
    if (!project) return;
    await gitRemoteAdd(project.root, "overleaf", url); setOverleafUrl(url); setNote("Overleaf remote saved.");
  }, [project]);
  const pullOverleaf = useCallback(async () => { if (!project) return; setLiveBusy("pull"); try { setNote(await gitPull(project.root, "overleaf")); await reloadProject(); if (file) setSource(await readText(file)); } finally { setLiveBusy(null); } }, [project, file, reloadProject]);
  const pushOverleaf = useCallback(async () => { if (!project) return; setLiveBusy("push"); try { setNote(await gitPush(project.root, "overleaf")); } finally { setLiveBusy(null); } }, [project]);

  const toggleNav = useCallback(() => { setAnimating(true); setNavOpen((v) => !v); }, []);
  const toggleInspector = useCallback(() => { setAnimating(true); autoCollapsed.current = false; setInspectorOpen((v) => !v); }, []);

  // One command router for the native menu bar and the browser keyboard fallback.
  const files = useMemo(() => (project ? flattenFiles(project.tree) : []), [project]);
  // Run File: the recipe for the open file, typed into the terminal panel so the author sees what ran.
  const runRecipeNow = useMemo(() => { const r = rel(file); return r ? runRecipe(r, files) : null; }, [rel, file, files]);
  const runInTerminal = useCallback((command: string) => {
    const now = Date.now();
    setTerminal({ open: true, focusStamp: now, run: { command, stamp: now } });
  }, []);
  const runFile = useCallback(async () => {
    if (!project || !file) return;
    if (!runRecipeNow) { setNote(`No run recipe for ${file.split("/").pop()}. Type the command in the terminal.`); return; }
    await flushRef.current();
    runInTerminal(runRecipeNow.command);
  }, [project, file, runRecipeNow, runInTerminal]);
  // ⇧⏎: the selection or the current line, typed into the terminal; a block gets a closing blank line for REPLs.
  const runSelection = useCallback((text?: string) => {
    const t = (text ?? editorRef.current?.selectionOrLine() ?? "").replace(/\s+$/, "");
    if (!t.trim()) return;
    const lines = t.split("\n");
    runInTerminal(lines.join("\r") + (lines.length > 1 ? "\r" : ""));
  }, [runInTerminal]);
  const replNow = useMemo(() => { const r = rel(file); return r ? replCommand(r) : null; }, [rel, file]);
  const openRepl = useCallback(() => { if (replNow) runInTerminal(replNow.command); }, [replNow, runInTerminal]);
  const codeState = useMemo(() => {
    const r = rel(file) ?? "";
    return {
      run: runRecipeNow, repl: replNow, canFormat: formattersFor(r).length > 0, server: codeServer,
      installHint: serversFor(r)[0]?.install ?? null, lint: codeLint, line: cursorLine, col: cursorCol,
      onRun: () => void runFile(), onRunSelection: runSelection, onRepl: openRepl, onFormat: () => void formatDocumentRef.current(), onServer: setCodeServer, onLint: setCodeLint,
    };
  }, [rel, file, runRecipeNow, replNow, codeServer, codeLint, cursorLine, cursorCol, runFile, runSelection, openRepl]);
  const formatDocumentRef = useRef<() => Promise<boolean>>(async () => false);
  // Format Document: the project's formatter over the buffer, applied as one change so undo is one step.
  const formatDocument = useCallback(async () => {
    const r = rel(file);
    if (!project || !r || !editorRef.current) return false;
    if (reviewText && reviewShowing) { setNote("Formatting is off while reading the agent's version."); return false; }
    const result = await formatText(project.root, r, editorRef.current.text());
    if (!result.ok) { setNote(result.error); return false; }
    const changed = editorRef.current.replaceAll(result.text);
    // The editor's change event updates the source on the next render; a save that follows at once must see it now.
    if (changed) { sourceRef.current = result.text; setSource(result.text); setDirty(true); }
    setNote(changed ? `Formatted with ${result.formatter}.` : `Already formatted (${result.formatter}).`);
    return true;
  }, [project, file, rel, reviewText, reviewShowing]);
  useEffect(() => { formatDocumentRef.current = formatDocument; }, [formatDocument]);
  // The file as HEAD has it, for the change gutter; refreshed when the file or the repository state changes.
  const [headText, setHeadText] = useState<string | null>(null);
  useEffect(() => {
    const r = rel(file);
    let live = true;
    (project && r ? gitHeadText(project.root, r) : Promise.resolve(null)).then((t) => { if (live) setHeadText(t); });
    return () => { live = false; };
  }, [project, file, rel, git]);
  // The tour runs on the sample paper: a copy under Documents/Dabir the first time, reopened after that.
  const startTour = useCallback(async () => {
    try {
      const folder = await openSample();
      if (project?.root !== folder) await openFolder(folder);
      setSheet(null); setNavOpen(true);
      setTour(0);
      try { localStorage.setItem("dabir.tourSeen", "1"); } catch { /* private mode */ }
    } catch (e) { setError(String(e)); }
  }, [project, openFolder]);
  const tourSteps = useMemo<TourStep[]>(() => {
    const root = project?.root ?? "";
    const showMain = () => { if (project?.mainTex && fileRef.current !== project.mainTex) void selectFile(project.mainTex); };
    return [
      { id: "folder", target: ".navigator .nav-section:first-of-type", title: "A paper is a folder", enter: () => { setNavOpen(true); showMain(); setMode("visual"); setTerminal((t) => ({ ...t, open: false })); },
        body: <><p>This is the sample: <code>main.tex</code>, a <code>refs.bib</code>, the figures and tables, and <code>code/sweep.py</code>, the script that made them. Dabir opens the folder in place. Nothing is uploaded or converted, and the folder stays yours to use with any other tool.</p><p>Click a file to open it. Open files become tabs above the editor.</p></> },
      { id: "modes", target: ".titlebar .seg", title: "Four ways to look at it", enter: () => { showMain(); setMode("visual"); },
        body: <><p><b>Visual</b> lays the LaTeX out as a page while you type, with the source one click away. <b>Source</b> is the raw file with highlighting, folding and completions. <b>PDF</b> is the compiled paper. <b>Split</b> puts source and PDF side by side; click a line in the PDF to jump to it in the source, and back.</p></>,
        keys: [{ keys: "⌘1 – ⌘4", does: "switch" }] },
      { id: "compile", target: '.titlebar .tb-btn[title^="Compile"]', title: "Compile", enter: showMain,
        body: <><p>Compiles with the engine in <code>dabir.toml</code> (Tectonic downloads packages on first use, so nothing else needs installing). Errors are turned into plain sentences under Problems, each pointing at its line. <b>Compile on save</b> keeps the PDF current as you write.</p></>,
        keys: [{ keys: "⌘B", does: "compile" }, { keys: "⌘S", does: "save" }] },
      { id: "write", target: ".formatbar", title: "Writing with help", enter: () => { showMain(); setMode("visual"); },
        body: <><p>The bar formats without you remembering the macro: bold, emphasis, inline math, sections, lists, citations and references. Type <code>\cite{"{"}</code> or <code>\ref{"{"}</code> and the entries and labels of this paper complete. Spelling and grammar are underlined; a suggestion is one click.</p></>,
        keys: [{ keys: "⇧⌘Space", does: "the agent continues the sentence" }, { keys: "⌘F", does: "find in paper" }] },
      { id: "outline", target: ".navigator .nav-section:nth-of-type(2)", title: "Outline and word count", enter: showMain,
        body: <><p>The outline follows the sections of the whole paper, <code>\input</code>s included, and the word count at the bottom counts prose only: no preamble, no comments, no math. Click a heading to jump.</p></> },
      { id: "agent", target: ".inspector textarea", title: "Ask an agent", enter: () => { setInspectorOpen(true); setTabRequest({ tab: "agent", stamp: Date.now() }); },
        body: <><p>Claude Code, Codex, Cursor, Grok or OpenCode: whichever is installed. Each run gets a short preamble (the paper's map, your focus, the memory of past runs) rather than the whole folder, and works on a copy of the paper. When it finishes, the document shows its version with the changes marked. <b>Accept</b> lands them and takes a snapshot; <b>Reject</b> discards them. Try: <i>"Tighten the abstract to 150 words."</i></p></>,
        keys: [{ keys: "⌘J", does: "ask" }, { keys: "⌘⏎", does: "send" }] },
      { id: "memory", target: ".inspector-tabs", title: "Memory", enter: () => { setInspectorOpen(true); setTabRequest({ tab: "memory", stamp: Date.now() }); },
        body: <><p>Agents remember through files in <code>.dabir/</code>: the project brief, decisions taken, a log of runs, and skills (recipes such as <i>address a reviewer</i> or <i>check the references</i>). They are plain Markdown in your repository, so you can read and edit them, and any agent can too.</p></> },
      { id: "code", target: ".codebar", title: "Code lives here too", enter: () => { setMode("source"); void selectFile(`${root}/code/sweep.py`); },
        body: <><p>Code files open with their grammar, a language server when one is installed, and Git marks in the gutter. The bar runs the file or the selection in the terminal, opens a REPL, and formats. <code>dabir.toml</code> records which command made each figure and table, so agents rerun the script instead of editing the numbers.</p></>,
        keys: [{ keys: "⌃⏎", does: "run file" }, { keys: "⇧⏎", does: "run selection" }, { keys: "⇧⌥F", does: "format" }] },
      { id: "terminal", target: ".terminal", title: "The terminal", enter: () => { setTerminal((t) => (t.open ? t : { ...t, open: true, focusStamp: Date.now() })); },
        body: <><p>A real shell in the paper's folder, with tabs, and the same one agents can use. With <code>[remote]</code> in <code>dabir.toml</code>, a tab opens over SSH on the machine that runs the experiments. Drag the top edge to resize.</p></>,
        keys: [{ keys: "⌃`", does: "show or hide" }] },
      { id: "history", target: ".navigator .nav-section:last-of-type", title: "History and Git", enter: () => { setNavOpen(true); setTerminal((t) => ({ ...t, open: false })); },
        body: <><p>Every save is a step you can return to, every accepted run a snapshot, and commits are yours: the message is drafted from the change, the author is you. The History tab in the inspector lists versions and restores any of them.</p></> },
      { id: "together", target: '.titlebar .tb-btn[aria-label="Share"]', title: "Working together", enter: () => { setInspectorOpen(true); setTabRequest({ tab: "people", stamp: Date.now() }); },
        body: <><p>Start a live session and send the invite code: coauthors edit the same paper peer to peer, with comments and suggested changes in the People tab. Overleaf projects pull and push as Git remotes, and Export makes an arXiv-ready bundle.</p></> },
      { id: "done", target: null, title: "That is the tour",
        body: <><p>Open your own paper's folder, or start one from a venue template. <kbd>⌘/</kbd> lists every shortcut, <kbd>⌘,</kbd> opens Settings (autosave, format on save, language servers, the agent's memory rules). The written guide covers each step in more depth.</p><p><button className="link" onClick={() => openGuide().catch(() => {})}>Open the user guide</button></p></> },
    ];
  }, [project, selectFile]);

  const command = useCallback((id: string) => {
    switch (id) {
      case "open": open(); break;
      case "close-paper": if (project) closePaper(); break;
      case "new": setSheet("new"); break;
      case "import-overleaf": importFromOverleaf(); break;
      case "clone": setSheet("clone"); break;
      case "share": setSheet("share"); break;
      case "export": setSheet("export"); break;
      case "references": setSheet("refs"); break;
      case "save": void (async () => { if (settings.formatOnSave && fileKind(file) === "code") await formatDocument(); await save(); })(); break;
      case "compile": compile(); break;
      case "show-log": setShowLog((v) => !v); break;
      case "show-terminal": if (project) toggleTerminal(); else setNote("Open a paper first: the terminal runs in the paper's folder."); break;
      case "run-file": void runFile(); break;
      case "run-selection": runSelection(); break;
      case "open-repl": openRepl(); break;
      case "format-doc": void formatDocument(); break;
      case "next-file": cycleFile(1); break;
      case "prev-file": cycleFile(-1); break;
      case "close-file": if (file) closeFile(file); break;
      case "find-paper": openFindPaper(); break;
      case "focus-mode": toggleFocusMode(); break;
      case "sync-pdf": showInPdf(); break;
      case "commit": if (!navOpen) toggleNav(); setCommitFocus((n) => n + 1); break;
      case "view-visual": setMode("visual"); break;
      case "view-source": setMode("source"); break;
      case "view-pdf": setMode("pdf"); break;
      case "view-split": setMode("split"); break;
      case "agent-continue": editorRef.current?.continueSentence(); break;
      case "fmt-bold": editorRef.current?.format("bold"); break;
      case "fmt-italic": editorRef.current?.format("italic"); break;
      case "fmt-emph": editorRef.current?.format("emph"); break;
      case "fmt-code": editorRef.current?.format("code"); break;
      case "fmt-section": case "fmt-subsection": case "fmt-subsubsection": editorRef.current?.heading(id.slice(4)); break;
      case "fmt-itemize": editorRef.current?.list("itemize"); break;
      case "fmt-enumerate": editorRef.current?.list("enumerate"); break;
      case "fmt-math": editorRef.current?.format("math"); break;
      case "fmt-equation": editorRef.current?.format("equation"); break;
      case "fmt-figure": editorRef.current?.format("figure"); break;
      case "fmt-table": editorRef.current?.format("table"); break;
      case "fmt-cite": editorRef.current?.format("cite"); break;
      case "fmt-ref": editorRef.current?.format("ref"); break;
      case "fmt-link": editorRef.current?.format("link"); break;
      case "fmt-footnote": editorRef.current?.format("footnote"); break;
      case "toggle-sidebar": toggleNav(); break;
      case "toggle-inspector": toggleInspector(); break;
      case "ask-agent": if (!inspectorOpen) toggleInspector(); setAskFocus((n) => n + 1); break;
      case "find": if (mode === "pdf") setPdfFindRequest((n) => n + 1); else { if (mode === "visual") setMode("source"); setFindRequest((n) => n + 1); } break;
      case "shortcuts": setSheet((v) => (v === "shortcuts" ? null : "shortcuts")); break;
      case "settings": setSheet("settings"); break;
      case "tour": startTour(); break;
      case "guide": openGuide().catch((e) => setNote(String(e))); break;
      case "zoom-in": setPdfZoom((z) => Math.min(4, (typeof z === "number" ? z : 1) * 1.18)); if (mode !== "pdf" && mode !== "split") setMode("pdf"); break;
      case "zoom-out": setPdfZoom((z) => Math.max(0.3, (typeof z === "number" ? z : 1) * 0.85)); break;
      case "zoom-fit": setPdfZoom("fit"); break;
      case "check-grammar": runGrammar(); break;
      case "unicode-tex": { const n = editorRef.current?.unicodeToTex() ?? 0; setNote(n ? `Rewrote ${n} symbol${n === 1 ? "" : "s"} as LaTeX.` : "Nothing to rewrite: no curly quotes, dashes or symbols LaTeX has a name for."); break; }
      case "check-updates":
        checkForUpdates(async (v, notes) => window.confirm(`Dabir ${v} is available.\n\n${notes}\n\nDownload and restart now?`)).then(setNote).catch((e) => setNote(String(e)));
        break;
    }
  }, [open, startTour, closePaper, importFromOverleaf, save, compile, showInPdf, toggleNav, toggleInspector, toggleTerminal, openFindPaper, toggleFocusMode, inspectorOpen, navOpen, runGrammar, mode, cycleFile, closeFile, file, project, runFile, runSelection, openRepl, formatDocument, settings.formatOnSave]);

  useEffect(() => onMenu(command), [command]);
  useEffect(() => onCompileProgress((line) => setProgress(line.length > 90 ? line.slice(0, 87) + "…" : line)), []);
  useEffect(() => { if (compileState.status !== "running") setProgress(null); }, [compileState.status]);
  useEffect(() => onWindowFocus((f) => { setFocused(f); if (f) refreshGit(); }), [refreshGit]);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 6000); return () => clearTimeout(t); }, [note]);

  // Keyboard fallback for the browser preview only; the native app owns accelerators through its menu.
  useEffect(() => {
    if (native) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && e.key === "`") { e.preventDefault(); command("show-terminal"); return; }
      if (e.ctrlKey && !e.metaKey && e.key === "Enter") { e.preventDefault(); command("run-file"); return; }
      if (e.shiftKey && e.altKey && !e.metaKey && !e.ctrlKey && (e.code === "KeyF") && !e.defaultPrevented) { e.preventDefault(); command("format-doc"); return; }
      if (!e.metaKey) return;
      const k = e.key.toLowerCase();
      const map: Record<string, string> = { o: "open", n: "new", s: "save", b: "compile", "1": "view-visual", "2": "view-source", "3": "view-pdf", "4": "view-split", j: "ask-agent", f: "find", "/": "shortcuts", ",": "settings", k: "fmt-link" };
      const shifted: Record<string, string> = { g: "check-grammar", b: "fmt-bold", i: "fmt-italic", e: "fmt-emph", m: "fmt-math", c: "fmt-cite", r: "fmt-ref", l: "show-log", j: "sync-pdf", s: "share", o: "clone", f: "find-paper" };
      if (e.shiftKey && !e.altKey && shifted[k]) { e.preventDefault(); command(shifted[k]); return; }
      if (e.shiftKey && (e.key === "]" || e.key === "}" || e.code === "BracketRight")) { e.preventDefault(); command("next-file"); return; }
      if (e.shiftKey && (e.key === "[" || e.key === "{" || e.code === "BracketLeft")) { e.preventDefault(); command("prev-file"); return; }
      if (e.altKey && k === "c") { e.preventDefault(); command("commit"); return; }
      if (e.altKey && (k === "e" || e.code === "KeyE")) { e.preventDefault(); command("export"); return; }
      if (e.altKey && (k === "r" || e.code === "KeyR")) { e.preventDefault(); command("references"); return; }
      if (k === "=" || k === "+") { e.preventDefault(); command("zoom-in"); return; }
      if (k === "-") { e.preventDefault(); command("zoom-out"); return; }
      if (k === "0") { e.preventDefault(); command("zoom-fit"); return; }
      if (e.ctrlKey && k === "s") { e.preventDefault(); command("toggle-sidebar"); return; }
      if (e.altKey && (k === "i" || e.code === "KeyI")) { e.preventDefault(); command("toggle-inspector"); return; }
      if (e.altKey && (k === "f" || e.code === "KeyF")) { e.preventDefault(); command("focus-mode"); return; }
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

  const onSourceChange = useCallback((text: string) => {
    sourceRef.current = text; dirtyRef.current = true;
    setSource(text); setDirty(true);
    if (!settings.autosave) return;
    setSaveState("unsaved");
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(async () => {
      setSaveState("saving");
      try { await saveRef.current(); setSaveState("saved"); } catch { setSaveState("unsaved"); }
    }, 900);
  }, [settings.autosave]);
  const saveRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => { saveRef.current = save; }, [save]);

  // Snapshots: every five minutes while something is uncommitted, so the paper has a version history without commits.
  const refreshVersions = useCallback((root: string) => { checkpoints(root).then(setVersions).catch(() => setVersions([])); }, []);
  versionsRef.current = refreshVersions;
  useEffect(() => { if (project) refreshVersions(project.root); else setVersions([]); }, [project, refreshVersions]);
  // Put the open buffer on disk if it is dirty, and drop any pending autosave, so runs and Accept see what the author sees.
  const flush = useCallback(async () => {
    if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = 0; }
    const path = fileRef.current, text = sourceRef.current;
    if (dirtyRef.current && path && text != null) { dirtyRef.current = false; await writeText(path, text); if (fileRef.current === path) { setDirty(false); setSaveState("saved"); } recordStep(path); }
  }, [recordStep]);
  useEffect(() => { flushRef.current = flush; }, [flush]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyFocus, setHistoryFocus] = useState(0);
  // Reload the open file and the project after history moved the working tree.
  const afterHistory = useCallback(async () => {
    if (!project) return;
    await reloadProject();
    if (file) { const t = await readText(file); setSource(t); setDirty(false); setSaveState("saved"); }
    refreshGit(); refreshVersions(project.root);
  }, [project, reloadProject, file, refreshGit, refreshVersions]);
  const restoreVersion = useCallback(async (id: string) => {
    if (!project) return;
    setHistoryBusy(true);
    try {
      await flush();
      await checkpointRestore(project.root, id);
      await afterHistory();
      setNote(`Restored to ${id}. The state before was kept as a step, so this can be undone.`);
    } catch (e) { setError(String(e)); } finally { setHistoryBusy(false); }
  }, [project, flush, afterHistory]);
  const undoVersion = useCallback(async (id: string) => {
    if (!project) return;
    setHistoryBusy(true);
    try {
      await flush();
      await checkpointUndo(project.root, id);
      await afterHistory();
      setNote(`Took step ${id} out. Later edits were kept.`);
    } catch (e) { setNote(String(e)); } finally { setHistoryBusy(false); }
  }, [project, flush, afterHistory]);
  const discardChange = useCallback(async (path: string) => {
    if (!project) return;
    setHistoryBusy(true);
    try {
      await flush();
      await gitDiscard(project.root, path);
      await afterHistory();
      setNote(`Discarded changes to ${path}. A step was kept first, so this can be undone from History.`);
    } catch (e) { setError(String(e)); } finally { setHistoryBusy(false); }
  }, [project, flush, afterHistory]);
  const jumpToFile = useCallback(async (relFile: string | null, line: number) => {
    if (project && relFile) { const abs = `${project.root}/${relFile}`; if (abs !== file) await selectFile(abs); }
    setMode("source"); setJumpLine(line); setJumpStamp(Date.now());
  }, [project, file, selectFile]);
  // What completions, go-to-definition and the outline read: the paper's symbols with the open buffer's labels live.
  const symbols = useMemo(() => paperSymbols(map, rel(file), source), [map, rel, file, source]);
  const assist = useMemo<AssistSources>(() => ({ bib: () => bib, symbols: () => symbols, files: () => files, currentFile: () => rel(file), goTo: jumpToFile, main: () => map?.main ?? rel(project?.mainTex ?? null), root: () => project?.root ?? null }), [bib, symbols, files, rel, file, jumpToFile, map, project]);
  const fixWithAgent = useCallback((prompt: string) => { if (!inspectorOpen) toggleInspector(); setPrefill({ text: prompt, stamp: Date.now() }); }, [inspectorOpen, toggleInspector]);
  // Hand the bibliography to the agent under the check-references skill: online lookups, fields fixed
  // from the record, doubtful entries reported rather than rewritten.
  const checkReferences = useCallback(() => {
    setSheet(null);
    fixWithAgent("Check the references: follow the check-references skill. Run its script (python3 .dabir/skills/check-references/scripts/verify_refs.py on every .bib the paper uses), fix the fields of verified entries from the records without changing citation keys, add missing DOIs, and list every mismatch and not-found entry at the top of your report for me to decide on. Also list \\cite keys with no entry and \\ref with no \\label. Do not delete or invent entries.");
  }, [fixWithAgent]);
  const jumpTo = useCallback((line: number, inSource?: boolean) => { if (inSource) setMode("source"); setJumpLine(line); setJumpStamp(Date.now()); }, []);
  const onChanged = useCallback(() => {
    // Cancel a pending autosave so a dirty buffer cannot overwrite an accepted agent change.
    if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = 0; }
    refreshGit();
    reloadProject();
    if (project) refreshVersions(project.root);
    if (file) {
      readText(file).then((t) => { setSource(t); setDirty(false); setSaveState("saved"); }).catch(() => {});
    }
  }, [refreshGit, reloadProject, file, project, refreshVersions]);

  // ⇧⌘Space: the chosen agent writes the next sentence as ghost text; Tab keeps it.
  const continueWithAgent = useCallback(async (before: string): Promise<string | null> => {
    if (!project || !file) return null;
    if (!agentReady) { setNote("No agent is signed in. Choose one in the Agent tab."); return null; }
    const provider = settings.agentProvider;
    try {
      return await agentComplete(project.root, provider, file.replace(project.root + "/", ""), before, settings.agentModel[provider] ?? "", settings.agentEffort[provider] ?? "");
    } catch (e) { setNote(String(e)); return null; }
  }, [project, file, agentReady, settings]);

  const addWord = useCallback((word: string) => {
    if (!project) return;
    const w = word.trim(); if (!w || dictionary.includes(w)) return;
    const next = [...dictionary, w].sort((a, b) => a.localeCompare(b));
    setDictionary(next);
    writeText(`${project.root}/.dabir/dictionary.txt`, next.join("\n") + "\n").catch((e) => setNote(String(e)));
  }, [project, dictionary]);

  // Review: the agent's version of the open file, read from its worktree, so the change can be read and compiled before it lands.
  useEffect(() => {
    if (!review || !file || !project) { setReviewText(null); return; }
    const r = file.slice(project.root.length + 1);
    if (!review.changes.some((c) => c.path === r && !c.binary)) { setReviewText(null); return; }
    let alive = true;
    readText(`${review.worktree}/${r}`).then((text) => { if (alive) setReviewText({ file, runId: review.runId, text }); }).catch(() => { if (alive) setReviewText(null); });
    return () => { alive = false; };
  }, [review, file, project]);
  useEffect(() => { setReviewShowing(true); }, [review?.runId]);
  // The run ended while the PDF still showed the agent's build: rebuild from the checkout.
  useEffect(() => {
    if (!review && compileState.status === "done" && compileState.agent && project?.mainTex) compileRef.current();
  }, [review]); // eslint-disable-line react-hooks/exhaustive-deps
  const docReview = useMemo<DocReview | null>(() => {
    if (!review || !project) return null;
    const r = rel(file);
    const text = reviewText && reviewText.runId === review.runId && reviewText.file === file ? reviewText.text : null;
    return {
      label: review.label, files: review.changes.map((c) => c.path), text,
      marks: text != null && r ? marksFromPatch(review.patch, r) : null,
      showing: reviewShowing, canShow: !session, busy: review.busy, working: review.working,
      onToggle: () => setReviewShowing((v) => !v),
      onOpenFile: (p) => selectFile(`${project.root}/${p}`),
      onAccept: review.accept, onReject: review.reject,
    };
  }, [review, project, file, rel, reviewText, reviewShowing, session, selectFile]);

  const cls = ["app", native ? "native" : "", isMac ? "mac" : "", navOpen ? "" : "nav-hidden", inspectorOpen ? "" : "inspector-hidden", animating ? "animating" : "", focused ? "" : "inactive", settings.focusMode ? "focus-mode" : ""].join(" ").trim();

  return (
    <div className={cls} style={{ "--nav-w": `${navW}px`, "--inspector-w": `${inspW}px` } as React.CSSProperties}>
      <Toolbar project={project} file={file} dirty={dirty} saveLabel={settings.autosave ? (saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Unsaved" : saveState === "saved" ? "Saved" : null) : null} mode={mode} navOpen={navOpen} inspectorOpen={inspectorOpen}
        compiling={compileState.status === "running"} onMode={setMode} onToggleNav={toggleNav} onToggleInspector={toggleInspector} onOpen={open} onCompile={compile} onCancelCompile={() => compileCancel()}
        onShare={() => setSheet("share")} live={!!live} terminalOpen={terminal.open} onToggleTerminal={() => command("show-terminal")} run={runRecipeNow} onRun={() => command("run-file")} />
      <Navigator project={project} current={file} outline={fileKind(file) === "code" || /\.(md|markdown)$/i.test(file ?? "") ? outline : paperOutline(map) ?? outline} git={git} commitFocus={commitFocus} busy={gitBusy || historyBusy} draftMessage={commitDraft} onDiscard={discardChange} onHistory={() => { if (!inspectorOpen) toggleInspector(); setHistoryFocus(Date.now()); }} historyCount={versions.length}
        onSelect={selectFile} onJump={(l, f) => (f ? jumpToFile(f, l) : jumpTo(l))} onInitGit={initGit} onCommit={commitAll} find={findPaper} onCloseFind={closeFindPaper} />
      <Document project={project} file={file} source={source} bib={bib} paperWords={paperWordsNow} openFiles={openFiles} dirty={dirty} onCloseFile={closeFile} headText={headText} code={codeState} mode={mode} jumpLine={jumpLine} jumpStamp={jumpStamp}
        compileState={compileState} progress={progress} showLog={showLog} onToggleLog={() => setShowLog((v) => !v)} terminal={terminal} onToggleTerminal={toggleTerminal} findRequest={findRequest}
        error={error ?? note} onDismissError={() => { setError(null); setNote(null); }} pdfTarget={pdfTarget}
        onOpen={open} onImport={importFromOverleaf} onClone={() => setSheet("clone")} onNew={openNew} onTour={startTour} onJoin={() => setSheet("share")} hostAway={hostAway} onOutline={setOutline}
        onSourceChange={onSourceChange} onSave={save} onCursorLine={onCursor} onSelectFile={selectFile} onJump={jumpTo} onPdfClick={onPdfClick}
        compileOnSave={compileOnSave} onToggleCompileOnSave={toggleCompileOnSave}
        agentReady={agentReady} onJumpFile={jumpToFile} onFix={fixWithAgent}
        collab={collab} comments={commentRanges} onSelection={(from, to) => setSelection({ from, to })} jumpOffset={jumpOffset}
        changes={changeRanges} author={me} onChanges={onEditorChanges} onToggleSuggesting={toggleSuggesting}
        settings={settings} grammar={grammar} pins={pins} pdfZoom={pdfZoom} onPdfZoom={setPdfZoom} onOpenSettings={() => setSheet("settings")}
        onPdfComment={onPdfComment} pdfFindRequest={pdfFindRequest} editorRef={editorRef} onFind={() => command("find")} onCommentSelection={() => { if (!inspectorOpen) toggleInspector(); setAskFocus(0); setNote("Type the comment in the People tab; it attaches to your selection."); }} hasSelection={selection.to > selection.from}
        review={docReview} dictionary={dictionary} onAddWord={addWord} onContinue={continueWithAgent} splitRatio={splitRatio} onSplitRatio={setSplitRatio} onPin={(id) => { const c = allComments.find((x) => x.id === id); if (c) jumpToComment(c); }}
        assist={assist} />
      <Inspector project={project} gitRepo={!!git?.isRepo} askFocus={askFocus} prefill={prefill} tabRequest={tabRequest} onProviderReady={setAgentReady} onChanged={onChanged} onBeforeRun={flush} onOpenFile={selectFile} history={versions} historyBusy={historyBusy} onRestoreStep={restoreVersion} onUndoStep={undoVersion} historyFocus={historyFocus} onNote={setNote} autoRun={autoRun} onReview={setReview}
        live={!!live} peers={peers} comments={allComments} currentFile={rel(file)} hasSelection={selection.to > selection.from} focus={agentFocus}
        changes={changeItems} suggesting={settings.suggesting} onToggleSuggesting={toggleSuggesting} onResolveChanges={resolveChange} onJumpChange={jumpToChange}
        onAddComment={(t) => addCommentAtSelection(t)} onResolveComment={resolveAnyComment} onReplyComment={replyAnyComment} onRemoveComment={removeAnyComment} onJumpComment={jumpToComment} onShare={() => setSheet("share")} />
      <div className={`divider nav ${dragging === "nav" ? "dragging" : ""}`} onPointerDown={() => setDragging("nav")} role="separator" aria-orientation="vertical" aria-label="Resize sidebar" />
      <div className={`divider inspector ${dragging === "inspector" ? "dragging" : ""}`} onPointerDown={() => setDragging("inspector")} role="separator" aria-orientation="vertical" aria-label="Resize inspector" />
      {sheet === "shortcuts" && <ShortcutSheet onClose={() => setSheet(null)} />}
      {sheet === "clone" && <CloneSheet onClose={() => setSheet(null)} onClone={cloneRepo} />}
      {sheet === "share" && (
        <ShareSheet projectName={project?.name ?? "Dabir"} live={live} overleafUrl={overleafUrl} busy={liveBusy} onClose={() => setSheet(null)}
          onStart={startSession} onJoin={joinSession} onStop={stopSession} onSetOverleaf={setOverleaf} onPull={pullOverleaf} onPush={pushOverleaf}
          onReferences={() => setSheet("refs")} onExport={() => setSheet("export")} signalingUrl={settings.signalingUrl} direct={directApi} />
      )}
      {sheet === "refs" && project && <ReferencesSheet project={project} sync={refSync} bibCount={Object.keys(bib).length} onClose={() => setSheet(null)} onChanged={onRefsChanged} agentReady={agentReady} onCheck={checkReferences} />}
      {sheet === "export" && project && <ExportSheet project={project} onClose={() => setSheet(null)} ensurePdf={ensurePdf} onNote={setNote} />}
      {sheet === "new" && <NewPaperSheet onClose={() => setSheet(null)} onCreate={createPaper} initial={newTemplate} />}
      {sheet === "settings" && <SettingsSheet onClose={() => setSheet(null)} />}
      {tour != null && <Tour steps={tourSteps} step={tour} onStep={setTour} onClose={() => setTour(null)} />}
    </div>
  );
}
