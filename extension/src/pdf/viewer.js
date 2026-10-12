// r-aloud PDF reader: renders a PDF with pdf.js (canvas + selectable text
// layer) so the regular content script can read, select and highlight it.
import * as pdfjs from "../vendor/pdfjs/pdf.mjs";
import { api, getSettings } from "../shared/settings.js";

const VENDOR = new URL("../vendor/pdfjs/", import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = VENDOR + "pdf.worker.mjs";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const src = params.get("file");
const autoRead = params.get("read"); // "page" to start reading once loaded

const send = (msg) => api.runtime.sendMessage({ target: "background", ...msg });

// ---- host hooks for content.js ----------------------------------------------

let markReady;
const ready = new Promise((r) => { markReady = r; });
let loading = false;
const tab = await api.tabs.getCurrent();
const pages = []; // { div, textLayer, page, viewport, rendered }
let doc = null;
let scale = 1.25;

globalThis.RAloudHost = {
  tabId: tab?.id,
  // Before any document is opened there is nothing to wait for.
  get ready() { return loading ? ready : Promise.resolve(); },
  /** Range from the first page in view to the end of the document. */
  pageRange() {
    if (!pages.length) throw new Error("Open a PDF first.");
    const range = document.createRange();
    const first = pages[currentPageIndex()] ?? pages[0];
    const last = pages[pages.length - 1];
    range.setStartBefore(first.textLayer);
    range.setEndAfter(last.textLayer);
    return range;
  },
};

for (const file of ["../content/segment.js", "../content/content.js"]) {
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = file;
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
}
send({ cmd: "viewerReady" }).catch(() => {});
window.addEventListener("pagehide", () => send({ cmd: "viewerGone" }).catch(() => {}));

// ---- loading ------------------------------------------------------------------

class NeedsFile extends Error {
  constructor(title, text, action) {
    super(text);
    this.title = title;
    this.action = action; // { label, run } offered next to the file picker
  }
}

function xhrBytes(url) {
  // Chrome lets extension pages read file:// via XHR (not fetch) once
  // "Allow access to file URLs" is on.
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("GET", url);
    x.responseType = "arraybuffer";
    x.onload = () => (x.response?.byteLength ? resolve(new Uint8Array(x.response)) : reject(new Error("empty")));
    x.onerror = () => reject(new Error("blocked"));
    x.send();
  });
}

