#!/bin/sh
# The gate. Same steps as CI; run before every pull request:  npm run check
# Fails on the first red step. Set SKIP_RUST=1 for a front-end-only pass while the dev app holds the build lock.
set -eu
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
step() { printf '\n\033[1m› %s\033[0m\n' "$1"; }

step "TypeScript"      && npx tsc --noEmit -p tsconfig.json
step "ESLint"          && npx eslint .
step "Production build" && npx vite build --logLevel warn
step "Script tests"    && node --test scripts/*.test.mjs
if [ "${SKIP_RUST:-0}" != "1" ]; then
  step "cargo fmt"     && (cd src-tauri && cargo fmt --check)
  step "cargo clippy"  && (cd src-tauri && CARGO_TARGET_DIR=target/test cargo clippy --all-targets -- -D warnings)
  step "cargo test"    && (cd src-tauri && CARGO_TARGET_DIR=target/test cargo test --quiet)
fi
DETECT="$HOME/.claude/skills/impeccable/scripts/impeccable"
if [ -x "$DETECT" ]; then
  step "Design detector"
  n="$("$DETECT" detect --json src index.html 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s||"[]").length))')"
  if [ "$n" != "0" ]; then "$DETECT" detect src index.html 2>/dev/null | head -40; echo "design detector: $n finding(s)"; exit 1; fi
  echo "0 findings"
else
  echo "Impeccable skill not installed; design detector skipped (say so in the pull request)."
fi
printf '\n\033[32mAll green.\033[0m\n'
