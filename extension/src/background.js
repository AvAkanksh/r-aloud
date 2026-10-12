import { api, getSettings } from "./shared/settings.js";
import { Player } from "./player/player.js";
import "./content/segment.js"; // sentence chunking for text that arrives without a page
const Seg = globalThis.RAloudSegment;
const READER = "pdf/viewer.html";

// Chrome: audio must play in an offscreen document. Firefox: the background
// page has a DOM and can play audio itself.
const USE_OFFSCREEN = !!api.offscreen?.createDocument;
let localPlayer = null;

const IDLE = { tabId: null, state: "idle", index: -1, total: 0, error: null };
let session = { ...IDLE };
// The Chrome service worker can be restarted mid-session; keep state in session storage.
// Tabs showing the r-aloud PDF reader. They are extension pages, so they get
// runtime messages (addressed by tab id) instead of tabs.sendMessage.
let readerTabs = new Set();
const restored = api.storage.session
  .get(["session", "readerTabs"])
  .then((r) => {
    if (r.session) session = r.session;
    readerTabs = new Set(r.readerTabs ?? []);
  })
  .catch(() => {});

function saveSession() {
  api.storage.session.set({ session }).catch(() => {});
}

function saveReaderTabs() {
  api.storage.session.set({ readerTabs: [...readerTabs] }).catch(() => {});
}

function sendToTab(tabId, msg) {
  if (readerTabs.has(tabId)) return api.runtime.sendMessage({ ...msg, target: "content", tabId });
  return api.tabs.sendMessage(tabId, { ...msg, target: "content" });
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  const existing = await api.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) return;
  creatingOffscreen ??= api.offscreen
    .createDocument({
      url: "offscreen/offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play synthesized speech",
    })
    .finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

