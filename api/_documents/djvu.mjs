/**
 * Reading the council scans that predate PDF.
 *
 * Meath, Kildare and Wicklow digitised their older planning files to DjVu — a
 * 1990s format from AT&T Bell Labs that separates a scanned page into a
 * bitonal text mask and a wavelet-compressed background, and got a colour page
 * down to tens of kilobytes when the PDF of the day was megabytes. It won on
 * size and lost on reach: no browser ever shipped a decoder for it.
 *
 * That left every pre-2020 Meath decision unreadable here. The refusal reasons
 * were on the file, fetched successfully, and thrown away because nothing in
 * the pipeline could turn them into something the model could look at. Asking
 * the council for a rendered image is not an option either — their "JPEG"
 * link is a page of JavaScript that fetches DjVu fragments and assembles the
 * picture in the browser, so there is no image on their server to request.
 *
 * So we decode it ourselves. `djvu-rs` is a pure-Rust DjVu decoder compiled to
 * WebAssembly, vendored here rather than installed: the API function has no
 * npm dependencies by design, and a .wasm sitting beside the code keeps it
 * that way. It is MIT-licensed, which the more obvious choice — djvu.js, the
 * library the councils' own portals link to — is not; that one is GPL v2,
 * because it borrows from DjVuLibre.
 *
 * A page comes out as raw pixels, and the model wants an image, so the pixels
 * go through a PNG encoder built on node:zlib. No dependency there either.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { greyPng } from "./png.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Is this one of the old scans?
 *
 * The iDocs portals label it "image/x.djvu", which is how it passed for an
 * image all the way to a browser that could not draw it.
 */
export function isDjvu(contentType, filename) {
  return /djvu/i.test(String(contentType ?? "")) || /\.djvu$/i.test(String(filename ?? ""));
}

/**
 * 150 dpi, because that is where the model's own limit lands.
 *
 * Images are scaled to fit 1568 pixels on the long edge before they are read,
 * so an A4 page rendered at 150 dpi (1754 px tall) arrives with a pixel or two
 * to spare and anything higher is bytes spent on detail that is discarded.
 */
const DPI = 150;

/**
 * How many pages are worth reading.
 *
 * A decision order runs to two to six pages and a request letter to one or
 * two; a planner's report can run to thirty, and the parts this app quotes —
 * the reasons, the conditions, the schedule — are at the front. Eight is past
 * every decision order seen so far and short of a document that would cost
 * more to read than it is worth.
 */
const MAX_PAGES = 8;

let wasmReady = null;
async function decoder() {
  // The failed promise is cleared rather than kept: a container that hit a
  // transient error while reading the .wasm off disk would otherwise refuse
  // every document for the rest of its life.
  wasmReady ??= (async () => {
    const mod = await import("./djvu/djvu_rs.mjs");
    // The published loader fetches its .wasm by URL, which is meaningless in a
    // serverless function — hand it the bytes off the filesystem instead.
    await mod.default({
      module_or_path: new Uint8Array(fs.readFileSync(path.join(HERE, "djvu", "djvu_rs_bg.wasm"))),
    });
    return mod;
  })().catch((err) => {
    wasmReady = null;
    throw err;
  });
  return wasmReady;
}

/**
 * DjVu bytes in, one PNG per page out. Empty when the file will not decode —
 * the caller must treat that as "could not read", never as "nothing there".
 */
export async function djvuToPngPages(bytes, { dpi = DPI, maxPages = MAX_PAGES } = {}) {
  let doc;
  try {
    const { WasmDocument } = await decoder();
    doc = WasmDocument.from_bytes(new Uint8Array(bytes));
  } catch {
    return [];
  }
  const pages = [];
  try {
    const count = Math.min(doc.page_count(), maxPages);
    for (let i = 0; i < count; i++) {
      const page = doc.page(i);
      try {
        pages.push(
          greyPng({
            width: page.width_at(dpi),
            height: page.height_at(dpi),
            data: page.render(dpi),
          })
        );
      } finally {
        // Rust-side pixel buffers are not the JS heap's to collect.
        page.free?.();
      }
    }
  } catch {
    // Keep whatever decoded — half a decision order is still the half with
    // the reasons on it.
  } finally {
    doc.free?.();
  }
  return pages;
}

/** The same, as base64 image blocks for the model. */
export async function djvuToImageBlocks(bytes, opts) {
  return (await djvuToPngPages(bytes, opts)).map((png) => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
  }));
}
