import os
from pathlib import Path

DATA_DIR = Path(
    os.getenv("R_ALOUD_DATA_DIR", Path.home() / ".local" / "share" / "r-aloud")
).expanduser()

HOST = os.getenv("R_ALOUD_HOST", "127.0.0.1")
PORT = int(os.getenv("R_ALOUD_PORT", "8771"))
DEFAULT_BACKEND = os.getenv("R_ALOUD_DEFAULT_BACKEND", "kokoro")
# Comma-separated backends to load at startup so the first request is fast.
PRELOAD = [b for b in os.getenv("R_ALOUD_PRELOAD", "kokoro").split(",") if b]
MAX_INPUT_CHARS = int(os.getenv("R_ALOUD_MAX_INPUT_CHARS", "5000"))
# Let the extension's PDF reader open local PDFs through the server (Firefox
# extensions cannot read file:// URLs themselves).
ALLOW_LOCAL_PDF = os.getenv("R_ALOUD_ALLOW_LOCAL_PDF", "1") == "1"
MAX_PDF_BYTES = int(os.getenv("R_ALOUD_MAX_PDF_MB", "300")) * 1024 * 1024
