import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { djvuToImageBlocks, djvuToPngPages, isDjvu } from "../../api/_documents/djvu.mjs";
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
