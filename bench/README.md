# Dabir agent benchmark

Twenty-one LaTeX repair, revision and one deliberately vague task on a fresh copy of `examples/score-anchor`. The runner reuses the same worktree + vendor CLI path as the app, and since 2026-09-10 sends the same prompt the app sends (the preamble with the brief, file map and context pack in front of the request), so it measures the prompt too.

`DABIR_BENCH_VERBOSE=1` prints every tool call and reply with its time; each result records the number of tool calls.

## Run

One provider, all tasks (writes `bench/results/<provider>.json`):

```bash
cd src-tauri
env -u ANTHROPIC_BASE_URL DABIR_LIVE_PROVIDER=claude CARGO_TARGET_DIR=target/test \
  cargo test agent_bench -- --ignored --nocapture
```

One task (writes `bench/results/<provider>-<task>.json`, leaving the suite's file alone):

```bash
DABIR_BENCH_TASK=01-strong-baselines DABIR_LIVE_PROVIDER=codex \
  cargo test agent_bench -- --ignored --nocapture
```

Or from the repo root:

```bash
./bench/run.sh claude
./bench/run.sh codex 07-unclosed-equation
```

Pass rates per vendor are the artifact that matters; publish them with a release note when the numbers stabilize.

Running several providers at once is fine (each task works in its own temp copy), but build the test binary once first (`cargo test --no-run`) and start the runs from that binary, or the second `cargo test` will wait on the build lock and may rewrite the binary under the first.

## Results, 2026-09-10, third run (preamble in the loop)

The vague task `21-add-a-figure-vague` (prompt: "add a figure") was added after a real run in the app took over six minutes and added nothing: the agent read Dabir's own CLAUDE.md and bench folder above the paper, ran `which tectonic`, and edited and reran code. With the raw request as prompt, Grok took 432 s and 36 tool calls and moved the existing figure instead of adding one. With the preamble (boundary, brief and file map inline, numbered procedure, tectonic on PATH) it took 138 s and 8 tool calls and added a TikZ schematic with a caption and a reference. The full Grok suite with the preamble: 21/21, 20 s mean on the twenty scripted tasks (24 s in the second run), 1 to 5 tool calls each, 8.9 min in all.

## Results, 2026-09-10, second run

After the run path changed (worktrees seeded from the working copy; Accept applies to the working tree with a plain `git apply`, three-way as a fallback), all four providers ran in parallel from one test binary. Every task passed on the first attempt; no reruns.

| Provider | Passed | Mean per task | Slowest | Suite |
|---|---|---|---|---|
| Grok | 20/20 | 24 s | 79 s (05-cite-add) | 7.9 min |
| Codex | 20/20 | 33 s | 41 s | 11.1 min |
| Claude Code | 20/20 | 35 s | 159 s (20-compile-and-fix-skill) | 11.6 min |
| Cursor | 20/20 | 44 s | 101 s | 14.6 min |

## Results, 2026-09-10, first run

| Provider | Passed | Mean per task | Notes |
|---|---|---|---|
| Grok | 20/20 | 20 s | |
| Claude Code | 19/20 | 34 s | 13 wrote `$A$` where the check wanted `A`; check loosened, passes on rerun |
| Cursor | 18/20 | 52 s | 13 as above; 11 reran the sweep and regenerated the figure PDF, and the apply step corrupted non-UTF-8 bytes in that diff (fixed: patches are now byte-exact; passes on rerun in 146 s) |
| Codex | 19/20 | 40 s | First attempt found the account at its usage limit and every task failed in 3 s; the CLI's error was swallowed as a bare failure (fixed: the message now reaches the transcript). Rerun after the window reset: 10 hung past the 180 s cap once and passed in 36 s on rerun |

With the two fixes above, every vendor passes every task on rerun; the cap of 180 s is generous for all of them (Grok 8–40 s, Codex 16–38 s, Claude and Cursor up to ~2 min on the compile-and-fix task).

## Task shape

Each `tasks/<id>.json`:

| Field | Meaning |
|---|---|
| `id` | Stable slug |
| `kind` | `revision`, `repair` or `vague` |
| `prompt` | Exact agent request |
| `mutate` | Optional `{file, find, replace}` applied before the run (for repair) |
| `expect_files` | Paths that must appear in the worktree diff |
| `expect_contains` | Substrings that must appear in the named file after accept |
| `expect_absent` | Substrings that must not remain |
| `expect_count` | `{file, text, min}`: the substring must occur at least `min` times |
| `timeout_secs` | Cap (default 180) |

## Rules

- Tasks stay small: one concern, one or two files.
- Never ask the agent to invent numbers that are not in the paper; repair tasks break syntax or refs that compile would catch.
- The user's branch is never the fixture; each run uses a temp copy.
