#!/usr/bin/env bash
# One-step installer for r-aloud.
#
#   ./install.sh                 server + background service + both extensions
#   ./install.sh --server-only   just the TTS server (e.g. extension from a store)
#   ./install.sh --uninstall     stop and remove the background service
#
# Needs: Linux with systemd (user services), curl, git. Installs uv if missing.
# Node.js >= 18 is only needed to build the extensions from source.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --server-only) SERVER_ONLY=1 ;;
    --uninstall) exec "$ROOT/scripts/install-server.sh" --uninstall ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

bold "Checking prerequisites"
[[ "$(uname -s)" == Linux ]] || die "this installer supports Linux only (see README for manual steps)"
command -v systemctl >/dev/null || die "systemd is required for the background service"
command -v curl >/dev/null || die "curl is required"
if ! command -v uv >/dev/null; then
  [[ -x "$HOME/.local/bin/uv" ]] || {
    echo "Installing uv (Python package manager) from https://astral.sh/uv ..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
  }
  export PATH="$HOME/.local/bin:$PATH"
fi
echo "uv: $(uv --version)"
if [[ $SERVER_ONLY == 0 ]]; then
  command -v node >/dev/null && command -v npm >/dev/null \
    || die "Node.js >= 18 with npm is needed to build the extensions (or use --server-only)"
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  (( node_major >= 18 )) || die "Node.js >= 18 required (found $(node --version))"
  echo "node: $(node --version)"
fi

bold "Installing the TTS server"
"$ROOT/scripts/install-server.sh"

if [[ $SERVER_ONLY == 0 ]]; then
  bold "Building the browser extensions"
  (cd "$ROOT/extension" && npm ci --no-fund --no-audit --loglevel=error && node scripts/build.mjs --zip)
fi

bold "Done"
cat <<EOF
The server runs at http://127.0.0.1:8771 and starts automatically at login.
  status:  systemctl --user status r-aloud
  logs:    journalctl --user -u r-aloud -f
EOF
if [[ $SERVER_ONLY == 0 ]]; then
  cat <<EOF

Load the extension:
  Chrome   chrome://extensions → Developer mode → Load unpacked →
           $ROOT/extension/dist/chrome
  Firefox  install r-aloud from addons.mozilla.org, or for a quick try:
           about:debugging → This Firefox → Load Temporary Add-on →
           $(ls "$ROOT"/extension/dist/r-aloud-firefox-*.xpi 2>/dev/null | head -1)
EOF
fi
