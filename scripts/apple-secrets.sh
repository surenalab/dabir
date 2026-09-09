#!/bin/sh
# Put the Apple signing and notarisation secrets into the GitHub repository, from your own keychain and
# prompts. Nothing is written to disk in the clear. Run it yourself: it asks for passwords.
#
# Before running you need, from a paid Apple Developer membership:
#   1. A "Developer ID Application" certificate in your login keychain
#      (Xcode › Settings › Accounts › your team › Manage Certificates… › + › Developer ID Application).
#   2. An app-specific password for your Apple ID (account.apple.com › Sign-In and Security › App-Specific Passwords).
#   3. Your Team ID (developer.apple.com/account › Membership details).
set -eu
REPO="${DABIR_REPO:-surenalab/dabir}"
command -v gh >/dev/null || { echo "gh (GitHub CLI) is required"; exit 1; }

IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
if [ -z "$IDENTITY" ]; then
  echo "No 'Developer ID Application' certificate in the keychain yet."
  echo "Create one in Xcode › Settings › Accounts › Manage Certificates… (needs the paid membership), then run this again."
  security find-identity -v -p codesigning | sed 's/^/   found: /'
  exit 1
fi
echo "Certificate: $IDENTITY"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
printf 'Choose a password to protect the exported certificate (used only as a GitHub secret): '
stty -echo; read -r P12PASS; stty echo; echo
# Keychain Access asks for permission to export; the .p12 lives only in the temp dir for a moment.
if [ -n "${DABIR_P12:-}" ]; then
  P12="$DABIR_P12"
else
  security export -t identities -f pkcs12 -P "$P12PASS" -o "$TMP/cert.p12" 2>/dev/null \
    || security export -t identities -f pkcs12 -k ~/Library/Keychains/login.keychain-db -P "$P12PASS" -o "$TMP/cert.p12" 2>/dev/null \
    || {
      echo "Automatic export failed (macOS often refuses it for a key created by Keychain Access)."
      echo "Export by hand: open Keychain Access, choose the login keychain and the My Certificates category,"
      echo "right-click 'Developer ID Application: ...' and choose Export, save as ~/Desktop/dabir.p12 with this same password,"
      echo "then run:  DABIR_P12=~/Desktop/dabir.p12 sh scripts/apple-secrets.sh   and delete the file afterwards."
      exit 1
    }
  P12="$TMP/cert.p12"
fi

printf 'Apple ID email: '; read -r APPLE_ID
printf 'App-specific password: '; stty -echo; read -r APPLE_PASSWORD; stty echo; echo
printf 'Team ID (10 characters): '; read -r TEAM_ID

base64 < "$P12" | tr -d '\n' | gh secret set APPLE_CERTIFICATE --repo "$REPO"
printf '%s' "$P12PASS" | gh secret set APPLE_CERTIFICATE_PASSWORD --repo "$REPO"
printf '%s' "$IDENTITY" | gh secret set APPLE_SIGNING_IDENTITY --repo "$REPO"
printf '%s' "$APPLE_ID" | gh secret set APPLE_ID --repo "$REPO"
printf '%s' "$APPLE_PASSWORD" | gh secret set APPLE_PASSWORD --repo "$REPO"
printf '%s' "$TEAM_ID" | gh secret set APPLE_TEAM_ID --repo "$REPO"
echo "Six secrets set on $REPO. Tag a release (git tag v0.1.1 && git push origin v0.1.1) to get a signed, notarised DMG."
