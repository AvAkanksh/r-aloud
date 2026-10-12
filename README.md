# r-aloud

Read web pages aloud in **Chrome** and **Firefox** using open-source neural TTS
that runs on your own machine. Nothing is sent to a cloud service.

- **Read the page or a selection.** Main-article detection skips navigation,
  sidebars and footers.
- **Sentence highlighting** follows along and scrolls the page. It uses the CSS
  Custom Highlight API, so the page's DOM is never modified.
- **Floating mini-player** on the page, plus a toolbar popup with
  previous / pause / next / stop.
- **Engine, voice and speed** can be changed mid-read; reading continues from
  the current sentence with the new settings.
- **Context menu** ("Read selection aloud" / "Read page aloud") and **shortcuts**:
  <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> read / pause / resume,
  <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> stop.
- **PDFs**, both local files and PDFs on the web. Browsers don't let extensions
  script their built-in PDF viewers, so reading a PDF tab reopens it in the
  r-aloud reader (pdf.js). There you get selectable text, sentence highlighting,
  "Read from here" from the page in view, zoom, and *Open PDF…* / drag-and-drop.
  Text selected in the browser's own viewer can also be read in place through
  the right-click menu.
- Audio is **streamed** and played gaplessly through Web Audio, while synthesis
  stays up to 15 s ahead of playback.

```
 page ──(content script: extract, chunk, highlight)──┐
                                                     ▼
 popup / menu / shortcut ──► background ──► player (Chrome: offscreen doc,
                                             Firefox: background page)
                                                     │ POST /v1/audio/speech (PCM stream)
                                                     ▼
                                    r-aloud-server (FastAPI, 127.0.0.1:8771)
                                      ├─ kokoro  Kokoro-82M (ONNX, CPU)  ← default
                                      └─ moss    MOSS-TTS-Realtime (PyTorch)
```

## Engines

| Engine | Quality | Needs | On a Ryzen 5 4600H / GTX 1650 |
|---|---|---|---|
| **Kokoro-82M** (Apache-2.0) | very natural, ~50 voices in 9 languages | ~400 MB disk, ~0.5 GB RAM | ~2.7× faster than real time on CPU; first audio in ~0.6 s |
| **MOSS-TTS-Realtime** (Apache-2.0) | expressive, 20 languages, **voice cloning** | ~12 GB weights; a CUDA GPU with ≥ 12 GB VRAM for real time | doesn't fit the 4 GB GPU; on CPU (bf16) it runs far slower than real time, which is fine for testing but not for reading |

MOSS-TTS-Realtime uses the official streaming recipe
(`push_text → end_text → drain → flush`) with the model card's recommended
sampling settings (temperature 0.8, top_p 0.6, top_k 30, repetition penalty 1.1
over 50 tokens). To clone a voice, drop a short `.wav`/`.mp3` into
`~/.local/share/r-aloud/voices/`; it shows up as "Clone: <name>".

## Install

Quick start (Linux with systemd; needs curl and Node.js ≥ 18, installs `uv` if missing):

```sh
git clone https://github.com/AvAkanksh/r-aloud && cd r-aloud
./install.sh                # server + background service + both extensions
./install.sh --server-only  # just the server (extension installed from a store)
./install.sh --uninstall
```

Then load the extension as described in step 2 below. The individual steps:

### 1. Server

```sh
scripts/install-server.sh         # uv env + Kokoro model + systemd user service
scripts/install-server.sh --uninstall
```

This runs `r-aloud-server` as the `r-aloud.service` user unit on
`http://127.0.0.1:8771`. Logs: `journalctl --user -u r-aloud -f`.

To enable MOSS-TTS-Realtime (on a machine with a big GPU):

```sh
git clone https://github.com/OpenMOSS/MOSS-TTS ~/.local/share/r-aloud/MOSS-TTS
cd server && uv sync --extra moss          # CUDA torch from PyPI
systemctl --user restart r-aloud
```

