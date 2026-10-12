// Streams PCM from the TTS server and plays it gaplessly with Web Audio.
// Runs in the Chrome offscreen document or the Firefox background page.

const LOOKAHEAD_S = 15;      // don't synthesize further ahead than this
const MIN_BUFFER_S = 0.25;   // schedule audio in slices of at least this length
const START_DELAY_S = 0.08;
const UNDERRUN_S = 0.6;     // silence this long before reporting "loading"

export class Player {
  /** @param {(evt: object) => void} emit */
  constructor(emit) {
    this.emit = emit;
    this.ctx = null;
    this.session = null;
    this.state = "idle";
  }

  setState(state, extra = {}) {
    this.state = state;
    this.emit({ evt: "state", state, ...extra });
  }

  /**
   * @param {{chunks: string[], startIndex?: number, settings: {serverUrl: string,
   *   backend: string, voice: string, speed: number}}} opts
   */
  async start({ chunks, startIndex = 0, settings }) {
    this.stop({ silent: true });
    if (!chunks.length) return;
    const ctx = new AudioContext({ latencyHint: "playback" });
    this.ctx = ctx;
    const session = {
      id: crypto.randomUUID(),
      ctx,
      chunks,
      settings,
      abort: new AbortController(),
      cursor: 0,          // ctx time where the next slice will start
      starts: new Map(),  // chunk index -> ctx start time
      ends: new Map(),
      sources: new Set(),
      current: -1,
      generated: false,
      lastIndex: chunks.length - 1,
    };
    this.session = session;
    this.setState("loading", { index: startIndex, total: chunks.length });
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    session.ticker = setInterval(() => this.tick(session), 100);
    this.generate(session, startIndex).catch((err) => {
      if (session !== this.session || err.name === "AbortError") return;
      this.fail(err);
    });
  }

  fail(err) {
    this.stop({ silent: true });
    this.setState("error", { error: err && err.message ? err.message : String(err) });
  }

  async generate(session, from) {
    const { ctx, chunks, settings } = session;
    for (let i = from; i < chunks.length; i++) {
      // Back-pressure: wait while we already have plenty of audio queued.
      while (session === this.session && session.cursor - ctx.currentTime > LOOKAHEAD_S) {
        await sleep(200);
      }
      if (session !== this.session) return;
      await this.fetchChunk(session, i, chunks[i], settings);
    }
    session.generated = true;
  }

  async fetchChunk(session, index, text, settings) {
    const url = `${settings.serverUrl.replace(/\/+$/, "")}/v1/audio/speech`;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: text,
          model: settings.backend,
          voice: settings.voice || undefined,
          speed: settings.speed,
          response_format: "pcm",
        }),
        signal: session.abort.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      throw new Error(`Cannot reach the TTS server at ${settings.serverUrl}. Is r-aloud-server running?`);
    }
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).detail; } catch { /* not json */ }
      throw new Error(`TTS server error ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const rate = parseInt(res.headers.get("X-Sample-Rate") || "24000", 10);
    const reader = res.body.getReader();
    const minBytes = Math.floor(rate * MIN_BUFFER_S) * 2;
    let pending = new Uint8Array(0);
    let first = true;
    const flush = (final) => {
      const usable = pending.length - (pending.length % 2);
      if (!usable || (!final && usable < minBytes)) return;
      this.schedule(session, index, pending.subarray(0, usable), rate, first);
      first = false;
      pending = pending.slice(usable);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (session !== this.session) { reader.cancel().catch(() => {}); return; }
      if (done) break;
      pending = concat(pending, value);
      flush(false);
    }
    flush(true);
    if (!session.starts.has(index)) {
      // Nothing audible (e.g. pure symbols): mark as instantly done.
      const t = Math.max(session.cursor, session.ctx.currentTime);
      session.starts.set(index, t);
      session.ends.set(index, t);
    }
  }

  schedule(session, index, bytes, rate, first) {
    const { ctx } = session;
    const n = bytes.length / 2;
    const buf = ctx.createBuffer(1, n, rate);
    const data = buf.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < n; i++) data[i] = view.getInt16(i * 2, true) / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const at = Math.max(session.cursor, ctx.currentTime + START_DELAY_S);
    src.start(at);
    session.sources.add(src);
    src.onended = () => session.sources.delete(src);
    if (first) session.starts.set(index, at);
    session.cursor = at + buf.duration;
    session.ends.set(index, session.cursor);
  }

  tick(session) {
    if (session !== this.session) return;
    const now = session.ctx.currentTime;
    let playing = -1;
    for (const [i, t] of session.starts) if (t <= now + 0.02 && i > playing) playing = i;
    if (playing !== -1 && playing !== session.current) {
      session.current = playing;
      this.emit({ evt: "chunk", index: playing, total: session.chunks.length });
    }
    const lastEnd = session.ends.get(session.lastIndex);
    if (session.generated && lastEnd !== undefined && now >= lastEnd) {
      this.stop({ silent: true });
      this.setState("ended");
      return;
    }
    // "loading" until audio starts, or whenever synthesis falls behind playback.
    // Small underruns (between sentences) shouldn't flash a spinner.
    const buffering = playing === -1 || (!session.generated && now - session.cursor > UNDERRUN_S);
    const want = buffering ? "loading" : "playing";
    if ((this.state === "loading" || this.state === "playing") && want !== this.state) {
      this.setState(want, { index: session.current, total: session.chunks.length });
    }
  }

  pause() {
    if (!this.session || this.state === "paused") return;
    this.session.ctx.suspend();
    this.setState("paused", { index: this.session.current, total: this.session.chunks.length });
  }

  resume() {
    if (!this.session || this.state !== "paused") return;
    this.session.ctx.resume();
    this.setState("playing", { index: this.session.current, total: this.session.chunks.length });
  }

  /** Restart from another chunk, reusing the same text and settings. */
  seek(index, settings) {
    const s = this.session;
    if (!s) return;
    const target = Math.min(Math.max(index, 0), s.chunks.length - 1);
    this.start({ chunks: s.chunks, startIndex: target, settings: settings ?? s.settings });
  }

  skip(delta) {
    const s = this.session;
    if (!s) return;
    this.seek(Math.max(s.current, 0) + delta);
  }

  stop({ silent = false } = {}) {
    const s = this.session;
    if (!s) return;
    this.session = null;
    clearInterval(s.ticker);
    s.abort.abort();
    for (const src of s.sources) { try { src.stop(); } catch { /* already stopped */ } }
    s.ctx.close().catch(() => {});
    if (this.ctx === s.ctx) this.ctx = null;
    if (!silent) this.setState("idle");
  }

  snapshot() {
    const s = this.session;
    return { state: this.state, index: s ? s.current : -1, total: s ? s.chunks.length : 0 };
  }

  /** Handle a control message; returns a response object. */
  handle(msg) {
    switch (msg.action) {
      case "start": this.start(msg); break;
      case "pause": this.pause(); break;
      case "resume": this.resume(); break;
      case "toggle": this.state === "paused" ? this.resume() : this.pause(); break;
      case "next": this.skip(1); break;
      case "prev": this.skip(-1); break;
      case "seek": this.seek(msg.index, msg.settings); break;
      case "stop": this.stop(); break;
      case "snapshot": break;
      default: return { ok: false, error: `unknown action ${msg.action}` };
    }
    return { ok: true, ...this.snapshot() };
  }
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
