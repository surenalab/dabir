import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus, Search, X } from "lucide-react";
import { readBinary, type PdfPos } from "../lib/backend";
import { chord } from "../lib/keys";
import { stepZoom, type Anchor, type PdfZoom } from "../lib/pdf-layout";
import { PdfPages, type PdfHits, type PdfPin } from "../lib/pdf-pages";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

export type { PdfPin, PdfZoom };

interface Props {
  path: string | null;
  stamp: number;
  target: (PdfPos & { stamp: number }) | null;   // forward sync: highlight this spot
  pins: PdfPin[];
  zoom: PdfZoom;
  onZoom: (z: PdfZoom) => void;
  /** The first page's scale on screen, whenever it changes (fit modes included). */
  onScale?: (scale: number) => void;
  onJump: (page: number, xPt: number, yPt: number) => void;      // double-click: go to source
  onComment: (page: number, xPt: number, yPt: number) => void;   // Option-click: comment here
  onPin: (id: string) => void;
  findRequest: number;
}

const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** Where the reader was when the view last closed: switching to Visual and back mounts it afresh. */
let lastPlace: { path: string; place: Anchor } | null = null;

export function PdfView({ path, stamp, target, pins, zoom, onZoom, onScale, onJump, onComment, onPin, findRequest }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const outer = useRef<HTMLDivElement>(null);
  const viewer = useRef<PdfPages | null>(null);
  const loaded = useRef<{ task: pdfjs.PDFDocumentLoadingTask; path: string } | null>(null);
  const handlers = useRef({ onZoom, onScale, onPin });
  useEffect(() => { handlers.current = { onZoom, onScale, onPin }; });
  const [note, setNote] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState(1);
  const [docKey, setDocKey] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PdfHits[]>([]);
  const findInput = useRef<HTMLInputElement>(null);

  // The page stack lives outside React (src/lib/pdf-pages.ts); this component owns the toolbar and the props.
  useLayoutEffect(() => {
    const v = new PdfPages(outer.current!, host.current!, {
      page: setCurrent,
      scale: (s) => handlers.current.onScale?.(s),
      commit: (z) => handlers.current.onZoom(z),
    });
    viewer.current = v;
    return () => {
      const l = loaded.current;
      if (l && v.where) lastPlace = { path: l.path, place: v.where };
      v.destroy();
      l?.task.destroy().catch(() => {});
      viewer.current = null; loaded.current = null;
    };
  }, []);

  useEffect(() => { viewer.current?.setZoom(zoom); }, [zoom]);

  // Load each build. The previous one stays on screen until the new one is laid out, and the reader keeps their place.
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    const drop = (message: string) => {
      v.clear(); setTotal(0); setNote(message);
      loaded.current?.task.destroy().catch(() => {}); loaded.current = null;
    };
    if (!path) { drop(chord("Compile the paper (⌘B) to see its PDF here. Select text to copy it, double-click to go to the source line, Option-click to comment there.")); return; }
    let cancelled = false;
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    (async () => {
      try {
        const bytes = await readBinary(path);
        if (cancelled) return;
        if (bytes.length === 0) { drop("The compiled PDF is only available in the desktop app."); return; }
        task = pdfjs.getDocument({ data: bytes });
        const doc = await task.promise;
        // Every page's size first (cheap), so the whole document is laid out before anything is drawn.
        const proxies = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
        if (cancelled || viewer.current !== v) return;
        const place = v.count ? v.where : lastPlace?.path === path ? lastPlace.place : null;
        v.show(proxies, place);
        const previous = loaded.current;
        loaded.current = { task, path };
        task = null;
        previous?.task.destroy().catch(() => {});
        setNote(null); setTotal(doc.numPages); setDocKey((k) => k + 1);
      } catch (e) { if (!cancelled) drop(`Could not render the PDF: ${String(e)}`); }
    })();
    return () => { cancelled = true; task?.destroy().catch(() => {}); };
  }, [path, stamp]);

  // Forward sync: mark the line and bring it into view.
  useEffect(() => { if (target) viewer.current?.mark(target); }, [target]);

  // Comment pins.
  useEffect(() => { viewer.current?.setPins(pins, (id) => handlers.current.onPin(id)); }, [pins]);

  // Find in the PDF text: highlight matching spans on drawn pages, count on all of them.
  useEffect(() => { if (findRequest) { setFindOpen(true); setTimeout(() => findInput.current?.focus(), 50); } }, [findRequest]);
  // A new query scrolls to its first hit; a new build keeps the reader where they are.
  const searched = useRef("");
  useEffect(() => {
    let alive = true;
    const reveal = query !== searched.current;
    searched.current = query;
    viewer.current?.search(query, reveal).then((h) => { if (alive && h) setHits(h); });
    return () => { alive = false; };
  }, [query, docKey]);

  const goto = (n: number) => viewer.current?.goto(n);
  /**
   * A zoom the reader asked for, told to the view as well as to the parent: a pinch leaves the parent's zoom
   * untouched until it settles, so asking for the value the parent already holds ("Fit width" right after a pinch)
   * changes no prop and would otherwise reach nothing.
   */
  const zoomTo = (z: PdfZoom) => { viewer.current?.setZoom(z); onZoom(z); };
  const shown = () => viewer.current?.scale ?? 1;
  const at = (e: React.MouseEvent) => viewer.current?.locate(e.target, e.clientX, e.clientY) ?? null;
  const onClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".pdf-pin, .pdf-bar")) return;
    if (!e.altKey) return; // plain clicks select text; nothing else happens
    const p = at(e); if (p) onComment(p.page, p.x, p.y);
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".pdf-pin, .pdf-bar")) return;
    const p = at(e); if (p) { window.getSelection()?.removeAllRanges(); onJump(p.page, p.x, p.y); }
  };

  const totalHits = hits.reduce((n, h) => n + h.count, 0);

  return (
    <div className="pdf-wrap">
      {total > 0 && (
        <div className="pdf-bar" role="toolbar" aria-label="PDF controls">
          <div className="group">
            <button className="tb-btn icon" onClick={() => goto(current - 1)} disabled={current <= 1} aria-label="Previous page"><ChevronLeft /></button>
            <span className="pageno"><input type="number" min={1} max={total} value={current} onChange={(e) => { const n = Number(e.target.value); if (n >= 1 && n <= total) goto(n); }} aria-label="Page number" /> / {total}</span>
            <button className="tb-btn icon" onClick={() => goto(current + 1)} disabled={current >= total} aria-label="Next page"><ChevronRight /></button>
          </div>
          <div className="group">
            <button className="tb-btn icon" onClick={() => zoomTo(stepZoom(shown(), -1))} aria-label="Zoom out" title={chord("Zoom out (⌘−)")}><Minus /></button>
            <select className="zoomsel" value={typeof zoom === "number" ? String(zoom) : zoom} onChange={(e) => { const v = e.target.value; zoomTo(v === "fit" || v === "page" ? v : Number(v)); }} aria-label="Zoom level">
              <option value="fit">Fit width</option>
              <option value="page">Fit page</option>
              {PRESETS.map((z) => <option key={z} value={String(z)}>{Math.round(z * 100)}%</option>)}
              {typeof zoom === "number" && !PRESETS.includes(zoom) && <option value={String(zoom)}>{Math.round(zoom * 100)}%</option>}
            </select>
            <button className="tb-btn icon" onClick={() => zoomTo(stepZoom(shown(), 1))} aria-label="Zoom in" title={chord("Zoom in (⌘=)")}><Plus /></button>
            <button className="tb-btn icon" onClick={() => zoomTo(zoom === "fit" ? "page" : "fit")} aria-label="Fit" title={zoom === "fit" ? "Fit page" : chord("Fit width (⌘0)")}><Maximize2 /></button>
          </div>
          <div className="group">
            <button className={`tb-btn icon ${findOpen ? "active" : ""}`} onClick={() => { setFindOpen((v) => !v); setTimeout(() => findInput.current?.focus(), 50); }} aria-label="Find in PDF" title={chord("Find in PDF (⌘F)")} aria-pressed={findOpen}><Search /></button>
            {findOpen && (
              <span className="pdf-find">
                <input ref={findInput} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find in PDF" aria-label="Find in PDF"
                  onKeyDown={(e) => { if (e.key === "Escape") { setFindOpen(false); setQuery(""); } if (e.key === "Enter" && hits.length) goto(hits[0].page); }} />
                <span className="hits">{query ? `${totalHits} on ${hits.length} page${hits.length === 1 ? "" : "s"}` : ""}</span>
                <button className="tb-btn icon" onClick={() => { setFindOpen(false); setQuery(""); }} aria-label="Close find"><X /></button>
              </span>
            )}
          </div>
        </div>
      )}
      <div className="pdf" ref={outer} onClick={onClick} onDoubleClick={onDoubleClick} aria-label={total ? `${total} page PDF` : undefined}>
        <div className="pdf-pages" ref={host} />
        {note && <p className="note">{note}</p>}
      </div>
    </div>
  );
}
