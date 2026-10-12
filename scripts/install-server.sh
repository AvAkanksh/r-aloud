#!/usr/bin/env bash
# Install the r-aloud TTS server as a systemd user service and fetch the Kokoro model.
#   scripts/install-server.sh            # install + start
#   scripts/install-server.sh --uninstall
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${R_ALOUD_DATA_DIR:-$HOME/.local/share/r-aloud}"
UNIT="$HOME/.config/systemd/user/r-aloud.service"
KOKORO_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl --user disable --now r-aloud.service 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "Removed r-aloud.service (models in $DATA were kept)."
  exit 0
fi

command -v uv >/dev/null || { echo "uv is required: https://docs.astral.sh/uv/" >&2; exit 1; }

echo "==> Python environment"
(cd "$ROOT/server" && uv sync --no-dev -q)

echo "==> Kokoro model files"
mkdir -p "$DATA/models"
for f in kokoro-v1.0.onnx voices-v1.0.bin; do
  [[ -s "$DATA/models/$f" ]] || curl -fL --progress-bar -o "$DATA/models/$f" "$KOKORO_URL/$f"
done

echo "==> systemd user service"
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<UNIT
[Unit]
Description=r-aloud local TTS server (Kokoro / MOSS-TTS-Realtime)
After=network.target

[Service]
ExecStart=$ROOT/server/.venv/bin/r-aloud-server
Environment=R_ALOUD_DATA_DIR=$DATA
Restart=on-failure
RestartSec=3
# Keep the desktop responsive while synthesizing.
Nice=5

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now r-aloud.service

for _ in $(seq 60); do
  curl -sf http://127.0.0.1:8771/health >/dev/null && { echo "==> Server is up at http://127.0.0.1:8771"; exit 0; }
  sleep 1
done
echo "Server did not come up; check: journalctl --user -u r-aloud -e" >&2
exit 1
