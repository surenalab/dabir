import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import { readBinary, type PdfPos } from "../lib/backend";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

export interface PdfPin { id: string; page: number; y: number; color: string; n: number; resolved: boolean; title: string }
export type PdfZoom = number | "fit";

interface Props {
  path: string | null;
  stamp: number;
  target: (PdfPos & { stamp: number }) | null;
  pins: PdfPin[];
  zoom: PdfZoom;
  onZoom: (z: PdfZoom) => void;
  onClickAt: (page: number, xPt: number, yPt: number, alt: boolean) => void;
  onPin: (id: string) => void;
}

export function PdfView({ path, stamp, target, pins, zoom, onZoom, onClickAt, onPin }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const outer = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pages, setPages] = useState(0);
  const docRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const taskRef = useRef<pdfjs.PDFDocumentLoadingTask | null>(null);
  const [docStamp, setDocStamp] = useState(0);

  // Load the document once per compile.
  useEffect(() => {
    let cancelled = false;
    taskRef.current?.destroy().catch(() => {});
    taskRef.current = null; docRef.current = null;
    setPages(0);
    if (!path) { setNote("Compile the paper (⌘B) to see its PDF here. Click a spot to jump to the source line, Option-click to comment there."); host.current?.replaceChildren(); return; }
    setNote(null);
    (async () => {
      try {
        const bytes = await readBinary(path);
        if (bytes.length === 0) { setNote("The compiled PDF is only available in the desktop app."); return; }
        const task = pdfjs.getDocument({ data: bytes });
        const doc = await task.promise;
        if (cancelled) { task.destroy(); return; }
        taskRef.current = task; docRef.current = doc;
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
      const avail = (outer.current?.clientWidth ?? 800) - 32;
      const dpr = window.devicePixelRatio || 1;
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const scale = zoom === "fit" ? Math.max(0.3, Math.min(avail, 1400) / base.width) : zoom;
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

  // Forward sync: scroll to the page and draw a marker at the line's position.
  useEffect(() => {
    if (!target || !host.current) return;
    const page = host.current.querySelector<HTMLElement>(`.pdf-page[data-page="${target.page}"]`);
    if (!page) return;
    page.querySelectorAll(".pdf-marker").forEach((m) => m.remove());
    const scale = Number(page.dataset.scale || 1);
    const marker = document.createElement("div");
    marker.className = "pdf-marker";
    marker.style.top = `${target.y * scale - 10}px`;
    page.appendChild(marker);
    page.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    const t = setTimeout(() => marker.remove(), 2500);
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

  // Pinch and ⌘-wheel zoom.
  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const cur = zoom === "fit" ? Number(host.current?.querySelector<HTMLElement>(".pdf-page")?.dataset.scale || 1) : zoom;
      onZoom(Math.min(4, Math.max(0.3, cur * (e.deltaY < 0 ? 1.08 : 0.92))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, onZoom]);

  const onClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".pdf-pin")) return;
    if (window.getSelection()?.toString()) return; // a text selection is not a jump
    const page = (e.target as HTMLElement).closest<HTMLElement>(".pdf-page");
    if (!page) return;
    const r = page.getBoundingClientRect();
    const scale = Number(page.dataset.scale || 1);
    onClickAt(Number(page.dataset.page), (e.clientX - r.left) / scale, (e.clientY - r.top) / scale, e.altKey);
  };

  const shown = zoom === "fit" ? Number(host.current?.querySelector<HTMLElement>(".pdf-page")?.dataset.scale || 1) : zoom;

  return (
    <div className="pdf" ref={outer} onClick={onClick} aria-label={pages ? `${pages} page PDF` : undefined}>
      {pages > 0 && (
        <div className="pdf-zoom" role="group" aria-label="Zoom" onClick={(e) => e.stopPropagation()}>
          <button className="tb-btn icon" onClick={() => onZoom(Math.max(0.3, shown * 0.85))} aria-label="Zoom out" title="Zoom out (⌘−)">−</button>
          <button className="tb-btn" onClick={() => onZoom("fit")} aria-pressed={zoom === "fit"} title="Fit width (⌘0)">{Math.round(shown * 100)}%</button>
          <button className="tb-btn icon" onClick={() => onZoom(Math.min(4, shown * 1.18))} aria-label="Zoom in" title="Zoom in (⌘=)">+</button>
        </div>
      )}
      <div ref={host} style={{ display: "contents" }} />
      {note && <p className="note">{note}</p>}
    </div>
  );
}
