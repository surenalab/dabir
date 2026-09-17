// The PDF view's page stack, kept outside React: every page is a placeholder sized from its viewport, so the scroll
// height is right from the start; only pages near the viewport hold a canvas and a text layer. All sizes follow one
// CSS property (--scale-factor), so a resize or a pinch is one property change and a scroll correction in the same
// frame; canvases are redrawn at the new scale once the change settles.
import * as pdfjs from "pdfjs-dist";
import { anchorIn, clampZoom, keepRange, outputScale, pageAt, pageScales, scrollFor, wheelFactor, type Anchor, type Box, type PdfZoom } from "./pdf-layout";

export interface PdfPin { id: string; page: number; y: number; color: string; n: number; resolved: boolean; title: string }
export interface PdfTarget { page: number; x: number; y: number; stamp: number }
export interface PdfHits { page: number; count: number }

interface Page {
  n: number; w: number; h: number;       // 1-based number; size in points, rotation applied
  proxy: pdfjs.PDFPageProxy;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  drawn: number;                         // the scale the canvas holds; 0 for none, -1 for a previous build's
  task: pdfjs.RenderTask | null;
  taskScale: number;
  text: HTMLDivElement | null;
  layer: pdfjs.TextLayer | null;
  textDone: boolean;
  strings: Promise<string[]> | null;     // the page's text items, for find
}

export interface PdfPagesEvents {
  /** The page a third of the way down the viewport changed. */
  page: (n: number) => void;
  /** The first page's scale on screen changed (the number the zoom buttons step from). */
  scale: (scale: number) => void;
  /** A pinch or ⌘-wheel gesture paused at this zoom. */
  commit: (zoom: number) => void;
}

/** Wait this long after the last resize or zoom step before drawing canvases at the new scale. */
const SETTLE_MS = 150;
/** Report a gesture's zoom this long after its last step. */
const COMMIT_MS = 220;
/** Pages drawn beyond the visible ones, and pages kept drawn before their canvas is released. */
const NEAR = 1, KEEP = 2;
/** Canvases drawn at once. */
const PARALLEL = 2;

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const free = (c: HTMLCanvasElement) => { c.width = 0; c.height = 0; c.remove(); }; // WebKit keeps the memory otherwise
const sameFits = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** The last sync target scrolled to, across mounts: coming back to the PDF view does not jump to it again. */
let followed = 0;

export class PdfPages {
  private pages: Page[] = [];
  private zoom: PdfZoom = "fit";
  private factor = 1;
  private fits: number[] = [];
  /** The reader's place: the top of the viewport, centred across. Only the reader's own scrolling moves it. */
  private place: Anchor | null = null;
  private ours = { top: -1, left: -1 };
  private settled = true;
  private settleTimer = 0;
  private commitTimer = 0;
  private gestureBase = 0;
  private visible = new Set<number>();
  private busy = 0;
  private size = { w: 0, h: 0 };
  private query = "";
  private reveal = 0;
  private pinList: PdfPin[] = [];
  private onPin: (id: string) => void = () => {};
  private marker: { target: PdfTarget; faded: boolean; scrolled: boolean; timer: number } | null = null;
  private io: IntersectionObserver;
  private ro: ResizeObserver;
  private destroyed = false;

  constructor(private scroller: HTMLElement, private stack: HTMLElement, private events: PdfPagesEvents) {
    this.io = new IntersectionObserver(this.onIntersect, { root: scroller, rootMargin: "50% 0px" });
    this.ro = new ResizeObserver(this.onResize);
    this.ro.observe(scroller);
    scroller.addEventListener("scroll", this.onScroll, { passive: true });
    scroller.addEventListener("wheel", this.onWheel, { passive: false });
    // WebKit reports a trackpad pinch as gesture events rather than a ⌃-wheel.
    scroller.addEventListener("gesturestart", this.onGesture);
    scroller.addEventListener("gesturechange", this.onGesture);
    scroller.addEventListener("gestureend", this.onGesture);
  }

  destroy() {
    this.destroyed = true;
    this.io.disconnect(); this.ro.disconnect();
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.scroller.removeEventListener("wheel", this.onWheel);
    for (const t of ["gesturestart", "gesturechange", "gestureend"]) this.scroller.removeEventListener(t, this.onGesture);
    clearTimeout(this.settleTimer); clearTimeout(this.commitTimer); clearTimeout(this.marker?.timer);
    this.clear();
  }

