#!/usr/bin/env node
// Dabir's own review bot: a codebase-aware pull request review that runs on the coding-agent
// subscriptions already on this machine (Claude Code, Codex, Cursor, Grok), so it costs nothing extra
// and never sends the repository to a third service. It is the open alternative to hosted reviewers.
//
//   npm run review                       review the current branch against main with Claude Code
//   npm run review -- --provider codex   second opinion from a different vendor
//   npm run review -- --pr 12 --post     review pull request 12 and post the result as a PR review
//   npm run review -- --base origin/main --out review.md
//
// What the reviewer sees: the rubric (docs/REVIEW.md) and the rules (CONTRIBUTING.md), the diff, the
// full text of every changed source file, and the places elsewhere in the repository that use the
// symbols the change touched. With Claude Code and Codex it may also read any other file itself,
// read-only. It must answer as JSON, which this script renders and, if asked, posts with gh.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) out[a.slice(2)] = true; else { out[a.slice(2)] = next; i++; }
  }
  return out;
}
export const isSource = (f) => /\.(ts|tsx|rs|mjs|js|css|toml|json|md|yml)$/.test(f) && !/(^|\/)(package-lock\.json|Cargo\.lock|skills-lock\.json)$/.test(f);
/** Find the reviewer's JSON object in free text: fenced block first, then the last balanced object containing "verdict". */
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/g) || [];
  const candidates = fenced.map((b) => b.replace(/```(?:json)?\s*|```$/g, ""));
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== "}") continue;
    let depth = 0;
    for (let j = i; j >= 0; j--) {
      if (text[j] === "}") depth++; else if (text[j] === "{") { depth--; if (depth === 0) { candidates.push(text.slice(j, i + 1)); break; } }
    }
    if (candidates.length > 6) break;
  }
  for (const c of candidates) { try { const o = JSON.parse(c); if (o && typeof o === "object" && "verdict" in o) return o; } catch { /* next candidate */ } }
  return null;
}

const isMain = process.argv[1] && /review\.mjs$/.test(process.argv[1]);
if (isMain) main();

function fail(msg, code = 1) { console.error(msg); process.exit(code); }

function main() {
const args = parseArgs(process.argv.slice(2));
const provider = typeof args.provider === "string" ? args.provider : "claude";
const pr = typeof args.pr === "string" ? args.pr : null;
const post = args.post === true;
if (post && !pr) fail("--post needs --pr <number>; nothing was posted.");
if (args.out === true) fail("--out needs a file path.");
const out = typeof args.out === "string" ? args.out : null;
let root;
try { root = execFileSync("git", ["rev-parse", "--show-toplevel"]).toString().trim(); } catch { fail("Not inside a Git repository."); }
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });

// ---- what changed. A pull request is fetched into a ref; HEAD and the working tree are never moved.
let head = "HEAD", base = typeof args.base === "string" ? args.base : "main";
if (pr) {
  try { sh("git", ["fetch", "-q", "origin", `pull/${pr}/head:refs/dabir/review/pr-${pr}`]); head = `refs/dabir/review/pr-${pr}`; }
  catch { fail(`Could not fetch pull request ${pr} from origin. Is the remote named origin and gh signed in?`); }
  try { const b = JSON.parse(sh("gh", ["pr", "view", pr, "--json", "baseRefName"])).baseRefName; if (b && !(typeof args.base === "string")) base = `origin/${b}`; } catch { /* keep base */ }
}
let mergeBase;
try { mergeBase = sh("git", ["merge-base", base, head]).trim(); }
catch { fail(`No branch or ref named ${base} here. Pass --base origin/main (or the branch the change targets).`); }
const diff = sh("git", ["diff", `${mergeBase}...${head}`, "--", ".", ":(exclude)package-lock.json", ":(exclude)Cargo.lock", ":(exclude)*.png", ":(exclude)*.jpg"]);
if (!diff.trim()) fail(`Nothing to review: no changes between ${base} and ${pr ? "pull request " + pr : head}.`, 2);
const files = sh("git", ["diff", "--name-only", `${mergeBase}...${head}`]).trim().split("\n").filter(Boolean);
const show = (f) => { try { return sh("git", ["show", `${head}:${f}`]); } catch { return null; } };
const srcFiles = files.filter(isSource).filter((f) => show(f) != null);

