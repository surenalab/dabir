import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus, Search, X } from "lucide-react";
import { readBinary, type PdfPos } from "../lib/backend";
import { chord } from "../lib/keys";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

export interface PdfPin { id: string; page: number; y: number; color: string; n: number; resolved: boolean; title: string }
export type PdfZoom = number | "fit" | "page";

interface Props {
  path: string | null;
  stamp: number;
  target: (PdfPos & { stamp: number }) | null;   // forward sync: highlight this spot
  pins: PdfPin[];
  zoom: PdfZoom;
  onZoom: (z: PdfZoom) => void;
  onJump: (page: number, xPt: number, yPt: number) => void;      // double-click: go to source
  onComment: (page: number, xPt: number, yPt: number) => void;   // Option-click: comment here
  onPin: (id: string) => void;
  findRequest: number;
}

const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

export function PdfView({ path, stamp, target, pins, zoom, onZoom, onJump, onComment, onPin, findRequest }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const outer = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pages, setPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState(1);
  const docRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const taskRef = useRef<pdfjs.PDFDocumentLoadingTask | null>(null);
  const [docStamp, setDocStamp] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ page: number; count: number }[]>([]);
  const findInput = useRef<HTMLInputElement>(null);

  // Load the document once per compile.
  useEffect(() => {
    let cancelled = false;
    taskRef.current?.destroy().catch(() => {});
    taskRef.current = null; docRef.current = null;
    setPages(0); setTotal(0);
    if (!path) { setNote(chord("Compile the paper (⌘B) to see its PDF here. Select text to copy it, double-click to go to the source line, Option-click to comment there.")); host.current?.replaceChildren(); return; }
    setNote(null);
    (async () => {
      try {
        const bytes = await readBinary(path);
        if (bytes.length === 0) { setNote("The compiled PDF is only available in the desktop app."); return; }
        const task = pdfjs.getDocument({ data: bytes });
        const doc = await task.promise;
        if (cancelled) { task.destroy(); return; }
        taskRef.current = task; docRef.current = doc;
        setTotal(doc.numPages);
        setDocStamp(Date.now());
      } catch (e) { if (!cancelled) setNote(`Could not render the PDF: ${String(e)}`); }
    })();
    return () => { cancelled = true; };
  }, [path, stamp]);

  // Render pages at the current zoom, with a selectable text layer on each.
  useEffect(() => {
    const doc = docRef.current, el = host.current;
    if (!doc || !el) return;
    let cancelled = false;
    const keepScroll = outer.current ? outer.current.scrollTop / Math.max(1, outer.current.scrollHeight) : 0;
    el.replaceChildren();
    (async () => {
      const availW = (outer.current?.clientWidth ?? 800) - 32;
      const availH = (outer.current?.clientHeight ?? 800) - 24;
      const dpr = window.devicePixelRatio || 1;
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const scale = zoom === "fit" ? Math.max(0.3, Math.min(availW, 1600) / base.width)
          : zoom === "page" ? Math.max(0.3, Math.min(availW / base.width, availH / base.height))
          : zoom;
        const viewport = page.getViewport({ scale });
        const wrap = document.createElement("div");
        wrap.className = "pdf-page";
        wrap.dataset.page = String(n);
        wrap.dataset.scale = String(scale);
        wrap.style.width = `${viewport.width}px`;
        wrap.style.height = `${viewport.height}px`;
        const canvas = document.createElement("canvas");
        const hi = page.getViewport({ scale: scale * dpr });
        canvas.width = hi.width; canvas.height = hi.height;
        canvas.style.width = "100%"; canvas.style.height = "100%";
        canvas.setAttribute("aria-label", `Page ${n} of ${doc.numPages}`);
        wrap.appendChild(canvas);
        const text = document.createElement("div");
        text.className = "textLayer";
        wrap.appendChild(text);
        el.appendChild(wrap);
        await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport: hi }).promise;
        if (cancelled) return;
        try {
          const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
          await layer.render();
        } catch { /* text layer is a convenience; the page still shows */ }
        if (!cancelled) setPages(n);
      }
      if (outer.current && keepScroll) outer.current.scrollTop = keepScroll * outer.current.scrollHeight;
    })();
    return () => { cancelled = true; };
  }, [docStamp, zoom]);

  // Track the page in view.
  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const onScroll = () => {
      const mid = el.scrollTop + el.clientHeight / 3;
      let best = 1;
      el.querySelectorAll<HTMLElement>(".pdf-page").forEach((p) => { if (p.offsetTop <= mid) best = Number(p.dataset.page); });
      setCurrent(best);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [pages]);

  const goto = useCallback((n: number) => {
    const page = host.current?.querySelector<HTMLElement>(`.pdf-page[data-page="${Math.max(1, Math.min(total, n))}"]`);
    page?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [total]);

  // Forward sync: scroll to the page and draw a marker at the line's position.
  useEffect(() => {
    if (!target || !host.current) return;
    const page = host.current.querySelector<HTMLElement>(`.pdf-page[data-page="${target.page}"]`);
    if (!page) return;
    host.current.querySelectorAll(".pdf-marker").forEach((m) => m.remove());
    const scale = Number(page.dataset.scale || 1);
    const marker = document.createElement("div");
    marker.className = "pdf-marker";
    marker.style.top = `${target.y * scale - 10}px`;
    page.appendChild(marker);
    const r = page.getBoundingClientRect(), o = outer.current!.getBoundingClientRect();
    const y = page.offsetTop + target.y * scale;
    if (y < outer.current!.scrollTop + 40 || y > outer.current!.scrollTop + o.height - 40 || r.top > o.bottom || r.bottom < o.top) {
      outer.current!.scrollTo({ top: y - o.height / 2, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
    const t = setTimeout(() => marker.classList.add("fade"), 1800);
    return () => clearTimeout(t);
  }, [target, pages]);

  // Comment pins.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.querySelectorAll(".pdf-pin").forEach((p) => p.remove());
    for (const pin of pins) {
      const page = el.querySelector<HTMLElement>(`.pdf-page[data-page="${pin.page}"]`);
      if (!page) continue;
      const scale = Number(page.dataset.scale || 1);
      const d = document.createElement("button");
      d.className = `pdf-pin ${pin.resolved ? "resolved" : ""}`;
      d.style.top = `${pin.y * scale - 11}px`;
      d.style.setProperty("--pin-color", pin.color);
      d.title = pin.title;
      d.setAttribute("aria-label", `Comment ${pin.n}: ${pin.title}`);
      d.innerHTML = `<span>${pin.n}</span>`;
      d.onclick = (e) => { e.stopPropagation(); onPin(pin.id); };
      page.appendChild(d);
    }
  }, [pins, pages, onPin]);

  // ⌘-wheel and pinch zoom.
  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const cur = typeof zoom === "number" ? zoom : Number(host.current?.querySelector<HTMLElement>(".pdf-page")?.dataset.scale || 1);
      onZoom(Math.min(4, Math.max(0.3, cur * (e.deltaY < 0 ? 1.08 : 0.92))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, onZoom]);

  // Find in the PDF text: highlight matching spans, count per page.
  useEffect(() => { if (findRequest) { setFindOpen(true); setTimeout(() => findInput.current?.focus(), 50); } }, [findRequest]);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.querySelectorAll(".textLayer span.hit").forEach((s) => s.classList.remove("hit"));
    if (!query.trim()) { setHits([]); return; }
    const q = query.toLowerCase();
    const counts: { page: number; count: number }[] = [];
    el.querySelectorAll<HTMLElement>(".pdf-page").forEach((p) => {
      let n = 0;
      p.querySelectorAll<HTMLElement>(".textLayer span").forEach((s) => { if (s.textContent && s.textContent.toLowerCase().includes(q)) { s.classList.add("hit"); n++; } });
      if (n) counts.push({ page: Number(p.dataset.page), count: n });
    });
    setHits(counts);
    const first = el.querySelector<HTMLElement>(".textLayer span.hit");
    first?.scrollIntoView({ block: "center" });
  }, [query, pages]);

  const at = (e: React.MouseEvent) => {
    const page = (e.target as HTMLElement).closest<HTMLElement>(".pdf-page");
    if (!page) return null;
    const r = page.getBoundingClientRect();
    const scale = Number(page.dataset.scale || 1);
    return { page: Number(page.dataset.page), x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };
  const onClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".pdf-pin, .pdf-bar")) return;
    if (!e.altKey) return; // plain clicks select text; nothing else happens
    const p = at(e); if (p) onComment(p.page, p.x, p.y);
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".pdf-pin, .pdf-bar")) return;
    const p = at(e); if (p) { window.getSelection()?.removeAllRanges(); onJump(p.page, p.x, p.y); }
  };

  const shown = typeof zoom === "number" ? zoom : Number(host.current?.querySelector<HTMLElement>(".pdf-page")?.dataset.scale || 1);
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
            <button className="tb-btn icon" onClick={() => onZoom(Math.max(0.3, shown * 0.85))} aria-label="Zoom out" title={chord("Zoom out (⌘−)")}><Minus /></button>
            <select className="zoomsel" value={typeof zoom === "number" ? String(zoom) : zoom} onChange={(e) => { const v = e.target.value; onZoom(v === "fit" || v === "page" ? v : Number(v)); }} aria-label="Zoom level">
              <option value="fit">Fit width</option>
              <option value="page">Fit page</option>
              {PRESETS.map((z) => <option key={z} value={String(z)}>{Math.round(z * 100)}%</option>)}
              {typeof zoom === "number" && !PRESETS.includes(zoom) && <option value={String(zoom)}>{Math.round(zoom * 100)}%</option>}
            </select>
            <button className="tb-btn icon" onClick={() => onZoom(Math.min(4, shown * 1.18))} aria-label="Zoom in" title={chord("Zoom in (⌘=)")}><Plus /></button>
            <button className="tb-btn icon" onClick={() => onZoom(zoom === "fit" ? "page" : "fit")} aria-label="Fit" title={zoom === "fit" ? "Fit page" : chord("Fit width (⌘0)")}><Maximize2 /></button>
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
      <div className="pdf" ref={outer} onClick={onClick} onDoubleClick={onDoubleClick} aria-label={pages ? `${pages} page PDF` : undefined}>
        <div ref={host} style={{ display: "contents" }} />
        {note && <p className="note">{note}</p>}
      </div>
    </div>
  );
}
