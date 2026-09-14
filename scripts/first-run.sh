#!/bin/sh
# Put the installed Dabir back into the state of a first launch, so the welcome screen, the tour offer and the
# sample copy can be tested again. macOS only; nothing in the repository is touched.
#
#   scripts/first-run.sh            reset the app's data and the sample copy, then launch
#   scripts/first-run.sh --install  also replace /Applications/Dabir.app with the last local build first
#   scripts/first-run.sh --keep-kits  keep the downloaded template kits (saves refetching them)
#
# What is removed: the web view's storage (settings, the last paper, "tour seen"), the app's data folder
# (template kits unless --keep-kits), and ~/Documents/Dabir/score-anchor-sample. Your own papers are not touched.
set -eu
id=com.surenalab.dabir
install=0; keep=0
for a in "$@"; do
  case "$a" in
    --install) install=1;;
    --keep-kits) keep=1;;
    *) echo "unknown option: $a" >&2; exit 2;;
  esac
done

if [ "$(uname)" != "Darwin" ]; then echo "This script knows macOS only." >&2; exit 1; fi

osascript -e 'tell application "Dabir" to quit' >/dev/null 2>&1 || true
pkill -x dabir 2>/dev/null || true
sleep 1

if [ "$install" = 1 ]; then
  app="$(dirname "$0")/../src-tauri/target/release/bundle/macos/Dabir.app"
  [ -d "$app" ] || { echo "no local build at $app; run: npm run tauri build -- --bundles app" >&2; exit 1; }
  rm -rf /Applications/Dabir.app
  cp -R "$app" /Applications/
  echo "installed $(defaults read /Applications/Dabir.app/Contents/Info.plist CFBundleShortVersionString) to /Applications"
fi

rm -rf "$HOME/Library/WebKit/$id" "$HOME/Library/Caches/$id" "$HOME/Library/Saved Application State/$id.savedState"
if [ "$keep" = 1 ]; then
  find "$HOME/Library/Application Support/$id" -mindepth 1 -maxdepth 1 ! -name templates -exec rm -rf {} + 2>/dev/null || true
else
  rm -rf "$HOME/Library/Application Support/$id"
fi
rm -rf "$HOME/Documents/Dabir/score-anchor-sample"
echo "first-run state restored: settings, last paper, tour flag and the sample copy are gone"

open -a /Applications/Dabir.app
