// Browser-agnostic end-to-end scenario. A driver provides:
//   inPopup(fnSource, arg)  -> runs an async function in the extension popup page
//   inPage(fnSource, arg)   -> runs an async function in the test article tab
// against a live r-aloud server.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePdf } from "./pdf-fixture.mjs";

export const SERVER = process.env.R_ALOUD_SERVER ?? "http://127.0.0.1:8771";

export function servePage() {
  const html = readFileSync(new URL("./page.html", import.meta.url));
  return new Promise((resolve) => {
    const long = `<!doctype html><title>long</title><article>${Array.from({ length: 40 }, (_, i) =>
      `<p>Paragraph ${i + 1}. This long page checks that reading keeps going well past the browser's idle timeouts for background scripts.</p>`).join("")}</article>`;
    const srv = createServer((req, res) => {
      if (req.url.startsWith("/doc.pdf")) {
        res.setHeader("Content-Type", "application/pdf");
        res.end(makePdf());
        return;
      }
      res.setHeader("Content-Type", "text/html");
      res.end(req.url.startsWith("/long") ? long : html);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ url: `http://localhost:${srv.address().port}/`, close: () => srv.close() }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BG = `(msg) => (globalThis.browser ?? chrome).runtime.sendMessage({ target: "background", ...msg })`;

export async function runScenario({ inPopup, inPage, pageUrl, log = console.log }) {
  const bg = (msg) => inPopup(`async (msg) => (${BG})(msg)`, msg);
  const state = () => bg({ cmd: "getState" });
  async function waitFor(pred, what, timeout = 30000) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await state();
      if (pred(last)) return last;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}; last state ${JSON.stringify(last)}`);
  }
  const highlighted = () => inPage(`async () => {
    const h = globalThis.CSS?.highlights?.get("r-aloud-current");
    return h ? [...h][0]?.toString() ?? null : null;
  }`);
  const barVisible = () => inPage(`async () => {
    const el = document.querySelector("r-aloud-player");
    return !!el && el.style.display !== "none";
  }`);

  const tabId = await inPopup(`async (url) => {
    const api = globalThis.browser ?? chrome;
    // Match patterns can't carry a port in Firefox, so filter by hand.
    const tabs = await api.tabs.query({});
    return tabs.find((t) => t.url?.startsWith(url))?.id ?? JSON.stringify(tabs.map((t) => t.url));
  }`, pageUrl);
  assert.ok(Number.isInteger(tabId), "found test tab");

  // Popup talks to the server.
  const popupInfo = await inPopup(`async () => {
    for (let i = 0; i < 40 && document.querySelectorAll("#voice option").length === 0; i++)
      await new Promise((r) => setTimeout(r, 100));
    return { dot: document.getElementById("server-dot").className,
             voices: document.querySelectorAll("#voice option").length,
             backend: document.getElementById("backend").value };
  }`);
  assert.equal(popupInfo.dot, "dot ok", "popup shows server connected");
  assert.ok(popupInfo.voices > 20, `popup lists voices (${popupInfo.voices})`);
  assert.equal(popupInfo.backend, "kokoro");
  log("✓ popup connected to server", popupInfo);

  // Read the whole page.
  const res = await bg({ cmd: "read", tabId, mode: "page" });
  assert.notEqual(res?.ok, false, `read failed: ${res?.error}`);
  let s = await waitFor((x) => x.state === "playing", "playing");
  assert.equal(s.tabId, tabId);
  assert.ok(s.total >= 6 && s.total <= 14, `chunk count ${s.total}`);
  let first = null;
  for (let i = 0; i < 20 && !first; i++) { first = await highlighted(); if (!first) await sleep(100); }
  assert.equal(first, "The quiet revolution of open speech models", "title highlighted first");
  assert.ok(await barVisible(), "floating player visible");
  log("✓ reading page:", s.total, "chunks; highlight:", JSON.stringify(first));

  s = await waitFor((x) => x.index >= 2, "advance to chunk 3");
  const h = await highlighted();
  assert.ok(h && !/newsletter|Copyright|Archive/.test(h), `highlight is article text: ${h}`);
  log("✓ advanced to chunk", s.index + 1, "highlight:", JSON.stringify(h));

  // Pause holds position, resume continues.
  await bg({ cmd: "control", action: "pause" });
  s = await waitFor((x) => x.state === "paused", "paused");
  const pausedAt = s.index;
  await sleep(2500);
  assert.equal((await state()).index, pausedAt, "position held while paused");
  await bg({ cmd: "control", action: "resume" });
  await waitFor((x) => x.state === "playing", "resumed");
  log("✓ pause/resume at chunk", pausedAt + 1);

  // Skip forward.
  const before = (await state()).index;
  await bg({ cmd: "control", action: "next" });
  s = await waitFor((x) => x.state === "playing" && x.index === before + 1, "skip to next");
  log("✓ next →", s.index + 1);

  // Changing speed mid-read restarts at the current sentence with new settings.
  await inPopup(`async () => (globalThis.browser ?? chrome).storage.local.set({ speed: 1.5, voice: "bm_george" })`);
  await bg({ cmd: "applySettings" });
  await waitFor((x) => x.state === "playing", "playing after settings change");
  log("✓ settings applied mid-read");

  await bg({ cmd: "control", action: "stop" });
  await waitFor((x) => x.state === "idle", "stopped");
  await sleep(300);
  assert.equal(await highlighted(), null, "highlight cleared on stop");
  assert.equal(await barVisible(), false, "floating player hidden on stop");
  log("✓ stop clears highlight and hides player");

  // Selection mode reads only the selection, to the end.
  await inPage(`async () => {
    const r = document.createRange();
    r.selectNodeContents(document.getElementById("p4"));
    getSelection().removeAllRanges(); getSelection().addRange(r);
  }`);
  await bg({ cmd: "read", tabId, mode: "selection" });
  s = await waitFor((x) => x.state === "playing", "playing selection");
  assert.equal(s.total, 2, "selection has 2 sentences");
  assert.match(await highlighted(), /^Running these models locally/);
  s = await waitFor((x) => x.state === "ended" || x.state === "idle", "selection finished", 40000);
  log("✓ selection read to the end:", s.state);

  // Server down -> clear error.
  await inPopup(`async () => (globalThis.browser ?? chrome).storage.local.set({ serverUrl: "http://127.0.0.1:9" })`);
  await bg({ cmd: "read", tabId, mode: "page" });
  s = await waitFor((x) => x.state === "error", "error state");
  assert.match(s.error, /Cannot reach the TTS server/);
  log("✓ server-down error:", s.error);
  await inPopup(`async () => (globalThis.browser ?? chrome).storage.local.clear()`);
}

/**
 * Reads a long page for > `seconds`. After starting, the popup is closed and only
 * the page is observed, so nothing keeps the background script artificially alive.
 */
export async function runLongScenario({ inPopup, inPage, closePopup, pageUrl, log = console.log, seconds = 80 }) {
  const tabId = await inPopup(`async (url) => {
    const tabs = await (globalThis.browser ?? chrome).tabs.query({});
    return tabs.find((t) => t.url?.startsWith(url))?.id;
  }`, pageUrl);
  await inPopup(`async (msg) => (${BG})(msg)`, { cmd: "read", tabId, mode: "page" });
  await closePopup();
  const current = () => inPage(`async () => {
    const h = globalThis.CSS?.highlights?.get("r-aloud-current");
    const t = h ? [...h][0]?.toString() ?? "" : "";
    return Number(t.match(/^Paragraph (\\d+)/)?.[1] ?? 0);
  }`);
  const t0 = Date.now();
  let last = 0;
  let lastChange = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    await sleep(5000);
    const n = await current();
    if (n !== last) { last = n; lastChange = Date.now(); }
    log(`  t=${Math.round((Date.now() - t0) / 1000)}s reading paragraph ${n}`);
    assert.ok(Date.now() - lastChange < 20000, "playback stalled");
  }
  // Headless Chrome loses ~15 s to one offscreen recovery; real playback reaches ~10.
  assert.ok(last >= 6, `progressed to paragraph ${last}`);
  log(`✓ still reading after ${seconds}s (paragraph ${last})`);
}

/** Pause longer than Chrome's 30 s offscreen idle limit, then resume where we were. */
export async function runPauseScenario({ inPopup, pageUrl, log = console.log, pauseSeconds = 40 }) {
  const bg = (msg) => inPopup(`async (msg) => (${BG})(msg)`, msg);
  const tabId = await inPopup(`async (url) => {
    const tabs = await (globalThis.browser ?? chrome).tabs.query({});
    return tabs.find((t) => t.url?.startsWith(url))?.id;
  }`, pageUrl);
  await bg({ cmd: "read", tabId, mode: "page" });
  let s;
  for (let i = 0; i < 120; i++) { s = await bg({ cmd: "getState" }); if (s.state === "playing" && s.index >= 2) break; await sleep(250); }
  await bg({ cmd: "control", action: "pause" });
  const at = (await bg({ cmd: "getState" })).index;
  log(`  paused at chunk ${at + 1}; waiting ${pauseSeconds}s`);
  await sleep(pauseSeconds * 1000);
  s = await bg({ cmd: "getState" });
  assert.equal(s.state, "paused", "still paused after long wait");
  await bg({ cmd: "control", action: "toggle" });
  for (let i = 0; i < 60; i++) { s = await bg({ cmd: "getState" }); if (s.state === "playing") break; await sleep(250); }
  assert.equal(s.state, "playing", `resumed: ${JSON.stringify(s)}`);
  assert.equal(s.index, at, "resumed at the same sentence");
  for (let i = 0; i < 80; i++) { s = await bg({ cmd: "getState" }); if (s.index > at) break; await sleep(250); }
  assert.ok(s.index > at, "continued past the paused sentence");
  await bg({ cmd: "control", action: "stop" });
  log(`✓ resumed after a ${pauseSeconds}s pause and continued to chunk ${s.index + 1}`);
}

/** Writes the fixture PDF to a temp dir and returns its file:// URL. */
export function localPdfUrl() {
  const file = join(mkdtempSync(join(tmpdir(), "r-aloud-pdf-")), "My Notes.pdf");
  writeFileSync(file, makePdf());
  return "file://" + file.split("/").map(encodeURIComponent).join("/");
}

/**
 * PDFs: a local file and a web PDF open in the browser's own viewer; reading
 * moves them into the r-aloud reader. `navigate(url)` loads a URL in the
 * test tab; `inPage` runs in whatever that tab shows.
 */
export async function runPdfScenario({ inPopup, inPage, navigate, fileUrl, httpUrl, log = console.log }) {
  const bg = (msg) => inPopup(`async (msg) => (${BG})(msg)`, msg);
  const state = () => bg({ cmd: "getState" });
  const chunks = () => inPopup(`async () => (await (globalThis.browser ?? chrome).storage.session.get("chunks")).chunks`);
  async function waitFor(pred, what, timeout = 30000) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await state();
      if (pred(last)) return last;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}; last state ${JSON.stringify(last)}`);
  }
  async function pageEval(src, arg, timeout = 20000) {
    // The tab navigates (native viewer -> reader); retry while it settles.
    const t0 = Date.now();
    for (;;) {
      try { return await inPage(src, arg); } catch (err) {
        if (Date.now() - t0 > timeout) throw err;
        await sleep(300);
      }
    }
  }
  const tabIdFor = (prefix) => inPopup(`async (prefix) => {
    const tabs = await (globalThis.browser ?? chrome).tabs.query({});
    return tabs.find((t) => t.url?.startsWith(prefix))?.id ?? null;
  }`, prefix);
  const highlighted = () => pageEval(`async () => {
    const h = globalThis.CSS?.highlights?.get("r-aloud-current");
    return h ? [...h][0]?.toString().replace(/\\s+/g, " ") ?? null : null;
  }`);
  async function waitReader() {
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const href = await pageEval(`async () => location.href`).catch(() => "");
      if (href.includes("/pdf/viewer.html")) return href;
      await sleep(250);
    }
    throw new Error("reader did not open");
  }

  // 1. Local PDF in the browser's viewer -> "read page" opens the reader and reads.
  await navigate(fileUrl);
  await sleep(1500);
  let tabId = await tabIdFor(fileUrl);
  assert.ok(Number.isInteger(tabId), "found the local PDF tab");
  const res = await bg({ cmd: "read", tabId, mode: "page" });
  assert.equal(res?.reader, true, `expected reader handoff, got ${JSON.stringify(res)}`);
  const readerUrl = await waitReader();
  assert.equal(new URL(readerUrl).searchParams.get("file"), fileUrl);
  let s = await waitFor((x) => x.state === "playing", "local PDF playing");
  const all = await chunks();
  log("  chunks:", JSON.stringify(all));
  assert.equal(all[0], "The PDF reading test");
  assert.ok(all.some((c) => c.includes("spans two lines so the reader has to join")), "lines joined");
  assert.ok(all.some((c) => c.includes("a hyphenated word that must be rejoined")), "hyphen rejoined");
  assert.ok(all.some((c) => c.startsWith("Page two begins")), "page 2 starts a new chunk");
  assert.equal(all[all.length - 1], "The final paragraph closes the document. Thank you for listening.");
  let first = null;
  for (let i = 0; i < 30 && !first; i++) { first = await highlighted(); if (!first) await sleep(150); }
  assert.equal(first, "The PDF reading test");
  s = await waitFor((x) => x.index >= 1, "advance");
  assert.match(await highlighted(), /^Portable documents are everywhere/);
  log(`✓ local PDF opened in the reader and read with highlighting (${s.total} chunks)`);
  await bg({ cmd: "control", action: "stop" });
  await waitFor((x) => x.state === "idle", "stopped");

  // 2. Selection inside the reader.
  await pageEval(`async () => {
    const spans = [...document.querySelectorAll(".textLayer span")];
    const a = spans.find((n) => n.textContent.startsWith("Page two begins"));
    const b = spans.find((n) => n.textContent.startsWith("paragraph and nothing else"));
    const r = document.createRange();
    r.setStart(a.firstChild, 0);
    r.setEnd(b.firstChild, b.firstChild.length);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }`);
  await bg({ cmd: "read", tabId, mode: "selection" });
  s = await waitFor((x) => x.state === "playing", "selection playing");
  assert.deepEqual(await chunks(), [
    "Page two begins with this sentence.",
    "The selection test reads only this paragraph and nothing else.",
  ]);
  assert.equal(await highlighted(), "Page two begins with this sentence.");
  log("✓ selection inside the reader");
  await bg({ cmd: "control", action: "stop" });
  await waitFor((x) => x.state === "idle", "stopped");

  // 3. "Read from here" starts at the page in view.
  await pageEval(`async () => { getSelection().removeAllRanges(); document.querySelector('.page[data-page="2"]').scrollIntoView(); }`);
  await sleep(300);
  await pageEval(`async () => document.getElementById("read-here").click()`);
  s = await waitFor((x) => x.state === "playing", "read from page 2");
  assert.equal((await chunks())[0], "Page two begins with this sentence.");
  log("✓ read from the page in view");
  await bg({ cmd: "control", action: "stop" });
  await waitFor((x) => x.state === "idle", "stopped");

  // 4. Web PDF in the browser's own viewer: a context-menu selection is read
  //    in place (no navigation), and "read page" moves it into the reader.
  await navigate(httpUrl);
  await sleep(1500);
  tabId = await tabIdFor(httpUrl);
  assert.ok(Number.isInteger(tabId), "found the web PDF tab");
  await bg({ cmd: "read", tabId, mode: "selection", selectionText: "Selected in the built-in viewer. Read it as is." });
  s = await waitFor((x) => x.state === "playing" || x.state === "ended", "native selection playing");
  assert.deepEqual(await chunks(), ["Selected in the built-in viewer.", "Read it as is."]);
  assert.equal(await tabIdFor(httpUrl), tabId, "tab stayed on the built-in viewer");
  log("✓ selection from the built-in PDF viewer read in place");
  await bg({ cmd: "control", action: "stop" });

  await bg({ cmd: "read", tabId, mode: "page" });
  await waitReader();
  s = await waitFor((x) => x.state === "playing", "web PDF playing in reader");
  assert.equal((await chunks())[0], "The PDF reading test");
  log("✓ web PDF opened in the reader and read");
  await bg({ cmd: "control", action: "stop" });
}
