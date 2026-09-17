// The PDF view's geometry (src/lib/pdf-layout.ts). The module has only erasable TypeScript, which Node 22.18 and
// later run directly, so the test imports the source rather than a copy of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorIn, clampSplit, clampZoom, keepRange, outputScale, pageAt, pageScales, scrollFor, stepZoom, wheelFactor, FIT_MAX_WIDTH, MAX_CANVAS_PIXELS, SPLIT_MAX, SPLIT_MIN, ZOOM_MAX, ZOOM_MIN } from "../src/lib/pdf-layout.ts";

const letter = { w: 612, h: 792 };
const landscape = { w: 792, h: 612 };
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test("a fixed zoom draws every page at that scale, clamped", () => {
  assert.deepEqual(pageScales(1.5, [letter, landscape], 800, 600), { factor: 1.5, fits: [1, 1] });
  assert.equal(pageScales(9, [letter], 800, 600).factor, ZOOM_MAX);
  assert.equal(pageScales(0.01, [letter], 800, 600).factor, ZOOM_MIN);
});

test("fit width fits each page to the pane, the first page setting the shared factor", () => {
  const { factor, fits } = pageScales("fit", [letter, landscape, letter], 612, 400);
  assert.equal(factor, 1);
  close(fits[1] * factor * landscape.w, 612, 1e-3);
  assert.equal(fits[2], 1);
  // A wider pane only changes the factor, not the per-page multipliers, so a resize is one property.
  const wider = pageScales("fit", [letter, landscape, letter], 918, 400);
  close(wider.factor, 1.5);
  assert.deepEqual(wider.fits, fits);
});

test("fit width stops growing on a very wide pane", () => {
  close(pageScales("fit", [letter], 5000, 800).factor, FIT_MAX_WIDTH / letter.w);
});

test("fit page keeps the whole page inside the pane", () => {
  const { factor } = pageScales("page", [letter], 1000, 396);
  close(factor, 0.5);
  close(pageScales("page", [letter], 306, 2000).factor, 0.5);
});

test("fit never goes below the minimum zoom, and the minimum still fits a landscape page in the narrowest pane", () => {
  assert.equal(pageScales("fit", [letter], 20, 800).factor, ZOOM_MIN);
  const { factor, fits } = pageScales("fit", [letter, landscape], 192, 800);
  assert.ok(factor * fits[1] * landscape.w <= 192 + 1e-3);
});

test("zoom steps are symmetric and land on whole percents", () => {
  assert.equal(stepZoom(1, 1), 1.18);
  assert.equal(stepZoom(1.18, -1), 1);
  assert.equal(stepZoom(ZOOM_MAX, 1), ZOOM_MAX);
  assert.equal(stepZoom(ZOOM_MIN, -1), ZOOM_MIN);
  assert.equal(clampZoom(2), 2);
});

test("a wheel notch zooms by about 8 %, a trackpad pinch in proportion, and the direction follows the delta", () => {
  close(wheelFactor(-100), Math.exp(0.08));
  close(wheelFactor(100), Math.exp(-0.08));
  close(wheelFactor(-240), Math.exp(0.08)); // coalesced notches are still one step
  close(wheelFactor(-3, 1), Math.exp(0.08)); // three lines is a notch
  close(wheelFactor(-2.5), Math.exp(0.025));
  close(wheelFactor(30), Math.exp(-0.3)); // a fast pinch, coalesced, is followed in full
  assert.equal(wheelFactor(0), 1);
});

test("the canvas uses the screen's pixel ratio until the page would pass the pixel cap", () => {
  assert.equal(outputScale(612, 792, 1, 2), 2);
  const out = outputScale(612, 792, 3, 2);
  assert.ok(out < 2 && out > 1.8);
  close(612 * 3 * out * 792 * 3 * out, MAX_CANVAS_PIXELS, 1e-3);
  assert.equal(outputScale(0, 0, 1, 2), 2);
});

test("the kept range widens the visible pages and stays inside the document", () => {
  assert.deepEqual(keepRange(1, 1, 60, 2), [1, 3]);
  assert.deepEqual(keepRange(30, 31, 60, 1), [29, 32]);
  assert.deepEqual(keepRange(60, 60, 60, 2), [58, 60]);
});

test("pageAt finds the page under a point, and the first page above the first top", () => {
  const tops = [24, 840, 1656, 2472];
  const at = (y) => pageAt(tops.length, (i) => tops[i], y);
  assert.equal(at(0), 0);
  assert.equal(at(24), 0);
  assert.equal(at(839), 0);
  assert.equal(at(840), 1);
  assert.equal(at(5000), 3);
  assert.equal(pageAt(0, () => 0, 10), 0);
});

test("an anchor on a page comes back to the same spot after the page is drawn larger", () => {
  const before = { top: 1000, left: 16, width: 612, height: 792 };
  const a = anchorIn(3, before, 16 + 306, 1000 + 198, 306, 0); // a quarter down page 4, centred, at the viewport's top
  assert.equal(a.page, 3);
  close(a.fy, 0.25); close(a.fx, 0.5);
  const after = { top: 1500, left: 16, width: 918, height: 1188 };
  const { top, left } = scrollFor(a, after);
  close(top, 1500 + 297);
  close(left, 16 + 459 - 306);
});

test("an anchor under the pointer keeps that point under the pointer", () => {
  const box = { top: 24, left: 100, width: 612, height: 792 };
  const a = anchorIn(0, box, 400, 424, 300, 400); // pointer at (300, 400) in a viewport scrolled to (100, 24)
  const bigger = { top: 24, left: 16, width: 1224, height: 1584 };
  const { top, left } = scrollFor(a, bigger);
  close(bigger.top + a.fy * bigger.height - top, 400);
  close(bigger.left + a.fx * bigger.width - left, 300);
});

test("an anchor in the gap between pages keeps its distance in pixels", () => {
  const box = { top: 0, left: 0, width: 612, height: 792 };
  const a = anchorIn(0, box, 0, 800, 0, 0); // 8 px below the page, in the gap
  assert.equal(a.fy, 1); assert.equal(a.dy, 8);
  assert.equal(scrollFor(a, { top: 0, left: 0, width: 306, height: 396 }).top, 404);
  const above = anchorIn(0, { top: 24, left: 0, width: 612, height: 792 }, 0, 0, 0, 0); // the padding above page 1
  assert.equal(scrollFor(above, { top: 24, left: 0, width: 1224, height: 1584 }).top, 0);
});

test("the split ratio stays inside its range and leaves both panes a usable width", () => {
  assert.equal(clampSplit(0.05, 1400, 280, 240), SPLIT_MIN);
  assert.equal(clampSplit(0.95, 1400, 280, 240), SPLIT_MAX);
  close(clampSplit(0.2, 1000, 280, 240), 0.28);
  close(clampSplit(0.8, 1000, 280, 240), 0.76);
  assert.equal(clampSplit(0.5, 1000, 280, 240), 0.5);
  // A window too small for both minimums keeps the plain range; CSS gives the editor its minimum first.
  assert.equal(clampSplit(0.2, 400, 280, 240), 0.2);
});