async function serverBytes(path) {
  const { serverUrl } = await getSettings();
  const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/v1/local-pdf?path=${encodeURIComponent(path)}`, {
    headers: { "X-R-Aloud": "1" },
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))).detail ?? res.statusText;
    throw new Error(`${res.status} ${detail}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchBytes(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function loadFromUrl(url) {
  const u = new URL(url);
  if (u.protocol === "file:") {
    const path = decodeURIComponent(u.pathname);
    try { return await xhrBytes(url); } catch { /* no file access: ask the server */ }
    try {
      return await serverBytes(path);
    } catch (err) {
      throw new NeedsFile(
        "Couldn't open the local file",
        `The r-aloud server couldn't read ${path} (${err.message}). Make sure it is running, or pick the file below.`,
      );
    }
  }
  try {
    return await fetchBytes(url);
  } catch {
    const origins = [`${u.origin}/*`];
    if (await api.permissions.contains({ origins }).catch(() => false)) {
      throw new NeedsFile("Couldn't download the PDF", `Downloading ${url} failed. You can save it and open it below.`);
    }
    throw new NeedsFile(
      "Allow r-aloud to download this PDF",
      `To read PDFs from ${u.host}, r-aloud needs permission to download from that site.`,
      {
        label: `Allow ${u.host}`,
        run: async () => {
          if (await api.permissions.request({ origins })) open(await fetchBytes(url), fileName(url));
        },
      },
    );
  }
}

const fileName = (url) => {
  try { return decodeURIComponent(new URL(url).pathname.split("/").pop()) || "document.pdf"; } catch { return "document.pdf"; }
};

function showNotice(err) {
  $("notice").hidden = false;
  $("notice-title").textContent = err.title ?? "Couldn't open this PDF";
  $("notice-text").textContent = err.message;
  const btn = $("notice-action");
  btn.hidden = !err.action;
  if (err.action) {
    btn.textContent = err.action.label;
    btn.onclick = () => err.action.run().catch((e) => showNotice(e));
  }
}

async function openFile(file) {
  open(new Uint8Array(await file.arrayBuffer()), file.name);
}

// ---- rendering ----------------------------------------------------------------

async function open(data, name) {
  loading = true;
  $("notice").hidden = true;
  $("pages").replaceChildren();
  pages.length = 0;
  doc?.destroy();
  try {
    doc = await pdfjs.getDocument({
      data,
      cMapUrl: VENDOR + "cmaps/",
      cMapPacked: true,
      standardFontDataUrl: VENDOR + "standard_fonts/",
      wasmUrl: VENDOR + "wasm/",
      iccUrl: VENDOR + "iccs/",
      isEvalSupported: false,
    }).promise;
  } catch (err) {
    loading = false;
    showNotice({ title: "This isn't a readable PDF", message: err.message });
    return;
  }
  const title = (await doc.getMetadata().catch(() => null))?.info?.Title?.trim();
  $("doc-title").textContent = title || name;
  document.title = `${title || name} – r-aloud`;

  const first = await doc.getPage(1);
  const base = first.getViewport({ scale: 1 });
  scale = Math.min(2, Math.max(0.6, (Math.min(window.innerWidth, 1100) - 48) / base.width));

  // Placeholders first so the layout (and scrolling to a page) is immediate.
  for (let n = 1; n <= doc.numPages; n++) {
    const div = document.createElement("div");
    div.className = "page";
    div.dataset.page = String(n);
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    div.append(textLayer);
    $("pages").append(div);
    pages.push({ div, textLayer, page: null, viewport: null, rendered: false });
    sizePage(pages[n - 1], base.width * scale, base.height * scale);
  }
  const startPage = Math.min(doc.numPages, parseInt(params.get("page") ?? "1", 10) || 1);
  if (startPage > 1) pages[startPage - 1].div.scrollIntoView();
  updatePageInfo();

  observeCanvases();
  await buildTextLayers();
  for (const id of ["read-here", "read-selection", "zoom-in", "zoom-out"]) $(id).disabled = false;
  markReady();
  if (autoRead === "page") send({ cmd: "read", tabId: tab?.id, mode: "page" });
}

function sizePage(p, w, h) {
  p.div.style.width = `${Math.floor(w)}px`;
  p.div.style.height = `${Math.floor(h)}px`;
}

async function buildTextLayers() {
  const progress = $("progress");
  for (let i = 0; i < pages.length; i++) {
    if (pages.length > 20 && i % 5 === 0) {
      progress.hidden = false;
      progress.textContent = `Preparing text… page ${i + 1} of ${pages.length}`;
    }
    await layoutPage(pages[i], i + 1);
  }
  progress.hidden = true;
}

async function layoutPage(p, n) {
  p.page ??= await doc.getPage(n);
  p.viewport = p.page.getViewport({ scale });
  sizePage(p, p.viewport.width, p.viewport.height);
  p.div.style.setProperty("--total-scale-factor", String(scale * (p.viewport.userUnit ?? 1)));
  p.textLayer.replaceChildren();
  const layer = new pdfjs.TextLayer({
    textContentSource: p.page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
    container: p.textLayer,
    viewport: p.viewport,
  });
  await layer.render();
  markParagraphs(p.textLayer);
}

/**
 * pdf.js ends every line with a <br>. Flag the ones that end a paragraph:
 * a vertical gap clearly bigger than the line height, or a short line that
 * finishes a sentence.
 */
function markParagraphs(layer) {
  const spans = [...layer.querySelectorAll("span:not(.markedContent)")].filter((s) => s.textContent.trim());
  if (!spans.length) return;
  const rects = new Map(spans.map((s) => [s, s.getBoundingClientRect()]));
  const left = Math.min(...[...rects.values()].map((r) => r.left));
  const right = Math.max(...[...rects.values()].map((r) => r.right));
  const width = right - left;
  for (const br of layer.querySelectorAll("br")) {
    const prev = previousSpan(br);
    const next = nextSpan(br);
    if (!prev || !next) continue;
    const a = rects.get(prev);
    const b = rects.get(next);
    if (!a || !b) continue;
    const lineH = Math.max(a.height, 1);
    const gap = b.top - a.top;
    const shortLine = a.right < left + width * 0.75 && /[.!?:”"')\]]\s*$/.test(prev.textContent);
    const indented = b.left > left + lineH * 1.2 && /[.!?:]\s*$/.test(prev.textContent);
    if (gap > lineH * 1.9 || gap < -lineH || shortLine || indented) br.dataset.para = "1";
  }
}

function previousSpan(node) {
  for (let n = node.previousElementSibling; n; n = n.previousElementSibling) {
    if (n.tagName === "SPAN" && n.textContent.trim()) return n.classList.contains("markedContent") ? n.querySelector("span:last-of-type") ?? n : n;
  }
  return null;
}

function nextSpan(node) {
  for (let n = node.nextElementSibling; n; n = n.nextElementSibling) {
    if (n.tagName === "SPAN" && n.textContent.trim()) return n.classList.contains("markedContent") ? n.querySelector("span") ?? n : n;
  }
  return null;
}

let canvasObserver = null;
function observeCanvases() {
  canvasObserver?.disconnect();
  canvasObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const p = pages[Number(e.target.dataset.page) - 1];
      if (!p.rendered) renderCanvas(p, Number(e.target.dataset.page)).catch(() => {});
    }
  }, { rootMargin: "1200px 0px" });
  for (const p of pages) canvasObserver.observe(p.div);
}

