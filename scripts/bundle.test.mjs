// What the app downloads before it shows anything. The gate builds first (scripts/check.sh), so this reads dist/.
// pdf.js is 430 kB and the PDF view is lazy, so nothing about it may be in the entry's static graph: an entry that
// imports its chunk also gets a <link rel="modulepreload"> for it, and the reader pays for it on every launch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist");
const assets = join(dist, "assets");
const skip = !existsSync(join(dist, "index.html")) && "no dist/: run npx vite build first";

test("the entry does not download pdf.js before the PDF view is opened", { skip }, () => {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const entry = html.match(/<script type="module"[^>]*src="\/assets\/([^"]+)"/)?.[1];
  assert.ok(entry, "no entry script in dist/index.html");

  // Every chunk the entry reaches without a dynamic import, followed to the end.
  const statics = (file) => [...readFileSync(join(assets, file), "utf8").matchAll(/(?:^|[;\s}])(?:import|export)[^;]*?from\s*"\.\/([^"]+)"/g)].map((m) => m[1]);
  const eager = new Set([entry]);
  for (const file of eager) for (const dep of statics(file)) eager.add(dep);

  const isPdfjs = (file) => readFileSync(join(assets, file), "utf8").includes("PDFDocumentLoadingTask");
  const eagerPdfjs = [...eager].filter(isPdfjs);
  assert.deepEqual(eagerPdfjs, [], `pdf.js is in the entry's static graph (${eagerPdfjs.join(", ")})`);

  const preloaded = [...html.matchAll(/rel="modulepreload"[^>]*href="\/assets\/([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(preloaded.filter(isPdfjs), [], "index.html preloads pdf.js");

  // And it is still one chunk, not copied into every view that imports it.
  const copies = readdirSync(assets).filter((f) => f.endsWith(".js") && isPdfjs(f));
  assert.equal(copies.length, 1, `pdf.js should be one chunk, found ${copies.length}: ${copies.join(", ")}`);
});
