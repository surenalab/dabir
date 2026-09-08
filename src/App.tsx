import { useCallback, useEffect, useRef, useState } from "react";
import { Toolbar, type ViewMode } from "./components/Toolbar";
import { Navigator } from "./components/Navigator";
import { Document } from "./components/Document";
import { Inspector } from "./components/Inspector";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { CloneSheet } from "./components/CloneSheet";
import { ShareSheet, type LiveState } from "./components/ShareSheet";
import { NewPaperSheet } from "./components/NewPaperSheet";
import { SettingsSheet } from "./components/SettingsSheet";
import type { EditorApi } from "./components/SourceEditor";
import { useSettings, updateSettings } from "./lib/settings";
import { checkGrammar, type GrammarMatch } from "./lib/grammar";
import { collectLabels } from "./lib/completions";
import type { PdfPin, PdfZoom } from "./components/PdfView";
import type { ManualProvider } from "./lib/manual";
import { addComment as yAddComment, connect as yConnect, decodeRange, disconnect as yDisconnect, encodeRange, peers as yPeers, randomRoom, removeComment as yRemoveComment, resolveComment as yResolveComment, setCurrentFile, textFor, whenSynced, type Comment, type Peer, type Session, type Transport, markHost, hostPresent, publishProject, republishChanged, awaitSnapshot, sharedTexts, persist } from "./lib/collab";
import type { CommentRange } from "./components/SourceEditor";
import {
  bibImportFile, checkForUpdates, projectSnapshot, sessionMaterialize, newPaper, zoteroImport, compile as runCompile, compileCancel, gitClone, gitPull, gitPush, gitRemoteAdd, gitRemoteUrl, isMac, onCompileProgress, relayStart, relayStop, gitCommit, gitInit, gitStatus, importOverleaf, native, onMenu, onWindowFocus,
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
  const [progress, setProgress] = useState<string | null>(null);
  const [pdfTarget, setPdfTarget] = useState<(PdfPos & { stamp: number }) | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [focused, setFocused] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"shortcuts" | "clone" | "share" | "new" | "settings" | null>(null);
  const settings = useSettings();
  const [grammar, setGrammar] = useState<GrammarMatch[]>([]);
  const [localComments, setLocalComments] = useState<Comment[]>([]);
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
    gitRemoteUrl(p.root, "overleaf").then(setOverleafUrl).catch(() => setOverleafUrl(null));
    readText(`${p.root}/.dabir/comments.json`).then((t) => setLocalComments(t ? JSON.parse(t) : [])).catch(() => setLocalComments([]));
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

  const createPaper = useCallback(async (name: string, template: string) => {
    const parent = await pickFolder("Choose where to create the paper");
    if (!parent) return;
    const dest = await newPaper(parent, name, template);
    await openFolder(dest);
    setNote("New paper created with Git and memory set up.");
  }, [openFolder]);
  const importZotero = useCallback(async () => { if (!project) return; setLiveBusy("zotero"); try { setNote(await zoteroImport(project.root)); await reloadProject(); } finally { setLiveBusy(null); } }, [project, reloadProject]);
  const importBib = useCallback(async () => { if (!project) return; const r = await bibImportFile(project.root); if (r) { setNote(r); await reloadProject(); } }, [project, reloadProject]);

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
      setCompileState({ status: "done", at: Date.now(), result: { ok: false, pdf: null, log: String(e), engine: "", millis: 0, diagnostics: [{ severity: "error", category: "other", file: null, line: null, message: String(e), context: null }] } });
    }
  }, [project, dirty, file, compileState.status]);
  compileRef.current = compile;
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

  const attachSession = useCallback((sess: Session) => {
    setSession(sess);
    (window as unknown as { __session?: Session }).__session = sess; // for automated tests
    seenHost.current = sess.host;
    setHostAway(false);
    persist(sess).then((u) => { unpersist.current = u; }).catch(() => {});
    const refresh = () => {
      setPeers(yPeers(sess));
      if (!sess.host) { const here = hostPresent(sess); if (here) seenHost.current = true; setHostAway(seenHost.current && !here); }
    };
    sess.awareness.on("change", refresh);
    const onComments = () => setComments(sess.comments.toArray());
    sess.comments.observe(onComments);
    refresh(); onComments();
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
    setSession(null); setPeers([]); setComments([]); setLive(null); setHostAway(false);
    if (live?.host && live.transport === "relay") await relayStop();
    // The host's checkout is the record of the session: suggest the commit.
    if (live?.host) { setCommitDraft(`Live session${names.length ? ` with ${names.join(", ")}` : ""}`); setNavOpen(true); }
  }, [session, live, peers]);

  // Every client writes shared files it does not have open to its own disk, so the host's checkout
  // and each joiner's mirror stay complete even for files only somebody else is editing.
  useEffect(() => { projectRef.current = project; fileRef.current = file; }, [project, file]);
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
  const localRange = useCallback((c: Comment): { from: number; to: number } | null => {
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
  const rangeOf = useCallback((c: Comment) => (session ? decodeRange(session.doc, c) : localRange(c)), [session, localRange]);

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
  const command = useCallback((id: string) => {
    switch (id) {
      case "open": open(); break;
      case "new": setSheet("new"); break;
      case "import-overleaf": importFromOverleaf(); break;
      case "clone": setSheet("clone"); break;
      case "share": setSheet("share"); break;
      case "save": save(); break;
      case "compile": compile(); break;
      case "show-log": setShowLog((v) => !v); break;
      case "sync-pdf": showInPdf(); break;
      case "commit": if (!navOpen) toggleNav(); setCommitFocus((n) => n + 1); break;
      case "view-visual": setMode("visual"); break;
      case "view-source": setMode("source"); break;
      case "view-pdf": setMode("pdf"); break;
      case "view-split": setMode("split"); break;
      case "fmt-bold": editorRef.current?.wrap("\\textbf{", "}"); break;
      case "fmt-italic": editorRef.current?.wrap("\\textit{", "}"); break;
      case "fmt-emph": editorRef.current?.wrap("\\emph{", "}"); break;
      case "fmt-code": editorRef.current?.wrap("\\texttt{", "}"); break;
      case "fmt-section": case "fmt-subsection": case "fmt-subsubsection": editorRef.current?.heading(id.slice(4)); break;
      case "fmt-itemize": editorRef.current?.list("itemize"); break;
      case "fmt-enumerate": editorRef.current?.list("enumerate"); break;
      case "fmt-math": editorRef.current?.wrap("$", "$"); break;
      case "fmt-equation": editorRef.current?.block("\\begin{equation}\n  ", "\n  \\label{eq:}\n\\end{equation}"); break;
      case "fmt-figure": editorRef.current?.block("\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=\\linewidth]{", "}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}"); break;
      case "fmt-table": editorRef.current?.block("\\begin{table}[t]\n  \\caption{}\n  \\label{tab:}\n  \\centering\n  \\begin{tabular}{lcc}\n    \\toprule\n    ", " & & \\\\\n    \\midrule\n     & & \\\\\n    \\bottomrule\n  \\end{tabular}\n\\end{table}"); break;
      case "fmt-cite": editorRef.current?.complete("\\cite{", "}"); break;
      case "fmt-ref": editorRef.current?.complete("\\ref{", "}"); break;
      case "fmt-link": editorRef.current?.wrap("\\href{https://}{", "}"); break;
      case "fmt-footnote": editorRef.current?.wrap("\\footnote{", "}"); break;
      case "toggle-sidebar": toggleNav(); break;
      case "toggle-inspector": toggleInspector(); break;
      case "ask-agent": if (!inspectorOpen) toggleInspector(); setAskFocus((n) => n + 1); break;
      case "find": if (mode === "pdf") setPdfFindRequest((n) => n + 1); else { if (mode === "visual") setMode("source"); setFindRequest((n) => n + 1); } break;
      case "shortcuts": setSheet((v) => (v === "shortcuts" ? null : "shortcuts")); break;
      case "settings": setSheet("settings"); break;
      case "zoom-in": setPdfZoom((z) => Math.min(4, (typeof z === "number" ? z : 1) * 1.18)); if (mode !== "pdf" && mode !== "split") setMode("pdf"); break;
      case "zoom-out": setPdfZoom((z) => Math.max(0.3, (typeof z === "number" ? z : 1) * 0.85)); break;
      case "zoom-fit": setPdfZoom("fit"); break;
      case "check-grammar": runGrammar(); break;
      case "check-updates":
        checkForUpdates(async (v, notes) => window.confirm(`Dabir ${v} is available.\n\n${notes}\n\nDownload and restart now?`)).then(setNote).catch((e) => setNote(String(e)));
        break;
    }
  }, [open, importFromOverleaf, save, compile, showInPdf, toggleNav, toggleInspector, inspectorOpen, navOpen, runGrammar, mode]);

  useEffect(() => onMenu(command), [command]);
  useEffect(() => onCompileProgress((line) => setProgress(line.length > 90 ? line.slice(0, 87) + "…" : line)), []);
  useEffect(() => { if (compileState.status !== "running") setProgress(null); }, [compileState.status]);
  useEffect(() => onWindowFocus((f) => { setFocused(f); if (f) refreshGit(); }), [refreshGit]);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 6000); return () => clearTimeout(t); }, [note]);

  // Keyboard fallback for the browser preview only; the native app owns accelerators through its menu.
  useEffect(() => {
    if (native) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const k = e.key.toLowerCase();
      const map: Record<string, string> = { o: "open", n: "new", s: "save", b: "compile", "1": "view-visual", "2": "view-source", "3": "view-pdf", "4": "view-split", j: "ask-agent", f: "find", "/": "shortcuts", ",": "settings", k: "fmt-link" };
      const shifted: Record<string, string> = { g: "check-grammar", b: "fmt-bold", i: "fmt-italic", e: "fmt-emph", m: "fmt-math", c: "fmt-cite", r: "fmt-ref", l: "show-log", j: "sync-pdf", s: "share", o: "clone" };
      if (e.shiftKey && !e.altKey && shifted[k]) { e.preventDefault(); command(shifted[k]); return; }
      if (e.altKey && k === "c") { e.preventDefault(); command("commit"); return; }
      if (k === "=" || k === "+") { e.preventDefault(); command("zoom-in"); return; }
      if (k === "-") { e.preventDefault(); command("zoom-out"); return; }
      if (k === "0") { e.preventDefault(); command("zoom-fit"); return; }
      if (e.ctrlKey && k === "s") { e.preventDefault(); command("toggle-sidebar"); return; }
      if (e.altKey && (k === "i" || e.code === "KeyI")) { e.preventDefault(); command("toggle-inspector"); return; }
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
  const jumpToFile = useCallback(async (relFile: string | null, line: number) => {
    if (project && relFile) { const abs = `${project.root}/${relFile}`; if (abs !== file) await selectFile(abs); }
    setMode("source"); setJumpLine(line); setJumpStamp(Date.now());
  }, [project, file, selectFile]);
  const fixWithAgent = useCallback((prompt: string) => { if (!inspectorOpen) toggleInspector(); setPrefill({ text: prompt, stamp: Date.now() }); }, [inspectorOpen, toggleInspector]);
  const jumpTo = useCallback((line: number, inSource?: boolean) => { if (inSource) setMode("source"); setJumpLine(line); setJumpStamp(Date.now()); }, []);
  const onChanged = useCallback(() => { refreshGit(); reloadProject(); if (file) readText(file).then((t) => { if (!dirty) setSource(t); }).catch(() => {}); }, [refreshGit, reloadProject, file, dirty]);

  const cls = ["app", native ? "native" : "", isMac ? "mac" : "", navOpen ? "" : "nav-hidden", inspectorOpen ? "" : "inspector-hidden", animating ? "animating" : "", focused ? "" : "inactive"].join(" ").trim();

  return (
    <div className={cls} style={{ "--nav-w": `${navW}px`, "--inspector-w": `${inspW}px` } as React.CSSProperties}>
      <Toolbar project={project} file={file} dirty={dirty} mode={mode} navOpen={navOpen} inspectorOpen={inspectorOpen}
        compiling={compileState.status === "running"} onMode={setMode} onToggleNav={toggleNav} onToggleInspector={toggleInspector} onOpen={open} onCompile={compile} onCancelCompile={() => compileCancel()}
        onShare={() => setSheet("share")} live={!!live} />
      <Navigator project={project} current={file} outline={outline} git={git} commitFocus={commitFocus} busy={gitBusy} draftMessage={commitDraft}
        onSelect={selectFile} onJump={(l) => jumpTo(l)} onInitGit={initGit} onCommit={commitAll} />
      <Document project={project} file={file} source={source} bib={bib} mode={mode} jumpLine={jumpLine} jumpStamp={jumpStamp}
        compileState={compileState} progress={progress} showLog={showLog} onToggleLog={() => setShowLog((v) => !v)} findRequest={findRequest}
        error={error ?? note} onDismissError={() => { setError(null); setNote(null); }} pdfTarget={pdfTarget}
        onOpen={open} onImport={importFromOverleaf} onClone={() => setSheet("clone")} onNew={() => setSheet("new")} onJoin={() => setSheet("share")} hostAway={hostAway} onOutline={setOutline}
        onSourceChange={onSourceChange} onSave={save} onCursorLine={setCursorLine} onSelectFile={selectFile} onJump={jumpTo} onPdfClick={onPdfClick}
        compileOnSave={compileOnSave} onToggleCompileOnSave={toggleCompileOnSave}
        agentReady={agentReady} onJumpFile={jumpToFile} onFix={fixWithAgent}
        collab={collab} comments={commentRanges} onSelection={(from, to) => setSelection({ from, to })} jumpOffset={jumpOffset}
        settings={settings} grammar={grammar} pins={pins} pdfZoom={pdfZoom} onPdfZoom={setPdfZoom} onOpenSettings={() => setSheet("settings")}
        onPdfComment={onPdfComment} pdfFindRequest={pdfFindRequest} editorRef={editorRef} onFind={() => command("find")} onCommentSelection={() => { if (!inspectorOpen) toggleInspector(); setAskFocus(0); setNote("Type the comment in the People tab; it attaches to your selection."); }} hasSelection={selection.to > selection.from}
        splitRatio={splitRatio} onSplitRatio={setSplitRatio} onPin={(id) => { const c = allComments.find((x) => x.id === id); if (c) jumpToComment(c); }}
        completions={{ bib: () => bib, labels: () => (source ? collectLabels(source) : []), files: () => project?.tree ?? [] }} />
      <Inspector project={project} gitRepo={!!git?.isRepo} askFocus={askFocus} prefill={prefill} onProviderReady={setAgentReady} onChanged={onChanged} onOpenFile={selectFile} onNote={setNote}
        live={!!live} peers={peers} comments={allComments} currentFile={rel(file)} hasSelection={selection.to > selection.from}
        onAddComment={(t) => addCommentAtSelection(t)} onResolveComment={resolveAnyComment} onRemoveComment={removeAnyComment} onJumpComment={jumpToComment} onShare={() => setSheet("share")} />
      <div className={`divider nav ${dragging === "nav" ? "dragging" : ""}`} onPointerDown={() => setDragging("nav")} role="separator" aria-orientation="vertical" aria-label="Resize sidebar" />
      <div className={`divider inspector ${dragging === "inspector" ? "dragging" : ""}`} onPointerDown={() => setDragging("inspector")} role="separator" aria-orientation="vertical" aria-label="Resize inspector" />
      {sheet === "shortcuts" && <ShortcutSheet onClose={() => setSheet(null)} />}
      {sheet === "clone" && <CloneSheet onClose={() => setSheet(null)} onClone={cloneRepo} />}
      {sheet === "share" && (
        <ShareSheet projectName={project?.name ?? "Dabir"} live={live} overleafUrl={overleafUrl} busy={liveBusy} onClose={() => setSheet(null)}
          onStart={startSession} onJoin={joinSession} onStop={stopSession} onSetOverleaf={setOverleaf} onPull={pullOverleaf} onPush={pushOverleaf}
          onZotero={importZotero} onBibFile={importBib} signalingUrl={settings.signalingUrl} direct={directApi} />
      )}
      {sheet === "new" && <NewPaperSheet onClose={() => setSheet(null)} onCreate={createPaper} />}
      {sheet === "settings" && <SettingsSheet onClose={() => setSheet(null)} />}
    </div>
  );
}
