// Fetch the Tectonic binary for a Rust target triple into src-tauri/binaries, where Tauri picks it
// up as an external binary (sidecar) at bundle time. Runs on macOS, Linux and Windows with only Node
// and the system `tar` (bsdtar on Windows 10+ and macOS reads zip files too).
//
// TARGET_TRIPLE=universal-apple-darwin downloads both Mac builds and lipo(1)s them, so one DMG
// runs on Apple silicon and Intel. lipo is a macOS tool; that triple is only built on macos runners.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = process.env.TECTONIC_VERSION ?? "0.17.0";

export const ASSETS = {
  "aarch64-apple-darwin": `tectonic-${VERSION}-aarch64-apple-darwin.tar.gz`,
  "x86_64-apple-darwin": `tectonic-${VERSION}-x86_64-apple-darwin.tar.gz`,
  // The static musl builds: Tectonic's own -gnu binaries are linked against glibc 2.39, so the sidecar
  // would not start on Ubuntu 22.04 (2.35) or any distribution older than 2024 even though the app does.
  "x86_64-unknown-linux-gnu": `tectonic-${VERSION}-x86_64-unknown-linux-musl.tar.gz`,
  "aarch64-unknown-linux-gnu": `tectonic-${VERSION}-aarch64-unknown-linux-musl.tar.gz`,
  "x86_64-pc-windows-msvc": `tectonic-${VERSION}-x86_64-pc-windows-msvc.zip`,
};

/** Arch triples to download for a sidecar triple. Universal is both Macs, then lipo. */
export function partsFor(triple) {
  if (triple === "universal-apple-darwin") return ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  return [triple];
}

export function sidecarPath(triple) {
  const win = triple.includes("windows");
  return join("src-tauri", "binaries", `tectonic-${triple}${win ? ".exe" : ""}`);
}

function hostTriple() {
  try { return execFileSync("rustc", ["-vV"]).toString().match(/^host: (.*)$/m)[1]; }
  catch { console.error("rustc not found; set TARGET_TRIPLE"); process.exit(1); }
}

async function download(url) {
  let res = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      res = await fetch(url);
      if (res.ok) break;
      console.error(`download failed: ${res.status} ${res.statusText}${attempt < 4 ? ", retrying" : ""}`);
    } catch (e) {
      console.error(`download failed: ${e.message}${attempt < 4 ? ", retrying" : ""}`);
      res = null;
    }
    if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 5000));
  }
  if (!res || !res.ok) process.exit(1);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchOne(triple) {
  const out = sidecarPath(triple);
  if (existsSync(out)) { console.log(`tectonic sidecar present: ${out}`); return out; }
  const asset = ASSETS[triple];
  if (!asset) { console.error(`no Tectonic release asset known for ${triple}`); process.exit(1); }
  const url = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${VERSION}/${asset}`;
  console.log(`downloading ${url}`);
  const buf = await download(url);
  const tmp = mkdtempSync(join(tmpdir(), "tectonic-"));
  const win = triple.includes("windows");
  writeFileSync(join(tmp, asset), buf);
  // On Windows, Git Bash puts GNU tar first on PATH, which cannot read zip files and mistakes "C:" for a host;
  // the system bsdtar reads both formats. Relative paths keep every tar happy.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", asset], { cwd: tmp, stdio: "inherit" });
  mkdirSync(join("src-tauri", "binaries"), { recursive: true });
  copyFileSync(join(tmp, `tectonic${win ? ".exe" : ""}`), out);
  if (!win) chmodSync(out, 0o755);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`tectonic sidecar ready: ${out}`);
  return out;
}

export async function fetchTectonic(triple = process.env.TARGET_TRIPLE ?? hostTriple()) {
  const out = sidecarPath(triple);
  if (existsSync(out)) { console.log(`tectonic sidecar present: ${out}`); return out; }
  const parts = partsFor(triple);
  if (parts.length > 1) {
    if (process.platform !== "darwin") {
      console.error("lipo is a macOS tool; universal Tectonic is built on macOS");
      process.exit(1);
    }
    const bins = [];
    for (const p of parts) bins.push(await fetchOne(p));
    mkdirSync(join("src-tauri", "binaries"), { recursive: true });
    execFileSync("lipo", ["-create", ...bins, "-output", out], { stdio: "inherit" });
    chmodSync(out, 0o755);
    console.log(`tectonic sidecar ready: ${out}`);
    return out;
  }
  return fetchOne(triple);
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  await fetchTectonic();
}
