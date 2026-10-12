import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const src = readFileSync(new URL("../src/content/segment.js", import.meta.url), "utf8");

function load(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: "outside-only" });
  dom.window.eval(src);
  return { win: dom.window, doc: dom.window.document, Seg: dom.window.RAloudSegment };
}

const pageText = (Seg, doc, el = doc.body) => {
  const r = doc.createRange();
  r.selectNodeContents(el);
  return Seg.collectText(r, { pageMode: true });
};

test("collects text with paragraph breaks and skips noise", () => {
  const { doc, Seg } = load(`
    <nav>Home About</nav>
    <h1>Title here</h1>
    <p>First   para with <b>bold</b> text.</p>
    <script>var x = 1;</script>
    <p>Second para<sup class="reference">[1]</sup>.</p>
    <div style="display:none">hidden</div>
    <footer>Copyright</footer>`);
  const { text } = pageText(Seg, doc);
  // Runs of spaces inside one text node are kept 1:1 so offsets map back to the DOM.
  assert.equal(text.trim().replace(/ +/g, " "), "Title here\nFirst para with bold text.\nSecond para.");
});

test("selection text is clipped to the range", () => {
  const { doc, Seg } = load(`<p id="p">Alpha beta gamma delta.</p>`);
  const node = doc.getElementById("p").firstChild;
  const r = doc.createRange();
  r.setStart(node, 6);
  r.setEnd(node, 16);
  assert.equal(Seg.collectText(r).text, "beta gamma");
});

test("chunks: first sentence alone, short sentences merged, paragraphs respected", () => {
  const { Seg } = load("");
  const text = "Intro sentence here. Yes. No. This is a longer sentence that goes on.\nNew paragraph starts. Ok.";
  const chunks = Array.from(Seg.makeChunks(text), (c) => c.text);
  assert.deepEqual(chunks, [
    "Intro sentence here.",
    "Yes. No. This is a longer sentence that goes on.",
    "New paragraph starts. Ok.",
  ]);
});

test("chunks: long sentences are split, symbols-only dropped, offsets exact", () => {
  const { Seg } = load("");
  const long = Array.from({ length: 60 }, (_, i) => `clause number ${i}`).join(", ") + ".";
  const text = `***\n${long}\n— —`;
  const chunks = Seg.makeChunks(text);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    assert.ok(c.text.length <= 450, `chunk too long: ${c.text.length}`);
    assert.equal(text.slice(c.start, c.end), c.text);
    assert.match(c.text, /clause/);
  }
});

test("rangeFor maps chunk offsets back to the DOM across elements", () => {
  const { doc, Seg } = load(`<p>One two. Three <em>four five</em> six. Seven.</p>`);
  const collected = pageText(Seg, doc);
  const chunks = Seg.makeChunks(collected.text);
  const second = chunks[1];
  const range = Seg.rangeFor(collected, second.start, second.end);
  assert.equal(range.toString(), "Three four five six. Seven.");
});

test("findMainRoot prefers the article over page chrome", () => {
  const { doc, Seg } = load(`
    <div id="sidebar"><p>${"menu link ".repeat(10)}</p></div>
    <article id="story"><p>${"Real story text. ".repeat(30)}</p></article>`);
  assert.equal(Seg.findMainRoot(doc).id, "story");
});

test("findMainRoot falls back to the densest paragraph container", () => {
  const { doc, Seg } = load(`
    <div id="a"><p>${"short ".repeat(5)}</p></div>
    <div id="b">${`<p>${"Body paragraph text goes here. ".repeat(6)}</p>`.repeat(4)}</div>`);
  assert.equal(Seg.findMainRoot(doc).id, "b");
});

test("pdf.js text layers: lines join, paragraph gaps break, hyphens rejoin", () => {
  const { doc, Seg } = load(`
    <div class="page"><div class="textLayer">
      <span style="position:absolute">The first line of a para</span><br>
      <span style="position:absolute">graph continues here. A hyph-</span><br>
      <span style="position:absolute">enated word.</span><br data-para="1">
      <span style="position:absolute">Second paragraph.</span><br>
    </div></div>
    <div class="page"><div class="textLayer"><span style="position:absolute">Next page.</span></div></div>`);
  const collected = pageText(Seg, doc);
  assert.equal(collected.text.trim(),
    "The first line of a para graph continues here. A hyphenated word.\nSecond paragraph.\nNext page.");
  const chunks = Seg.makeChunks(collected.text);
  const hy = chunks.find((c) => c.text.includes("hyphenated"));
  // Offsets still map to the DOM across the joined hyphen.
  assert.match(Seg.rangeFor(collected, hy.start, hy.end).toString(), /A hyph-\s*enated word\./);
});
