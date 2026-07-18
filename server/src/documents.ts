/**
 * Document access helpers (PRD §7.3) — the deep-link tier plus on-demand
 * file-list fetching where a council's URL scheme makes it derivable.
 *
 * Kildare (eplanning.ie): the application id in
 *   https://www.eplanning.ie/KildareCC/AppFileRefDetails/{id}/0
 * is the same id used by the council's iDocs scanned-file listing:
 *   https://idocsweb.kildarecoco.ie/iDocsWebDPSS/listFiles.aspx?catalog=planning&id={id}
 *
 * Fetching happens only on user request (no caching, no bulk mirroring) —
 * anything heavier is Phase 0/2 territory per the PRD.
 */

export function deriveScannedFilesUrl(
  authorityId: string,
  sourceUrl: string | null | undefined
): string | null {
  if (!sourceUrl) return null;
  if (authorityId === "kildare") {
    const m = sourceUrl.match(/AppFileRefDetails\/(\d+)/i);
    if (m) {
      return `https://idocsweb.kildarecoco.ie/iDocsWebDPSS/listFiles.aspx?catalog=planning&id=${m[1]}`;
    }
  }
  return null;
}

export interface ScannedFile {
  title: string;
  url: string;
}

const ANCHOR_RE = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const DOC_HREF_RE =
  /\.(pdf|tiff?|jpe?g|png|doc|docx)([?#]|$)|getfile|getdocument|viewdocument|download|openfile|docid=|fileid=/i;
/** Anchor text that names the action, not the document ("View", "Open", …). */
const GENERIC_LABEL_RE = /^(view|open|download|show|file|document|link)?$/i;

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function resolveDocHref(href: string, baseUrl: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.toLowerCase().startsWith("javascript:")) return null;
  if (!DOC_HREF_RE.test(trimmed)) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Tolerant parser for a council file-listing HTML page: collects anchors that
 * look like document links and resolves them against the page URL. Built
 * defensively (the markup is not under our control) — an empty result means
 * "fall back to the deep link", never a hard failure.
 *
 * Listing pages (e.g. Kildare's iDocs GridView) typically label every link
 * "View" and keep the document name in sibling cells of the same table row,
 * so when a row contains exactly one document link, the row's remaining text
 * becomes the title.
 */
export function parseFileListHtml(html: string, baseUrl: string): ScannedFile[] {
  const files: ScannedFile[] = [];
  const seen = new Set<string>();

  const push = (url: string, title: string, fallback: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    files.push({ title: title || fallback, url });
  };

  // Pass 1: table rows — use the row text (minus the anchor's own label) as
  // the title when the anchor text is generic.
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(html)) !== null) {
    const rowHtml = row[1];
    const anchors = [...rowHtml.matchAll(ANCHOR_RE)]
      .map((a) => ({ url: resolveDocHref(a[1], baseUrl), label: stripTags(a[2]) }))
      .filter((a): a is { url: string; label: string } => a.url !== null);
    if (anchors.length !== 1) continue;
    const { url, label } = anchors[0];
    const rowText = stripTags(rowHtml.replace(ANCHOR_RE, " "));
    const filename = decodeURIComponent(url.split("/").pop() ?? "Document");
    const title = GENERIC_LABEL_RE.test(label) ? rowText : label || rowText;
    push(url, title, filename);
  }

  // Pass 2: any document anchors not inside a single-link row (non-table
  // layouts, multi-link rows) keep their own text.
  let m: RegExpExecArray | null;
  while ((m = ANCHOR_RE.exec(html)) !== null) {
    const url = resolveDocHref(m[1], baseUrl);
    if (!url) continue;
    const label = stripTags(m[2]);
    push(url, label, decodeURIComponent(url.split("/").pop() ?? "Document"));
  }
  return files;
}

const FETCH_TIMEOUT_MS = 12_000;

/** Live-fetch and parse a file listing; returns null when unreachable/unparsable. */
export async function fetchScannedFileList(listUrl: string): Promise<ScannedFile[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(listUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "PlanView/0.1 (planning register viewer; respectful on-demand fetch)",
        Accept: "text/html",
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const files = parseFileListHtml(html, listUrl);
    return files.length > 0 ? files : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
