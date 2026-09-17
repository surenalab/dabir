// The PDF view's decisions that need neither the DOM nor pdf.js, so node:test runs them as they are
// (scripts/pdf-layout.test.mjs): how large pages are drawn, how many canvas pixels that costs, which pages stay
// drawn, how the reader's place survives a change of scale, where the split divider may go, and which build is
// on screen.

/** A number is a fixed scale (1 = 100 %); "fit" fits each page to the pane's width, "page" fits each page whole. */
export type PdfZoom = number | "fit" | "page";

/** As pdf.js: low enough that fit width still fits a landscape page in the narrowest split pane. */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 4;
/** One press of zoom in; zoom out divides by it, so in then out comes back to the same scale. */
export const ZOOM_STEP = 1.18;
/** Fit width stops growing past this many CSS pixels of page, where lines get too long to read. */
export const FIT_MAX_WIDTH = 1600;
/** Canvas pixels per page at most (4096²): a letter page at 300 % on a Retina screen, a little under. */
export const MAX_CANVAS_PIXELS = 16_777_216;

export const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** Zoom in (dir 1) or out (-1) by one step, to a whole percent. */
export function stepZoom(current: number, dir: 1 | -1): number {
  return clampZoom(Math.round(current * (dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP) * 100) / 100);
}

/**
 * The zoom factor for one ⌘-wheel or pinch event. A mouse notch (lines or pages, or a large pixel delta) is one step
 * of about 8 %; a trackpad pinch sends small pixel deltas, followed in proportion so the page tracks the fingers.
 */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  if (!deltaY) return 1;
  const notch = deltaMode !== 0 || Math.abs(deltaY) >= 40;
  return Math.exp(-(notch ? Math.sign(deltaY) * 8 : deltaY) / 100);
}

export interface PageSize { w: number; h: number }

/**
 * The scale each page is drawn at, as one shared factor (the first page's scale) and a multiplier per page. A number
 * draws every page at that scale. The fit modes fit each page on its own, so a landscape table page fits as the
 * portrait text does; the multipliers only change when the pane's shape does, which keeps a resize to one factor.
 */
export function pageScales(zoom: PdfZoom, pages: PageSize[], availW: number, availH: number): { factor: number; fits: number[] } {
  if (typeof zoom === "number") return { factor: clampZoom(zoom), fits: pages.map(() => 1) };
  const w = Math.max(1, Math.min(availW, FIT_MAX_WIDTH)), h = Math.max(1, availH);
  const scales = pages.map((p) => clampZoom(zoom === "fit" ? w / p.w : Math.min(w / p.w, h / p.h)));
  const factor = scales[0] ?? 1;
  // Rounded, so the same pane shape gives the same multipliers whatever its size.
  return { factor, fits: scales.map((s) => Math.round((s / factor) * 1e6) / 1e6) };
}

/** Device pixels per CSS pixel for a page's canvas: the screen's ratio, lowered so the canvas stays under the cap. */
export function outputScale(wPt: number, hPt: number, scale: number, dpr: number, maxPixels = MAX_CANVAS_PIXELS): number {
  const css = wPt * scale * hPt * scale;
  return css > 0 ? Math.min(dpr, Math.sqrt(maxPixels / css)) : dpr;
}

/** Pages first..last widened by margin on both sides, within 1..total. */
export function keepRange(first: number, last: number, total: number, margin: number): [number, number] {
  return [Math.max(1, first - margin), Math.min(total, last + margin)];
}

/** Index of the last page whose top is at or above y (0 when y is above them all); tops ascend. */
export function pageAt(count: number, topOf: (i: number) => number, y: number): number {
  let lo = 0, hi = count - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (topOf(mid) <= y) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/** A page's box in the scroller's content coordinates. */
export interface Box { top: number; left: number; width: number; height: number }

/**
 * A place in the document that survives a change of scale: a point on a page, as a fraction of the page (fy, fx) plus
 * whatever lies outside it in unscaled pixels (the gap between pages, the margin beside a narrow page), and where that
 * point sits in the viewport (vx, vy). The top of the viewport while reading; the pointer while pinching.
 */
export interface Anchor { page: number; fy: number; dy: number; fx: number; dx: number; vx: number; vy: number }

const split = (rel: number, size: number): [number, number] => {
  const f = size > 0 ? Math.min(1, Math.max(0, rel / size)) : 0;
  return [f, rel - f * size];
};

/** The anchor for content point (x, y) on page `page`, drawn at `box`, seen at (vx, vy) in the viewport. */
export function anchorIn(page: number, box: Box, x: number, y: number, vx: number, vy: number): Anchor {
  const [fy, dy] = split(y - box.top, box.height);
  const [fx, dx] = split(x - box.left, box.width);
  return { page, fy, dy, fx, dx, vx, vy };
}

/** The scroll position that puts the anchor back under (vx, vy), with its page now drawn at `box`. */
export function scrollFor(a: Anchor, box: Box): { top: number; left: number } {
  return {
    top: Math.max(0, box.top + a.fy * box.height + a.dy - a.vy),
    left: Math.max(0, box.left + a.fx * box.width + a.dx - a.vx),
  };
}

/** Split view: the editor's share of the width by default and at the extremes. */
export const SPLIT_DEFAULT = 0.55;
export const SPLIT_MIN = 0.2;
export const SPLIT_MAX = 0.8;

/** The editor's share for a requested ratio, keeping both panes at least their minimum width when the window allows. */
export function clampSplit(ratio: number, width: number, minLeft: number, minRight: number): number {
  const r = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio));
  if (width <= 0 || width < minLeft + minRight) return r;
  return Math.min(1 - minRight / width, Math.max(minLeft / width, r));
}

/** The build the PDF view is showing: a file and the compile it came from. `at` is 0 when there is none. */
export interface ShownPdf { path: string | null; at: number }

/**
 * Which build to show. A compile that produced a file replaces the one on screen; a compile that produced none
 * (a LaTeX error, a cancelled run) leaves the last build up rather than emptying the pane, and closing the paper
 * clears it. Returns the same object when nothing changes, so the caller can compare by identity.
 */
export function shownBuild(shown: ShownPdf, compile: { status: "idle" | "running" | "done"; pdf?: string | null; at?: number }): ShownPdf {
  if (compile.status === "idle") return shown.at === 0 ? shown : { path: null, at: 0 };
  if (compile.status !== "done" || !compile.pdf || compile.at === shown.at) return shown;
  return { path: compile.pdf, at: compile.at ?? 0 };
}