| Variable | Default | Meaning |
|---|---|---|
| `R_ALOUD_PORT` | `8771` | port |
| `R_ALOUD_DEFAULT_BACKEND` | `kokoro` | engine used when a request names none |
| `R_ALOUD_PRELOAD` | `kokoro` | engines loaded at startup |
| `MOSS_TTS_DIR` | `~/.local/share/r-aloud/MOSS-TTS` | MOSS-TTS repo clone |
| `R_ALOUD_MOSS_DEVICE` | `auto` | `cuda:0` / `cpu`; `auto` uses CUDA only if ≥ 11 GB free |
| `R_ALOUD_MOSS_DTYPE` | `auto` | e.g. `bfloat16` to run on CPU in ~8 GB RAM |

The API is OpenAI-compatible (`POST /v1/audio/speech` with
`{input, model, voice, speed, response_format: "wav"|"pcm"}`), so the extension
can also point at another compatible server via the popup's *Server* setting.
Only `chrome-extension://` and `moz-extension://` origins are allowed by CORS,
so websites you visit can't drive your local TTS.

### 2. Extension

```sh
cd extension && npm install && npm run build   # → dist/chrome, dist/firefox (+ .zip/.xpi)
```

- **Chrome:** open `chrome://extensions`, turn on *Developer mode*, click
  *Load unpacked*, and pick `extension/dist/chrome`.
- **Firefox:** release Firefox only keeps signed add-ons. Sign it privately
  (it isn't listed publicly) with your AMO API key, then open the signed `.xpi`:
  ```sh
  cd extension && npx web-ext sign --channel=unlisted --source-dir dist/firefox \
      --api-key=$AMO_JWT_ISSUER --api-secret=$AMO_JWT_SECRET --artifacts-dir dist/signed
  firefox dist/signed/*.xpi
  ```
  For a quick try, use `about:debugging` → *This Firefox* → *Load Temporary
  Add-on* → `dist/r-aloud-firefox-0.1.0.xpi`. That install lasts until restart.

### Reading local PDFs

- **Chrome** reads `file://` PDFs itself once *Allow access to file URLs* is on
  for r-aloud (in `chrome://extensions` → r-aloud → Details). It's on by default
  for unpacked extensions.
- **Firefox** never lets extensions read `file://`, so the reader asks the local
  server for the file (`GET /v1/local-pdf?path=…`). The server only returns real
  PDF files (it checks the `%PDF` header) and requires a custom header, so only
  browser extensions can call it, not websites. Set `R_ALOUD_ALLOW_LOCAL_PDF=0`
  to turn this off; you can still use *Open PDF…*.
- Web PDFs: the reader asks once per site for permission to download them.

## Tests

```sh
cd server && uv run pytest                       # API, streaming, CORS, splitting
cd extension && npm test                         # text extraction & chunking (jsdom)
npm run e2e:chrome && npm run e2e:firefox        # full flow in real browsers (server must run)
node test/e2e/chrome.e2e.mjs --pause             # 40 s pause → resume recovery
node test/e2e/firefox.e2e.mjs --long             # 80 s read past idle timeouts
node test/e2e/chrome.e2e.mjs --pdf               # local + web PDFs, selection, read-from-here
```

The E2E tests load the built extension into Chromium (Playwright) and into
Firefox (Selenium, temporary add-on). They read a test article, check that
highlighting matches the sentence being spoken, and exercise pause/resume,
skipping, changing settings mid-read, selection mode, and the server-down
error. Audio is muted.

Chrome note: Chrome closes an `AUDIO_PLAYBACK` offscreen document after about
30 s without audible output (a long pause, a muted browser, a very slow engine).
The background script keeps the text in session storage and resumes from the
current sentence when that happens.

## License

Apache-2.0. Bundles [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0); uses the Kokoro-82M and MOSS-TTS-Realtime models (Apache-2.0).
