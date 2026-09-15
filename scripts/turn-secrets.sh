#!/bin/sh
# Give the signalling worker a Cloudflare TURN key, so peers behind firewalls that block direct
# traffic still connect (TURN carries the encrypted packets; it cannot read them). Free: 1 TB/month.
#
#   1. dash.cloudflare.com › Realtime › TURN Server › Create  (name it dabir-signal)
#   2. scripts/turn-secrets.sh          then paste the Key ID and the API token it shows once
#
# Checks the key against Cloudflare first; writes the two worker secrets only if it answers.
set -eu
cd "$(dirname "$0")/.."
printf 'TURN Key ID: '; read -r KEY_ID
printf 'TURN API token: '; stty -echo; read -r API_TOKEN; stty echo; echo
[ -n "$KEY_ID" ] && [ -n "$API_TOKEN" ] || { echo "both are needed"; exit 1; }

echo "Key ID has ${#KEY_ID} characters, token has ${#API_TOKEN}."
echo "Asking Cloudflare for a test credential…"
OUT="$(curl -s -w '\n%{http_code}' -X POST "https://rtc.live.cloudflare.com/v1/turn/keys/$KEY_ID/credentials/generate-ice-servers" \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" -d '{"ttl":86400}')"
CODE="$(printf '%s' "$OUT" | tail -1)"
BODY="$(printf '%s' "$OUT" | sed '$d')"
if [ "$CODE" != "200" ] && [ "$CODE" != "201" ]; then
  echo "Cloudflare answered HTTP $CODE:"
  printf '%s\n' "$BODY" | head -c 400; echo
  echo "Nothing was changed. The Key ID is the 32-character id shown on the TURN key (not its name); the token is the one"
  echo "shown once when the key was created. If the token was lost, delete the key and create a new one."
  exit 1
fi
printf '%s\n' "$BODY" | grep -q '"turn' || { echo "Cloudflare answered without TURN servers; nothing was changed."; echo "$BODY" | head -c 300; exit 1; }
echo "Cloudflare accepted the key."
printf '%s' "$KEY_ID" | npx wrangler secret put TURN_KEY_ID --config relay/wrangler.toml
printf '%s' "$API_TOKEN" | npx wrangler secret put TURN_API_TOKEN --config relay/wrangler.toml
echo "Set. Check: curl -s $(sed -n 's/^.*DEFAULT_SIGNAL = "wss:\(.*\)";/https:\1/p' src/lib/collab.ts)/ice   should list turn: servers."
