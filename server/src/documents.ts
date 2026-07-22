/**
 * Document access helpers (PRD §7.3) — the deep-link tier plus on-demand
 * file-list fetching where a council's URL scheme makes it derivable.
 *
 * Kildare (eplanning.ie): the application id in
 *   https://www.eplanning.ie/KildareCC/AppFileRefDetails/{id}/0
 * is the same id used by the council's iDocs scanned-file listing:
 *   https://idocsweb.kildarecoco.ie/iDocsWebDPSS/listFiles.aspx?catalog=planning&id={id}
 *
 * South Dublin: the agile portal loads documents from the council's own DMS,
 * a plain HTML page addressable by planning reference:
 *   https://planning.southdublin.ie/Home/Documents?regref={reference}
 * (Its ViewDocument links are not session-bound — direct PDFs.)
 *
 * Fetching happens only on user request (no caching, no bulk mirroring) —
 * anything heavier is Phase 0/2 territory per the PRD.
 */

export function deriveScannedFilesUrl(
  authorityId: string,
  sourceUrl: string | null | undefined,
  reference?: string | null
): string | null {
  if (authorityId === "south-dublin" && reference) {
    return `https://planning.southdublin.ie/Home/Documents?regref=${encodeURIComponent(reference)}`;
  }
  if (authorityId === "dublin-city" && reference) {
    // DCC's PublicAccess document server, addressable by planning reference.
    // The council's own links keep the slash in the reference unencoded.
    const ref = encodeURIComponent(reference).replace(/%2F/gi, "/");
    return `https://webapps.dublincity.ie/PublicAccess_Live/SearchResult/RunThirdPartySearch?FileSystemId=PL&Folder1_Ref=${ref}`;
  }
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
/** A DD/MM/YYYY (or -/.- separated) date as councils display it. */
const DATE_RE = /\b(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})\b/;

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

