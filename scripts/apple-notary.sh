#!/bin/sh
# Fix the notarisation credentials on the repository. The v0.1.1 and v0.1.2 release runs signed the app
# (the certificate secrets are fine) and then failed at notarisation with HTTP 401: the Apple ID,
# app-specific password or Team ID in the secrets do not match. This script checks a set of credentials
# against Apple first, with notarytool, and only then writes the three secrets. Nothing is stored on disk.
#
# You need an app-specific password for your Apple ID: account.apple.com › Sign-In and Security ›
# App-Specific Passwords › + (a plain account password is refused with the same 401).
set -eu
REPO="${DABIR_REPO:-surenalab/dabir}"
command -v gh >/dev/null || { echo "gh (GitHub CLI) is required"; exit 1; }
xcrun notarytool --version >/dev/null 2>&1 || { echo "Xcode command line tools are required (xcrun notarytool)"; exit 1; }

# The Team ID is in the Developer ID certificate's name; offer it as the default.
TEAM_DEFAULT="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*Developer ID Application: .*(\([A-Z0-9]\{10\}\)).*/\1/p' | head -1)"

printf 'Apple ID email: '; read -r APPLE_ID
printf 'App-specific password (xxxx-xxxx-xxxx-xxxx): '; stty -echo; read -r APPLE_PASSWORD; stty echo; echo
printf 'Team ID [%s]: ' "${TEAM_DEFAULT:-none found}"; read -r TEAM_ID
TEAM_ID="${TEAM_ID:-$TEAM_DEFAULT}"
[ -n "$TEAM_ID" ] || { echo "A Team ID is needed (developer.apple.com/account › Membership details)."; exit 1; }

echo "Checking with Apple…"
if ! OUT="$(xcrun notarytool history --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$TEAM_ID" 2>&1)"; then
  echo "$OUT" | head -5
  echo
  echo "Apple refused these credentials; nothing was changed on GitHub."
  echo "Check: the email is the Apple ID of the developer account; the password is an app-specific one, not the"
  echo "account password; the Team ID is the one in the certificate name ($TEAM_DEFAULT)."
  exit 1
fi
echo "Apple accepted them."

printf '%s' "$APPLE_ID" | gh secret set APPLE_ID --repo "$REPO"
printf '%s' "$APPLE_PASSWORD" | gh secret set APPLE_PASSWORD --repo "$REPO"
printf '%s' "$TEAM_ID" | gh secret set APPLE_TEAM_ID --repo "$REPO"
echo "APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID set on $REPO. The next tag builds signed, notarised DMGs."