  get count() { return this.pages.length; }
  /** Where the reader is, to hand to the next `show` (or to a later mount of the view). */
  get where(): Anchor | null { return this.place; }
  /** The first page's scale on screen. */
  get scale() { return this.factor * (this.fits[0] ?? 1); }

  /** Remove every page. */
  clear() {
    for (const p of this.pages) { this.release(p); this.io.unobserve(p.el); }
    this.pages = []; this.visible.clear(); this.place = null;
    this.stack.replaceChildren();
  }

  /**
   * Show a build. `place` puts the reader back where they were (a recompile must not move them); pages that kept
   * their size show the previous build's canvas until theirs is drawn, so a recompile does not flash white.
   */
  show(proxies: pdfjs.PDFPageProxy[], place: Anchor | null) {
    if (this.destroyed) return;
    const old = this.pages;
    for (const p of old) { this.cancel(p); this.io.unobserve(p.el); }
    this.pages = proxies.map((proxy, i) => {
      const { width: w, height: h } = proxy.getViewport({ scale: 1 });
      const el = document.createElement("div");
      el.className = "pdf-page";
      el.dataset.page = String(i + 1);
      el.style.setProperty("--page-w", `${w}px`);
      el.style.setProperty("--page-h", `${h}px`);
      const page: Page = { n: i + 1, w, h, proxy, el, canvas: null, drawn: 0, task: null, taskScale: 0, text: null, layer: null, textDone: false, strings: null };
      const prev = old[i];
      if (prev?.canvas && prev.w === w && prev.h === h) { page.canvas = prev.canvas; page.drawn = -1; prev.canvas = null; el.appendChild(page.canvas); }
      return page;
    });
    for (const p of old) this.release(p);
    this.visible.clear();
    this.fits = [];
    this.stack.replaceChildren(...this.pages.map((p) => p.el));
    const { factor, fits } = pageScales(this.zoom, this.pages, this.availW(), this.availH());
    this.setScale(factor, fits);
    this.markFitted();
    const kept = place && place.page < this.pages.length ? { ...place, vx: this.scroller.clientWidth / 2 } : null;
    if (kept) this.restore(kept);
    else if (place) this.restore(place);
    else {
      this.scroller.scrollTo({ top: 0, left: Math.max(0, (this.scroller.scrollWidth - this.scroller.clientWidth) / 2) });
      this.ours = { top: this.scroller.scrollTop, left: this.scroller.scrollLeft };
    }
    this.place = kept ?? this.capture();
    this.placePins();
    if (this.marker) this.placeMarker(!this.marker.scrolled);
    // Drawing starts when the observer reports which pages are in view, at the scale just set.
    clearTimeout(this.settleTimer);
    this.settled = true;
    for (const p of this.pages) this.io.observe(p.el);
    this.events.page(this.current());
  }

  /** The zoom asked for by the toolbar, the menu or a finished gesture. The centre of the viewport stays put. */
  setZoom(zoom: PdfZoom) {
    if (this.commitTimer) { this.zoom = zoom; return; }
    this.zoom = zoom;
    this.markFitted();
    if (!this.pages.length) return;
    const { factor, fits } = pageScales(zoom, this.pages, this.availW(), this.availH());
    if (factor === this.factor && sameFits(fits, this.fits)) return;
    this.apply(factor, fits, this.capture(this.scroller.clientWidth / 2, this.scroller.clientHeight / 2));
    this.place = this.capture();
  }

  goto(n: number) {
    const p = this.pages[Math.max(1, Math.min(this.pages.length, n)) - 1];
    if (p) this.scroller.scrollTo({ top: this.box(p).top - this.gap(), behavior: reduced() ? "auto" : "smooth" });
  }

  /** The page and point (in PDF points from the page's top left) under a pointer, for jump-to-source and comments. */
  locate(target: EventTarget | null, clientX: number, clientY: number): { page: number; x: number; y: number } | null {
    const el = target instanceof Element ? target.closest<HTMLElement>(".pdf-page") : null;
    const p = el ? this.pages[Number(el.dataset.page) - 1] : undefined;
    if (!el || !p || p.el !== el) return null;
    const r = el.getBoundingClientRect();
    return { page: p.n, x: ((clientX - r.left) / r.width) * p.w, y: ((clientY - r.top) / r.height) * p.h };
  }

  /** Forward sync: mark the line's position and bring it into view when it is not. */
  mark(target: PdfTarget) {
    clearTimeout(this.marker?.timer);
    const seen = target.stamp === followed;
    this.marker = { target, faded: seen, scrolled: seen, timer: seen ? 0 : window.setTimeout(() => this.fadeMarker(), 1800) };
    this.placeMarker(!seen);
  }

