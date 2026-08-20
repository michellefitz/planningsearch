import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { djvuToImageBlocks, djvuToPdf, djvuToPngPages, isDjvu } from "../../api/_documents/djvu.mjs";
import { greyPng } from "../../api/_documents/png.mjs";

/**
 * The Chief Executive's Order for Meath 2161 — Piper Hill, Belshamstown — as
 * the council's own file viewer serves it. Two pages: the order on the first,
 * the two reasons for refusal on the second. Until this decoded, every one of
 * those reasons was on the file, fetched successfully, and thrown away.
 */
const ORDER = readFileSync(join(__dirname, "fixtures", "documents", "meath-2161-order.djvu"));

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height out of a PNG's IHDR, so the test reads what it wrote. */
function pngSize(png: Buffer) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe("recognising the old scans", () => {
  it("knows the content type the iDocs portals send", () => {
    expect(isDjvu("image/x.djvu", null)).toBe(true);
    expect(isDjvu("application/octet-stream", "1213760.djvu")).toBe(true);
  });

  it("does not mistake a PDF for one", () => {
    expect(isDjvu("application/pdf", "order.pdf")).toBe(false);
    expect(isDjvu(null, null)).toBe(false);
  });
});

describe("decoding a council decision order", () => {
  it("renders every page", async () => {
    const pages = await djvuToPngPages(ORDER);
    expect(pages).toHaveLength(2);
  });

  it("produces PNGs a browser and the model can read", async () => {
    const [first] = await djvuToPngPages(ORDER);
    expect(first.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    // An A4 page at 150 dpi, which is where the model's own 1568px limit lands.
    const { width, height } = pngSize(first);
    expect(width).toBeGreaterThan(1000);
    expect(height).toBeGreaterThan(1400);
    expect(height).toBeLessThan(1800);
    // Small enough to send several of: the whole point of DjVu was size, and
    // a bitonal page re-encoded stays well under a tenth of a megabyte.
    expect(first.byteLength).toBeLessThan(200_000);
  });

  it("stops at the page budget", async () => {
    expect(await djvuToPngPages(ORDER, { maxPages: 1 })).toHaveLength(1);
  });

  /** Never an exception into a request handler: an undecodable file has to
   *  read as "we could not", which is different from "there is nothing". */
  it("returns nothing rather than throwing on a file that is not DjVu", async () => {
    expect(await djvuToPngPages(Buffer.from("%PDF-1.4 not a djvu at all"))).toEqual([]);
    expect(await djvuToPngPages(Buffer.alloc(0))).toEqual([]);
  });
});

describe("handing the pages to the model", () => {
  it("comes out as base64 image blocks, one per page", async () => {
    const blocks = await djvuToImageBlocks(ORDER);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block.type).toBe("image");
      expect(block.source.media_type).toBe("image/png");
      expect(Buffer.from(block.source.data, "base64").subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    }
  });
});

/**
 * Structural, not visual: a PDF that renders in one viewer and not another is
 * usually a byte offset in the cross-reference table, which nothing but
 * arithmetic will catch.
 */
function readPdf(pdf: Buffer) {
  const startxref = Number(/startxref\s+(\d+)\s+%%EOF/.exec(pdf.toString("latin1"))?.[1]);
  const text = pdf.toString("latin1");
  const entries = [
    ...text
      .slice(startxref)
      .matchAll(/(\d{10}) (\d{5}) ([nf])/g),
  ].map((m) => ({ at: Number(m[1]), kind: m[3] }));
  return {
    header: pdf.subarray(0, 8).toString("latin1"),
    xrefAt: startxref,
    xrefIsWhereItSays: text.slice(startxref, startxref + 4) === "xref",
    /** Every entry must land exactly on "N 0 obj" or no reader can follow it. */
    offsetsLandOnObjects: entries.every(
      (e, i) => e.kind === "f" || text.startsWith(`${i} 0 obj`, e.at)
    ),
    pageCount: Number(/\/Type \/Pages \/Count (\d+)/.exec(text)?.[1]),
    images: [...text.matchAll(/\/Subtype \/Image \/Width (\d+) \/Height (\d+)/g)].map((m) => ({
      width: Number(m[1]),
      height: Number(m[2]),
    })),
    predictor: text.includes("/Predictor 15"),
  };
}

describe("serving an old scan as a PDF", () => {
  it("puts every page in one file a browser can open", async () => {
    const pdf = (await djvuToPdf(ORDER, { title: "Chief Executives Order" })) as Buffer;
    const read = readPdf(pdf);
    expect(read.header).toBe("%PDF-1.4");
    expect(read.pageCount).toBe(2);
    expect(read.images).toHaveLength(2);
  });

  it("writes a cross-reference table that points at the objects", async () => {
    const read = readPdf((await djvuToPdf(ORDER)) as Buffer);
    expect(read.xrefIsWhereItSays).toBe(true);
    expect(read.offsetsLandOnObjects).toBe(true);
  });

  /** The same filtered, deflated scanlines the PNG path builds, handed to PDF
   *  as /Predictor 15 rather than compressed a second time. */
  it("reuses the PNG compression rather than re-encoding", async () => {
    expect(readPdf((await djvuToPdf(ORDER)) as Buffer).predictor).toBe(true);
  });

  it("stays small enough to come back through a serverless response", async () => {
    const pdf = (await djvuToPdf(ORDER)) as Buffer;
    expect(pdf.byteLength).toBeLessThan(500_000);
  });

  /** Half a decision order handed over as though it were the whole one is
   *  worse than none: nobody can tell which condition is missing. */
  it("refuses rather than truncates when it will not fit", async () => {
    expect(await djvuToPdf(ORDER, { maxBytes: 1000 })).toBe("too_large");
  });

  /** A budget the document fits inside changes nothing. */
  it("returns the document when it does fit", async () => {
    expect(await djvuToPdf(ORDER, { maxBytes: 1_000_000 })).toBeInstanceOf(Buffer);
  });

  it("returns nothing for a file that is not DjVu", async () => {
    expect(await djvuToPdf(Buffer.from("not a djvu"))).toBeNull();
  });
});

describe("the PNG encoder", () => {
  it("writes a valid greyscale PNG with the dimensions it was given", () => {
    const width = 3;
    const height = 2;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const png = greyPng({ width, height, data });
    expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(pngSize(png)).toEqual({ width, height });
    // IHDR: 8-bit, colour type 0 (greyscale).
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(0);
    expect(png.subarray(png.length - 8).toString("latin1")).toContain("IEND");
  });
});
