// The native menu's shortcuts (src-tauri/src/lib.rs). Two items sharing a chord is silent: the menu delivers it to
// one of them and the other action simply never fires from the keyboard, which is how Show/Hide Inspector and
// Format › Italic both came to answer to Ctrl+Shift+I off the Mac. A test reads the accelerators out of the source
// because the menu is built against a live app handle and cannot be constructed here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/src/lib.rs"), "utf8");

/** Every menu item with a shortcut: its id, and the chord on the Mac and off it (a cfg! picks between two). */
function shortcuts() {
  const out = [];
  for (const m of source.matchAll(/with_id\(\s*"([\w-]+)"\s*,\s*"([^"]*)"\s*\)([\s\S]*?)\.build\(/g)) {
    const [, id, label, body] = m;
    const pair = /\.accelerator\(\s*if cfg!\(target_os = "macos"\)\s*\{\s*"([^"]+)"\s*\}\s*else\s*\{\s*"([^"]+)"\s*\}/.exec(body);
    const plain = /\.accelerator\(\s*"([^"]+)"\s*\)/.exec(body);
    if (pair) out.push({ id, label, mac: pair[1], other: pair[2] });
    else if (plain) out.push({ id, label, mac: plain[1], other: plain[1] });
  }
  return out;
}

/** One chord, whatever order the modifiers were written in, and whichever name the platform's key goes by. */
function normalise(chord, platform) {
  const parts = chord.split("+").map((p) => p.trim());
  const key = parts.pop();
  const mods = parts.map((m) => {
    const lower = m.toLowerCase();
    if (lower === "cmdorctrl" || lower === "cmd" || lower === "super" || lower === "meta") return platform === "mac" ? "mod" : lower === "cmdorctrl" ? "mod" : lower;
    if (lower === "ctrl" || lower === "control") return platform === "mac" ? "ctrl" : "mod";
    if (lower === "option") return "alt";
    return lower;
  });
  return [...new Set(mods)].sort().concat(key.toLowerCase()).join("+");
}

const items = shortcuts();

test("the menu's shortcuts were read out of the source", () => {
  assert.ok(items.length > 30, `expected the whole menu, found ${items.length}`);
  assert.ok(items.some((i) => i.id === "toggle-inspector"), "Show/Hide Inspector is in the list");
});

for (const platform of ["mac", "other"]) {
  test(`no two menu items share a shortcut ${platform === "mac" ? "on the Mac" : "off the Mac"}`, () => {
    const seen = new Map();
    const clashes = [];
    for (const item of items) {
      const chord = normalise(item[platform], platform);
      const first = seen.get(chord);
      if (first) clashes.push(`${chord}: ${first.id} (${first.label}) and ${item.id} (${item.label})`);
      else seen.set(chord, item);
    }
    assert.deepEqual(clashes, [], `two items cannot answer to one chord:\n  ${clashes.join("\n  ")}`);
  });
}

test("the Word chords are the ones the guide names", () => {
  const by = (id) => items.find((i) => i.id === id);
  const chord = (id, platform = "mac") => normalise(by(id)?.[platform] ?? "", platform);
  assert.equal(chord("new-word"), "alt+mod+n");
  assert.equal(chord("open-file"), "alt+mod+o");
  assert.equal(chord("import-word"), "alt+mod+shift+i", "Import takes the Shift of the inspector's chord");
  assert.equal(chord("toggle-inspector"), "alt+mod+i", "the inspector keeps the plain Alt chord");
  assert.equal(chord("toggle-inspector", "other"), "alt+mod+i", "and the same one off the Mac, where Ctrl+Shift+I is Italic");
  assert.equal(chord("fmt-italic", "other"), "mod+shift+i");
});

test("the sidebar's views answer to their own chords, not the document views'", () => {
  const by = (id) => items.find((i) => i.id === id);
  const chord = (id, platform = "mac") => normalise(by(id)?.[platform] ?? "", platform);
  ["nav-outline", "nav-files", "nav-changes"].forEach((id, i) => {
    assert.equal(chord(id), `ctrl+mod+${i + 1}`, `${id} on the Mac`);
    assert.equal(chord(id, "other"), `alt+mod+${i + 1}`, `${id} off the Mac`);
  });
  assert.equal(chord("view-visual"), "mod+1", "the document views keep the plain chords");
});
