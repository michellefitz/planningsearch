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

/** First cookie pair from each Set-Cookie header, joined for reuse. */
export function cookieHeaderFromSetCookies(setCookies: string[]): string {
  return setCookies
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

/**
 * If a "document" URL returns an HTML viewer shell, find the actual content it
 * embeds (iframe/embed/object src, meta refresh, or JS redirect).
 */
export function extractFrameSrc(html: string): string | null {
  const frame = html.match(/<(?:iframe|embed)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
  if (frame) return frame[1];
  const object = html.match(/<object\b[^>]*\bdata\s*=\s*["']([^"']+)["']/i);
  if (object) return object[1];
  const refresh = html.match(
    /<meta\b[^>]*http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["'][^"']*url=([^"']+)["']/i
  );
  if (refresh) return refresh[1].trim();
  const jsLoc = html.match(
    /(?:window\.|document\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i
  );
  if (jsLoc) return jsLoc[1];
  const jsReplace = html.match(/location\.replace\(\s*["']([^"']+)["']\s*\)/i);
  if (jsReplace) return jsReplace[1];
  return null;
}

const FETCH_TIMEOUT_MS = 12_000;

const UA_HEADERS = {
  "User-Agent": "PlanView/0.1 (planning register viewer; respectful on-demand fetch)",
  Accept: "text/html",
};

/** Live-fetch and parse a file listing; returns null when unreachable/unparsable. */
export async function fetchScannedFileList(listUrl: string): Promise<ScannedFile[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(listUrl, { signal: controller.signal, headers: UA_HEADERS });
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

export interface FetchedDocument {
  contentType: string;
  disposition: string | null;
  body: Buffer;
}

export interface DiagnosticStep {
  step: string;
  status?: number;
  contentType?: string;
  cookies?: string;
  bodySnippet?: string;
  fileCount?: number;
  targetUrl?: string;
  extractedInner?: string | null;
  error?: string;
}

/**
 * Fetch one document by its position in the listing, doing the whole session
 * dance server-side in a single pass: load the listing (capturing the
 * session cookies it sets), then request that file with those cookies. The
 * council's document URLs are session-bound — handed to a browser without the
 * originating session they serve the wrong document — so each proxied view is
 * fully self-contained.
 *
 * Returns "too_large" when the document exceeds maxBytes (serverless response
 * limits), null on any upstream failure. When a trace array is passed, each
 * step pushes diagnostic info to it.
 */
export async function fetchScannedDocument(
  listUrl: string,
  index: number,
  maxBytes = 4_000_000,
  trace?: DiagnosticStep[]
): Promise<FetchedDocument | "too_large" | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const listRes = await fetch(listUrl, { signal: controller.signal, headers: UA_HEADERS });
    trace?.push({
      step: "fetch_listing",
      status: listRes.status,
      contentType: listRes.headers.get("content-type") ?? undefined,
    });
    if (!listRes.ok) return null;
    const cookies = cookieHeaderFromSetCookies(listRes.headers.getSetCookie?.() ?? []);
    const listHtml = await listRes.text();
    const files = parseFileListHtml(listHtml, listUrl);
    trace?.push({
      step: "parse_listing",
      fileCount: files.length,
      cookies: cookies || "(none)",
      bodySnippet: listHtml.slice(0, 500),
    });
    const target = files[index];
    if (!target) {
      trace?.push({ step: "target_lookup", error: `No file at index ${index} (${files.length} files found)` });
      return null;
    }
    trace?.push({ step: "target_lookup", targetUrl: target.url });

    const docHeaders: Record<string, string> = {
      ...UA_HEADERS,
      Accept: "*/*",
      Referer: listUrl,
    };
    if (cookies) docHeaders.Cookie = cookies;

    let docRes = await fetch(target.url, { signal: controller.signal, headers: docHeaders });
    trace?.push({
      step: "fetch_document",
      status: docRes.status,
      contentType: docRes.headers.get("content-type") ?? undefined,
    });
    if (!docRes.ok) return null;

    let contentType = docRes.headers.get("content-type") ?? "application/octet-stream";
    let currentUrl = target.url;
    for (let hop = 0; hop < 3 && /text\/html/i.test(contentType); hop++) {
      const shellHtml = await docRes.text();
      const inner = extractFrameSrc(shellHtml);
      trace?.push({
        step: `viewer_shell_${hop}`,
        extractedInner: inner,
        bodySnippet: shellHtml.slice(0, 500),
      });
      if (!inner) return null;
      currentUrl = new URL(inner, currentUrl).toString();
      docRes = await fetch(currentUrl, { signal: controller.signal, headers: docHeaders });
      trace?.push({
        step: `fetch_inner_${hop}`,
        status: docRes.status,
        contentType: docRes.headers.get("content-type") ?? undefined,
      });
      if (!docRes.ok) return null;
      contentType = docRes.headers.get("content-type") ?? "application/octet-stream";
    }
    if (/text\/html/i.test(contentType)) return null;

    const declared = Number(docRes.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return "too_large";
    const body = Buffer.from(await docRes.arrayBuffer());
    if (body.byteLength > maxBytes) return "too_large";
    return {
      contentType,
      disposition: docRes.headers.get("content-disposition"),
      body,
    };
  } catch (err) {
    trace?.push({ step: "error", error: String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
