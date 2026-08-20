/**
 * An Coimisiún Pleanála (formerly An Bord Pleanála) appeal-case deep links.
 *
 * The national planning dataset carries an appeal reference (AppealRefNumber)
 * in several historical forms — ABP-319506-23, ACP-301000-21, PL29N.301702,
 * TR17.310928, or a bare 319506. In every one the operative case number is the
 * six-digit group, which is what ACP's public case search keys on; the case
 * file (pending or decided) lives at a stable per-case URL. Wiring that link
 * closes the loop from a council decision to the national appeal outcome.
 */
export const ACP_CASE_BASE = "https://www.pleanala.ie/en-ie/case";

/**
 * Pull the six-digit ACP/ABP case number out of any appeal-reference form.
 * Returns null for references with no six-digit group (some pre-2015 legacy
 * refs), which simply get no deep link rather than a broken one.
 */
export function abpCaseNumber(reference: string | null | undefined): string | null {
  if (!reference) return null;
  const m = reference.match(/\d{6}/);
  return m ? m[0] : null;
}

/** Deep link to the An Coimisiún Pleanála case file, or null if unparseable. */
export function abpCaseUrl(reference: string | null | undefined): string | null {
  const num = abpCaseNumber(reference);
  return num ? `${ACP_CASE_BASE}/${num}` : null;
}

export interface AppealCaseField {
  label: string;
  value: string;
}

export interface AppealCaseDoc {
  title: string;
  url: string;
}

export interface AppealCaseDetails {
  /** Labelled facts scraped from the case page (status, decision, parties…). */
  fields: AppealCaseField[];
  /** Links to case documentation (inspector's report, board direction, PDFs). */
  documents: AppealCaseDoc[];
}

interface AbpDiagnosticStep {
  step: string;
  url?: string;
  status?: number;
  contentType?: string;
  bodySnippet?: string;
  error?: string;
}

const stripTags = (h: string): string =>
  h
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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

const clean = (h: string): string => decodeEntities(stripTags(h));

// Labels longer than this are almost certainly a paragraph mis-read as a label;
// values are allowed to run long (the development description is the outlier).
const MAX_LABEL_LEN = 60;
const MAX_VALUE_LEN = 1200;

function pushPair(
  out: AppealCaseField[],
  seen: Set<string>,
  rawLabel: string,
  rawValue: string
): void {
  const label = clean(rawLabel).replace(/[:\s]+$/, "");
  const value = clean(rawValue);
  if (!label || !value) return;
  if (label.length > MAX_LABEL_LEN || value.length > MAX_VALUE_LEN) return;
  if (label.toLowerCase() === value.toLowerCase()) return;
  const key = label.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ label, value });
}

