import { test } from "node:test";
import assert from "node:assert/strict";
import { aliasDarwin } from "./alias-darwin-latest.mjs";

const uni = { signature: "sig-u", url: "https://example/Dabir.app.tar.gz" };
const arm = { signature: "sig-a", url: "https://example/arm.tar.gz" };

test("copies darwin-universal onto the arch keys 0.1.8 clients look up", () => {
  const out = aliasDarwin({ version: "0.1.9", platforms: { "darwin-universal": uni, "linux-x86_64": { url: "l" } } });
  assert.equal(out.platforms["darwin-aarch64"], uni);
  assert.equal(out.platforms["darwin-x86_64"], uni);
  assert.equal(out.platforms["darwin-universal"], uni);
  assert.equal(out.platforms["linux-x86_64"].url, "l");
});

test("does not overwrite an arch-specific entry already on the release", () => {
  const out = aliasDarwin({ platforms: { "darwin-universal": uni, "darwin-aarch64": arm } });
  assert.equal(out.platforms["darwin-aarch64"], arm);
  assert.equal(out.platforms["darwin-x86_64"], uni);
});

test("leaves latest.json alone when there is no universal artifact", () => {
  const src = { platforms: { "darwin-aarch64": arm } };
  assert.equal(aliasDarwin(src), src);
});
