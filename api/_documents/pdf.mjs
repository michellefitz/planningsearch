/**
 * A PDF around pages we have already compressed.
 *
 * The councils' older scans decode to pixels, and pixels are not something to
 * hand a reader: one page at a time, no printing, no saving as the document it
 * is. A PDF is what a planning file should arrive as — every browser renders
 * it inline, it prints, and it keeps its pages together.
 *
 * Nothing is re-encoded to build it. PDF reads exactly the scanline layout PNG
 * uses, as `/Predictor 15`, so the deflated stream that would have gone into
 * an IDAT chunk goes into an image XObject unchanged. A twenty-page order
 * costs twenty deflates, not forty, and the arithmetic below is all that
 * stands between them and a file.
 */

/** PDF strings are Latin-1; every byte we write here is ASCII. */
const bytes = (s) => Buffer.from(s, "latin1");

/**
 * Pages, each `{ width, height, deflated }` in pixels, at `dpi`.
 *
 * The page box is in points — 72 to the inch — so a 150 dpi scan of an A4
 * sheet comes out A4 rather than four feet tall, and prints at its true size.
 */
export function greyPagesToPdf(pages, { dpi = 150, title = "" } = {}) {
  if (!pages.length) return null;
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length; // 1-based object number
  };

  // Reserved so the page objects can name their parent before it exists.
  const catalogNum = add(null);
  const pagesNum = add(null);
  const pageNums = [];

  for (const page of pages) {
    const w = ((page.width * 72) / dpi).toFixed(2);
    const h = ((page.height * 72) / dpi).toFixed(2);
    const imageNum = add(
      Buffer.concat([
        bytes(
          `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
            `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode ` +
            `/DecodeParms << /Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns ${page.width} >> ` +
            `/Length ${page.deflated.length} >>\nstream\n`
        ),
        page.deflated,
        bytes("\nendstream"),
      ])
    );
    // Draw the image over the whole page: scale to the box, place at the
    // origin, paint once.
    const content = bytes(`q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`);
    const contentNum = add(
      Buffer.concat([bytes(`<< /Length ${content.length} >>\nstream\n`), content, bytes("\nendstream")])
    );
    pageNums.push(
      add(
        bytes(
          `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${w} ${h}] ` +
            `/Resources << /XObject << /Im0 ${imageNum} 0 R >> /ProcSet [/PDF /ImageB] >> ` +
            `/Contents ${contentNum} 0 R >>`
        )
      )
    );
  }

  objects[catalogNum - 1] = bytes(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  objects[pagesNum - 1] = bytes(
    `<< /Type /Pages /Count ${pageNums.length} /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] >>`
  );

  const infoNum = add(bytes(`<< /Title (${pdfText(title)}) /Producer (PlanView) >>`));

  // Body, recording where each object starts — the xref table is byte offsets
  // and nothing else, so it has to be built as the file is.
  const parts = [bytes("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  let offset = parts[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    const head = bytes(`${i + 1} 0 obj\n`);
    const tail = bytes("\nendobj\n");
    offsets.push(offset);
    parts.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  });

  const xrefAt = offset;
  const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n"];
  for (const at of offsets) xref.push(`${String(at).padStart(10, "0")} 00000 n \n`);
  parts.push(bytes(xref.join("")));
  parts.push(
    bytes(
      `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R /Info ${infoNum} 0 R >>\n` +
        `startxref\n${xrefAt}\n%%EOF\n`
    )
  );
  return Buffer.concat(parts);
}

/** Escaping for a PDF literal string, and only the characters that need it. */
function pdfText(s) {
  return String(s ?? "")
    .replace(/[\\()]/g, "\\$&")
    .replace(/[^\x20-\x7e]/g, " ")
    .slice(0, 200);
}
