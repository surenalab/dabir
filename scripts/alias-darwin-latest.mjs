// After a universal macOS build, latest.json names the artifact `darwin-universal`. Installs of 0.1.8
// and earlier look up `darwin-aarch64` / `darwin-x86_64`. Copy the universal entry onto those keys so
// every Mac still sees an update, and a single DMG covers both.
//
//   node scripts/alias-darwin-latest.mjs v0.1.9
//
// Reads and writes the draft release's latest.json through `gh`. No-op when there is no darwin-universal
// platform (a failed Mac job, or an older two-arch release).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function aliasDarwin(latest) {
  const platforms = { ...(latest.platforms ?? {}) };
  const uni = platforms["darwin-universal"];
  if (!uni) return latest;
  return {
    ...latest,
    platforms: {
      ...platforms,
      "darwin-aarch64": platforms["darwin-aarch64"] ?? uni,
      "darwin-x86_64": platforms["darwin-x86_64"] ?? uni,
    },
  };
}

function gh(args, opts = {}) {
  const r = spawnSync("gh", args, { encoding: "utf8", ...opts });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || `gh ${args[0]} failed`).trim();
    throw new Error(err);
  }
  return r.stdout;
}

function main(tag) {
  if (!tag) {
    console.error("usage: node scripts/alias-darwin-latest.mjs vX.Y.Z");
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), "dabir-latest-"));
  try {
    let json = null;
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        gh(["release", "download", tag, "--pattern", "latest.json", "--dir", dir, "--clobber"]);
        json = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
        break;
      } catch (e) {
        console.error(`latest.json not on ${tag} yet (${e.message})${attempt < 8 ? ", retrying" : ""}`);
        if (attempt === 8) process.exit(1);
        spawnSync("sleep", [String(attempt * 3)], { stdio: "inherit" });
      }
    }
    const next = aliasDarwin(json);
    if (JSON.stringify(next) === JSON.stringify(json)) {
      console.log("latest.json has no darwin-universal to alias; leaving it");
      return;
    }
    writeFileSync(join(dir, "latest.json"), `${JSON.stringify(next, null, 2)}\n`);
    gh(["release", "upload", tag, join(dir, "latest.json"), "--clobber"]);
    console.log("aliased darwin-aarch64 and darwin-x86_64 to the universal artifact");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main(process.argv[2]);
}