/** PublicAccess embeds Date_Received as US-format "MM/DD/YYYY hh:mm:ss". */
function publicAccessDate(v: unknown): string | null {
  const m = String(v ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

export function parsePublicAccessModel(html: string, baseUrl: string): ScannedFile[] {
  // The model JSON is emitted on a single line; lazy up to the first `};` at
  // end-of-line, with a greedy retry in case a string value contains one.
  const candidates = [
    html.match(/var\s+model\s*=\s*(\{.*?\})\s*;?\s*$/m)?.[1],
    html.match(/var\s+model\s*=\s*(\{.*\})\s*;?\s*$/m)?.[1],
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const model = JSON.parse(raw) as { Rows?: Array<Record<string, unknown>> };
      if (!Array.isArray(model.Rows)) continue;
      const base = new URL(baseUrl);
      const appRoot = base.pathname.split("/")[1];
      return model.Rows.filter((r) => r.Guid).map((r) => {
        const docType = String(r.Doc_Type ?? "").trim() || "Document";
        const date = publicAccessDate(r.Date_Received);
        return {
          title: date ? `${docType} — ${date}` : docType,
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

  // Pass 0: NEC PublicAccess (Dublin City) serves the list with no anchors at
  // all — the rows are embedded as `var model = {...}` JSON and drawn
  // client-side. Its Guids resolve as direct GETs on /Document/ViewDocument.
  const modelFiles = parsePublicAccessModel(html, baseUrl);
  if (modelFiles.length) return modelFiles;

  // Pass 1: table rows — extract Document Type and Comment cells (columns 0–1)
  // from the council's GridView, ignoring # Files, Size, JPEG columns.
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(html)) !== null) {
    const rowHtml = row[1];
    const anchors = [...rowHtml.matchAll(ANCHOR_RE)]
      .map((a) => ({ url: resolveDocHref(a[1], baseUrl), label: stripTags(a[2]) }))
      .filter((a): a is { url: string; label: string } => a.url !== null);
    if (anchors.length !== 1) continue;
    const { url, label } = anchors[0];
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
    // Append a document date from the row if one is present and not already
    // shown (Dublin City / South Dublin listings carry a received date).
    const dateInRow = cells.map((c) => c.match(DATE_RE)?.[1]).find(Boolean);
    if (dateInRow && !displayTitle.includes(dateInRow)) {
      displayTitle = `${displayTitle} — ${dateInRow}`;
    }
    push(url, displayTitle, filename);
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
  // JS-driven shells: window.location / location.href / location.replace(...)
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

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

/** Third-party submissions/observations show up in council file listings as
 *  document types like "Third Party Submission" or "Submission/ Objection". */
export const OBJECTION_TITLE_RE = /submiss|observ|object/i;

export function countObjectionFiles(files: ScannedFile[]): number {
  return files.filter((f) => OBJECTION_TITLE_RE.test(f.title)).length;
}

export interface EplanningParties {
  applicant: string | null;
  agent: string | null;
}

/**
 * The national dataset redacts applicant names and has no agent field at
 * all, but eplanning.ie detail pages publish both: the applicant under the
 * Applicant tab, the agent (usually the architect, name + practice) in a
 * hidden "Agent Details" popup div.
 */
export function parseEplanningParties(html: string): EplanningParties {
  const applicantM = html.match(/Applicant name:\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  const applicant = applicantM ? decodeEntities(stripTags(applicantM[1])) || null : null;

  let agent: string | null = null;
  const agentsBlock = html.match(/id="DivAgents"([\s\S]*?)<\/table>/i);
  if (agentsBlock) {
    const nameM = agentsBlock[1].match(/Name\s*:\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    // First address line is typically the practice name.
    const firmM = agentsBlock[1].match(/Address\s*:\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    const name = nameM ? decodeEntities(stripTags(nameM[1])) : "";
    const firm = firmM ? decodeEntities(stripTags(firmM[1])) : "";
    agent = [name, firm].filter(Boolean).join(", ") || null;
  }
  return { applicant, agent };
}

export interface EplanningRelated {
  /** The reference text shown in the related link. */
  reference: string;
  /** The other application's eplanning internal id (from its AppFileRefDetails
   *  link) — the reliable join key back to our records via their source_url. */
  eplanningId: string;
}

/**
 * Parse the eplanning detail page's "Related Applications" section. Kildare
 * addresses are often townlands, so matching applications by address is wrong;
 * eplanning instead publishes the genuinely-related file references here.
 *
 * Deliberately conservative: it anchors on the "Related Applications" label,
 * takes a window from there, and extracts only links to other AppFileRefDetails
 * pages. If the label isn't found the result is empty — never a wrong guess.
 */
export function parseEplanningRelated(html: string, selfId?: string | null): EplanningRelated[] {
  const label = html.search(/related\s+applications?/i);
  if (label < 0) return [];
  const region = html.slice(label, label + 8000);
  const out: EplanningRelated[] = [];
  const seen = new Set<string>();
  const re = /href="[^"]*AppFileRefDetails\/(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region))) {
    const eplanningId = m[1];
    const reference = decodeEntities(stripTags(m[2])).trim();
    // Require a reference-looking token, dedupe, and drop the self link.
    if (!reference || !/\d/.test(reference)) continue;
    if (eplanningId === selfId || seen.has(eplanningId)) continue;
    seen.add(eplanningId);
    out.push({ reference, eplanningId });
  }
  return out;
}

/** On-demand fetch of the "Related Applications" from an eplanning detail page. */
export async function fetchEplanningRelated(sourceUrl: string): Promise<EplanningRelated[]> {
  if (!/eplanning\.ie\/.+AppFileRefDetails/i.test(sourceUrl)) return [];
  const selfId = sourceUrl.match(/AppFileRefDetails\/(\d+)/i)?.[1] ?? null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(sourceUrl, { signal: controller.signal, headers: UA_HEADERS });
    if (!res.ok) return [];
    return parseEplanningRelated(await res.text(), selfId);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** On-demand fetch of both parties from an eplanning detail page. */
export async function fetchEplanningParties(sourceUrl: string): Promise<EplanningParties> {
  const none: EplanningParties = { applicant: null, agent: null };
  if (!/eplanning\.ie\/.+AppFileRefDetails/i.test(sourceUrl)) return none;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(sourceUrl, { signal: controller.signal, headers: UA_HEADERS });
    if (!res.ok) return none;
    return parseEplanningParties(await res.text());
  } catch {
    return none;
  } finally {
    clearTimeout(timer);
  }
}

/** Live-fetch and parse a file listing; returns null when unreachable/unparsable. */
export async function fetchScannedFileList(
  listUrl: string,
  trace?: DiagnosticStep[]
): Promise<ScannedFile[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(listUrl, { signal: controller.signal, headers: UA_HEADERS });
    const html = res.ok ? await res.text() : "";
    const files = res.ok ? parseFileListHtml(html, listUrl) : [];
    if (trace) {
      // Sample the raw anchors so a mismatch between the page and the parser
      // is visible from a ?debug=1 response.
      const hrefs = [...html.matchAll(ANCHOR_RE)].slice(0, 12).map((a) => a[1]);
      trace.push({
        step: "fetch_list",
        url: res.url || listUrl,
        status: res.status,
        contentType: res.headers.get("content-type") ?? undefined,
        fileCount: files.length,
        bodySnippet: `[${html.length} bytes] anchors=${JSON.stringify(hrefs)} :: ${html.slice(0, 1800)}`,
      });
    }
    if (!res.ok) return null;
    return files.length > 0 ? files : null;
  } catch (err) {
    trace?.push({ step: "fetch_list", url: listUrl, error: String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchedDocument {
  contentType: string;
  /** Best filename for the download/tab title, if known. */
  filename: string | null;
  body: Buffer;
}

const EXT_CONTENT_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
};

/**
 * Decide how the proxy should present a document. Councils frequently send a
 * generic octet-stream type and/or Content-Disposition: attachment, which
 * forces a download; for PDFs and images we normalise the type and switch to
 * inline so they open in a browser tab. Types the browser can't render (e.g.
 * .docx) stay as an attachment.
 */
export function presentDocument(
  rawType: string | null | undefined,
  filename: string | null | undefined
): { contentType: string; disposition: "inline" | "attachment" } {
  const ext = filename?.toLowerCase().match(/\.([a-z0-9]+)(?:$|[?#])/)?.[1];
  let contentType = (rawType ?? "").split(";")[0].trim();
  if (!contentType || /octet-stream/i.test(contentType)) {
    contentType = (ext && EXT_CONTENT_TYPE[ext]) || contentType || "application/octet-stream";
  }
  const inlineable = /^application\/pdf$/i.test(contentType) || /^image\//i.test(contentType);
  return { contentType, disposition: inlineable ? "inline" : "attachment" };
}

/** Filename from a Content-Disposition header, if present. */
export function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = disposition.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].replace(/^["']|["']$/g, "").trim());
    } catch {
      /* fall through */
    }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

/** Strip characters that can't appear in a Content-Disposition filename. */
export function safeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, "").replace(/[/]/g, "-").trim().slice(0, 150);
}

export interface DiagnosticStep {
  step: string;
  url?: string;
  status?: number;
  contentType?: string;
  cookies?: string;
  bodySnippet?: string;
  fileCount?: number;
  targetUrl?: string;
  extractedInner?: string | null;
  resolvedId?: number | null;
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
      filename:
        filenameFromDisposition(docRes.headers.get("content-disposition")) ??
        (decodeURIComponent(new URL(currentUrl).pathname.split("/").pop() ?? "") || target.title),
      body,
    };
  } catch (err) {
    trace?.push({ step: "error", error: String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
