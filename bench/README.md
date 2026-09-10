# Dabir agent benchmark

Twenty LaTeX repair and revision tasks on a fresh copy of `examples/score-anchor`. The runner reuses the same worktree + vendor CLI path as `live_agent_run`.

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

## Results, 2026-09-10

| Provider | Passed | Mean per task | Notes |
|---|---|---|---|
| Grok | 20/20 | 20 s | |
| Claude Code | 19/20 | 34 s | 13 wrote `$A$` where the check wanted `A`; check loosened, passes on rerun |
| Cursor | 18/20 | 52 s | 13 as above; 11 reran the sweep and regenerated the figure PDF, and the apply step corrupted non-UTF-8 bytes in that diff (fixed: patches are now byte-exact; passes on rerun in 146 s) |
| Codex | 0/20 | 3 s | Account at its usage limit; the CLI's error was swallowed as a bare failure (fixed: the message now reaches the transcript) |

## Task shape

Each `tasks/<id>.json`:

| Field | Meaning |
|---|---|
| `id` | Stable slug |
| `kind` | `revision` or `repair` |
| `prompt` | Exact agent request |
| `mutate` | Optional `{file, find, replace}` applied before the run (for repair) |
| `expect_files` | Paths that must appear in the worktree diff |
| `expect_contains` | Substrings that must appear in the named file after accept |
| `expect_absent` | Substrings that must not remain |
| `timeout_secs` | Cap (default 180) |

## Rules

- Tasks stay small: one concern, one or two files.
- Never ask the agent to invent numbers that are not in the paper; repair tasks break syntax or refs that compile would catch.
- The user's branch is never the fixture; each run uses a temp copy.
