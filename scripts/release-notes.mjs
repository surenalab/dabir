// Print the CHANGELOG.md section for a version, for the release body:  node scripts/release-notes.mjs v0.2.0
// Falls back to the Unreleased section when the version has no heading yet, so a tag pushed before the
// changelog was rolled still gets its notes.
import { readFileSync } from "node:fs";

const tag = (process.argv[2] ?? "").replace(/^v/, "");
const text = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

export function section(changelog, version) {
  const blocks = changelog.split(/^## /m).slice(1);
  const find = (title) => blocks.find((b) => b.split("\n")[0].trim().toLowerCase() === title.toLowerCase());
  const block = (version && find(version)) || find("Unreleased");
  if (!block) return "";
  return block.split("\n").slice(1).join("\n").trim();
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const body = section(text, tag);
  process.stdout.write((body || "See CHANGELOG.md.") + "\n\nInstall notes and the user guide: https://github.com/surenalab/dabir/blob/main/docs/GUIDE.md\n");
}
