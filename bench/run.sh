#!/usr/bin/env bash
# Run the agent benchmark for one provider, optionally one task.
# Usage: ./bench/run.sh <provider> [task-id]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
provider="${1:?provider required (claude|codex|cursor|grok)}"
task="${2:-}"
export PATH="${HOME}/.cargo/bin:${PATH}"
cd "$root/src-tauri"
# Scrub parent Claude Code session vars that make nested CLIs 401.
unset ANTHROPIC_BASE_URL
for k in $(env | sed -n 's/^\(CLAUDE_CODE_[^=]*\)=.*/\1/p'); do unset "$k"; done
export DABIR_LIVE_PROVIDER="$provider"
export CARGO_TARGET_DIR=target/test
if [[ -n "$task" ]]; then export DABIR_BENCH_TASK="$task"; else unset DABIR_BENCH_TASK || true; fi
cargo test agent_bench -- --ignored --nocapture
