import { api, getSettings, setSettings } from "../shared/settings.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => api.runtime.sendMessage({ target: "background", ...msg });
const PLAY = "M8 5v14l11-7z";
const PAUSE = "M6 19h4V5H6zm8-14v14h4V5z";

let settings;
let backends = [];

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

function renderSession(s) {
  const pos = s.index >= 0 && s.total ? ` ${s.index + 1} / ${s.total}` : "";
  const text = {
    idle: "Idle",
    loading: `Loading…${pos}`,
    playing: `Reading${pos}`,
    paused: `Paused${pos}`,
    ended: "Finished",
    error: s.error || "Error",
  }[s.state] ?? s.state;
  setStatus(text, s.state === "error");
  $("toggle-icon").setAttribute("d", s.state === "paused" ? PLAY : PAUSE);
  const active = ["loading", "playing", "paused"].includes(s.state);
  for (const b of document.querySelectorAll(".transport button")) b.disabled = !active;
}

async function fetchJson(path) {
  const res = await fetch(settings.serverUrl.replace(/\/+$/, "") + path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${(await res.json().catch(() => ({}))).detail ?? ""}`);
  return res.json();
}

async function refreshServer() {
  const dot = $("server-dot");
  dot.className = "dot";
  try {
    const health = await fetchJson("/health");
    backends = health.backends;
    dot.className = "dot ok";
    dot.title = "Server connected";
    $("server-info").textContent = `Connected. Backends: ${backends
      .map((b) => `${b.name}${b.available ? "" : " (unavailable)"}`).join(", ")}`;
    const sel = $("backend");
    sel.replaceChildren(...backends.map((b) => {
      const o = new Option(b.label, b.name);
      o.disabled = !b.available;
      if (!b.available) o.title = b.reason;
      return o;
    }));
    if (!backends.some((b) => b.name === settings.backend && b.available)) {
      settings.backend = health.default_backend;
      await setSettings({ backend: settings.backend, voice: "" });
      settings.voice = "";
    }
    sel.value = settings.backend;
    await refreshVoices();
  } catch {
    dot.className = "dot bad";
    dot.title = "Server not reachable";
    $("server-info").textContent =
      `Can't reach ${settings.serverUrl}. Start the server (systemctl --user start r-aloud) or fix the URL.`;
    $("backend").replaceChildren(new Option("— server offline —", ""));
    $("voice").replaceChildren();
  }
}

async function refreshVoices() {
  const backend = backends.find((b) => b.name === settings.backend);
  $("speed").disabled = !backend?.supports_speed;
  $("speed").title = backend?.supports_speed ? "" : "This engine has a fixed speed";
  const data = await fetchJson(`/v1/voices?backend=${encodeURIComponent(settings.backend)}`);
  const sel = $("voice");
  // Group by language for long lists (Kokoro has ~50 voices).
  const groups = new Map();
  for (const v of data.voices) {
    const lang = v.name.match(/\(([^,]+),/)?.[1] ?? v.lang;
    if (!groups.has(lang)) groups.set(lang, []);
    groups.get(lang).push(v);
  }
  sel.replaceChildren(...[...groups].map(([lang, vs]) => {
    const g = document.createElement("optgroup");
    g.label = lang;
    g.append(...vs.map((v) => new Option(v.name.replace(/\s*\(.*\)$/, "") + (v.id === data.default ? " ★" : ""), v.id)));
    return g;
  }));
  sel.value = data.voices.some((v) => v.id === settings.voice) ? settings.voice : data.default;
}

/** Persist a change and, if something is playing, continue from the current sentence with it. */
async function changeSetting(patch) {
  Object.assign(settings, patch);
  await setSettings(patch);
  await send({ cmd: "applySettings" });
}

async function activeTabId() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function read(mode) {
  setStatus("Starting…");
  const res = await send({ cmd: "read", tabId: await activeTabId(), mode });
  if (res && res.ok === false && res.error) setStatus(res.error, true);
}

async function init() {
  settings = await getSettings();
  $("server-url").value = settings.serverUrl;
  $("speed").value = settings.speed;
  $("speed-out").textContent = `${Number(settings.speed).toFixed(1)}×`;

  $("read-page").addEventListener("click", () => read("page"));
  $("read-selection").addEventListener("click", () => read("selection"));
  $("open-pdf").addEventListener("click", async () => { await send({ cmd: "openReader" }); window.close(); });
  for (const b of document.querySelectorAll(".transport button")) {
    b.addEventListener("click", () => send({ cmd: "control", action: b.dataset.a }));
  }
  $("test-voice").addEventListener("click", () =>
    send({ cmd: "speakText", chunks: ["Hello! This is how I sound when I read the web for you."] }));
  $("backend").addEventListener("change", async (e) => {
    await changeSetting({ backend: e.target.value, voice: "" });
    await refreshVoices();
  });
  $("voice").addEventListener("change", (e) => changeSetting({ voice: e.target.value }));
  $("speed").addEventListener("input", (e) => {
    $("speed-out").textContent = `${Number(e.target.value).toFixed(1)}×`;
  });
  $("speed").addEventListener("change", (e) => changeSetting({ speed: Number(e.target.value) }));
  $("server-url").addEventListener("change", async (e) => {
    const url = e.target.value.trim() || "http://127.0.0.1:8771";
    settings.serverUrl = url;
    await setSettings({ serverUrl: url });
    await refreshServer();
  });

  api.runtime.onMessage.addListener((msg) => {
    if (msg?.target === "popup" && msg.evt === "session") renderSession(msg.session);
    return false;
  });
  renderSession(await send({ cmd: "getState" }));
  await refreshServer();
}

init();