// ---- codebase awareness without a service: exported symbols touched by the change, and where they are used
const symbols = new Set();
for (const f of srcFiles.filter((x) => /\.(ts|tsx|rs)$/.test(x))) {
  const text = show(f) ?? "";
  for (const m of text.matchAll(/export (?:async )?(?:function|const|class|interface|type) ([A-Za-z_][A-Za-z0-9_]*)/g)) symbols.add(m[1]);
  for (const m of text.matchAll(/pub (?:async )?fn ([a-z_][a-z0-9_]*)/g)) symbols.add(m[1]);
}
let usages = "";
if (symbols.size) {
  const pattern = [...symbols].slice(0, 60).join("|");
  const r = spawnSync("git", ["grep", "-n", "-E", `\\b(${pattern})\\b`, head, "--", "src", "src-tauri/src"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.stdout) r.stdout = r.stdout.replace(new RegExp(`^${head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "gm"), "");
  usages = (r.stdout || "").split("\n").filter((l) => l && !files.some((f) => l.startsWith(f + ":"))).slice(0, 400).join("\n");
}

// ---- the brief the reviewer works from
const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : "");
const rubric = read("docs/REVIEW.md"), rules = read("CONTRIBUTING.md");
const design = (read("DESIGN.md").match(/## Do not[\s\S]*?(?=\n## |$)/) || [""])[0];
let budget = 180_000; // characters of source we include in full; the agent can read the rest itself
const sources = [];
for (const f of srcFiles) { const t = show(f) ?? ""; if (t.length > budget) continue; budget -= t.length; sources.push(`===== ${f}\n${t}`); }

const prompt = `You are reviewing a change to Dabir, a local-first desktop editor for scientific papers (Tauri, React, Rust).
Work through the rubric completely. Report only real findings; do not restate the diff; do not praise.
Answer with ONE JSON object and nothing else, in this shape:
{"verdict":"approve|request_changes|comment","summary":"one sentence","findings":[{"severity":"blocking|should|nit","file":"path","line":123,"claim":"one sentence","scenario":"concrete input or state -> wrong result","suggestion":"what to change"}]}

### Rubric (docs/REVIEW.md)
${rubric}

### Rules (CONTRIBUTING.md)
${rules}

### Design bans (DESIGN.md)
${design}

### Files changed
${files.join("\n")}

### Diff against ${base}
${diff.slice(0, 260_000)}

### Full text of changed source files
${sources.join("\n\n")}

### Where the touched symbols are used elsewhere (git grep)
${usages || "(none found)"}
`;

// ---- run the provider, read-only
const home = homedir();
const env = { ...process.env }; delete env.ANTHROPIC_BASE_URL; for (const k of Object.keys(env)) if (k.startsWith("CLAUDE_CODE_")) delete env[k];
const tmp = mkdtempSync(join(tmpdir(), "dabir-review-"));
const cleanup = () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } };
process.on("exit", cleanup);
const bins = {
  claude: [existsSync(join(home, ".local/bin/claude")) ? join(home, ".local/bin/claude") : "claude", ["-p", "--output-format", "text", "--permission-mode", "plan", "--allowedTools", "Read,Grep,Glob"]],
  codex: ["/Applications/ChatGPT.app/Contents/Resources/codex", ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-C", root]],
  cursor: [join(home, ".local/bin/cursor-agent"), ["-p", "--output-format", "text"]],
  grok: [join(home, ".grok/bin/grok"), ["-p", "--output-format", "plain", "--permission-mode", "plan", "--cwd", root]],
};
const [bin, extra] = bins[provider] ?? bins.claude;
const stdinProviders = new Set(["codex", "cursor", "claude"]);
const runArgs = stdinProviders.has(provider) ? extra : [...extra.slice(0, 1), prompt, ...extra.slice(1)];
console.error(`Reviewing ${files.length} files against ${base} with ${provider}…`);
const r = spawnSync(bin, runArgs, { cwd: root, env, encoding: "utf8", input: stdinProviders.has(provider) ? prompt : undefined, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
if (r.error) fail(`Could not start ${provider} (${bin}): ${r.error.message}. Install its CLI and sign in, or pick another --provider.`);
const raw = (r.stdout || "") + (r.stderr && !r.stdout ? r.stderr : "");
const review = extractJson(raw);
if (!review) fail(`The reviewer did not answer with JSON. Raw output:\n${raw.slice(0, 4000)}`);

// ---- render
const sev = { blocking: "Blocking", should: "Should fix", nit: "Nit" };
const order = { blocking: 0, should: 1, nit: 2 };
const findings = (review.findings || []).sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
const verdictWord = { approve: "Approve", request_changes: "Request changes", comment: "Comment" }[review.verdict] || "Comment";
let md = `## Review by ${provider} · ${verdictWord}\n\n${review.summary || ""}\n\n`;
if (!findings.length) md += "No findings.\n";
for (const f of findings) md += `- **${sev[f.severity] || f.severity}** \`${f.file}${f.line ? ":" + f.line : ""}\` — ${f.claim}\n  - Scenario: ${f.scenario || "—"}\n  - Suggestion: ${f.suggestion || "—"}\n`;
md += `\n<sub>Rubric: docs/REVIEW.md · base ${base} · ${files.length} files · generated by scripts/review.mjs on the author's ${provider} subscription, read-only.</sub>\n`;
if (out) writeFileSync(out, md);
process.stdout.write(md);

// ---- post
if (post && pr) {
  const event = review.verdict === "approve" ? "--approve" : review.verdict === "request_changes" ? "--request-changes" : "--comment";
  const body = join(tmp, "review.md"); writeFileSync(body, md);
  try { sh("gh", ["pr", "review", pr, event, "--body-file", body]); console.error(`Posted as a ${verdictWord} review on #${pr}.`); }
  catch (e) { fail(`gh could not post the review (${e.message.split("\n")[0]}); the text is above. Sign in with gh auth login and try again.`); }
}
// A blocking finding fails the run whatever the verdict says, so this can gate a merge.
process.exit(findings.some((f) => f.severity === "blocking") ? 3 : 0);
}
