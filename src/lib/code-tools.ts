// What an IDE adds around a code file: a way to run it and a way to format it. Runs go to the terminal
// panel as a typed command, so the author sees exactly what ran and can rerun or change it. Formatting
// goes through the project's own formatter on the PATH the agents use, so both sides agree on style.

import { lspAvailable, runFilter } from "./backend";

const ext = (path: string) => path.split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const stem = (path: string) => (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "");
const bin = (path: string) => q(`/tmp/${stem(path)}`);

export interface RunRecipe { label: string; command: string }

/** The command that runs `rel` (a path relative to the paper's folder), or null when Dabir has no recipe for it.
 * `files` are the paper's relative paths, to notice a Cargo.toml or package.json. */
export function runRecipe(rel: string, files: string[] = []): RunRecipe | null {
  const e = ext(rel);
  const has = (name: string) => files.includes(name);
  switch (e) {
    case "py": return { label: "Run with Python", command: `python3 ${q(rel)}` };
    case "jl": return { label: "Run with Julia", command: `julia ${q(rel)}` };
    case "r": return { label: "Run with Rscript", command: `Rscript ${q(rel)}` };
    case "sh": case "bash": return { label: "Run with bash", command: `bash ${q(rel)}` };
    case "zsh": return { label: "Run with zsh", command: `zsh ${q(rel)}` };
    case "js": case "mjs": case "cjs": return { label: "Run with Node", command: `node ${q(rel)}` };
    case "ts": return { label: "Run with tsx", command: `npx tsx ${q(rel)}` };
    case "lua": return { label: "Run with Lua", command: `lua ${q(rel)}` };
    case "m": return { label: "Run with Octave", command: `octave --no-gui ${q(rel)}` };
    case "rs": return has("Cargo.toml") ? { label: "cargo run", command: "cargo run" } : { label: "Compile and run", command: `rustc ${q(rel)} -o ${bin(rel)} && ${bin(rel)}` };
    case "c": return { label: "Compile and run", command: `cc -O2 ${q(rel)} -o ${bin(rel)} && ${bin(rel)}` };
    case "cc": case "cpp": case "cxx": return { label: "Compile and run", command: `c++ -std=c++17 -O2 ${q(rel)} -o ${bin(rel)} && ${bin(rel)}` };
    case "cu": return { label: "Compile and run", command: `nvcc -O2 ${q(rel)} -o ${bin(rel)} && ${bin(rel)}` };
    case "f": case "f90": case "f95": return { label: "Compile and run", command: `gfortran -O2 ${q(rel)} -o ${bin(rel)} && ${bin(rel)}` };
    default: return null;
  }
}

/** The interactive shell for a language, which ⇧⏎ then feeds line by line; null when there is none worth opening. */
export function replCommand(rel: string): { label: string; command: string } | null {
  switch (ext(rel)) {
    case "py": case "pyi": return { label: "Python", command: "python3" };
    case "jl": return { label: "Julia", command: "julia" };
    case "r": return { label: "R", command: "R" };
    case "js": case "mjs": case "cjs": case "ts": case "tsx": case "jsx": return { label: "Node", command: "node" };
    case "lua": return { label: "Lua", command: "lua" };
    case "m": return { label: "Octave", command: "octave --no-gui" };
    case "sql": return { label: "sqlite3", command: "sqlite3" };
    default: return null;
  }
}

export interface Formatter { command: string; args: (rel: string) => string[]; install: string }

/** Formatters for a file, best first. All read stdin and write the result to stdout. */
export function formattersFor(rel: string): Formatter[] {
  const e = ext(rel);
  const prettier: Formatter = { command: "prettier", args: (r) => ["--stdin-filepath", r], install: "npm i -g prettier" };
  switch (e) {
    case "py": case "pyi": return [
      { command: "ruff", args: (r) => ["format", "--stdin-filename", r, "-"], install: "pip install ruff" },
      { command: "black", args: (r) => ["-q", "--stdin-filename", r, "-"], install: "pip install black" },
    ];
    case "js": case "jsx": case "mjs": case "cjs": case "ts": case "tsx": case "css": case "html": case "json": case "yml": case "yaml": case "md": case "markdown": return [prettier];
    case "rs": return [{ command: "rustfmt", args: () => ["--emit", "stdout", "--edition", "2021"], install: "rustup component add rustfmt" }];
    case "c": case "h": case "cc": case "cpp": case "cxx": case "hh": case "hpp": case "cu": case "cuh": return [{ command: "clang-format", args: (r) => [`--assume-filename=${r}`], install: "brew install clang-format" }];
    case "jl": return [{ command: "julia", args: () => ["--startup-file=no", "-e", "using JuliaFormatter; print(format_text(read(stdin, String)))"], install: "julia -e 'using Pkg; Pkg.add(\"JuliaFormatter\")'" }];
    case "r": return [{ command: "Rscript", args: () => ["-e", 'cat(styler::style_text(readLines(file("stdin"))), sep = "\\n")'], install: "R -e 'install.packages(\"styler\")'" }];
    case "sh": case "bash": case "zsh": return [{ command: "shfmt", args: (r) => ["-filename", r], install: "brew install shfmt" }];
    case "lua": return [{ command: "stylua", args: () => ["-"], install: "brew install stylua" }];
    case "toml": return [{ command: "taplo", args: () => ["fmt", "-"], install: "brew install taplo" }];
    default: return [];
  }
}

export type FormatResult = { ok: true; text: string; formatter: string } | { ok: false; error: string };

/** Reformat `text` of `rel` with the first formatter installed; the error says which to install when none is. */
export async function formatText(root: string, rel: string, text: string): Promise<FormatResult> {
  const specs = formattersFor(rel);
  if (!specs.length) return { ok: false, error: `No formatter for .${ext(rel)} files.` };
  const have = new Set(await lspAvailable(specs.map((s) => s.command)));
  const spec = specs.find((s) => have.has(s.command));
  if (!spec) return { ok: false, error: `No formatter installed for .${ext(rel)} files. Install one: ${specs.map((s) => s.install).join(", or ")}.` };
  try {
    const out = await runFilter(spec.command, spec.args(rel), root, text);
    if (out.code !== 0) return { ok: false, error: `${spec.command} failed: ${(out.stderr || out.stdout).trim().split("\n").slice(0, 3).join(" ") || `exit ${out.code}`}` };
    if (!out.stdout && text.trim()) return { ok: false, error: `${spec.command} returned nothing.` };
    return { ok: true, text: out.stdout, formatter: spec.command };
  } catch (e) { return { ok: false, error: String(e) }; }
}

/** The smallest single replacement that turns `before` into `after`: common prefix and suffix kept. */
export function minimalChange(before: string, after: string): { from: number; to: number; insert: string } | null {
  if (before === after) return null;
  let a = 0;
  const max = Math.min(before.length, after.length);
  while (a < max && before.charCodeAt(a) === after.charCodeAt(a)) a++;
  let b = 0;
  while (b < max - a && before.charCodeAt(before.length - 1 - b) === after.charCodeAt(after.length - 1 - b)) b++;
  return { from: a, to: before.length - b, insert: after.slice(a, after.length - b) };
}
