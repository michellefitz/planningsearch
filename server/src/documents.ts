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
    push(url, GENERIC_LABEL_RE.test(label) ? title : fullerCell ?? label ?? title, filename);
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

/* ------------------------------------------------------------------ */
/* Agile Applications (Dublin City, Fingal, South Dublin)             */
/* ------------------------------------------------------------------ */

const AGILE_BASE = "https://planning.agileapplications.ie";

/**
 * Candidate JSON endpoints for resolving a planning reference to Agile's
 * internal application id. The citizen portal is a SPA whose API is not
 * publicly documented; these are tried in order and every attempt is
 * traceable via ?debug=1 so the first live run identifies the real one.
 */
export function agileSearchCandidates(slug: string, reference: string): string[] {
  const q = encodeURIComponent(reference);
  return [
    `${AGILE_BASE}/${slug}/api/application/search?keyword=${q}`,
    `${AGILE_BASE}/api/${slug}/application/search?keyword=${q}`,
    `${AGILE_BASE}/${slug}/api/applications?keyword=${q}`,
    `${AGILE_BASE}/${slug}/api/search/applications?keyword=${q}`,
    `${AGILE_BASE}/api/application/search?council=${slug}&keyword=${q}`,
  ];
}

export function agileDocumentCandidates(slug: string, applicationId: number): string[] {
  return [
    `${AGILE_BASE}/${slug}/api/application/${applicationId}/documents`,
    `${AGILE_BASE}/api/${slug}/application/${applicationId}/documents`,
    `${AGILE_BASE}/${slug}/api/applications/${applicationId}/documents`,
  ];
}

const normalizeRef = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Walk arbitrary JSON from an Agile search response and find the internal id
 * of the object whose reference-like field matches our planning reference.
 */
export function extractAgileApplicationId(json: unknown, reference: string): number | null {
  const want = normalizeRef(reference);
  if (!want) return null;
  let fallback: number | null = null;
  const visit = (node: unknown): number | null => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = visit(item);
        if (hit !== null) return hit;
      }
      return null;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const id =
        typeof obj.id === "number" ? obj.id
        : typeof obj.applicationId === "number" ? obj.applicationId
        : null;
      if (id !== null) {
        const matches = Object.values(obj).some(
          (v) => typeof v === "string" && normalizeRef(v) === want
        );
        if (matches) return id;
        if (fallback === null) fallback = id;
      }
      for (const v of Object.values(obj)) {
        const hit = visit(v);
        if (hit !== null) return hit;
      }
    }
    return null;
  };
  const exact = visit(json);
  if (exact !== null) return exact;
  // Single-result responses often omit/abbreviate the reference field; if the
  // response contained exactly one candidate id, trust it.
  return fallback;
}

const AGILE_JSON_HEADERS = {
  "User-Agent": "PlanView/0.1 (planning register viewer; respectful on-demand fetch)",
  Accept: "application/json",
};

async function tryAgileJson(
  url: string,
  trace?: DiagnosticStep[]
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: AGILE_JSON_HEADERS });
    const ct = res.headers.get("content-type") ?? "";
    const step: DiagnosticStep = { step: "agile_api", url, status: res.status, contentType: ct };
    if (!res.ok || !/json/i.test(ct)) {
      if (/text\/html/i.test(ct)) step.bodySnippet = (await res.text()).slice(0, 300);
      trace?.push(step);
      return null;
    }
    const body = await res.json();
    step.bodySnippet = JSON.stringify(body).slice(0, 400);
    trace?.push(step);
    return body;
  } catch (err) {
    trace?.push({ step: "agile_api", url, error: String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the Agile citizen-portal application-details URL for a reference.
 * Returns null when no candidate endpoint yields an id (caller falls back to
 * the portal search page).
 */
export async function resolveAgileApplicationUrl(
  slug: string,
  reference: string,
  trace?: DiagnosticStep[]
): Promise<string | null> {
  for (const url of agileSearchCandidates(slug, reference)) {
    const json = await tryAgileJson(url, trace);
    if (json === null) continue;
    const id = extractAgileApplicationId(json, reference);
    trace?.push({ step: "agile_resolve", url, resolvedId: id });
    if (id !== null) return `${AGILE_BASE}/${slug}/application-details/${id}`;
  }
  return null;
}

/** Normalise an Agile documents-endpoint response into ScannedFile entries. */
export function parseAgileDocuments(json: unknown, slug: string): ScannedFile[] {
  const out: ScannedFile[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const urlish = [obj.url, obj.downloadUrl, obj.link, obj.href, obj.documentUrl].find(
      (v): v is string => typeof v === "string" && /^(https?:)?\//.test(v)
    );
    const name = [obj.name, obj.title, obj.description, obj.fileName, obj.documentType].find(
      (v): v is string => typeof v === "string" && v.trim().length > 0
    );
    const docId = typeof obj.id === "number" ? obj.id : null;
    if (urlish) {
      out.push({
        title: name ?? "Document",
        url: new URL(urlish, `${AGILE_BASE}/${slug}/`).toString(),
      });
    } else if (name && docId !== null) {
      // No direct URL in the payload: the portal's document download route.
      out.push({
        title: name,
        url: `${AGILE_BASE}/${slug}/api/document/${docId}/download`,
      });
    }
    Object.values(obj).forEach(visit);
  };
  visit(json);
  const seen = new Set<string>();
  return out.filter((f) => (seen.has(f.url) ? false : (seen.add(f.url), true)));
}

/** List an Agile application's documents; null when nothing resolvable. */
export async function fetchAgileFileList(
  slug: string,
  reference: string,
  trace?: DiagnosticStep[]
): Promise<{ files: ScannedFile[]; applicationUrl: string } | null> {
  for (const searchUrl of agileSearchCandidates(slug, reference)) {
    const json = await tryAgileJson(searchUrl, trace);
    if (json === null) continue;
    const id = extractAgileApplicationId(json, reference);
    if (id === null) continue;
    for (const docsUrl of agileDocumentCandidates(slug, id)) {
      const docsJson = await tryAgileJson(docsUrl, trace);
      if (docsJson === null) continue;
      const files = parseAgileDocuments(docsJson, slug);
      trace?.push({ step: "agile_documents", url: docsUrl, fileCount: files.length });
      if (files.length > 0) {
        return { files, applicationUrl: `${AGILE_BASE}/${slug}/application-details/${id}` };
      }
    }
    // Id resolved but no docs endpoint worked — still useful for the portal link.
    return { files: [], applicationUrl: `${AGILE_BASE}/${slug}/application-details/${id}` };
  }
  return null;
}
