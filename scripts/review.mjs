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
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] == null ? "1" : all[i + 1]] : [])).filter((x) => x.length));
const provider = args.provider ?? "claude";
const base = args.base ?? "main";
const pr = args.pr && args.pr !== "1" ? args.pr : null;
const post = args.post === "1";
const out = args.out ?? null;
const root = execFileSync("git", ["rev-parse", "--show-toplevel"]).toString().trim();
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });

// ---- what changed
let head = "HEAD";
if (pr) { sh("gh", ["pr", "checkout", pr]); head = "HEAD"; }
const mergeBase = sh("git", ["merge-base", base, head]).trim();
const diff = sh("git", ["diff", `${mergeBase}...${head}`, "--", ".", ":(exclude)package-lock.json", ":(exclude)Cargo.lock", ":(exclude)*.png", ":(exclude)*.jpg"]);
if (!diff.trim()) { console.error(`Nothing to review: no changes between ${base} and ${head}.`); process.exit(2); }
const files = sh("git", ["diff", "--name-only", `${mergeBase}...${head}`]).trim().split("\n").filter(Boolean);
const srcFiles = files.filter((f) => /\.(ts|tsx|rs|mjs|js|css|toml|json|md|yml)$/.test(f) && !/lock|\.png|\.jpg/.test(f) && existsSync(join(root, f)));

// ---- codebase awareness without a service: exported symbols touched by the change, and where they are used
const symbols = new Set();
for (const f of srcFiles.filter((x) => /\.(ts|tsx|rs)$/.test(x))) {
  const text = readFileSync(join(root, f), "utf8");
  for (const m of text.matchAll(/export (?:async )?(?:function|const|class|interface|type) ([A-Za-z_][A-Za-z0-9_]*)/g)) symbols.add(m[1]);
  for (const m of text.matchAll(/pub (?:async )?fn ([a-z_][a-z0-9_]*)/g)) symbols.add(m[1]);
}
let usages = "";
if (symbols.size) {
  const pattern = [...symbols].slice(0, 60).join("|");
  const r = spawnSync("git", ["grep", "-n", "-E", `\\b(${pattern})\\b`, "--", "src", "src-tauri/src", ":(exclude)*.lock"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  usages = (r.stdout || "").split("\n").filter((l) => l && !files.some((f) => l.startsWith(f + ":"))).slice(0, 400).join("\n");
}

// ---- the brief the reviewer works from
const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : "");
const rubric = read("docs/REVIEW.md"), rules = read("CONTRIBUTING.md");
const design = (read("DESIGN.md").match(/## Do not[\s\S]*?(?=\n## |$)/) || [""])[0];
let budget = 180_000; // characters of source we include in full; the agent can read the rest itself
const sources = [];
for (const f of srcFiles) { const t = readFileSync(join(root, f), "utf8"); if (t.length > budget) continue; budget -= t.length; sources.push(`===== ${f}\n${t}`); }

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
const promptFile = join(tmp, "prompt.md"); writeFileSync(promptFile, prompt);
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
if (r.error) { console.error(`Could not start ${provider}: ${r.error.message}`); process.exit(1); }
const raw = (r.stdout || "") + (r.stderr && !r.stdout ? r.stderr : "");
const jsonText = (raw.match(/\{[\s\S]*"verdict"[\s\S]*\}/) || [null])[0];
let review;
try { review = JSON.parse(jsonText); } catch { console.error(`The reviewer did not answer with JSON. Raw output:\n${raw.slice(0, 4000)}`); process.exit(1); }

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
  catch (e) { console.error(`gh could not post the review (${e.message}); the text is above.`); process.exit(1); }
}
process.exit(review.verdict === "request_changes" && findings.some((f) => f.severity === "blocking") ? 3 : 0);