  setPins(pins: PdfPin[], onPin: (id: string) => void) {
    this.pinList = pins; this.onPin = onPin;
    this.placePins();
  }

  /** Highlight a query on the drawn pages and count it on all of them; with `reveal`, scroll to the first hit. */
  async search(query: string, reveal: boolean): Promise<PdfHits[] | null> {
    const q = query.trim().toLowerCase();
    this.query = q;
    for (const p of this.pages) this.markHits(p);
    if (!q) { this.reveal = 0; return []; }
    const pages = this.pages;
    const texts = await Promise.all(pages.map((p) => this.stringsOf(p)));
    if (pages !== this.pages || q !== this.query) return null;
    const hits: PdfHits[] = [];
    texts.forEach((items, i) => { const count = items.filter((s) => s.toLowerCase().includes(q)).length; if (count) hits.push({ page: i + 1, count }); });
    this.reveal = reveal ? hits[0]?.page ?? 0 : 0;
    const first = pages[this.reveal - 1];
    if (first?.textDone) this.revealHit(first);
    else if (first) this.scroller.scrollTo({ top: this.box(first).top - this.gap() });
    return hits;
  }

  // ------------------------------------------------------------------ scale and place

  /** Fitted pages never need a horizontal scrollbar; hiding it keeps a resize from toggling one (and refitting again). */
  private markFitted() { this.scroller.classList.toggle("fitted", typeof this.zoom !== "number" && !this.commitTimer); }

  private gap() { return parseFloat(getComputedStyle(this.stack).rowGap) || 0; }
  private availW() {
    const s = getComputedStyle(this.stack);
    return this.scroller.clientWidth - (parseFloat(s.paddingLeft) || 0) - (parseFloat(s.paddingRight) || 0);
  }
  private availH() { return this.scroller.clientHeight - 2 * this.gap(); }

  /** Put a new scale on screen; with an anchor, scroll so that point stays where it was. Redraw once it settles. */
  private apply(factor: number, fits: number[] | null, anchor: Anchor | null) {
    if (!this.setScale(factor, fits)) return;
    if (anchor) this.restore(anchor);
    this.unsettle();
  }

  /** One property for the shared factor, one per page for its fit; false when nothing changed. */
  private setScale(factor: number, fits: number[] | null): boolean {
    const refit = !!fits && !sameFits(fits, this.fits);
    if (!refit && factor === this.factor) return false;
    if (fits && refit) {
      this.fits = fits;
      this.pages.forEach((p, i) => p.el.style.setProperty("--page-fit", String(fits[i])));
    }
    this.factor = factor;
    this.stack.style.setProperty("--scale-factor", String(factor));
    this.events.scale(this.scale);
    return true;
  }

  private restore(a: Anchor) {
    const p = this.pages[Math.min(a.page, this.pages.length - 1)];
    if (!p) return;
    const { top, left } = scrollFor(a.page < this.pages.length ? a : { ...a, fy: 1, dy: 0 }, this.box(p));
    this.scroller.scrollTop = top;
    this.scroller.scrollLeft = left;
    this.ours = { top: this.scroller.scrollTop, left: this.scroller.scrollLeft };
  }

  /** The anchor for the point (vx, vy) of the viewport; the reader's place by default. */
  private capture(vx = this.scroller.clientWidth / 2, vy = 0): Anchor | null {
    if (!this.pages.length) return null;
    const x = this.scroller.scrollLeft + vx, y = this.scroller.scrollTop + vy;
    const i = pageAt(this.pages.length, (k) => this.pages[k].el.offsetTop, y);
    return anchorIn(i, this.box(this.pages[i]), x, y, vx, vy);
  }

  /** A page's box in the scroller's content coordinates, to the sub-pixel. */
  private box(p: Page): Box {
    const r = p.el.getBoundingClientRect(), s = this.scroller.getBoundingClientRect();
    return {
      top: r.top - s.top - this.scroller.clientTop + this.scroller.scrollTop,
      left: r.left - s.left - this.scroller.clientLeft + this.scroller.scrollLeft,
      width: r.width, height: r.height,
    };
  }

  private current() {
    if (!this.pages.length) return 1;
    return pageAt(this.pages.length, (k) => this.pages[k].el.offsetTop, this.scroller.scrollTop + this.scroller.clientHeight / 3) + 1;
  }

