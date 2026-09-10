import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, isSource, extractJson } from "./review.mjs";

test("flags without values are booleans, values are strings", () => {
  assert.deepEqual(parseArgs(["--post", "--pr", "12", "--base", "origin/main"]), { post: true, pr: "12", base: "origin/main" });
  assert.deepEqual(parseArgs(["--out"]), { out: true });
});
test("lockfiles are excluded by name, not by substring", () => {
  assert.equal(isSource("package-lock.json"), false);
  assert.equal(isSource("src/components/BlockList.tsx"), true);
  assert.equal(isSource("assets/a.png"), false);
});
test("the JSON object is found inside prose and fences", () => {
  const o = { verdict: "approve", summary: "ok", findings: [] };
  assert.deepEqual(extractJson(`Here you go:\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\`\nNote: {braces} after.`), o);
  assert.deepEqual(extractJson(`text {not json} ${JSON.stringify(o)}`), o);
  assert.equal(extractJson("no object here"), null);
});
