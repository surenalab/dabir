import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import { readBinary } from "../lib/backend";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

export function PdfView({ path, stamp }: { path: string | null; stamp: number }) {
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
    if (!path) { setNote("Compile the paper to see its PDF here."); return; }
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
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width; canvas.height = viewport.height;
          canvas.style.width = `${viewport.width / dpr}px`; canvas.style.height = `${viewport.height / dpr}px`;
          canvas.setAttribute("aria-label", `Page ${n} of ${doc.numPages}`);
          el.appendChild(canvas);
          await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
          if (!cancelled) setPages(n);
        }
      } catch (e) {
        if (!cancelled) setNote(`Could not render the PDF: ${String(e)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [path, stamp]);

  return (
    <div className="pdf" ref={outer} aria-label={pages ? `${pages} page PDF` : undefined}>
      <div ref={host} style={{ display: "contents" }} />
      {note && <p className="note">{note}</p>}
    </div>
  );
}
