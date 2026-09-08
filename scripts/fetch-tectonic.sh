#!/bin/sh
# Fetch the Tectonic binary for the current Rust target triple into src-tauri/binaries,
# where Tauri picks it up as an external binary (sidecar) at bundle time.
set -eu
VERSION="${TECTONIC_VERSION:-0.17.0}"
TRIPLE="${TARGET_TRIPLE:-$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')}"
[ -n "$TRIPLE" ] || { echo "rustc not found; set TARGET_TRIPLE"; exit 1; }
OUT="src-tauri/binaries/tectonic-$TRIPLE"
EXT=""
case "$TRIPLE" in
  *windows*) EXT=".exe"; OUT="$OUT.exe" ;;
esac
if [ -x "$OUT" ]; then echo "tectonic sidecar present: $OUT"; exit 0; fi
case "$TRIPLE" in
  aarch64-apple-darwin) ASSET="tectonic-$VERSION-aarch64-apple-darwin.tar.gz" ;;
  x86_64-apple-darwin) ASSET="tectonic-$VERSION-x86_64-apple-darwin.tar.gz" ;;
  x86_64-unknown-linux-gnu) ASSET="tectonic-$VERSION-x86_64-unknown-linux-gnu.tar.gz" ;;
  aarch64-unknown-linux-gnu) ASSET="tectonic-$VERSION-aarch64-unknown-linux-gnu.tar.gz" ;;
  x86_64-pc-windows-msvc) ASSET="tectonic-$VERSION-x86_64-pc-windows-msvc.zip" ;;
  *) echo "no Tectonic release asset known for $TRIPLE"; exit 1 ;;
esac
URL="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40$VERSION/$ASSET"
TMP="$(mktemp -d)"
echo "downloading $URL"
curl -fsSL "$URL" -o "$TMP/$ASSET"
case "$ASSET" in
  *.zip) unzip -q "$TMP/$ASSET" -d "$TMP" ;;
  *) tar -xzf "$TMP/$ASSET" -C "$TMP" ;;
esac
mv "$TMP/tectonic$EXT" "$OUT"
chmod +x "$OUT"
rm -rf "$TMP"
echo "tectonic sidecar ready: $OUT"
