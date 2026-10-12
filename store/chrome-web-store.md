# Chrome Web Store submission

Everything needed to publish r-aloud at
<https://chrome.google.com/webstore/devconsole>. You need a developer account
first (Google sign-in plus a one-time US$5 registration fee).

## 1. Package

```sh
cd extension && npm ci && node scripts/build.mjs chrome --zip
# upload: extension/dist/r-aloud-chrome-<version>.zip
```

## 2. Store listing

**Name:** r-aloud

**Summary (max 132 chars):**
Read web pages and PDFs aloud with natural open-source voices running on your own computer.

**Category:** Accessibility · **Language:** English

**Description:**

> r-aloud reads web pages, selections and PDFs aloud using open-source neural
> text-to-speech (Kokoro-82M, and optionally MOSS-TTS-Realtime) that runs
> entirely on your own machine. Nothing is sent to a cloud service.
>
> IMPORTANT: r-aloud needs its free companion TTS server running locally
> (Linux): https://github.com/AvAkanksh/r-aloud. Run `./install.sh --server-only`.
>
> • Read the whole page (the main article is detected) or just your selection
> • The sentence being read is highlighted and followed
> • PDF reader for local and web PDFs, with selection reading and "read from here"
> • Floating mini-player, popup controls, right-click menu, keyboard shortcuts
>   (Alt+Shift+R read/pause, Alt+Shift+X stop)
> • About 50 voices in 9 languages; change voice or speed while reading
>
> Privacy: page text is sent only to the r-aloud server on 127.0.0.1.
> No analytics, no tracking, no remote servers.

**Screenshots (1280×800):** `store/screenshots/1-article.png`,
`2-pdf-reader.png`, `3-popup.png`

**Icon:** `extension/src/icons/icon-128.png`

**Homepage / support:** https://github.com/AvAkanksh/r-aloud

## 3. Privacy practices tab

**Single purpose:**
Read web page and PDF text aloud using a text-to-speech server that runs on the user's own computer.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `activeTab` | Read the text of the tab the user asks to have read aloud (toolbar, context menu or shortcut). |
| `scripting` | Inject the reader script into that tab to extract text and highlight the sentence being spoken. |
| `storage` | Remember the user's voice, speed, engine and server settings, and the current reading session. |
| `contextMenus` | Offer "Read selection aloud" and "Read page aloud" in the right-click menu. |
| `offscreen` | Play the synthesized audio (service workers cannot play audio). |
| Host `http://127.0.0.1/*`, `http://localhost/*` | Talk to the local text-to-speech server the extension depends on. |
| Host `file:///*` | Open local PDF files the user asks to have read (only with "Allow access to file URLs"). |
| Optional host `http://*/*`, `https://*/*` | Requested per site, only when the user opens a web PDF in the reader, to download that PDF. |

**Remote code:** No. All code ships in the package (pdf.js is bundled).

**Data usage:** tick nothing in "collected data". Website content is processed
locally and sent only to a server on the user's own machine (127.0.0.1).
Certify the three disclosures (no selling, no unrelated use, no creditworthiness).

**Privacy policy URL:** https://github.com/AvAkanksh/r-aloud/blob/main/store/PRIVACY.md

## 4. Submit

Distribution → Public (or Unlisted), then **Submit for review**. Reviews
usually take a few days. Because the extension requests broad host and file
access, expect a manual review.
