// Injected on demand. Extracts text, highlights the sentence being read and
// shows a small floating player.
(() => {
  if (window.__rAloudLoaded) return;
  window.__rAloudLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const Seg = globalThis.RAloudSegment;
  const HIGHLIGHT = "r-aloud-current";

  let collected = null;
  let chunks = [];
  let active = false;
  let heartbeat = null;
  let bar = null;

  const send = (msg) => api.runtime.sendMessage({ target: "background", ...msg }).catch(() => {});

  // Set by the r-aloud PDF reader page, which loads this script directly.
  const host = globalThis.RAloudHost;

  async function prepare(mode) {
    // Chrome's built-in PDF viewer is a wrapper page we can't read; the
    // background reopens the document in the r-aloud reader instead.
    if (!host && document.contentType === "application/pdf") return { pdf: true };
    if (host) await host.ready;
    const sel = window.getSelection();
    const hasSel = sel && sel.rangeCount && !sel.isCollapsed && sel.toString().trim().length > 0;
    if (mode === "selection" && !hasSel) return { error: "Select some text first." };
    let range;
    let pageMode = false;
    if (hasSel && mode !== "page") {
      range = sel.getRangeAt(0).cloneRange();
    } else if (host) {
      range = host.pageRange(); // from the page in view to the end of the document
    } else {
      range = document.createRange();
      range.selectNodeContents(Seg.findMainRoot(document));
      pageMode = true;
    }
    collected = Seg.collectText(range, { pageMode, skipRoot: bar?.host });
    chunks = Seg.makeChunks(collected.text);
    if (!chunks.length) return { error: "No readable text found." };
    setActive(true);
    showBar();
    updateBar("loading", -1, chunks.length);
    return { chunks: chunks.map((c) => c.text), title: document.title };
  }

  function highlight(index) {
    const c = chunks[index];
    if (!c || !collected) return;
    const range = Seg.rangeFor(collected, c.start, c.end);
    if (!range) return;
    if (globalThis.CSS?.highlights && globalThis.Highlight) {
      CSS.highlights.set(HIGHLIGHT, new Highlight(range));
    }
    const rect = range.getBoundingClientRect();
    const margin = 80;
    if (rect.height && (rect.top < margin || rect.bottom > window.innerHeight - margin - 60)) {
      window.scrollBy({ top: rect.top - window.innerHeight / 3, behavior: "smooth" });
    }
  }

  function clearHighlight() {
    globalThis.CSS?.highlights?.delete(HIGHLIGHT);
  }

  function setActive(on) {
    active = on;
    clearInterval(heartbeat);
    heartbeat = null;
    // Keeps Firefox's event page (which hosts the audio) alive while reading.
    if (on) heartbeat = setInterval(() => send({ cmd: "heartbeat" }), 10000);
  }

  // ---- floating player -------------------------------------------------------

  const ICONS = {
    prev: "M6 6h2v12H6zm3.5 6 8.5 6V6z",
    play: "M8 5v14l11-7z",
    pause: "M6 19h4V5H6zm8-14v14h4V5z",
    next: "M6 18l8.5-6L6 6zM16 6v12h2V6z",
    stop: "M6 6h12v12H6z",
  };
  const BUTTONS = [
    ["prev", "Previous sentence"], ["toggle", "Pause / resume"],
    ["next", "Next sentence"], ["stop", "Stop"],
  ];
  const STYLE = `
    :host { all: initial; }
    .bar { display: flex; align-items: center; gap: 4px; padding: 6px 8px 6px 12px;
      font: 13px/1.2 system-ui, sans-serif; color: #f4f4f5; background: #18181bee;
      border-radius: 999px; box-shadow: 0 4px 18px #0005; backdrop-filter: blur(6px); }
    .status { min-width: 92px; margin-right: 4px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .status.error { color: #fca5a5; white-space: normal; max-width: 280px; }
    button { all: unset; cursor: pointer; width: 30px; height: 30px; border-radius: 50%;
      display: grid; place-items: center; color: inherit; }
    button:hover { background: #ffffff1f; }
    button:focus-visible { outline: 2px solid #a5b4fc; }
    svg { width: 18px; height: 18px; fill: currentColor; }
    .spin { display: none; width: 10px; height: 10px; margin-right: 6px; border: 2px solid #a1a1aa;
      border-top-color: transparent; border-radius: 50%; animation: s 0.8s linear infinite; vertical-align: -1px; }
    .loading .spin { display: inline-block; }
    @keyframes s { to { transform: rotate(360deg); } }`;

  const SVG_NS = "http://www.w3.org/2000/svg";
  function icon(name) {
    const el = document.createElementNS(SVG_NS, "svg");
    el.setAttribute("viewBox", "0 0 24 24");
    el.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ICONS[name]);
    el.append(path);
    return el;
  }

  function showBar() {
    if (bar) { bar.host.style.display = ""; return; }
    const host = document.createElement("r-aloud-player");
    host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    const wrap = document.createElement("div");
    wrap.className = "bar";
    wrap.setAttribute("role", "toolbar");
    wrap.setAttribute("aria-label", "Read aloud");
    const status = document.createElement("span");
    status.className = "status";
    status.setAttribute("aria-live", "polite");
    const spin = document.createElement("span");
    spin.className = "spin";
    const label = document.createElement("span");
    status.append(spin, label);
    wrap.append(status);
    const buttons = {};
    for (const [action, title] of BUTTONS) {
      const b = document.createElement("button");
      b.title = title;
      b.setAttribute("aria-label", title);
      b.append(icon(action === "toggle" ? "pause" : action));
      b.addEventListener("click", () => send({ cmd: "control", action }));
      buttons[action] = b;
      wrap.append(b);
    }
    root.append(style, wrap);
    document.documentElement.appendChild(host);
    bar = { host, status, label, toggle: buttons.toggle };
  }

  function hideBar() {
    if (bar) bar.host.style.display = "none";
  }

  function setLabel(text, cls = "") {
    bar.status.className = `status ${cls}`;
    bar.label.textContent = text;
  }

  function updateBar(state, index, total) {
    if (!bar) return;
    const pos = index >= 0 ? `${index + 1} / ${total}` : "";
    if (state === "loading") setLabel(pos || "Loading", "loading");
    else setLabel(state === "paused" ? `Paused ${pos}` : pos);
    bar.toggle.replaceChildren(icon(state === "paused" ? "play" : "pause"));
  }

  function onState(msg) {
    if (["idle", "ended", "error"].includes(msg.state)) {
      setActive(false);
      clearHighlight();
      if (msg.state === "error" && bar) {
        showBar();
        setLabel(msg.error || "Something went wrong.", "error");
        setTimeout(() => { if (!active) hideBar(); }, 6000);
      } else {
        hideBar();
      }
      return;
    }
    updateBar(msg.state, msg.index ?? -1, msg.total ?? chunks.length);
  }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== "content") return false;
    // The reader page gets broadcast messages addressed by tab id.
    if (host ? msg.tabId !== host.tabId : msg.tabId !== undefined) return false;
    if (msg.cmd === "ping") sendResponse({ ok: true });
    else if (msg.cmd === "prepare") {
      prepare(msg.mode).then(sendResponse, (err) => sendResponse({ error: String(err.message || err) }));
      return true;
    }
    else if (msg.evt === "chunk") { highlight(msg.index); updateBar("playing", msg.index, msg.total); }
    else if (msg.evt === "state") onState(msg);
    return false;
  });

  window.addEventListener("pagehide", () => {
    if (active) send({ cmd: "control", action: "stop" });
  });
})();
