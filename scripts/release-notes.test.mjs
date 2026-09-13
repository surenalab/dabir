import { test } from "node:test";
import assert from "node:assert/strict";
import { section } from "./release-notes.mjs";

const log = `# Changelog

## Unreleased

- Pending thing.

## 0.2.0

- Tour and guide.
- Fixed the switch-and-undo overwrite.

## 0.1.1

- Signed builds.
`;

test("the named version's block, without its heading", () => {
  assert.equal(section(log, "0.2.0"), "- Tour and guide.\n- Fixed the switch-and-undo overwrite.");
});
test("an unknown version falls back to Unreleased", () => {
  assert.equal(section(log, "9.9.9"), "- Pending thing.");
});
test("no changelog sections gives an empty string", () => {
  assert.equal(section("# Changelog\n", "0.2.0"), "");
});
