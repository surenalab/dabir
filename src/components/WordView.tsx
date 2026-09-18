// The Word view: one page-layout editor for a .docx, in place of Visual, Source and PDF. The engine is
// docx-editor on its free line (Apache-2.0: @heyirisai/docx-editor-react and -core 1.12.0, the community
// continuation of eigenpal's 1.9.0, which is the last release before the upstream 2.x line moved comments and
// tracked changes into a paid package). It lays pages out as Word does, keeps what it does not understand, and
// saves by patching only the paragraphs that changed.
//
// Saving follows the editor invariants in AGENTS.md: each document gets its own `WordDocument`, keyed by path,
// whose path never changes, so its save can only ever write that document's bytes to that path. The app
// flushes the open document before switching files, and before a run, a restore or a close.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DocxEditor, type DocxEditorRef } from "@heyirisai/docx-editor-react";
import { collectHeadings } from "@heyirisai/docx-editor-core/utils/headingCollector";
import { renderAllPagesForPrint } from "@heyirisai/docx-editor-core/layout-painter";
import editorCss from "@heyirisai/docx-editor-react/styles.css?inline";
import { printWindow, readBinary, revealPath, writeBinary } from "../lib/backend";
import { repaired, withoutStyleEchoes, withParagraphIds } from "../lib/word-package";
import { countWords, looksLikeDocx, markupWidth, pagePixels, wordOutline, wordScale, type WordMode, type WordOutlineRow, type WordZoom } from "../lib/word";

/** What the app asks of the open Word document. */
export interface WordHandle {
  /** The document this handle belongs to; it never changes. */
  readonly path: string;
  /** True while the editor holds edits that are not on disk yet. */
  dirty(): boolean;
  /** Write the edits to the document's own file, if there are any. Resolves once they are on disk. */
  flush(): Promise<boolean>;
  /** The document as it stands in the editor, as .docx bytes (for Export › Word). */
  bytes(): Promise<Uint8Array | null>;
  /** Print the pages through the system panel, whose PDF button saves a PDF. */
  print(): Promise<void>;
  /** Pass a shortcut the app's menu took (⌘B, ⌘F, ⌘K) to the editor, as if it had been typed there. */
  key(key: string, shift?: boolean): void;
}

export interface WordStats { pages: number; page: number; words: number; scale: number }

interface Props {
  path: string;
  /** Bumped when the file changed on disk under the view (History, an accepted run): the document is read again. */
  reload: number;
  mode: WordMode;
  zoom: WordZoom;
  author: string;
  /** A heading to show: the outline row's `line`, and a stamp that changes with each request. */
  jump: { line: number; stamp: number } | null;
  /** An edit landed in the document at `path`. */
  onEdit: (path: string) => void;
  /** Written to disk (or failed); `path` is always the document's own. */
  onSaved: (path: string, error: string | null) => void;
  onStats: (s: WordStats) => void;
  onOutline: (rows: WordOutlineRow[]) => void;
  onMode: (m: WordMode) => void;
  /** Where the author is, for the agent: the selected text and the paragraph around the cursor. */
  onFocus: (f: { selection: string; paragraph: string } | null) => void;
  onError: (message: string) => void;
}

// The engine's stylesheet is scoped to `.ep-root` except for a few `[contenteditable=true]` rules, which would
// reach Dabir's own editors; those are scoped here. Inserted first in <head>, so app.css maps the theme over it.
let styled = false;
function injectEditorStyles() {
  if (styled) return;
  styled = true;
  const el = document.createElement("style");
  el.dataset.source = "docx-editor";
  el.textContent = editorCss.replace(/(^|[{},])\s*\[contenteditable=true\]/g, "$1.ep-root [contenteditable=true]");
  document.head.prepend(el);
}

/** Follow the app's appearance: the data-theme override when set, the system otherwise. */
function useDark(): boolean {
  const query = useMemo(() => window.matchMedia("(prefers-color-scheme: dark)"), []);
  const read = useCallback(() => {
    const forced = document.documentElement.dataset.theme;
    return forced === "dark" || (forced !== "light" && query.matches);
  }, [query]);
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const update = () => setDark(read());
    query.addEventListener("change", update);
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { query.removeEventListener("change", update); obs.disconnect(); };
  }, [query, read]);
  return dark;
}

