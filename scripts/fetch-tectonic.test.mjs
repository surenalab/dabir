import { test } from "node:test";
import assert from "node:assert/strict";
import { partsFor, sidecarPath } from "./fetch-tectonic.mjs";

test("universal macOS is both arch triples, then lipo", () => {
  assert.deepEqual(partsFor("universal-apple-darwin"), ["aarch64-apple-darwin", "x86_64-apple-darwin"]);
  assert.deepEqual(partsFor("aarch64-apple-darwin"), ["aarch64-apple-darwin"]);
  assert.equal(sidecarPath("universal-apple-darwin"), "src-tauri/binaries/tectonic-universal-apple-darwin");
});

test("Windows sidecar keeps the .exe suffix", () => {
  assert.equal(sidecarPath("x86_64-pc-windows-msvc"), "src-tauri/binaries/tectonic-x86_64-pc-windows-msvc.exe");
});
