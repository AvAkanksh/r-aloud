// Text extraction and sentence chunking. Loaded as a classic content script
// (exposes globalThis.RAloudSegment) and imported by the Node tests.
(() => {
  if (globalThis.RAloudSegment) return;

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT",
    "VIDEO", "AUDIO", "BUTTON", "SELECT", "TEXTAREA", "INPUT", "MATH", "HEAD",
  ]);
  // Page chrome that is noise when reading a whole page (but fine inside a selection).
  const PAGE_SKIP_TAGS = new Set(["NAV", "ASIDE", "FOOTER", "FORM", "FIGCAPTION"]);
  const PAGE_SKIP_SELECTORS = [
    "sup.reference", ".mw-editsection", ".noprint", "[role=navigation]",
    "[role=complementary]", "[aria-hidden=true]", ".sr-only", ".visually-hidden",
  ].join(",");
  const INLINE_DISPLAYS = new Set(["inline", "inline-block", "contents", "ruby"]);

  const MAX_CHUNK = 300;   // chars per TTS request
  const MIN_CHUNK = 40;    // merge shorter sentences with the next one
  const HARD_MAX = 450;    // split sentences longer than this

  function isHidden(el) {
    if (el.hidden) return true;
    const view = el.ownerDocument.defaultView;
    if (!view || !view.getComputedStyle) return false;
    const cs = view.getComputedStyle(el);
    return cs.display === "none" || cs.visibility === "hidden";
  }

  const inTextLayer = (el) => !el.classList?.contains("textLayer") && !!el.parentElement?.closest(".textLayer");

  function isBlock(el) {
    const view = el.ownerDocument.defaultView;
    if (!view || !view.getComputedStyle) return !/^(A|B|I|EM|STRONG|SPAN|CODE|SUP|SUB|SMALL|MARK|ABBR|CITE|Q|U|S|LABEL|TIME)$/.test(el.tagName);
    return !INLINE_DISPLAYS.has(view.getComputedStyle(el).display);
  }

  /**
   * Flatten the text inside `range` into one string, remembering which text
   * node every character came from so offsets can be mapped back to the DOM.
   * Block elements become newlines.
   *
   * In a pdf.js text layer every span is absolutely positioned (so it computes
   * as a block) and every line ends in a <br>; there, spans count as inline and
   * a <br> is a space, except where the reader marked a paragraph gap
   * (data-para) or a hyphenated line break is joined back together.
   */
  function collectText(range, { pageMode = false, skipRoot = null } = {}) {
    const doc = range.startContainer.ownerDocument || range.startContainer;
    let root = range.commonAncestorContainer;
    if (root.nodeType === 3) root = root.parentNode;
    let text = "";
    const map = []; // {node, start, end, nodeStart}

    const needsBreak = () => text.length && !/\s$/.test(text);
    // A block boundary upgrades a synthetic trailing space (from a text-layer <br>) to a newline.
    const breakLine = () => {
      const last = map[map.length - 1];
      if (text.endsWith(" ") && (!last || last.end < text.length)) text = text.slice(0, -1) + "\n";
      else if (needsBreak()) text += "\n";
    };
    const shouldSkip = (el) =>
      SKIP_TAGS.has(el.tagName.toUpperCase()) ||
      (skipRoot && el === skipRoot) ||
      isHidden(el) ||
      (pageMode && (PAGE_SKIP_TAGS.has(el.tagName.toUpperCase()) || el.matches(PAGE_SKIP_SELECTORS)));

    const walk = (node) => {
      if (node.nodeType === 3) {
        if (!range.intersectsNode(node)) return;
        let s = 0;
        let e = node.data.length;
        if (node === range.startContainer) s = range.startOffset;
        if (node === range.endContainer) e = range.endOffset;
        const raw = node.data.slice(s, e);
        if (!raw || (!raw.trim() && inTextLayer(node))) return;
        // Collapse whitespace the way rendering does, keeping a 1:1 char map.
        let piece = raw.replace(/[\s ]/g, " ");
        if (/\s$/.test(text) || !text.length) {
          const lead = piece.match(/^ */)[0].length;
          piece = piece.slice(lead);
          s += lead;
        }
        if (!piece) return;
        map.push({ node, start: text.length, end: text.length + piece.length, nodeStart: s });
        text += piece;
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 1) {
        if (node !== root && shouldSkip(node)) return;
        if (node.tagName === "BR") {
          if (!range.intersectsNode(node)) return;
          if (!inTextLayer(node)) { if (needsBreak()) text += "\n"; return; }
          if (node.dataset.para) { if (needsBreak()) text += "\n"; return; }
          const last = map[map.length - 1];
          if (/\p{Ll}-$/u.test(text) && last && last.end === text.length) {
            text = text.slice(0, -1);
            last.end -= 1;
          } else if (needsBreak()) {
            text += " ";
          }
          return;
        }
      }
      const block = node.nodeType === 1 && node !== root && !inTextLayer(node) && isBlock(node);
      if (block) breakLine();
      for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
      if (block) breakLine();
    };
    walk(root);
    return { text, map, doc };
  }

  function segmentSentences(text) {
    const out = [];
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      const seg = new Intl.Segmenter(undefined, { granularity: "sentence" });
      for (const s of seg.segment(text)) out.push({ start: s.index, end: s.index + s.segment.length });
    } else {
      const re = /[^.!?\n]+(?:[.!?]+["'”’)\]]*|\n|$)\s*/g;
      let m;
      while ((m = re.exec(text)) && m[0]) out.push({ start: m.index, end: m.index + m[0].length });
    }
    // Paragraph breaks always end a sentence.
    const split = [];
    for (const s of out) {
      let a = s.start;
      for (let i = s.start; i < s.end; i++) {
        if (text[i] === "\n") {
          if (i > a) split.push({ start: a, end: i });
          a = i + 1;
        }
      }
      if (s.end > a) split.push({ start: a, end: s.end });
    }
    return split;
  }

  function splitLong(text, s) {
    const parts = [];
    let a = s.start;
    while (s.end - a > HARD_MAX) {
      const window = text.slice(a, a + HARD_MAX);
      let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
      if (cut < HARD_MAX / 3) cut = window.lastIndexOf(" ");
      if (cut < HARD_MAX / 3) cut = HARD_MAX - 1;
      parts.push({ start: a, end: a + cut + 1 });
      a += cut + 1;
    }
    parts.push({ start: a, end: s.end });
    return parts;
  }

  const speakable = (t) => /[\p{L}\p{N}]/u.test(t);

  /**
   * Group sentences into TTS chunks. The first chunk is kept to a single
   * sentence so audio starts quickly. Chunks never span paragraphs.
   */
  function makeChunks(text) {
    const sentences = segmentSentences(text).flatMap((s) => splitLong(text, s));
    const chunks = [];
    for (const s of sentences) {
      const prev = chunks[chunks.length - 1];
      const prevLen = prev ? prev.end - prev.start : 0;
      const len = s.end - s.start;
      const merge =
        prev && chunks.length > 1 &&
        !text.slice(prev.end, s.start).includes("\n") &&
        (prevLen < MIN_CHUNK || len < MIN_CHUNK) &&
        prevLen + len <= MAX_CHUNK;
      if (merge) prev.end = s.end;
      else chunks.push({ start: s.start, end: s.end });
    }
    return chunks
      .map(({ start, end }) => {
        // Trim whitespace while keeping offsets exact.
        while (start < end && /\s/.test(text[start])) start++;
        while (end > start && /\s/.test(text[end - 1])) end--;
        return { start, end, text: text.slice(start, end) };
      })
      .filter((c) => speakable(c.text));
  }

  /** Map [start, end) in collected text back to a DOM Range. */
  function rangeFor(collected, start, end) {
    const { map, doc } = collected;
    const locate = (pos, preferEnd) => {
      for (const m of map) {
        if (pos >= m.start && (pos < m.end || (preferEnd && pos === m.end))) {
          return { node: m.node, offset: m.nodeStart + (pos - m.start) };
        }
      }
      return null;
    };
    // `start` may sit on a synthetic newline; then begin at the next text node.
    let a = locate(start, false);
    if (!a) {
      const next = map.find((m) => m.start >= start);
      a = next && { node: next.node, offset: next.nodeStart };
    }
    const b = locate(end, true);
    if (!a || !b) return null;
    const r = doc.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return r;
  }

  /** Pick the element that most likely holds the page's main content. */
  function findMainRoot(doc) {
    const textLen = (el) => (el.innerText || el.textContent || "").trim().length;
    const articles = [...doc.querySelectorAll("article")].filter((a) => textLen(a) > 200);
    if (articles.length) return articles.sort((x, y) => textLen(y) - textLen(x))[0];
    const main = doc.querySelector("main, [role=main], #content, #main-content, .post-content, .entry-content");
    if (main && textLen(main) > 200) return main;
    // Score containers by the paragraph text they directly hold.
    const scores = new Map();
    for (const p of doc.querySelectorAll("p")) {
      const len = (p.textContent || "").trim().length;
      if (len < 25 || !p.parentElement) continue;
      scores.set(p.parentElement, (scores.get(p.parentElement) || 0) + len);
    }
    let best = null;
    let bestScore = 0;
    for (const [el, sc] of scores) if (sc > bestScore) { best = el; bestScore = sc; }
    return best && bestScore > 400 ? best : doc.body;
  }

  globalThis.RAloudSegment = { collectText, segmentSentences, makeChunks, rangeFor, findMainRoot };
})();
