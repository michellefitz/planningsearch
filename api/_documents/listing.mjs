/**
 * Reading a council's document listing — a tolerant anchor-scrape that returns
 * [] when there is nothing to read, so the sheet falls back to a deep link.
 *
 * Four different systems are behind this one function: NEC PublicAccess
 * (Dublin City) draws its rows from embedded JSON, South Dublin's portal and
 * the three iDocs councils (Kildare, Meath, Wicklow) publish HTML tables, and
 * the tables are not the same table twice.
 */

/** Entities out of cell text — see stripTags below for why it matters. */
export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

export const ANCHOR_RE = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const DOC_HREF_RE =
  /\.(pdf|tiff?|jpe?g|png|doc|docx)([?#]|$)|getfile|getdocument|viewdocument|download|openfile|docid=|fileid=/i;
const GENERIC_LABEL_RE = /^(view|open|download|show|file|document|link)?$/i;
/**
 * A link to a viewer, not to a document.
 *
 * `ViewFiles.aspx?...&format=jpeg` on the iDocs portals looks like an
 * alternative rendering and is not one: it opens a page of JavaScript that
 * fetches 256-pixel tiles from the councils' DjVu server. There is no image
 * at the end of it to fetch, so the link can only ever fail.
 */
const VIEWER_ONLY_HREF_RE = /[?&]format=jpe?g\b/i;
const DATE_RE = /\b(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})\b/;
/**
 * The size the listing publishes for a document — "414 Kb", "19 Mb".
 *
 * Worth reading because a serverless response is capped at four megabytes and
 * planning files routinely exceed it: one Kildare photo montage is 19 Mb. The
 * size is on the page before anything is fetched, so a document that cannot
 * come through can say so instead of failing on the click.
 */
const SIZE_CELL_RE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i;
const SIZE_UNIT = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

function cellSize(cell) {
  const m = SIZE_CELL_RE.exec(cell.trim());
  if (!m) return null;
  const bytes = Math.round(Number(m[1]) * SIZE_UNIT[m[2].toLowerCase()]);
  // "0 Kb" is what these listings print for a document with nothing behind it
  // yet, which is a fact about the file rather than a size.
  return bytes > 0 ? bytes : null;
}

/**
 * Cell text from a council listing: tags out, entities decoded, whitespace
 * collapsed. Mirrors stripTags() in server/src/documents.ts.
 *
 * The decode is what stops an empty iDocs cell reading as content. Kildare
 * writes an unused comment column as `<td>&nbsp;</td>`, which stripping alone
 * left as the literal string "&nbsp;" — truthy, so every document with no
 * comment came out as "Application Form - Part A — &nbsp;". Decoding turns it
 * into a space that the collapse then removes, and the empty cell is falsy
 * again. It also fixes titles like "Plans &amp; Particulars" along the way.
 *
 * Tags are stripped before decoding, so "&lt;b&gt;" becomes the text "<b>"
 * rather than markup — and it is rendered as text, never as HTML.
 */
export const stripTags = (h) =>
  decodeEntities(h.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

function resolveDocHref(href, baseUrl) {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.toLowerCase().startsWith("javascript:")) return null;
  if (!DOC_HREF_RE.test(trimmed)) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

// PublicAccess embeds Date_Received as US-format "MM/DD/YYYY hh:mm:ss".
function publicAccessDate(v) {
  const m = String(v ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

function parsePublicAccessModel(html, baseUrl) {
  const candidates = [
    html.match(/var\s+model\s*=\s*(\{.*?\})\s*;?\s*$/m)?.[1],
    html.match(/var\s+model\s*=\s*(\{.*\})\s*;?\s*$/m)?.[1],
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const model = JSON.parse(raw);
      if (!Array.isArray(model.Rows)) continue;
      const base = new URL(baseUrl);
      const appRoot = base.pathname.split("/")[1];
      return model.Rows.filter((r) => r.Guid).map((r) => {
        const docType = String(r.Doc_Type ?? "").trim() || "Document";
        const ref2 = String(r.Doc_Ref2 ?? "").trim();
        const qualifier = ref2 && ref2.toLowerCase() !== docType.toLowerCase() ? ref2 : "";
        const label = qualifier ? `${docType} — ${qualifier}` : docType;
        const date = publicAccessDate(r.Date_Received);
        return {
          title: date ? `${date} — ${label}` : label,
          url: `${base.origin}/${appRoot}/Document/ViewDocument?id=${r.Guid}`,
        };
      });
    } catch {
      // fall through to the next candidate / anchor-based passes
    }
  }
  return [];
}

/**
 * Listing pages like Kildare's iDocs GridView label every link "View" and keep
 * the document name in sibling cells of the same table row, so the row's
 * remaining text is what names the document.
 */
export function parseFileListHtml(html, baseUrl) {
  const files = [];
  const seen = new Set();
  const push = (url, title, fallback, size) => {
    if (seen.has(url)) return;
    seen.add(url);
    files.push({ title: title || fallback, url, ...(size ? { size } : {}) });
  };

  // NEC PublicAccess (Dublin City) serves the list with no anchors at all —
  // the rows are embedded as `var model = {...}` JSON and drawn client-side.
  const modelFiles = parsePublicAccessModel(html, baseUrl);
  if (modelFiles.length) return modelFiles;

  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let row;
  while ((row = rowRe.exec(html)) !== null) {
    const rowHtml = row[1];
    const anchors = [...rowHtml.matchAll(ANCHOR_RE)]
      .map((a) => ({ url: resolveDocHref(a[1], baseUrl), label: stripTags(a[2]) }))
      .filter((a) => a.url !== null);
    // The iDocs councils offer the same document twice: a "View" link that
    // serves the file and a "JPEG" link that opens a JavaScript tile viewer
    // and never yields one. Older Meath applications carry both columns,
    // newer ones only "View" — so every row on an older listing had two
    // anchors, was skipped here, and fell through to the anchor sweep below,
    // which knows nothing but the link text. That is where "JPEG", "View" and
    // a doubled file list came from, and why half the links 502'd.
    const usable = anchors.filter((a) => !VIEWER_ONLY_HREF_RE.test(a.url));
    // Still one document per row: a row holding two *different* documents is
    // not something this can name correctly, and is left to the sweep.
    if (usable.length !== 1) continue;
    const { url, label } = usable[0];
    const cells = [...rowHtml.matchAll(cellRe)].map((c) => stripTags(c[1]));
    const docType = cells[0] ?? "";
    const comment = cells[1] ?? "";
    const title = comment && comment !== docType
      ? `${docType} — ${comment}`
      : docType;
    const filename = decodeURIComponent(url.split("/").pop() ?? "Document");
    // Some listings (South Dublin) put extra detail after the link text in
    // the same cell — prefer the fuller cell over the bare anchor label.
    const fullerCell = cells.find(
      (c) => c.length > label.length && c.toLowerCase().includes(label.toLowerCase())
    );
    let displayTitle = GENERIC_LABEL_RE.test(label) ? title : fullerCell ?? label ?? title;
    const dateInRow = cells.map((c) => c.match(DATE_RE)?.[1]).find(Boolean);
    if (dateInRow && !displayTitle.includes(dateInRow)) displayTitle = `${displayTitle} — ${dateInRow}`;
    // Only the size travels with a row now. A JPEG sibling used to be recorded
    // too, as the listings' own way of saying "this one is DjVu" — but those
    // are decoded and served as PDFs, so knowing it in advance changes
    // nothing about where the link goes.
    push(url, displayTitle, filename, cells.map(cellSize).find(Boolean) ?? null);
  }

  // Last resort, for a listing with no table to read. It used to run always,
  // topping up a perfectly good table with every other document-shaped link on
  // the page — which on every iDocs listing meant the DjVu viewer vendor's
  // "downloads" page, filed as though it were a drawing.
  if (files.length === 0) {
    ANCHOR_RE.lastIndex = 0;
    let m;
    while ((m = ANCHOR_RE.exec(html)) !== null) {
      const url = resolveDocHref(m[1], baseUrl);
      if (!url) continue;
      push(url, stripTags(m[2]), decodeURIComponent(url.split("/").pop() ?? "Document"));
    }
  }
  return files;
}

/**
 * The separator the decision summariser used to join two document titles.
 *
 * It reads `A" and "B` because the string was dropped straight into a sentence
 * already in quotes. Kept here rather than inlined, because a cached answer
 * from before the indexes travelled has to be split back apart on exactly the
 * same string it was joined with.
 */
export const TITLE_JOIN = '" and "';

/**
 * Where each named document sits in the council's file list.
 *
 * The summaries were cached before the sheet could link to their source, so
 * every application anyone has already looked at holds titles and no indexes.
 * Matching the titles back against the listing costs one HTTP call and no
 * model call, and a title the listing no longer carries simply drops out —
 * better an unlinked name than a link to the wrong document.
 */
export function matchDocumentIndexes(files, joinedTitle) {
  if (!joinedTitle) return [];
  return String(joinedTitle)
    .split(TITLE_JOIN)
    .map((title) => ({ title, index: (files ?? []).findIndex((f) => f?.title === title) }))
    .filter((d) => d.index >= 0);
}
