#!/bin/sh
# Build the standalone dabir-check as one release asset and smoke-test it on the sample paper.
#   build.sh <asset name> [rust target]    no target: a universal macOS binary
# Used by CI (each platform, on a change to the check) and by the release, which attaches the assets.
set -eu
cd "$(dirname "$0")"
asset=$1 target=${2:-}
if [ -z "$target" ]; then
  cargo build --release --target aarch64-apple-darwin
  cargo build --release --target x86_64-apple-darwin
  lipo -create -output "$asset" target/aarch64-apple-darwin/release/dabir-check target/x86_64-apple-darwin/release/dabir-check
else
  cargo build --release --target "$target"
  case "$target" in *windows*) ext=.exe ;; *) ext= ;; esac
  cp "target/$target/release/dabir-check$ext" "$asset"
fi
bin="$PWD/$asset"
(cd ../../examples/score-anchor && "$bin")
