// Builds a small multi-page text PDF (Helvetica, no dependencies) for tests.
export const PDF_PAGES = [
  [
    ["The PDF reading test"],
    [],
    ["Portable documents are everywhere. This paragraph spans two lines so the", "reader has to join them back into one sentence."],
    [],
    ["A second paragraph follows here. It mentions a hyphen-", "ated word that must be rejoined."],
  ],
  [
    ["Page two begins with this sentence. The selection test reads only this", "paragraph and nothing else."],
    [],
    ["The final paragraph closes the document. Thank you for listening."],
  ],
];

export function makePdf(pages = PDF_PAGES) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null);
  const pagesId = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids = [];
  for (const paras of pages) {
    const ops = ["BT", "/F1 14 Tf", "72 760 Td"];
    let first = true;
    for (const lines of paras) {
      if (!lines.length) { ops.push("0 -14 Td"); continue; } // paragraph gap
      for (const line of lines) {
        if (!first) ops.push("0 -20 Td");
        first = false;
        ops.push(`(${line.replace(/[\\()]/g, (c) => "\\" + c)}) Tj`);
      }
    }
    ops.push("ET");
    const stream = ops.join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