async function renderCanvas(p, n) {
  p.rendered = true;
  p.page ??= await doc.getPage(n);
  const dpr = window.devicePixelRatio || 1;
  const viewport = p.page.getViewport({ scale: scale * dpr });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  p.div.prepend(canvas);
  await p.page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
}

function currentPageIndex() {
  const mid = 80; // just below the toolbar
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].div.getBoundingClientRect().bottom > mid) return i;
  }
  return 0;
}

function updatePageInfo() {
  if (pages.length) $("page-info").textContent = `Page ${currentPageIndex() + 1} / ${pages.length}`;
}

async function zoom(factor) {
  const anchor = currentPageIndex();
  scale = Math.min(4, Math.max(0.4, scale * factor));
  for (const p of pages) { p.div.querySelector("canvas")?.remove(); p.rendered = false; }
  // Stop reading: the highlighted ranges point at the old text layer.
  send({ cmd: "control", action: "stop" }).catch(() => {});
  await buildTextLayers();
  pages[anchor].div.scrollIntoView();
  observeCanvases();
}

// ---- UI -----------------------------------------------------------------------

window.addEventListener("scroll", updatePageInfo, { passive: true });
$("read-here").addEventListener("click", () => send({ cmd: "read", tabId: tab?.id, mode: "page" }));
$("read-selection").addEventListener("click", () => send({ cmd: "read", tabId: tab?.id, mode: "selection" }));
$("zoom-in").addEventListener("click", () => zoom(1.2));
$("zoom-out").addEventListener("click", () => zoom(1 / 1.2));
for (const id of ["file-input", "notice-file"]) {
  $(id).addEventListener("change", (e) => e.target.files[0] && openFile(e.target.files[0]));
}
document.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dragging"); });
document.addEventListener("dragleave", () => document.body.classList.remove("dragging"));
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  const file = [...e.dataTransfer.files].find((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (file) openFile(file);
});

if (src) {
  $("doc-title").textContent = fileName(src);
  try {
    await open(await loadFromUrl(src), fileName(src));
  } catch (err) {
    showNotice(err);
  }
} else {
  showNotice({ title: "Open a PDF", message: "Pick a PDF from your computer to read it aloud." });
}
