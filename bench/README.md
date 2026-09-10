# Dabir agent benchmark

Twenty LaTeX repair and revision tasks on a fresh copy of `examples/score-anchor`. The runner reuses the same worktree + vendor CLI path as `live_agent_run`.

## Run

One provider, all tasks (writes `bench/results/<provider>.json`):

```bash
cd src-tauri
env -u ANTHROPIC_BASE_URL DABIR_LIVE_PROVIDER=claude CARGO_TARGET_DIR=target/test \
  cargo test agent_bench -- --ignored --nocapture
```

One task:

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