/** Copy the laid-out pages into a print-only root and print them; the app's chrome is hidden by the print stylesheet.
 *  The engine keeps pages nobody has scrolled to as empty shells, so the copy is taken only after
 *  `renderAllPagesForPrint` has filled every page *and waited for its images to decode*: `renderAllPagesNow`
 *  fills the shells but returns before the pictures are there, which printed a figure on page 8 as a blank. */
async function printPages(host: HTMLElement | null): Promise<void> {
  const pages = host?.querySelector<HTMLElement>(".paged-editor__pages");
  if (!pages) throw new Error("The document is not laid out yet.");
  const materialized = await renderAllPagesForPrint(pages);
  document.getElementById("word-print")?.remove();
  const root = document.createElement("div");
  root.id = "word-print";
  root.setAttribute("aria-hidden", "true");
  const copy = pages.cloneNode(true) as HTMLElement;
  copy.removeAttribute("style");
  copy.querySelectorAll<HTMLElement>(".layout-page").forEach((p) => { p.style.boxShadow = "none"; p.style.margin = "0"; });
  root.appendChild(copy);
  document.body.appendChild(root);
  const html = document.documentElement;
  html.classList.add("printing-word");
  // Once: the print panel's afterprint and a failed printWindow can both reach here, and the materialization
  // is released exactly once so the pages go back to being virtualized.
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    html.classList.remove("printing-word");
    root.remove();
    materialized.release();
  };
  window.addEventListener("afterprint", done, { once: true });
  try { await printWindow(); } catch (e) { done(); throw e; }
}

