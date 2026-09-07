import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import { readBinary, type PdfPos } from "../lib/backend";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

interface Props {
  path: string | null;
  stamp: number;
  target: (PdfPos & { stamp: number }) | null;
  onClickAt: (page: number, xPt: number, yPt: number) => void;
}

export function PdfView({ path, stamp, target, onClickAt }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const outer = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pages, setPages] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const el = host.current;
    if (!el) return;
    el.replaceChildren();
    setPages(0);
    if (!path) { setNote("Compile the paper (⌘B) to see its PDF here. Click anywhere on a page to jump to the source line."); return; }
    setNote(null);
    (async () => {
      try {
        const bytes = await readBinary(path);
        if (bytes.length === 0) { setNote("The compiled PDF is only available in the desktop app."); return; }
        const doc = await pdfjs.getDocument({ data: bytes }).promise;
        if (cancelled) return;
        const avail = (outer.current?.clientWidth ?? 800) - 32;
        const width = Math.max(320, Math.min(avail, 820));
        const dpr = window.devicePixelRatio || 1;
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const scale = width / base.width;
          const viewport = page.getViewport({ scale: scale * dpr });
          const wrap = document.createElement("div");
          wrap.className = "pdf-page";
          wrap.dataset.page = String(n);
          wrap.dataset.scale = String(scale);
          wrap.style.width = `${viewport.width / dpr}px`;
          wrap.style.height = `${viewport.height / dpr}px`;
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width; canvas.height = viewport.height;
          canvas.style.width = "100%"; canvas.style.height = "100%";
          canvas.setAttribute("aria-label", `Page ${n} of ${doc.numPages}`);
          wrap.appendChild(canvas);
          el.appendChild(wrap);
          await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
          if (!cancelled) setPages(n);
        }
      } catch (e) {
        if (!cancelled) setNote(`Could not render the PDF: ${String(e)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [path, stamp]);

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

  const onClick = (e: React.MouseEvent) => {
    const page = (e.target as HTMLElement).closest<HTMLElement>(".pdf-page");
    if (!page) return;
    const r = page.getBoundingClientRect();
    const scale = Number(page.dataset.scale || 1);
    onClickAt(Number(page.dataset.page), (e.clientX - r.left) / scale, (e.clientY - r.top) / scale);
  };

  return (
    <div className="pdf" ref={outer} onClick={onClick} aria-label={pages ? `${pages} page PDF` : undefined} title={pages ? "Click to jump to the source line" : undefined}>
      <div ref={host} style={{ display: "contents" }} />
      {note && <p className="note">{note}</p>}
    </div>
  );
}