  private unsettle() {
    this.settled = false;
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => { this.settled = true; this.pump(); }, SETTLE_MS);
    this.pump();
  }

  private onScroll = () => {
    const { scrollTop, scrollLeft } = this.scroller;
    const mine = Math.abs(scrollTop - this.ours.top) < 1 && Math.abs(scrollLeft - this.ours.left) < 1;
    this.ours = { top: -1, left: -1 };
    if (!mine) this.place = this.capture();
    this.events.page(this.current());
  };

  private onResize = () => {
    const w = this.scroller.clientWidth, h = this.scroller.clientHeight;
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    // A pane being hidden, or a gesture in progress, keeps its scale; a fixed zoom does not depend on the pane.
    if (!this.pages.length || !w || !h || this.commitTimer || typeof this.zoom === "number") return;
    const { factor, fits } = pageScales(this.zoom, this.pages, this.availW(), this.availH());
    this.apply(factor, fits, this.place && { ...this.place, vx: w / 2 });
  };

  private onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    if (this.gestureBase) return;
    const r = this.scroller.getBoundingClientRect();
    this.zoomAround(this.factor * wheelFactor(e.deltaY, e.deltaMode), e.clientX - r.left, e.clientY - r.top);
  };

  private onGesture = (ev: Event) => {
    const e = ev as Event & { scale: number; clientX: number; clientY: number };
    e.preventDefault();
    if (e.type === "gesturestart") this.gestureBase = this.factor;
    else if (e.type === "gestureend") this.gestureBase = 0;
    else if (this.gestureBase) {
      const r = this.scroller.getBoundingClientRect();
      this.zoomAround(this.gestureBase * e.scale, e.clientX - r.left, e.clientY - r.top);
    }
  };

  /** Scale at once, keeping the point under the pointer still; report the zoom when the gesture pauses. */
  private zoomAround(target: number, vx: number, vy: number) {
    const next = clampZoom(target);
    if (!this.pages.length || next === this.factor) return;
    clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => {
      this.commitTimer = 0;
      // Fixed from here on, so a resize before the parent answers does not refit.
      this.zoom = this.factor;
      this.events.commit(this.factor);
    }, COMMIT_MS);
    this.markFitted();
    this.apply(next, null, this.capture(vx, vy));
    this.place = this.capture();
  }

  // ------------------------------------------------------------------ drawing

  private onIntersect = (entries: IntersectionObserverEntry[]) => {
    for (const e of entries) {
      const n = Number((e.target as HTMLElement).dataset.page);
      if (e.isIntersecting) this.visible.add(n); else this.visible.delete(n);
    }
    this.pump();
  };

  /** Draw what is near the viewport, nearest first; release what is far. */
  private pump() {
    const total = this.pages.length;
    if (!total) return;
    let first = Infinity, last = -Infinity;
    for (const n of this.visible) { if (n > total) continue; first = Math.min(first, n); last = Math.max(last, n); }
    const here = this.current();
    if (first > last) first = last = here;
    const [keepFrom, keepTo] = keepRange(first, last, total, KEEP);
    for (const p of this.pages) if (p.n < keepFrom || p.n > keepTo) this.release(p);
    const [from, to] = keepRange(first, last, total, NEAR);
    const order = this.pages.slice(from - 1, to).sort((a, b) => Math.abs(a.n - here) - Math.abs(b.n - here));
    for (const p of order) {
      const want = this.factor * (this.fits[p.n - 1] ?? 1);
      if (p.drawn === want) { if (!p.layer) this.drawText(p); continue; }
      if (p.task) { if (this.settled && p.taskScale !== want) this.cancel(p); continue; }
      if (this.busy >= PARALLEL) continue;
      // While the size is still changing, a stretched canvas will do; only blank pages are drawn.
      if (!this.settled && p.drawn !== 0) continue;
      void this.draw(p, want);
    }
  }

  private async draw(p: Page, scale: number) {
    const out = outputScale(p.w, p.h, scale, window.devicePixelRatio || 1);
    const viewport = p.proxy.getViewport({ scale: scale * out });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    canvas.setAttribute("aria-label", `Page ${p.n} of ${this.pages.length}`);
    const task = p.proxy.render({ canvas, viewport });
    p.task = task;
    p.taskScale = scale;
    this.busy++;
    try {
      await task.promise;
      if (p.task !== task) { free(canvas); return; }
      if (p.canvas) { p.canvas.replaceWith(canvas); free(p.canvas); } else p.el.prepend(canvas);
      p.canvas = canvas;
      p.drawn = scale;
      if (!p.layer) this.drawText(p);
    } catch {
      free(canvas); // cancelled: released, superseded, or the document went away
    } finally {
      if (p.task === task) p.task = null;
      this.busy--;
      this.pump();
    }
  }

  /** The selectable text. Its layout follows --total-scale-factor, so it is made once per page, not per zoom. */
  private drawText(p: Page) {
    const div = document.createElement("div");
    div.className = "textLayer";
    const layer = new pdfjs.TextLayer({ textContentSource: p.proxy.streamTextContent(), container: div, viewport: p.proxy.getViewport({ scale: p.drawn > 0 ? p.drawn : 1 }) });
    p.text = div; p.layer = layer; p.textDone = false;
    if (p.canvas) p.canvas.after(div); else p.el.prepend(div);
    layer.render().then(() => {
      if (p.layer !== layer) return;
      p.textDone = true;
      this.markHits(p);
      if (this.reveal === p.n) this.revealHit(p);
    }, () => { /* cancelled, or no text: the page still shows */ });
  }

  private cancel(p: Page) {
    const t = p.task;
    if (t) { p.task = null; t.cancel(); }
  }

  private release(p: Page) {
    if (!p.canvas && !p.task && !p.text) return;
    this.cancel(p);
    if (p.canvas) { free(p.canvas); p.canvas = null; }
    p.drawn = 0;
    p.layer?.cancel();
    p.text?.remove();
    p.layer = null; p.text = null; p.textDone = false;
    p.proxy.cleanup();
  }

  // ------------------------------------------------------------------ marks on pages

  private placePins() {
    this.stack.querySelectorAll(".pdf-pin").forEach((el) => el.remove());
    for (const pin of this.pinList) {
      const page = this.pages[pin.page - 1];
      if (!page) continue;
      const b = document.createElement("button");
      b.className = `pdf-pin ${pin.resolved ? "resolved" : ""}`;
      b.style.setProperty("--y", `${pin.y}px`);
      b.style.setProperty("--pin-color", pin.color);
      b.title = pin.title;
      b.setAttribute("aria-label", `Comment ${pin.n}: ${pin.title}`);
      const n = document.createElement("span");
      n.textContent = String(pin.n);
      b.appendChild(n);
      b.onclick = (e) => { e.stopPropagation(); this.onPin(pin.id); };
      page.el.appendChild(b);
    }
  }

  private placeMarker(scroll: boolean) {
    this.stack.querySelectorAll(".pdf-marker").forEach((el) => el.remove());
    const m = this.marker;
    const p = m && this.pages[m.target.page - 1];
    if (!m || !p) return;
    const el = document.createElement("div");
    el.className = `pdf-marker ${m.faded ? "fade" : ""}`;
    el.style.setProperty("--y", `${m.target.y}px`);
    p.el.appendChild(el);
    if (!scroll) return;
    m.scrolled = true;
    followed = m.target.stamp;
    const b = this.box(p);
    const y = b.top + (m.target.y / p.h) * b.height;
    const top = this.scroller.scrollTop, h = this.scroller.clientHeight;
    if (y < top + 40 || y > top + h - 40) this.scroller.scrollTo({ top: y - h / 2, behavior: reduced() ? "auto" : "smooth" });
  }

  private fadeMarker() {
    if (!this.marker) return;
    this.marker.faded = true;
    this.stack.querySelector(".pdf-marker")?.classList.add("fade");
  }

  private stringsOf(p: Page): Promise<string[]> {
    p.strings ??= p.proxy.getTextContent().then(
      (tc) => tc.items.map((i) => ("str" in i ? i.str : "")).filter(Boolean),
      () => [],
    );
    return p.strings;
  }

  private markHits(p: Page) {
    if (!p.text || !p.textDone) return;
    p.text.querySelectorAll(".hit").forEach((s) => s.classList.remove("hit"));
    if (!this.query) return;
    p.text.querySelectorAll<HTMLElement>("span:not(.markedContent)").forEach((s) => {
      if (s.textContent?.toLowerCase().includes(this.query)) s.classList.add("hit");
    });
  }

  private revealHit(p: Page) {
    this.reveal = 0;
    const hit = p.text?.querySelector<HTMLElement>(".hit");
    if (!hit) return;
    const r = hit.getBoundingClientRect(), s = this.scroller.getBoundingClientRect();
    this.scroller.scrollTo({ top: this.scroller.scrollTop + r.top - s.top - (this.scroller.clientHeight - r.height) / 2 });
  }
}