const WordDocument = forwardRef<WordHandle, Props & { dark: boolean; onRetry: () => void }>(function WordDocument(p, ref) {
  // Fixed for this component's life: the parent keys it by path.
  const [path] = useState(p.path);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // The document as the editor received it: what the author had written directly, as opposed to what a save adds.
  const asRead = useRef<Uint8Array | null>(null);
  const editor = useRef<DocxEditorRef>(null);
  const host = useRef<HTMLDivElement>(null);
  // Edits count up; a save records the count it wrote, so an edit made while saving keeps the document dirty.
  const edits = useRef(0);
  const saved = useRef(0);
  const saving = useRef<Promise<boolean> | null>(null);
  const ready = useRef(false);
  const cb = useRef(p);
  cb.current = p;

  useEffect(() => {
    let alive = true;
    const name = path.split(/[\\/]/).pop();
    readBinary(path).then(async (raw) => {
      if (!alive) return;
      if (!raw.length) { setFailed(`${name} is empty or could not be read.`); return; }
      if (!looksLikeDocx(raw)) { setFailed(`${name} is not a Word document (.docx). An older .doc, or a file renamed to .docx, opens in Word, which can save it as a .docx.`); return; }
      // Paragraph ids let a save rewrite only what changed (a document from another tool has none).
      const b = await withParagraphIds(raw).catch(() => raw);
      asRead.current = b;
      if (alive) setBytes(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    }).catch((e) => { if (alive) setFailed(String(e).replace(/^Error:\s*/, "")); });
    return () => { alive = false; };
  }, [path]);

  const serialize = useCallback(async (): Promise<Uint8Array | null> => {
    const buf = await editor.current?.save();
    if (!buf) return null;
    const fixed = await repaired(new Uint8Array(buf));
    // The engine writes each edited paragraph's style out as direct formatting on its runs; take that back, or the
    // text stops following the style and a journal's style sheet no longer reaches it.
    return withoutStyleEchoes(fixed, asRead.current).catch(() => fixed);
  }, []);

  const flush = useCallback(async (): Promise<boolean> => {
    // Wait for a save already running, and swallow its failure: it was reported through onSaved, and letting it
    // throw here would make this call give up without writing at all — ⌘S after a failed autosave has to try again.
    if (saving.current) { try { await saving.current; } catch { /* reported; this call makes its own attempt */ } }
    if (edits.current === saved.current || !ready.current) return false;
    const upTo = edits.current;
    const run = (async () => {
      try {
        const out = await serialize();
        if (!out) throw new Error("The editor could not produce the document.");
        await writeBinary(path, out);
        saved.current = Math.max(saved.current, upTo);
        cb.current.onSaved(path, null);
        return true;
      } catch (e) {
        cb.current.onSaved(path, String(e).replace(/^Error:\s*/, ""));
        throw e;
      }
    })();
    saving.current = run;
    try { return await run; } finally { if (saving.current === run) saving.current = null; }
  }, [path, serialize]);

  // Headings, words and pages, read from the editor after it settles.
  const statsTimer = useRef(0);
  const refresh = useCallback(() => {
    window.clearTimeout(statsTimer.current);
    statsTimer.current = window.setTimeout(() => {
      const ed = editor.current;
      const view = ed?.getEditorRef()?.getView();
      if (!ed || !view) return;
      const doc = view.state.doc;
      cb.current.onOutline(wordOutline(collectHeadings(doc)));
      cb.current.onStats({ pages: ed.getTotalPages(), page: ed.getCurrentPage(), words: countWords(doc.textBetween(0, doc.content.size, "\n", " ")), scale: ed.getZoom() });
      const sel = ed.getSelectionInfo();
      cb.current.onFocus(sel ? { selection: sel.selectedText.slice(0, 1200), paragraph: sel.paragraphText.slice(0, 1200) } : null);
    }, 250);
  }, []);
  useEffect(() => () => window.clearTimeout(statsTimer.current), []);

  useImperativeHandle(ref, () => ({
    path,
    dirty: () => edits.current !== saved.current,
    flush,
    bytes: serialize,
    print: () => printPages(host.current),
    key: (key, shift = false) => {
      const target = editor.current?.getEditorRef()?.getView()?.dom;
      if (!target) return;
      const mac = /Mac/.test(navigator.platform);
      const init = { key, code: `Key${key.toUpperCase()}`, metaKey: mac, ctrlKey: !mac, shiftKey: shift, bubbles: true, cancelable: true };
      target.dispatchEvent(new KeyboardEvent("keydown", init));
    },
  }), [path, flush, serialize]);

  // Zoom: a fixed scale as given; fit width and whole page follow the pane's size.
  const zoom = p.zoom;
  const applyZoom = useCallback(() => {
    const ed = editor.current, el = host.current;
    if (!ed || !el) return;
    const sect = ed.getDocument()?.package.document?.finalSectionProperties;
    const scroller = el.querySelector<HTMLElement>(".docx-editor__scroll-container") ?? el;
    const scale = wordScale(zoom, pagePixels(sect?.pageWidth, sect?.pageHeight), { w: scroller.clientWidth, h: scroller.clientHeight });
    if (Math.abs(ed.getZoom() - scale) > 0.004) ed.setZoom(scale);
    refresh();
  }, [zoom, refresh]);
  useEffect(() => { if (ready.current) applyZoom(); }, [applyZoom]);
  useEffect(() => {
    const el = host.current;
    if (!el || typeof zoom === "number") return;
    const obs = new ResizeObserver(() => { if (ready.current) applyZoom(); });
    obs.observe(el);
    return () => obs.disconnect();
  }, [applyZoom, zoom, bytes]);

  // The outline asked for a heading.
  const jump = p.jump;
  useEffect(() => {
    if (!jump || !ready.current) return;
    const view = editor.current?.getEditorRef()?.getView();
    const h = view ? collectHeadings(view.state.doc)[jump.line - 1] : null;
    if (h) editor.current?.scrollToPosition(h.pmPos);
  }, [jump]);

  // Page number while scrolling.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onScroll = () => refresh();
    el.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => el.removeEventListener("scroll", onScroll, { capture: true });
  }, [refresh]);

  // Comment and change cards sit in a column beside the page, and the engine then lays out the page and the column at
  // full size (about 1,190 px for A4) whatever the zoom. The engine opens the column by itself (on load, on a new
  // suggestion); that is let through only where it fits, so the page never slides out of view while typing. A click on
  // one of the editor's buttons (the comments toggle, Comment) opens it anywhere, and the pane scrolls sideways to it.
  const [markup, setMarkup] = useState(false);
  // When the author last clicked one of the editor's buttons (never, to begin with: performance.now() starts at 0).
  const clickedAt = useRef(Number.NEGATIVE_INFINITY);
  const onMarkup = useCallback((open: boolean) => {
    const asked = performance.now() - clickedAt.current < 1000;
    if (open && !asked) {
      const el = host.current?.querySelector<HTMLElement>(".docx-editor__scroll-container") ?? host.current;
      const sect = editor.current?.getDocument()?.package.document?.finalSectionProperties;
      if ((el?.clientWidth ?? 0) < markupWidth(pagePixels(sect?.pageWidth, sect?.pageHeight).w)) return;
    }
    setMarkup(open);
  }, []);
  // The editor's File › Save would download a copy (to ~/Downloads in the app); here it saves the document itself.
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    const item = (e.target as Element).closest("[role=menubar] button");
    if (item?.querySelector("span")?.textContent?.trim() !== "Save") return;
    e.stopPropagation(); e.preventDefault();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    flush().catch(() => { /* reported through onSaved */ });
  }, [flush]);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as Element).closest("button, [role=button], [role=menuitem]")) clickedAt.current = performance.now();
  }, []);

  const onReady = useCallback(() => {
    // The first layout lands a moment after the view exists; edits before that are the load itself.
    window.setTimeout(() => { ready.current = true; applyZoom(); }, 0);
  }, [applyZoom]);
  const onChange = useCallback(() => {
    if (!ready.current) return;
    edits.current += 1;
    cb.current.onEdit(path);
    refresh();
  }, [path, refresh]);

  if (failed) {
    return (
      <div className="doc-empty" role="alert">
        <div className="card">
          <p>{failed}</p>
          <div className="actions">
            <button className="btn" onClick={p.onRetry}>Try Again</button>
            <button className="btn" onClick={() => void revealPath(path)}>Reveal</button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="word-host" ref={host} onPointerDownCapture={onPointerDown} onClickCapture={onClickCapture} data-markup={markup ? "open" : "closed"}>
      {bytes ? (
        <DocxEditor
          ref={editor}
          documentBuffer={bytes}
          mode={p.mode}
          onModeChange={(m) => cb.current.onMode(m)}
          author={p.author}
          colorMode={p.dark ? "dark" : "light"}
          className="word-editor"
          showFileOpen={false}
          showHelpMenu={false}
          showZoomControl={false}
          showOutlineButton={false}
          initialZoom={typeof zoom === "number" ? zoom : 1}
          onEditorViewReady={onReady}
          onChange={onChange}
          onSelectionChange={refresh}
          commentsSidebarOpen={markup}
          onCommentsSidebarOpenChange={onMarkup}
          renderLogo={() => null}
          onPrint={() => { printPages(host.current).catch((e) => cb.current.onError(String(e))); }}
          onError={(e) => cb.current.onError(e.message)}
          loadingIndicator={<div className="word-loading" role="status">Opening {path.split(/[\\/]/).pop()}…</div>}
        />
      ) : <div className="word-loading" role="status">Opening {path.split(/[\\/]/).pop()}…</div>}
    </div>
  );
});

/** The Word view for `path`; a new path mounts a new document, so nothing of the previous one can reach it. */
export const WordView = forwardRef<WordHandle, Props>(function WordView(props, ref) {
  useLayoutEffect(injectEditorStyles, []);
  const dark = useDark();
  const [attempt, setAttempt] = useState(0);
  return (
    <div className="word-view">
      <WordDocument key={`${props.path}#${props.reload}#${attempt}`} ref={ref} {...props} dark={dark} onRetry={() => setAttempt((n) => n + 1)} />
    </div>
  );
});

export default WordView;