const hasOffscreen = async () =>
  (await api.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length > 0;

async function player(msg) {
  if (USE_OFFSCREEN) {
    if (msg.action !== "start" && !(await hasOffscreen())) return recover(msg);
    await ensureOffscreen();
    return api.runtime.sendMessage({ target: "offscreen", ...msg });
  }
  localPlayer ??= new Player(onPlayerEvent);
  return localPlayer.handle(msg);
}

const ACTIVE = ["loading", "playing", "paused"];
// Chrome closes an AUDIO_PLAYBACK offscreen document after ~30 s without
// audible output (a long pause, a muted browser, a very slow engine). The text
// is kept in session storage so playback can pick up at the current sentence.
const MAX_RECOVERIES_PER_CHUNK = 2;

async function recover(msg) {
  await restored;
  if (!ACTIVE.includes(session.state)) return { ok: false, state: session.state };
  const { chunks } = await api.storage.session.get("chunks");
  if (!chunks?.length) {
    onPlayerEvent({ evt: "state", state: "idle" });
    return { ok: false, state: "idle" };
  }
  let index = Math.max(session.index, 0);
  const pausedNow = (msg.action === "toggle" && session.state !== "paused") || msg.action === "pause";
  if (msg.action === "stop") {
    onPlayerEvent({ evt: "state", state: "idle" });
    return { ok: true, state: "idle" };
  }
  if (pausedNow) {
    onPlayerEvent({ evt: "state", state: "paused", index, total: chunks.length });
    return { ok: true, state: "paused" };
  }
  if (msg.action === "snapshot") return { ok: true, ...session };
  if (msg.action === "heartbeat") {
    // Only an unexpected loss while loading/playing counts towards the limit.
    session.recoveries ??= {};
    session.recoveries[index] = (session.recoveries[index] ?? 0) + 1;
    if (session.recoveries[index] > MAX_RECOVERIES_PER_CHUNK) {
      onPlayerEvent({ evt: "state", state: "error",
        error: "Speech engine too slow: no audio for 30 s. Try a faster engine (Kokoro)." });
      return { ok: false, state: "error" };
    }
  }
  if (msg.action === "next") index += 1;
  if (msg.action === "prev") index -= 1;
  if (msg.action === "seek") index = msg.index;
  index = Math.min(Math.max(index, 0), chunks.length - 1);
  return player({ action: "start", chunks, startIndex: index, settings: msg.settings ?? (await getSettings()) });
}

const BADGES = {
  loading: ["…", "#6b7280"], playing: ["▶", "#16a34a"], paused: ["❚❚", "#d97706"], error: ["!", "#dc2626"],
};

async function onPlayerEvent(evt) {
  await restored; // a restarted service worker must not clobber the saved session
  if (evt.evt === "state") {
    session.state = evt.state;
    session.error = evt.error ?? null;
    if (evt.index !== undefined) session.index = evt.index;
    if (evt.total !== undefined) session.total = evt.total;
  } else if (evt.evt === "chunk") {
    session.index = evt.index;
    session.total = evt.total;
  }
  const [text, color] = BADGES[session.state] ?? ["", "#000"];
  api.action.setBadgeText({ text }).catch(() => {});
  if (text) api.action.setBadgeBackgroundColor({ color }).catch(() => {});
  saveSession();

  if (session.tabId != null) sendToTab(session.tabId, evt).catch(() => {});
  api.runtime.sendMessage({ target: "popup", evt: "session", session }).catch(() => {});
  if (["idle", "ended"].includes(session.state)) {
    session = { ...IDLE, state: session.state };
    saveSession();
  }
}

async function injectContent(tabId) {
  try {
    const pong = await api.tabs.sendMessage(tabId, { target: "content", cmd: "ping" });
    if (pong?.ok) return;
  } catch { /* not injected yet */ }
  await api.scripting.insertCSS({ target: { tabId }, files: ["content/content.css"] });
  await api.scripting.executeScript({
    target: { tabId },
    files: ["content/segment.js", "content/content.js"],
  });
}

function reportError(error) {
  onPlayerEvent({ evt: "state", state: "error", error });
  return { ok: false, error };
}

/** A registered reader tab may have navigated away without telling us. */
async function isReaderTab(tabId) {
  if (!readerTabs.has(tabId)) return false;
  const pong = await api.runtime.sendMessage({ target: "content", cmd: "ping", tabId }).catch(() => null);
  if (pong?.ok) return true;
  readerTabs.delete(tabId);
  saveReaderTabs();
  return false;
}

function looksLikePdf(url) {
  try {
    const u = new URL(url);
    return ["http:", "https:", "file:"].includes(u.protocol) && /\.pdf$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** Replace the browser's PDF viewer in this tab with the r-aloud reader. */
async function openReader(tab, read) {
  const page = tab.url.match(/#.*\bpage=(\d+)/)?.[1];
  const query = new URLSearchParams({ file: tab.url });
  if (read) query.set("read", read);
  if (page) query.set("page", page);
  await api.tabs.update(tab.id, { url: `${api.runtime.getURL(READER)}?${query}` });
  return { ok: true, reader: true };
}

function speakText(tabId, text) {
  const chunks = Seg.makeChunks(text.replace(/\r/g, "")).map((c) => c.text);
  if (!chunks.length) return reportError("Nothing readable in the selection.");
  return startChunks(tabId, chunks);
}

/**
 * Start reading in a tab. mode: "auto" | "selection" | "page".
 * `selectionText` comes from the context menu, which works even where no
 * script can run (e.g. the browser's built-in PDF viewer).
 */
async function startReading(tabId, mode = "auto", selectionText = "") {
  await restored;
  if (await isReaderTab(tabId)) return prepareAndStart(tabId, mode);

  const tab = await api.tabs.get(tabId).catch(() => null);
  // Browsers don't let extensions script their PDF viewers: read a context-menu
  // selection as is, otherwise reopen the document in the r-aloud reader.
  const viaPdfReader = () =>
    mode === "selection" && selectionText.trim()
      ? speakText(tabId, selectionText)
      : openReader(tab, mode === "selection" ? null : "page");
  if (tab?.url && looksLikePdf(tab.url)) return viaPdfReader();

  try {
    await injectContent(tabId);
  } catch (err) {
    if (selectionText.trim()) return speakText(tabId, selectionText);
    // Chrome hides file:// tabs (even their URL) until the user allows it.
    if (!tab?.url && api.extension?.isAllowedFileSchemeAccess && !(await api.extension.isAllowedFileSchemeAccess())) {
      return reportError('To read local files (including PDFs), turn on "Allow access to file URLs" for r-aloud in chrome://extensions, then try again.');
    }
    return reportError(`Can't read this page (${err.message || err}). Browser-internal pages are off limits.`);
  }
  const prep = await sendToTab(tabId, { cmd: "prepare", mode });
  if (prep?.pdf && tab?.url) return viaPdfReader();
  return startPrepared(tabId, prep);
}

async function prepareAndStart(tabId, mode) {
  return startPrepared(tabId, await sendToTab(tabId, { cmd: "prepare", mode }));
}

function startPrepared(tabId, prep) {
  if (!prep?.chunks?.length) return reportError(prep?.error || "No readable text found on this page.");
  return startChunks(tabId, prep.chunks);
}

async function startChunks(tabId, chunks) {
  if (session.tabId != null && session.tabId !== tabId) {
    sendToTab(session.tabId, { evt: "state", state: "idle" }).catch(() => {});
  }
  session = { ...IDLE, tabId, state: "loading", total: chunks.length };
  saveSession();
  await api.storage.session.set({ chunks });
  const settings = await getSettings();
  return player({ action: "start", chunks, startIndex: 0, settings });
}

async function control(action) {
  await restored;
  return player({ action });
}

async function toggleInTab(tab) {
  await restored;
  if (session.tabId === tab.id && ["playing", "loading"].includes(session.state)) return control("pause");
  if (session.tabId === tab.id && session.state === "paused") return control("resume");
  return startReading(tab.id, "auto");
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== "background") return false;
  if (msg.evt) { onPlayerEvent(msg); return false; } // from the offscreen player
  const handlers = {
    read: () => startReading(msg.tabId, msg.mode, msg.selectionText ?? ""),
    speakText: () => startChunks(null, msg.chunks),
    viewerReady: async () => {
      await restored;
      readerTabs.add(sender.tab?.id);
      saveReaderTabs();
      return { ok: true };
    },
    viewerGone: async () => {
      await restored;
      readerTabs.delete(sender.tab?.id);
      saveReaderTabs();
      return { ok: true };
    },
    openReader: () => api.tabs.create({ url: api.runtime.getURL(READER) }),
    control: () => control(msg.action),
    seek: () => player({ action: "seek", index: msg.index }),
    applySettings: async () => {
      await restored;
      if (!["loading", "playing", "paused"].includes(session.state)) return { ok: true };
      return player({ action: "seek", index: Math.max(session.index, 0), settings: await getSettings() });
    },
    getState: async () => { await restored; return { ...session }; },
    heartbeat: async () => {
      await restored;
      if (USE_OFFSCREEN && ["loading", "playing"].includes(session.state) && !(await hasOffscreen())) {
        await recover({ action: "heartbeat" });
      }
      return { ok: true };
    },
  };
  const handler = handlers[msg.cmd];
  if (!handler) return false;
  Promise.resolve(handler())
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true; // async response
});

function createMenus() {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({ id: "read-selection", title: "Read selection aloud", contexts: ["selection"] });
    api.contextMenus.create({ id: "read-page", title: "Read page aloud", contexts: ["page"] });
  });
}
api.runtime.onInstalled.addListener(createMenus);
api.runtime.onStartup.addListener(createMenus);

api.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  startReading(tab.id, info.menuItemId === "read-selection" ? "selection" : "page", info.selectionText ?? "");
});

api.commands.onCommand.addListener(async (command, tab) => {
  tab ??= (await api.tabs.query({ active: true, currentWindow: true }))[0];
  if (command === "stop-reading") control("stop");
  else if (command === "toggle-reading" && tab?.id) toggleInTab(tab);
});

// Navigation is reported by the content script (pagehide); closing the tab is not.
api.tabs.onRemoved.addListener(async (tabId) => {
  await restored;
  if (tabId === session.tabId) control("stop");
  if (readerTabs.delete(tabId)) saveReaderTabs();
});
