#!/usr/bin/env bash
# Sign the Firefox build with your AMO API credentials (unlisted: signed for
# your own use, not published) and open the result in Firefox to install it.
# Credentials file (chmod 600), from https://addons.mozilla.org/developers/addon/api/key/ :
#   AMO_JWT_ISSUER=user:12345:678
#   AMO_JWT_SECRET=abcdef...
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CREDS="${AMO_CREDENTIALS:-$HOME/.config/r-aloud/amo.env}"
[[ -r "$CREDS" ]] || { echo "Put AMO_JWT_ISSUER / AMO_JWT_SECRET in $CREDS" >&2; exit 1; }
set -a; source "$CREDS"; set +a

cd "$ROOT/extension"
node scripts/build.mjs firefox
rm -rf dist/signed
npx web-ext sign --channel=unlisted --source-dir dist/firefox --artifacts-dir dist/signed \
  --api-key="$AMO_JWT_ISSUER" --api-secret="$AMO_JWT_SECRET"
XPI="$(command ls -t dist/signed/*.xpi | head -1)"
echo "Signed: $XPI"
[[ "${1:-}" == "--no-open" ]] || firefox "$XPI"