const DL_RE = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
const ROW_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL_RE = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
// Labelled containers, e.g. <span class="field-label">Decision</span>
// <span class="field-value">Grant</span> — common in CMS-rendered detail cards.
const LABELLED_RE =
  /<(\w+)[^>]*class="[^"]*\b(?:label|term|key|field-name)\b[^"]*"[^>]*>([\s\S]*?)<\/\1>\s*<(\w+)[^>]*class="[^"]*\b(?:value|desc|detail|field-value)\b[^"]*"[^>]*>([\s\S]*?)<\/\3>/gi;

/**
 * Extract every label/value pair the case page exposes, across the three
 * structures An Coimisiún Pleanála's pages have used (definition lists, two-
 * column tables, and labelled CMS cards). Parsing generically rather than
 * hunting for known labels keeps this resilient to the site's wording and
 * markup changing — whatever facts the page shows, we surface.
 */
/**
 * The Commission's own summary block.
 *
 * Its case pages lay each field out as a Foundation grid row — a `case-sub`
 * paragraph in one cell and a `case-summary` paragraph in the next — so the
 * label and value are cousins rather than siblings and none of the generic
 * patterns above see them. Nothing did, which is how a case whose page reads
 * "Decision: Grant Permissions with Conditions" came back with no fields at
 * all, and a summary written from the inspector's report went unchallenged
 * when it said the refusal stood.
 *
 * The gap between the two is bounded so a label cannot pair with a value from
 * the row below it.
 */
const CASE_FIELD_RE =
  /<p[^>]*class="[^"]*\bcase-sub\b[^"]*"[^>]*>([\s\S]*?)<\/p>[\s\S]{0,400}?<p[^>]*class="[^"]*\bcase-summary\b[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;

export function parseAppealCaseFields(html: string): AppealCaseField[] {
  const out: AppealCaseField[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(DL_RE)) pushPair(out, seen, m[1], m[2]);
  for (const m of html.matchAll(CASE_FIELD_RE)) pushPair(out, seen, m[1], m[2]);
  for (const m of html.matchAll(LABELLED_RE)) pushPair(out, seen, m[2], m[4]);
  for (const rowMatch of html.matchAll(ROW_RE)) {
    const cells = [...rowMatch[1].matchAll(CELL_RE)].map((c) => c[2]);
    if (cells.length === 2) pushPair(out, seen, cells[0], cells[1]);
  }
  return out;
}

const ANCHOR_RE = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const CASE_DOC_HREF_RE = /\.(pdf|docx?|tiff?)([?#]|$)|case\s*documentation|\/document|getfile/i;
// Trailing "(… .PDF format 285KB)" / "(report.pdf)" clutter the anchor text.
const DOC_META_PAREN_RE = /\s*\([^)]*(?:\.pdf|format|\d\s*[kmg]b)[^)]*\)\s*$/i;

/** Strip file-format/size clutter the case site appends to document labels. */
export function cleanDocTitle(raw: string): string {
  const t = raw.replace(DOC_META_PAREN_RE, "").trim();
  return t || raw.trim();
}

/** Links to case documentation (inspector's report, board direction, PDFs). */
export function parseAppealCaseDocuments(html: string, baseUrl: string): AppealCaseDoc[] {
  const out: AppealCaseDoc[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(ANCHOR_RE)) {
    const href = decodeEntities(m[1]).trim();
    if (!CASE_DOC_HREF_RE.test(href)) continue;
    let url: string;
    try {
      url = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const text = clean(m[2]);
    const title = text
      ? cleanDocTitle(text)
      : decodeURIComponent(url.split("/").pop() ?? "Document");
    out.push({ title, url });
  }
  return out;
}

export function parseAppealCase(html: string, baseUrl: string): AppealCaseDetails {
  return {
    fields: parseAppealCaseFields(html),
    documents: parseAppealCaseDocuments(html, baseUrl),
  };
}

// A mainstream browser UA gives the best chance of clearing the case site's
// bot protection; the fetch degrades gracefully (returns null) if blocked.
const ABP_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-IE,en;q=0.9",
};

// Documents whose title names the decision reasoning are the most useful to
// summarise; everything else (application forms, observations) is secondary.
const DECISION_DOC_RE = /board\s*(order|direction)|inspector|decision|determination/i;
const PDF_URL_RE = /\.pdf($|[?#])/i;

/** Pick the case document most worth summarising — a decision/board document
 *  if present, else the first PDF. Non-PDFs are skipped (can't be fed to the
 *  model as a document block). */
export function pickAppealDocument(documents: AppealCaseDoc[]): AppealCaseDoc | null {
  const pdfs = documents.filter((d) => PDF_URL_RE.test(d.url));
  if (!pdfs.length) return null;
  return pdfs.find((d) => DECISION_DOC_RE.test(d.title)) ?? pdfs[0];
}

/** Fetch a case document and return it base64-encoded, or null if it is not a
 *  PDF, is too large, or is unreachable. Never throws. */
export async function fetchAppealDocumentBase64(
  url: string,
  maxBytes = 12_000_000,
  trace?: AbpDiagnosticStep[]
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: ABP_FETCH_HEADERS });
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      trace?.push({ step: "abp_doc_fetch", url, status: res.status, contentType, error: "non-200" });
      return null;
    }
    if (!/pdf/i.test(contentType) && !PDF_URL_RE.test(url)) {
      trace?.push({ step: "abp_doc_fetch", url, status: res.status, contentType, error: "not-pdf" });
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      trace?.push({ step: "abp_doc_fetch", url, status: res.status, contentType, error: `too-large ${buf.length}` });
      return null;
    }
    trace?.push({ step: "abp_doc_fetch", url, status: res.status, contentType, bodySnippet: `${buf.length} bytes` });
    return buf.toString("base64");
  } catch (err) {
    trace?.push({ step: "abp_doc_fetch", url, error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse an An Coimisiún Pleanála case page on demand. Returns null
 * (never throws) if the page is unreachable or blocked, so the caller can fall
 * back to the summary fields it already holds plus the case-file link.
 */
export async function fetchAppealCase(
  caseUrl: string,
  trace?: AbpDiagnosticStep[]
): Promise<AppealCaseDetails | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(caseUrl, { signal: controller.signal, headers: ABP_FETCH_HEADERS });
    const contentType = res.headers.get("content-type") ?? undefined;
    if (!res.ok) {
      trace?.push({ step: "abp_fetch", url: caseUrl, status: res.status, contentType, error: "non-200" });
      return null;
    }
    const html = await res.text();
    const details = parseAppealCase(html, caseUrl);
    trace?.push({
      step: "abp_fetch",
      url: caseUrl,
      status: res.status,
      contentType,
      bodySnippet: `[${html.length} bytes] fields=${details.fields.length} docs=${details.documents.length} :: ${html.slice(0, 1500)}`,
    });
    if (!details.fields.length && !details.documents.length) return null;
    return details;
  } catch (err) {
    trace?.push({ step: "abp_fetch", url: caseUrl, error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
