#!/usr/bin/env bash
# Sign the Firefox build with your AMO API credentials and open the result in
# Firefox to install it.
#   scripts/sign-firefox.sh            unlisted: signed for your own use only
#   scripts/sign-firefox.sh --listed   submit to addons.mozilla.org (public, reviewed)
# Each submission needs a new "version" in extension/manifest.base.json.
# Credentials file (chmod 600), from https://addons.mozilla.org/developers/addon/api/key/ :
#   AMO_JWT_ISSUER=user:12345:678
#   AMO_JWT_SECRET=abcdef...
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CREDS="${AMO_CREDENTIALS:-$HOME/.config/r-aloud/amo.env}"
[[ -r "$CREDS" ]] || { echo "Put AMO_JWT_ISSUER / AMO_JWT_SECRET in $CREDS" >&2; exit 1; }
set -a; source "$CREDS"; set +a

CHANNEL=unlisted
EXTRA=()
OPEN=1
for arg in "$@"; do
  case "$arg" in
    --listed) CHANNEL=listed; EXTRA=(--amo-metadata "$ROOT/store/amo-metadata.json") ;;
    --no-open) OPEN=0 ;;
  esac
done

cd "$ROOT/extension"
node scripts/build.mjs firefox
rm -rf dist/signed
npx web-ext sign --channel="$CHANNEL" --source-dir dist/firefox --artifacts-dir dist/signed \
  --api-key="$AMO_JWT_ISSUER" --api-secret="$AMO_JWT_SECRET" "${EXTRA[@]}"
XPI="$(command ls -t dist/signed/*.xpi | head -1)"
echo "Signed: $XPI"
(( OPEN )) && firefox "$XPI"
exit 0
