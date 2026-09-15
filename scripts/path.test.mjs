import test from "node:test";
import assert from "node:assert/strict";

// Keep in step with src/lib/path.ts.
function slash(p) {
  let s = p.replace(/\\/g, "/");
  if (/^\/\/\?\/[a-zA-Z]:/.test(s)) s = s.slice(4);
  return s.replace(/\/+$/, "");
}
function relTo(root, path) {
  const r = slash(root);
  const p = slash(path);
  if (!r) return p;
  const fold = (s) => (/^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s);
  const R = fold(r), P = fold(p);
  if (P === R) return "";
  if (P.startsWith(R + "/")) return p.slice(r.length + 1);
  return p;
}

test("relTo is posix under a posix root", () => {
  assert.equal(relTo("/Users/a/paper", "/Users/a/paper/main.tex"), "main.tex");
  assert.equal(relTo("/Users/a/paper", "/Users/a/paper/code/sweep.py"), "code/sweep.py");
});

test("relTo strips a Windows root with backslashes", () => {
  assert.equal(relTo("C:\\Users\\a\\paper", "C:\\Users\\a\\paper\\main.tex"), "main.tex");
  assert.equal(relTo("C:\\Users\\a\\paper", "C:\\Users\\a\\paper\\code\\sweep.py"), "code/sweep.py");
});

test("relTo does not care about drive-letter case", () => {
  assert.equal(relTo("c:\\Users\\a\\paper", "C:\\Users\\a\\paper\\refs.bib"), "refs.bib");
});

test("relTo strips a Windows extended path prefix", () => {
  assert.equal(relTo("\\\\?\\C:\\Users\\a\\paper", "\\\\?\\C:\\Users\\a\\paper\\main.tex"), "main.tex");
  assert.equal(relTo("C:\\Users\\a\\paper", "\\\\?\\C:\\Users\\a\\paper\\main.tex"), "main.tex");
});
