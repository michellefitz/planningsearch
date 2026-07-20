/**
 * Vercel serverless API for the demo deployment — dependency-free.
 *
 * Serves the five /api/* routes from a static JSON bundle generated at build
 * time (server/src/export-json.ts). No native modules, no database driver, so
 * nothing in the serverless build or runtime can fail on better-sqlite3. The
 * search/filter/fuzzy behaviour mirrors the SQLite-backed server used for the
 * long-running (Docker/Render) deployment.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = JSON.parse(fs.readFileSync(path.join(__dirname, "_data/planning.json"), "utf8"));
const AUTH = new Map(BUNDLE.authorities.map((a) => [a.id, a]));

const haystackOf = (a) =>
  [a.planning_reference, a.address_text, a.applicant_name, a.description]
    .filter(Boolean)
    .join(" • ")
    .toLowerCase();
const HAYSTACK = new Map(BUNDLE.applications.map((a) => [a.id, haystackOf(a)]));

function trigrams(s) {
  const set = new Set();
  for (const w of s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" "))
    for (let i = 0; i + 3 <= w.length; i++) set.add(w.slice(i, i + 3));
  return set;
}
const TRI = new Map(BUNDLE.applications.map((a) => [a.id, trigrams(HAYSTACK.get(a.id))]));

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Kildare/eplanning: the id in .../AppFileRefDetails/{id}/0 is the same id the
 * council's iDocs scanned-file listing uses.
 * South Dublin: the agile portal loads documents from the council's own DMS,
 * a plain HTML page addressable by planning reference (links are direct PDFs).
 */
function scannedFilesUrl(authorityId, sourceUrl, reference) {
  if (authorityId === "south-dublin" && reference) {
    return `https://planning.southdublin.ie/Home/Documents?regref=${encodeURIComponent(reference)}`;
  }
  if (authorityId === "dublin-city" && reference) {
    // DCC's PublicAccess document server, addressable by planning reference.
    const ref = encodeURIComponent(reference).replace(/%2F/gi, "/");
    return `https://webapps.dublincity.ie/PublicAccess_Live/SearchResult/RunThirdPartySearch?FileSystemId=PL&Folder1_Ref=${ref}`;
  }
  if (authorityId !== "kildare" || !sourceUrl) return null;
  const m = sourceUrl.match(/AppFileRefDetails\/(\d+)/i);
  return m
    ? `https://idocsweb.kildarecoco.ie/iDocsWebDPSS/listFiles.aspx?catalog=planning&id=${m[1]}`
    : null;
}

/**
 * Deep link to the An Coimisiún Pleanála (An Bord Pleanála) case file from an
 * appeal reference. The operative case number is the six-digit group in any of
 * the historical formats (ABP-319506-23, ACP-301000-21, PL29N.301702, 319506).
 */
function abpCaseUrl(reference) {
  if (!reference) return null;
  const m = String(reference).match(/\d{6}/);
  return m ? `https://www.pleanala.ie/en-ie/case/${m[0]}` : null;
}

// --- An Coimisiún Pleanála case-page parsing (mirrors server/src/abp.ts) ---
const ABP_STRIP = (h) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
function abpDecode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}
const abpClean = (h) => abpDecode(ABP_STRIP(h));

function abpPushPair(out, seen, rawLabel, rawValue) {
  const label = abpClean(rawLabel).replace(/[:\s]+$/, "");
  const value = abpClean(rawValue);
  if (!label || !value) return;
  if (label.length > 60 || value.length > 1200) return;
  if (label.toLowerCase() === value.toLowerCase()) return;
  const key = label.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ label, value });
}

const ABP_DL_RE = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
const ABP_ROW_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const ABP_CELL_RE = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const ABP_LABELLED_RE =
  /<(\w+)[^>]*class="[^"]*\b(?:label|term|key|field-name)\b[^"]*"[^>]*>([\s\S]*?)<\/\1>\s*<(\w+)[^>]*class="[^"]*\b(?:value|desc|detail|field-value)\b[^"]*"[^>]*>([\s\S]*?)<\/\3>/gi;

function parseAppealCaseFields(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(ABP_DL_RE)) abpPushPair(out, seen, m[1], m[2]);
  for (const m of html.matchAll(ABP_LABELLED_RE)) abpPushPair(out, seen, m[2], m[4]);
  for (const rowMatch of html.matchAll(ABP_ROW_RE)) {
    const cells = [...rowMatch[1].matchAll(ABP_CELL_RE)].map((c) => c[2]);
    if (cells.length === 2) abpPushPair(out, seen, cells[0], cells[1]);
  }
  return out;
}

const ABP_ANCHOR_RE = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const ABP_DOC_HREF_RE = /\.(pdf|docx?|tiff?)([?#]|$)|case\s*documentation|\/document|getfile/i;
const ABP_DOC_META_PAREN_RE = /\s*\([^)]*(?:\.pdf|format|\d\s*[kmg]b)[^)]*\)\s*$/i;
function cleanDocTitle(raw) {
  const t = raw.replace(ABP_DOC_META_PAREN_RE, "").trim();
  return t || raw.trim();
}

function parseAppealCaseDocuments(html, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(ABP_ANCHOR_RE)) {
    const href = abpDecode(m[1]).trim();
    if (!ABP_DOC_HREF_RE.test(href)) continue;
    let url;
    try {
      url = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const text = abpClean(m[2]);
    out.push({
      title: text ? cleanDocTitle(text) : decodeURIComponent(url.split("/").pop() ?? "Document"),
      url,
    });
  }
  return out;
}

const ABP_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-IE,en;q=0.9",
};

async function fetchAppealCase(caseUrl, trace) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch(caseUrl, { signal: controller.signal, headers: ABP_FETCH_HEADERS });
    const contentType = resp.headers.get("content-type") ?? undefined;
    if (!resp.ok) {
      trace?.push({ step: "abp_fetch", url: caseUrl, status: resp.status, contentType, error: "non-200" });
      return null;
    }
    const html = await resp.text();
    const details = {
      fields: parseAppealCaseFields(html),
      documents: parseAppealCaseDocuments(html, caseUrl),
    };
    trace?.push({
      step: "abp_fetch",
      url: caseUrl,
      status: resp.status,
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

/**
 * Tolerant anchor-scrape of a council file-listing page; [] means "fall back
 * to deep link". Listing pages like Kildare's iDocs GridView label every link
 * "View" and keep the document name in sibling cells of the same table row,
 * so single-link rows use the row's remaining text as the title.
 */
const ANCHOR_RE = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const DOC_HREF_RE =
  /\.(pdf|tiff?|jpe?g|png|doc|docx)([?#]|$)|getfile|getdocument|viewdocument|download|openfile|docid=|fileid=/i;
const GENERIC_LABEL_RE = /^(view|open|download|show|file|document|link)?$/i;
const DATE_RE = /\b(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})\b/;

const stripTags = (h) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

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

function parseFileListHtml(html, baseUrl) {
  const files = [];
  const seen = new Set();
  const push = (url, title, fallback) => {
    if (seen.has(url)) return;
    seen.add(url);
    files.push({ title: title || fallback, url });
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
    const dateInRow = cells.map((c) => c.match(DATE_RE)?.[1]).find(Boolean);
    if (dateInRow && !displayTitle.includes(dateInRow)) displayTitle = `${displayTitle} — ${dateInRow}`;
    push(url, displayTitle, filename);
  }

  let m;
  while ((m = ANCHOR_RE.exec(html)) !== null) {
    const url = resolveDocHref(m[1], baseUrl);
    if (!url) continue;
    push(url, stripTags(m[2]), decodeURIComponent(url.split("/").pop() ?? "Document"));
  }
  return files;
}

const UA_HEADERS = {
  "User-Agent": "PlanView/0.1 (planning register viewer; respectful on-demand fetch)",
  Accept: "text/html",
};

async function fetchScannedFileList(listUrl, trace) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(listUrl, { signal: controller.signal, headers: UA_HEADERS });
    const html = res.ok ? await res.text() : "";
    const files = res.ok ? parseFileListHtml(html, listUrl) : [];
    if (trace) {
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

const cookieHeaderFromSetCookies = (setCookies) =>
  setCookies.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");

function extractFrameSrc(html) {
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


/**
 * Session-bound document proxy: the council's file URLs only work inside the
 * session that loaded the listing, so each view re-does the whole dance —
 * fetch listing (capture cookies), fetch the file at `index` with them.
 */
async function fetchScannedDocument(listUrl, index, maxBytes = 4_000_000, trace) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const listRes = await fetch(listUrl, { signal: controller.signal, headers: UA_HEADERS });
    trace?.push({ step: "fetch_listing", status: listRes.status, contentType: listRes.headers.get("content-type") });
    if (!listRes.ok) return null;
    const cookies = cookieHeaderFromSetCookies(listRes.headers.getSetCookie?.() ?? []);
    const listHtml = await listRes.text();
    const files = parseFileListHtml(listHtml, listUrl);
    trace?.push({ step: "parse_listing", fileCount: files.length, cookies: cookies || "(none)", bodySnippet: listHtml.slice(0, 500) });
    const target = files[index];
    if (!target) {
      trace?.push({ step: "target_lookup", error: `No file at index ${index} (${files.length} files found)` });
      return null;
    }
    trace?.push({ step: "target_lookup", targetUrl: target.url });

    const docHeaders = { ...UA_HEADERS, Accept: "*/*", Referer: listUrl };
    if (cookies) docHeaders.Cookie = cookies;

    let docRes = await fetch(target.url, { signal: controller.signal, headers: docHeaders });
    trace?.push({ step: "fetch_document", status: docRes.status, contentType: docRes.headers.get("content-type") });
    if (!docRes.ok) return null;
    let contentType = docRes.headers.get("content-type") ?? "application/octet-stream";
    let currentUrl = target.url;
    for (let hop = 0; hop < 3 && /text\/html/i.test(contentType); hop++) {
      const shellHtml = await docRes.text();
      const inner = extractFrameSrc(shellHtml);
      trace?.push({ step: `viewer_shell_${hop}`, extractedInner: inner, bodySnippet: shellHtml.slice(0, 500) });
      if (!inner) return null;
      currentUrl = new URL(inner, currentUrl).toString();
      docRes = await fetch(currentUrl, { signal: controller.signal, headers: docHeaders });
      trace?.push({ step: `fetch_inner_${hop}`, status: docRes.status, contentType: docRes.headers.get("content-type") });
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

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const AI_SUMMARY_CACHE = new Map();

const decodeEntities = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

/* Third-party submissions/observations show up in council file listings as
   document types like "Third Party Submission" or "Submission/ Objection". */
const OBJECTION_TITLE_RE = /submiss|observ|object/i;
const countObjectionFiles = (files) => files.filter((f) => OBJECTION_TITLE_RE.test(f.title)).length;

/* Applicant names are redacted in the national dataset and agents absent
   from it entirely; eplanning.ie detail pages publish both (agent = usually
   the architect, in a hidden "Agent Details" div). Cached per instance. */
const PARTIES_CACHE = new Map();

function parseEplanningParties(html) {
  const applicantM = html.match(/Applicant name:\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  const applicant = applicantM ? decodeEntities(stripTags(applicantM[1])) || null : null;
  let agent = null;
  const agentsBlock = html.match(/id="DivAgents"([\s\S]*?)<\/table>/i);
  if (agentsBlock) {
    const nameM = agentsBlock[1].match(/Name\s*:\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    const firmM = agentsBlock[1].match(/Address\s*:\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    const name = nameM ? decodeEntities(stripTags(nameM[1])) : "";
    const firm = firmM ? decodeEntities(stripTags(firmM[1])) : "";
    agent = [name, firm].filter(Boolean).join(", ") || null;
  }
  return { applicant, agent };
}

/* Agile Applications citizen-portal API (South Dublin, Dublin City, Fingal):
   tenant-scoped via three headers captured from a browser session. Returns
   applicant AND agent names, both missing from the national dataset. */
const AGILE_API = "https://planningapi.agileapplications.ie/api";
const AGILE_CLIENT_BY_AUTHORITY = {
  "south-dublin": "SD",
  "dublin-city": "DCC",
  fingal: "FG",
  dlr: "DLR",
};

async function agileGetJson(url, client) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": UA_HEADERS["User-Agent"],
        Accept: "application/json",
        "x-client": client,
        "x-product": "CITIZENPORTAL",
        "x-service": "PA",
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const joinName = (fore, sur, whole) => {
  const parts = [fore, sur].map((v) => String(v ?? "").trim()).filter(Boolean);
  if (parts.length) return parts.join(" ");
  return String(whole ?? "").trim() || null;
};

const AGILE_ID_CACHE = new Map();

const normRef = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const REF_FIELDS = [
  "reference",
  "applicationReference",
  "caseReference",
  "formattedReference",
  "referenceNumber",
  "planningReference",
];
const ID_FIELDS = ["id", "applicationId", "caseId", "applicationID"];

function coerceResults(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    for (const k of ["results", "applications", "data", "items"]) {
      if (Array.isArray(json[k])) return json[k];
    }
    for (const v of Object.values(json)) if (Array.isArray(v)) return v;
  }
  return [];
}

function fieldOf(r, fields) {
  for (const f of fields) {
    const v = r[f];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return null;
}

async function resolveAgileId(client, sourceUrl, reference, trace) {
  const fromUrl = sourceUrl?.match(/application-details\/(\d+)/i)?.[1];
  if (fromUrl) return fromUrl;
  const cacheKey = `${client}:${reference}`;
  if (AGILE_ID_CACHE.has(cacheKey)) return AGILE_ID_CACHE.get(cacheKey);
  const url = `${AGILE_API}/application/search?query=${encodeURIComponent(reference)}`;
  const found = await agileGetJson(url, client);
  const results = coerceResults(found);
  trace?.push({
    step: "agile_search",
    url,
    fileCount: results.length,
    bodySnippet: JSON.stringify(found ?? null).slice(0, 500),
  });
  const want = normRef(reference);
  // Match the reference tolerantly (case/punctuation-insensitive, across the
  // several field names tenants use); fall back to the sole result when a
  // reference-keyed search returns exactly one application.
  let hit = results.find((r) => normRef(fieldOf(r, REF_FIELDS)) === want && fieldOf(r, ID_FIELDS));
  if (!hit && results.length === 1 && fieldOf(results[0], ID_FIELDS)) hit = results[0];
  const id = hit ? fieldOf(hit, ID_FIELDS) : null;
  trace?.push({ step: "agile_resolve", resolvedId: id ? Number(id) : null });
  if (id) AGILE_ID_CACHE.set(cacheKey, id);
  return id;
}

// The proposal-description field name varies across tenants; take the longest
// non-empty candidate so we never regress on the truncated national value.
// The proposal-description field name varies across tenants and casings
// (proposalDescription, developmentDescription, proposal_description…), so
// match on the key rather than an exact name and take the longest such value.
const DESCRIPTION_KEY_RE = /descript|proposal|development/i;
function pickDescription(d) {
  let best = null;
  for (const [key, value] of Object.entries(d)) {
    if (typeof value !== "string" || !DESCRIPTION_KEY_RE.test(key)) continue;
    const v = value.trim();
    if (v && v.length > (best?.length ?? 0)) best = v;
  }
  return best;
}

// Normalise to the canonical "D15 YF1W" form; null unless a real Eircode
// (routing key + 4-char unique identifier, D6W special-cased) — Dublin
// tenants often put old postal districts ("2.") in the same field.
function normaliseEircode(raw) {
  const s = String(raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const m = s.match(/^(D6W|[A-Z]\d{2})([A-Z0-9]{4})$/);
  return m ? `${m[1]} ${m[2]}` : null;
}

async function fetchAgileDetail(authorityId, sourceUrl, reference, debug = false) {
  const client = AGILE_CLIENT_BY_AUTHORITY[authorityId];
  if (!client) return null;
  const cacheKey = `agile-detail:${authorityId}:${reference}`;
  if (!debug && PARTIES_CACHE.has(cacheKey)) return PARTIES_CACHE.get(cacheKey);
  const id = await resolveAgileId(client, sourceUrl, reference);
  if (!id) return null;
  const d = await agileGetJson(`${AGILE_API}/application/${id}`, client);
  if (!d || typeof d !== "object") return null;
  const detail = {
    applicant: joinName(d.applicantForename, d.applicantSurname, d.applicantName),
    agent: joinName(d.agentForename, d.agentSurname, d.agentName),
    description: pickDescription(d),
    eircode: normaliseEircode(d.postcode),
    ...(debug ? { keys: Object.keys(d) } : {}),
  };
  PARTIES_CACHE.set(cacheKey, detail);
  return detail;
}

async function fetchAgileParties(authorityId, sourceUrl, reference) {
  const detail = await fetchAgileDetail(authorityId, sourceUrl, reference);
  return detail
    ? { applicant: detail.applicant, agent: detail.agent }
    : { applicant: null, agent: null };
}

const ZONING_CACHE = new Map();
const GZT_URL =
  "https://services.arcgis.com/NzlPQPKn5QF9v2US/ArcGIS/rest/services/GZT_Current_Plan/FeatureServer/0/query";

/**
 * Land-use zoning at a point, from the national Generalised Zoning Types
 * layer (MyPlan / DHLGH). A location can sit in more than one current plan
 * (Development Plan + Local Area Plan).
 */
async function fetchZoning(lat, lng) {
  const cacheKey = `${lat},${lng}`;
  if (ZONING_CACHE.has(cacheKey)) return ZONING_CACHE.get(cacheKey);
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    spatialRel: "esriSpatialRelIntersects",
    where: "CURRENT_PLAN=1",
    // GZT_LINK omitted: those links point at the dead viewer.myplan.ie host.
    outFields: "ZONE_ORIG,ZONE_GZT,GZT_DESC,ZONE_DESC,PLAN_NAME,PLAN_LEVEL,ZONE_LINK",
    returnGeometry: "false",
    f: "json",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${GZT_URL}?${params}`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json();
    if (body.error || !Array.isArray(body.features)) return null;
    const zones = body.features
      .map((f) => f.attributes)
      .map((a) => ({
        zone: String(a.ZONE_ORIG ?? "").trim(),
        general: String(a.GZT_DESC ?? "").trim() || null,
        objective: String(a.ZONE_DESC ?? "").trim() || null,
        plan: String(a.PLAN_NAME ?? "").trim() || null,
        plan_level: String(a.PLAN_LEVEL ?? "").trim() || null,
        plan_url: /^https?:\/\//i.test(String(a.ZONE_LINK ?? "").trim())
          ? String(a.ZONE_LINK).trim()
          : null,
      }))
      .filter((z) => z.zone);
    zones.sort((a, b) => (a.plan_level === "DP" ? 0 : 1) - (b.plan_level === "DP" ? 0 : 1));
    const seen = new Set();
    const deduped = zones.filter((z) => !seen.has(z.zone) && seen.add(z.zone));
    ZONING_CACHE.set(cacheKey, deduped);
    return deduped;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Indicative flood-risk (OPW national flood mapping). Mirrors server/src/flood.ts.
const FLOOD_CACHE = new Map();
const FLOOD_URL =
  process.env.PLANVIEW_FLOOD_URL ??
  "https://services7.arcgis.com/aopigSLPh2SnT3cX/ArcGIS/rest/services/Flood_Maps/FeatureServer/0/query";
const FLOOD_SCENARIO_FIELDS = [
  "Probability", "PROBABILITY", "Scenario", "SCENARIO", "AEP",
  "Flood_Zone", "FLOOD_ZONE", "FloodZone", "Flood_Type", "FLOOD_TYPE",
  "Type", "TYPE", "Likelihood", "Event", "Class", "Descriptor",
  "DESCRIPT", "Description", "DESCRIPTION",
];
const FLOOD_SCENARIO_KEY_RE = /prob|scenario|aep|zone|fluvial|coastal|likelihood|extent|event/i;
function floodScenarioLabel(attrs) {
  for (const f of FLOOD_SCENARIO_FIELDS) {
    const v = attrs[f];
    if (typeof v === "string" && v.trim() && v.trim().length <= 60) return v.trim();
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "string" && v.trim() && v.trim().length <= 60 && FLOOD_SCENARIO_KEY_RE.test(k)) {
      return v.trim();
    }
  }
  return null;
}
async function fetchFlood(lat, lng, trace) {
  const cacheKey = `${lat},${lng}`;
  if (!trace && FLOOD_CACHE.has(cacheKey)) return FLOOD_CACHE.get(cacheKey);
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    where: "1=1",
    outFields: "*",
    returnGeometry: "false",
    f: "json",
  });
  const url = `${FLOOD_URL}?${params}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      trace?.push({ step: "flood_query", url, status: res.status, error: "non-200" });
      return null;
    }
    const body = await res.json();
    if (body.error || !Array.isArray(body.features)) {
      trace?.push({ step: "flood_query", url, bodySnippet: JSON.stringify(body).slice(0, 500), error: "no-features" });
      return null;
    }
    const scenarios = [...new Set(body.features.map((f) => floodScenarioLabel(f.attributes)).filter(Boolean))];
    const result = { at_risk: body.features.length > 0, scenarios };
    trace?.push({
      step: "flood_query",
      url,
      status: res.status,
      featureCount: body.features.length,
      bodySnippet: JSON.stringify(body.features.slice(0, 3)).slice(0, 800),
    });
    FLOOD_CACHE.set(cacheKey, result);
    return result;
  } catch (err) {
    trace?.push({ step: "flood_query", url, error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Map overlays (zoning, flood) as GeoJSON for a viewport. Mirrors server/src/overlays.ts.
const OVERLAY_CONFIG = {
  zoning: { url: GZT_URL, where: "CURRENT_PLAN=1", outFields: "ZONE_ORIG,ZONE_DESC,GZT_DESC,PLAN_NAME" },
  flood: { url: FLOOD_URL, where: "1=1", outFields: "*" },
};
const EMPTY_FC = { type: "FeatureCollection", features: [] };

function classifyZone(text) {
  const t = String(text).toLowerCase();
  if (/mixed/.test(t)) return "mixed";
  if (/resid|\bhousing\b|dwelling/.test(t)) return "residential";
  if (/commerc|retail|town centre|village centre|city centre|tourism/.test(t)) return "commercial";
  if (/industr|enterprise|employ|business|logistic|warehous|extract/.test(t)) return "industrial";
  if (/communit|educat|institution|civic|health|social|amenity building/.test(t)) return "community";
  if (/open space|amenity|recreat|green|park|\bsport\b|passive|active|woodland/.test(t)) return "open_space";
  if (/agricul|rural|farm/.test(t)) return "agriculture";
  if (/transport|utilit|infrastructure|\bport\b|airport|\broad\b|energy/.test(t)) return "infrastructure";
  if (/water|marine|coastal|\briver\b|lake|estuar/.test(t)) return "water";
  return "other";
}
const ovStr = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const OV_FLOOD_FIELDS = [
  "Probability", "PROBABILITY", "Scenario", "SCENARIO", "AEP", "Flood_Zone", "FLOOD_ZONE",
  "FloodZone", "Flood_Type", "FLOOD_TYPE", "Type", "TYPE", "Likelihood", "Event", "Class",
  "Descriptor", "DESCRIPT", "Description", "DESCRIPTION",
];
function ovFloodLabel(props) {
  for (const f of OV_FLOOD_FIELDS) {
    const v = ovStr(props[f]);
    if (v && v.length <= 60) return v;
  }
  return "Mapped flood extent";
}
function ovTransform(layer, features) {
  return features.map((f) => {
    const p = f.properties ?? {};
    if (layer === "zoning") {
      const desc = ovStr(p.GZT_DESC) || ovStr(p.ZONE_DESC) || ovStr(p.ZONE_ORIG);
      f.properties = {
        zone_group: classifyZone(desc),
        zone_label: ovStr(p.ZONE_DESC) || ovStr(p.ZONE_ORIG) || "Zone",
        zone_code: ovStr(p.ZONE_ORIG),
        zone_general: ovStr(p.GZT_DESC),
        plan: ovStr(p.PLAN_NAME),
      };
    } else {
      f.properties = { flood_label: ovFloodLabel(p) };
    }
    return f;
  });
}
async function fetchOverlay(layer, bbox) {
  const cfg = OVERLAY_CONFIG[layer];
  if (!cfg) return EMPTY_FC;
  const [w, s, e, n] = bbox;
  const offset = Math.max((e - w) / 1000, 0);
  const params = new URLSearchParams({
    geometry: `${w},${s},${e},${n}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    where: cfg.where,
    outFields: cfg.outFields,
    returnGeometry: "true",
    geometryPrecision: "5",
    maxAllowableOffset: String(offset),
    resultRecordCount: "2000",
    f: "geojson",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`${cfg.url}?${params}`, { signal: controller.signal });
    if (!res.ok) return EMPTY_FC;
    const body = await res.json();
    if (body.error || body.type !== "FeatureCollection" || !Array.isArray(body.features)) return EMPTY_FC;
    return { type: "FeatureCollection", features: ovTransform(layer, body.features) };
  } catch {
    return EMPTY_FC;
  } finally {
    clearTimeout(timer);
  }
}

const CONDITIONS_CACHE = new Map();

/**
 * Decision substance from /application/{id}/conditions — "prescriptions"
 * coded by kind: C condition of grant, R reason for refusal, D directive
 * (what an F.I. request asked for), I informative, N note.
 */
async function fetchAgileConditions(authorityId, sourceUrl, reference) {
  const client = AGILE_CLIENT_BY_AUTHORITY[authorityId];
  if (!client) return null;
  const cacheKey = `${authorityId}:${reference}`;
  if (CONDITIONS_CACHE.has(cacheKey)) return CONDITIONS_CACHE.get(cacheKey);
  const id = await resolveAgileId(client, sourceUrl, reference);
  if (!id) return null;
  const d = await agileGetJson(`${AGILE_API}/application/${id}/conditions`, client);
  if (!d || typeof d !== "object") return null;
  const items = (d.applicationPrescriptions ?? [])
    .map((p) => ({
      code: String(p.prescriptionCode ?? "").trim(),
      code_label: String(p.prescriptionCodeDescription ?? "").trim(),
      title: String(p.shortPrescription ?? "").trim(),
      text: String(p.longPrescription ?? "").replace(/\r\n/g, "\n").trim(),
      order: Number(p.orderNumber ?? 0),
    }))
    .filter((p) => p.title || p.text)
    .sort((a, b) => a.code.localeCompare(b.code) || a.order - b.order);
  const decision = String(d.decisionText ?? "").trim() || null;
  if (!decision && items.length === 0) return null;
  const result = {
    decision,
    decision_date: d.decisionDate ? String(d.decisionDate).slice(0, 10) : null,
    items,
  };
  CONDITIONS_CACHE.set(cacheKey, result);
  return result;
}

async function fetchEplanningParties(sourceUrl) {
  const none = { applicant: null, agent: null };
  if (!/eplanning\.ie\/.+AppFileRefDetails/i.test(sourceUrl)) return none;
  if (PARTIES_CACHE.has(sourceUrl)) return PARTIES_CACHE.get(sourceUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(sourceUrl, { signal: controller.signal, headers: UA_HEADERS });
    if (!res.ok) return none;
    const parties = parseEplanningParties(await res.text());
    if (parties.applicant || parties.agent) PARTIES_CACHE.set(sourceUrl, parties);
    return parties;
  } catch {
    return none;
  } finally {
    clearTimeout(timer);
  }
}

async function callHaiku(systemPrompt, userMsg) {
  if (!ANTHROPIC_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.content?.find((b) => b.type === "text")?.text?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function callClaude(systemPrompt, content, maxTokens = 120, timeoutMs = 10000) {
  if (!ANTHROPIC_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.content?.find((b) => b.type === "text")?.text?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sanitiseSummary(text) {
  return text
    .replace(/\*\*/g, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// The model must summarise or say nothing — never address the reader. Appended
// to every summary prompt; the sentinel it yields is turned into null below.
const NO_LEAK_RULE =
  "Output only the summary itself — never address the reader, never ask a question, never mention " +
  "that information is missing or incomplete, never refer to yourself. If the material does not " +
  "contain enough to write the summary, reply with exactly this single word and nothing else: INSUFFICIENT";

const LEAK_RE =
  /\b(?:I (?:don'?t|do not|cannot|can'?t|couldn'?t|am unable|'?m unable|'?m sorry)|as an AI|could you (?:provide|clarify|share)|please provide|not enough (?:info|information|detail)|appears? (?:incomplete|to be incomplete)|the (?:description|text) (?:appears|seems|is) |would you like|unable to (?:summari|determine|tell))/i;

function isUsableSummary(text) {
  if (!text) return null;
  const t = text.trim();
  if (!t || /^insufficient[.!]?$/i.test(t) || LEAK_RE.test(t)) return null;
  return t;
}

const APPEAL_SUMMARY_PROMPT =
  "You explain the outcome of an Irish planning appeal to a regular person in plain English. " +
  "Appeals are decided nationally by An Coimisiún Pleanála (formerly An Bord Pleanála), and the " +
  "Commission's decision replaces the council's. Write a short, flowing summary of a few sentences: " +
  "who appealed and what was at stake, then — if the appeal has been decided — what the Commission " +
  "decided and the main practical reasons. If it is not yet decided, say it is still under " +
  "consideration and what is being contested. Name real issues (overlooking neighbours, traffic, " +
  "height and scale, drainage…), never policy or plan citations. " +
  "FORMAT: plain prose only — no Markdown, asterisks, bold, headings, bullet points, section labels " +
  "or a title. Do not restate the address as a heading; begin directly with the summary. " +
  "Use only what the material states — never invent details. " +
  NO_LEAK_RULE;

async function summariseAppeal(context, pdfBase64) {
  if (!context.trim() && !pdfBase64) return null;
  let text;
  if (pdfBase64) {
    const content = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
      { type: "text", text: `${context}\n\nSummarise this appeal and its decision for a general reader.` },
    ];
    text = await callClaude(APPEAL_SUMMARY_PROMPT, content, 320, 25000);
  } else {
    text = await callClaude(APPEAL_SUMMARY_PROMPT, context, 320);
  }
  const usable = isUsableSummary(text);
  return usable ? sanitiseSummary(usable) : null;
}

const DECISION_EXTRACT_PROMPT =
  "You read an Irish council planning decision order and extract it as JSON for a public planning " +
  "viewer. Return ONLY a JSON object — no prose, no Markdown fences — with exactly this shape:\n" +
  '{"summary": string, "conditions": [{"number": number|null, "title": string, "text": string}], ' +
  '"reasons": [{"number": number|null, "text": string}]}\n' +
  '- summary: one or two plain-English sentences a regular person understands. If REFUSED, begin ' +
  '"Refused because" and give the real problems (overlooking, traffic, drainage, out of character…), ' +
  "not policy citations. If GRANTED, say so and flag whether the conditions are routine or onerous.\n" +
  "- conditions: every CONDITION OF GRANT. number = its number; title = a short (max 8 words) " +
  'plain-English label of what it controls (e.g. "Construction hours", "Development contribution", ' +
  '"Materials and finishes", "Landscaping"); text = the condition wording, lightly trimmed.\n' +
  "- reasons: every REASON FOR REFUSAL (number + wording).\n" +
  "If granted, reasons is []. If refused, conditions is []. Use only what the order states — never invent items.";

function parseJsonLoose(raw) {
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}
const ovClip = (v, max) => String(v ?? "").trim().slice(0, max);
const ovNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

async function extractDecisionDocument(pdfBase64, decision) {
  if (!pdfBase64) return null;
  const content = [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
    { type: "text", text: `Recorded decision: ${decision ?? "unknown"}. Extract the decision order as JSON.` },
  ];
  const raw = await callClaude(DECISION_EXTRACT_PROMPT, content, 2000, 30000);
  const parsed = raw ? parseJsonLoose(raw) : null;
  if (!parsed || typeof parsed !== "object") return null;
  const summaryRaw = typeof parsed.summary === "string" ? parsed.summary : null;
  const summary = summaryRaw ? isUsableSummary(sanitiseSummary(summaryRaw)) : null;
  const conditions = Array.isArray(parsed.conditions)
    ? parsed.conditions
        .map((c) => ({ number: ovNum((c ?? {}).number), title: ovClip((c ?? {}).title, 80), text: ovClip((c ?? {}).text, 1200) }))
        .filter((c) => c.title || c.text)
        .slice(0, 40)
    : [];
  const reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons
        .map((r) => ({ number: ovNum((r ?? {}).number), text: ovClip((r ?? {}).text, 1200) }))
        .filter((r) => r.text)
        .slice(0, 40)
    : [];
  if (!summary && conditions.length === 0 && reasons.length === 0) return null;
  return { summary, conditions, reasons };
}

const DECISION_SUMMARY_CACHE = new Map();
function findDecisionDocIndex(files) {
  const specific = files.findIndex((f) =>
    /notification of decision|decision order|manager.?s order|board order|order to (grant|refuse)/i.test(f.title)
  );
  if (specific >= 0) return specific;
  return files.findIndex((f) => /\bdecision\b|refus|grant of permission|\border\b/i.test(f.title));
}

const DECISION_DOC_RE = /board\s*(order|direction)|inspector|decision|determination/i;
const PDF_URL_RE = /\.pdf($|[?#])/i;

function pickAppealDocument(documents) {
  const pdfs = (documents ?? []).filter((d) => PDF_URL_RE.test(d.url));
  if (!pdfs.length) return null;
  return pdfs.find((d) => DECISION_DOC_RE.test(d.title)) ?? pdfs[0];
}

async function fetchAppealDocumentBase64(url, maxBytes = 12_000_000, trace) {
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

const APPEAL_SUMMARY_CACHE = new Map();

async function summariseDescription(description, applicationType) {
  if (!description) return null;
  if (AI_SUMMARY_CACHE.has(description)) return AI_SUMMARY_CACHE.get(description);
  const systemPrompt =
    "You summarise Irish planning applications in one short sentence of plain English. " +
    "The reader is a regular person, not a planner or architect. " +
    "Say what the project actually is: an extension, a new house, a commercial unit, solar panels, etc. " +
    "Include key details like number of bedrooms or storeys only when stated. " +
    'Never start with "This application is for". Just state what it is. ' +
    "Keep it under 30 words. " +
    NO_LEAK_RULE;
  const userMsg = applicationType
    ? `Application type: ${applicationType}\nDescription: ${description}`
    : description;
  const text = isUsableSummary(await callHaiku(systemPrompt, userMsg));
  if (text) AI_SUMMARY_CACHE.set(description, text);
  return text;
}

const REFUSAL_SUMMARY_CACHE = new Map();

async function summariseRefusal(appId, reasons) {
  if (!reasons.length) return null;
  if (REFUSAL_SUMMARY_CACHE.has(appId)) return REFUSAL_SUMMARY_CACHE.get(appId);
  const systemPrompt =
    "You explain why an Irish council refused a planning application, in one short sentence " +
    'of plain English starting with "Refused because". ' +
    "The reader is a regular person, not a planner. Name the actual problems " +
    "(too close to a sewer, would overlook neighbours, no drainage details, out of character " +
    "with the area…), never the policy or plan citations. " +
    "If there are several reasons, mention the main ones. Keep it under 35 words. " +
    NO_LEAK_RULE;
  const userMsg = reasons.map((r, i) => `Reason ${i + 1}: ${r.title}\n${r.text}`).join("\n\n");
  const text = isUsableSummary(await callHaiku(systemPrompt, userMsg));
  if (text) REFUSAL_SUMMARY_CACHE.set(appId, text);
  return text;
}

/** Path slugs on planning.agileapplications.ie (Dublin City, Fingal, and
 *  South Dublin, which migrated off the localgov portal). */
const AGILE_SLUGS = {
  "dublin-city": "dublincity",
  fingal: "fingal",
  "south-dublin": "southdublin",
  dlr: "dunlaoghaire",
};
const AGILE_BASE = "https://planning.agileapplications.ie";

function publicApp(a) {
  const auth = AUTH.get(a.authority_id);
  const agile = Boolean(AGILE_SLUGS[a.authority_id]);
  return {
    ...a,
    is_domestic_guess: Boolean(a.is_domestic_guess),
    status_label: BUNDLE.statuses[a.status] ?? a.status,
    application_type_label: BUNDLE.application_types[a.application_type] ?? a.application_type ?? "",
    authority_name: auth?.name ?? a.authority_id,
    authority_short_name: auth?.short_name ?? a.authority_id,
    portal_url: a.source_url ?? null,
    scanned_files_url: scannedFilesUrl(a.authority_id, a.source_url, a.planning_reference),
    appeal_url: abpCaseUrl(a.appeal_reference),
    portal_resolver: agile,
    files_supported:
      agile || scannedFilesUrl(a.authority_id, a.source_url, a.planning_reference) !== null,
  };
}

async function agileGetTraced(url, client, service, trace) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": UA_HEADERS["User-Agent"],
        Accept: "application/json",
        "x-client": client,
        "x-product": "CITIZENPORTAL",
        "x-service": service,
      },
    });
    const step = {
      step: "agile_api",
      url: `${url} [x-service=${service}]`,
      status: res.status,
      contentType: res.headers.get("content-type") ?? undefined,
    };
    if (!res.ok) {
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

/** Deep link to the citizen portal's application page, via the verified API. */
async function agilePortalUrl(authorityId, sourceUrl, reference, trace) {
  const client = AGILE_CLIENT_BY_AUTHORITY[authorityId];
  const slug = AGILE_SLUGS[authorityId];
  if (!client || !slug) return null;
  const id = await resolveAgileId(client, sourceUrl, reference, trace);
  return id ? `${AGILE_BASE}/${slug}/application-details/${id}` : null;
}

const agileStr = (v) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);

function coerceDocArray(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    for (const v of Object.values(json)) if (Array.isArray(v)) return v;
  }
  return [];
}

const formatAgileDate = (raw) => {
  const m = (typeof raw === "string" ? raw.slice(0, 10) : "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
};

/** Verified /api/application/{id}/document shape. */
function parseAgileDocEntries(json) {
  return coerceDocArray(json)
    .map((o) => {
      if (!o || typeof o !== "object") return null;
      const documentHash = agileStr(o.documentHash);
      const documentId = agileStr(o.documentId);
      if (!documentHash && !documentId) return null;
      const title = agileStr(o.description) ?? agileStr(o.mediaDescription) ?? agileStr(o.name) ?? "Document";
      return { title, name: agileStr(o.name), date: formatAgileDate(o.receivedDate), documentId, documentHash };
    })
    .filter(Boolean);
}

function parseAgileDocuments(json) {
  return parseAgileDocEntries(json).map((e) => ({
    title: e.date ? `${e.title} — ${e.date}` : e.title,
    url: `${AGILE_API}/document/${e.documentHash ?? e.documentId}`,
  }));
}

const EXT_CONTENT_TYPE = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", tif: "image/tiff", tiff: "image/tiff", svg: "image/svg+xml",
};
function presentDocument(rawType, filename) {
  const ext = filename?.toLowerCase().match(/\.([a-z0-9]+)(?:$|[?#])/)?.[1];
  let contentType = (rawType ?? "").split(";")[0].trim();
  if (!contentType || /octet-stream/i.test(contentType)) {
    contentType = (ext && EXT_CONTENT_TYPE[ext]) || contentType || "application/octet-stream";
  }
  const inlineable = /^application\/pdf$/i.test(contentType) || /^image\//i.test(contentType);
  return { contentType, disposition: inlineable ? "inline" : "attachment" };
}
function filenameFromDisposition(disposition) {
  if (!disposition) return null;
  const star = disposition.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1].replace(/^["']|["']$/g, "").trim()); } catch {} }
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}
const safeFilename = (name) => name.replace(/[\r\n"\\]/g, "").replace(/[/]/g, "-").trim().slice(0, 150);
function agileFilename(entry) {
  const ext = entry.name?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const base = safeFilename(entry.title);
  return ext ? `${base}.${ext}` : entry.name ?? (base || null);
}

function agileDownloadCandidates(entry, appId) {
  // Verified pattern: /api/application/document/{documentHash}.
  const urls = [];
  if (entry.documentHash) {
    urls.push(`${AGILE_API}/application/document/${entry.documentHash}`);
    urls.push(`${AGILE_API}/document/${entry.documentHash}`);
  }
  if (entry.documentId) {
    urls.push(`${AGILE_API}/application/document/${entry.documentId}`);
  }
  return urls;
}

const confirmedDocEndpoint = (id) => `${AGILE_API}/application/${id}/document`;

async function fetchAgileDocumentList(authorityId, sourceUrl, reference, trace) {
  const client = AGILE_CLIENT_BY_AUTHORITY[authorityId];
  const slug = AGILE_SLUGS[authorityId];
  if (!client || !slug) return null;
  const id = await resolveAgileId(client, sourceUrl, reference);
  trace?.push({ step: "agile_resolve", resolvedId: id === null ? null : Number(id) });
  if (!id) return null;
  const applicationUrl = `${AGILE_BASE}/${slug}/application-details/${id}`;
  const json = await agileGetTraced(confirmedDocEndpoint(id), client, "PA", trace);
  const files = parseAgileDocuments(json);
  trace?.push({ step: "agile_documents", url: confirmedDocEndpoint(id), fileCount: files.length });
  return { files, applicationUrl };
}

/** Stream one Agile document by index, adding tenant headers a plain link can't. */
async function fetchAgileDocument(authorityId, sourceUrl, reference, index, maxBytes = 4_000_000, trace) {
  const client = AGILE_CLIENT_BY_AUTHORITY[authorityId];
  if (!client) return null;
  const id = await resolveAgileId(client, sourceUrl, reference);
  if (!id) return null;
  const listJson = await agileGetTraced(confirmedDocEndpoint(id), client, "PA", trace);
  const entries = parseAgileDocEntries(listJson);
  const target = entries[index];
  if (!target) {
    trace?.push({ step: "agile_target", error: `No document at index ${index} of ${entries.length}` });
    return null;
  }
  for (const url of agileDownloadCandidates(target, id)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": UA_HEADERS["User-Agent"],
          Accept: "application/pdf,application/octet-stream,*/*",
          "x-client": client,
          "x-product": "CITIZENPORTAL",
          "x-service": "PA",
        },
      });
      const ct = res.headers.get("content-type") ?? "application/octet-stream";
      trace?.push({ step: "agile_download", url, status: res.status, contentType: ct });
      if (!res.ok || /application\/json|text\/html/i.test(ct)) continue;
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) return "too_large";
      const body = Buffer.from(await res.arrayBuffer());
      if (body.byteLength > maxBytes) return "too_large";
      return {
        contentType: ct,
        filename: filenameFromDisposition(res.headers.get("content-disposition")) ?? agileFilename(target),
        body,
      };
    } catch (err) {
      trace?.push({ step: "agile_download", url, error: String(err) });
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function csv(v) {
  if (!v) return null;
  const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}
function parseBbox(v) {
  const parts = csv(v)?.map(Number);
  if (!parts || parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts;
}
function parseNear(p) {
  const lat = Number(p.get("lat")), lng = Number(p.get("lng"));
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function applyFilters(rows, p) {
  const auths = csv(p.get("authority"));
  const statuses = csv(p.get("status"));
  const types = csv(p.get("type"));
  const domestic = p.get("domestic") === "1" || p.get("domestic") === "true";
  const appealed = p.get("appealed") === "1" || p.get("appealed") === "true";
  const commenced = p.get("commenced") === "1" || p.get("commenced") === "true";
  const rf = p.get("receivedFrom"), rt = p.get("receivedTo");
  const df = p.get("decisionFrom"), dt = p.get("decisionTo");
  const bbox = parseBbox(p.get("bbox"));
  return rows.filter((a) => {
    if (auths && !auths.includes(a.authority_id)) return false;
    if (statuses && !statuses.includes(a.status)) return false;
    if (types && !types.includes(a.application_type)) return false;
    if (domestic && a.is_domestic_guess !== 1) return false;
    if (appealed && !a.appeal_reference) return false;
    if (commenced && !a.commencement_date) return false;
    if (rf && (!a.received_date || a.received_date < rf)) return false;
    if (rt && (!a.received_date || a.received_date > rt)) return false;
    if (df && (!a.decision_date || a.decision_date < df)) return false;
    if (dt && (!a.decision_date || a.decision_date > dt)) return false;
    if (bbox) {
      const [w, s, e, n] = bbox;
      if (a.lng == null || a.lat == null) return false;
      if (a.lng < w || a.lng > e || a.lat < s || a.lat > n) return false;
    }
    return true;
  });
}

function runSearch(p) {
  let rows = applyFilters(BUNDLE.applications, p);
  let fuzzy = false;
  const q = (p.get("q") ?? "").trim().toLowerCase();
  if (q) {
    const tokens = q.split(/\s+/).map((t) => t.replace(/\*+$/, "")).filter(Boolean);
    const exact = rows.filter((a) => {
      const h = HAYSTACK.get(a.id);
      return tokens.every((t) => h.includes(t));
    });
    if (exact.length) {
      rows = exact.map((a) => ({ ...a, match_quality: "exact" }));
    } else {
      fuzzy = true;
      const qt = trigrams(q);
      rows = rows
        .map((a) => {
          let hit = 0;
          for (const g of qt) if (TRI.get(a.id).has(g)) hit++;
          return { a, score: qt.size ? hit / qt.size : 0 };
        })
        .filter((x) => x.score >= 0.45)
        .sort((x, y) => y.score - x.score)
        .map((x) => ({ ...x.a, match_quality: "fuzzy" }));
    }
  }

  const near = parseNear(p);
  if (near) {
    for (const r of rows) {
      if (r.lat != null && r.lng != null)
        r.distance_km = Math.round(haversineKm(near.lat, near.lng, r.lat, r.lng) * 100) / 100;
    }
  }

  const sort = p.get("sort");
  if (sort === "distance" && near) {
    rows.sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
  } else if (sort === "decision") {
    rows.sort((a, b) => (b.decision_date ?? "").localeCompare(a.decision_date ?? ""));
  } else if (!q || sort === "received") {
    rows.sort((a, b) => (b.received_date ?? "").localeCompare(a.received_date ?? ""));
  }
  return { rows, fuzzy };
}

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=60");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.searchParams;
  // Normalise the path: Build Output API may invoke this function with the
  // original path (/api/meta) or a rewritten one (/meta); accept both.
  let route = url.pathname.replace(/\/$/, "");
  if (!route.startsWith("/api")) route = "/api" + route;

  if (route === "/api/meta") {
    return send(res, 200, {
      authorities: BUNDLE.authorities,
      source_updated_at: BUNDLE.source_updated_at ?? null,
      generated_at: BUNDLE.generated_at ?? null,
      statuses: BUNDLE.statuses,
      application_types: BUNDLE.application_types,
      glossary: BUNDLE.glossary,
      attribution: BUNDLE.attribution,
    });
  }

  if (route === "/api/search") {
    const limit = Math.min(Math.max(Number(p.get("limit")) || 25, 1), 200);
    const page = Math.max(Number(p.get("page")) || 1, 1);
    const { rows, fuzzy } = runSearch(p);
    const start = (page - 1) * limit;
    return send(res, 200, {
      total: rows.length,
      fuzzy,
      page,
      results: rows.slice(start, start + limit).map(publicApp),
    });
  }

  if (route === "/api/suggest") {
    const q = (p.get("q") ?? "").trim().toLowerCase();
    if (!q) return send(res, 200, { suggestions: [] });
    const seen = new Set();
    const out = [];
    for (const a of BUNDLE.applications) {
      if (!HAYSTACK.get(a.id).includes(q)) continue;
      const cand = (a.address_text || a.planning_reference || "").trim();
      const key = cand.toLowerCase();
      if (cand && !seen.has(key)) {
        seen.add(key);
        out.push(cand);
      }
      if (out.length >= 8) break;
    }
    return send(res, 200, { suggestions: out });
  }

  if (route === "/api/map/applications") {
    const { rows } = runSearch(p);
    return send(res, 200, {
      type: "FeatureCollection",
      features: rows
        .filter((r) => r.lat != null && r.lng != null)
        .map((r) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [r.lng, r.lat] },
          properties: {
            id: r.id,
            reference: r.planning_reference,
            status: r.status,
            authority_id: r.authority_id,
            address: r.address_text,
            is_domestic_guess: Boolean(r.is_domestic_guess),
          },
        })),
    });
  }

  const dm = route.match(/^\/api\/applications\/(\d+)\/files\/(\d+)$/);
  if (dm) {
    const app = BUNDLE.applications.find((a) => a.id === Number(dm[1]));
    if (!app) return send(res, 404, { error: "Application not found" });
    const index = Number(dm[2]);
    const debug = p.get("debug") === "1";
    const trace = debug ? [] : undefined;
    const listUrl = scannedFilesUrl(app.authority_id, app.source_url, app.planning_reference);
    const slug = AGILE_SLUGS[app.authority_id];

    const doc =
      !listUrl && slug
        ? await fetchAgileDocument(app.authority_id, app.source_url, app.planning_reference, index, 4_000_000, trace)
        : listUrl
          ? await fetchScannedDocument(listUrl, index, 4_000_000, trace)
          : null;

    if (debug) {
      return send(res, 200, { listUrl, index, result: doc === null ? "null" : doc === "too_large" ? "too_large" : "ok", trace });
    }
    if (doc === "too_large" || doc === null) {
      // Land the user on the specific application, not the generic portal.
      const fallbackUrl =
        listUrl ??
        (slug
          ? (await agilePortalUrl(app.authority_id, app.source_url, app.planning_reference)) ?? `${AGILE_BASE}/${slug}`
          : "");
      const reason =
        doc === "too_large"
          ? "This document is too large to display here."
          : "Couldn't retrieve this document from the council just now.";
      res.statusCode = doc === "too_large" ? 413 : 502;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><meta charset="utf-8"><title>PlanView</title>` +
          `<p>${reason}</p><p><a href="${fallbackUrl}">Open it on the council's viewer instead</a>.</p>`
      );
      return;
    }
    // Open PDFs/images in the tab; download only what the browser can't render.
    const pres = presentDocument(doc.contentType, doc.filename);
    res.statusCode = 200;
    res.setHeader("Content-Type", pres.contentType);
    res.setHeader(
      "Content-Disposition",
      doc.filename ? `${pres.disposition}; filename="${safeFilename(doc.filename)}"` : pres.disposition
    );
    res.setHeader("Cache-Control", "private, max-age=300");
    res.end(doc.body);
    return;
  }

  const zm = route.match(/^\/api\/applications\/(\d+)\/zoning$/);
  if (zm) {
    const app = BUNDLE.applications.find((a) => a.id === Number(zm[1]));
    if (!app) return send(res, 404, { error: "Application not found" });
    if (app.lat == null || app.lng == null) return send(res, 200, { supported: false, zones: null });
    const zones = await fetchZoning(app.lat, app.lng);
    return send(res, 200, { supported: true, zones });
  }

  const flm = route.match(/^\/api\/applications\/(\d+)\/flood$/);
  if (flm) {
    const app = BUNDLE.applications.find((a) => a.id === Number(flm[1]));
    if (!app) return send(res, 404, { error: "Application not found" });
    if (app.lat == null || app.lng == null) return send(res, 200, { supported: false, flood: null });
    const debug = p.get("debug") === "1";
    const trace = debug ? [] : undefined;
    const flood = await fetchFlood(app.lat, app.lng, trace);
    if (debug) return send(res, 200, { flood, trace });
    return send(res, 200, { supported: true, flood });
  }

  const om = route.match(/^\/api\/overlays\/(zoning|flood)$/);
  if (om) {
    const bbox = parseBbox(p.get("bbox"));
    if (!bbox) return send(res, 200, { type: "FeatureCollection", features: [] });
    return send(res, 200, await fetchOverlay(om[1], bbox));
  }

  const cm = route.match(/^\/api\/applications\/(\d+)\/conditions$/);
  if (cm) {
    const app = BUNDLE.applications.find((a) => a.id === Number(cm[1]));
    if (!app) return send(res, 404, { error: "Application not found" });
    if (!(app.authority_id in AGILE_CLIENT_BY_AUTHORITY)) {
      return send(res, 200, { supported: false, conditions: null });
    }
    const conditions = await fetchAgileConditions(
      app.authority_id,
      app.source_url,
      app.planning_reference
    );
    // The plain-English refusal line is its own (cached) endpoint so the
    // conditions themselves never wait on a model call.
    return send(res, 200, {
      supported: true,
      conditions: conditions
        ? { ...conditions, refusal_summary: REFUSAL_SUMMARY_CACHE.get(app.id) ?? null }
        : null,
    });
  }

  const rsm = route.match(/^\/api\/applications\/(\d+)\/refusal-summary$/);
  if (rsm) {
    const app = BUNDLE.applications.find((a) => a.id === Number(rsm[1]));
    if (!app) return send(res, 404, { error: "Application not found" });
    if (!(app.authority_id in AGILE_CLIENT_BY_AUTHORITY)) {
      return send(res, 200, { supported: false, summary: null });
    }
    const conditions = await fetchAgileConditions(
      app.authority_id,
      app.source_url,
      app.planning_reference
    );
    const reasons = conditions?.items.filter((i) => i.code === "R") ?? [];
    const summary = reasons.length ? await summariseRefusal(app.id, reasons) : null;
    return send(res, 200, { supported: true, summary });
  }

  const am = route.match(/^\/api\/applications\/(\d+)\/appeal$/);
  if (am) {
    const app = BUNDLE.applications.find((a) => a.id === Number(am[1]));
    if (!app) return send(res, 404, { error: "Application not found" });
    const caseUrl = abpCaseUrl(app.appeal_reference);
    if (!caseUrl) return send(res, 200, { supported: false });
    const debug = p.get("debug") === "1";
    const trace = debug ? [] : undefined;
    const details = await fetchAppealCase(caseUrl, trace);
    if (debug) return send(res, 200, { case_url: caseUrl, details, trace });
    return send(res, 200, {
      supported: true,
      case_url: caseUrl,
      reference: app.appeal_reference ?? null,
      status: app.appeal_status ?? null,
      lodged_date: app.appeal_lodged_date ?? null,
      decision: app.appeal_decision ?? null,
      decision_date: app.appeal_decision_date ?? null,
      fields: details?.fields ?? null,
      documents: details?.documents ?? null,
    });
  }

  const asm = route.match(/^\/api\/applications\/(\d+)\/appeal-summary$/);
  if (asm) {
    const app = BUNDLE.applications.find((a) => a.id === Number(asm[1]));
    if (!app) return send(res, 404, { error: "Application not found" });
    const caseUrl = abpCaseUrl(app.appeal_reference);
    if (!caseUrl) return send(res, 200, { supported: false });
    const cached = APPEAL_SUMMARY_CACHE.get(app.id);
    if (cached) return send(res, 200, { supported: true, ...cached });

    const debug = p.get("debug") === "1";
    const trace = debug ? [] : undefined;
    const details = await fetchAppealCase(caseUrl, trace);
    const context = [
      app.description ? `Development: ${app.description}` : null,
      `Council decision: ${app.decision ?? "unknown"}`,
      app.appeal_status ? `Appeal status: ${app.appeal_status}` : null,
      app.appeal_decision
        ? `An Coimisiún Pleanála decision: ${app.appeal_decision}${app.appeal_decision_date ? ` on ${app.appeal_decision_date}` : ""}`
        : null,
      ...(details?.fields ?? []).map((f) => `${f.label}: ${f.value}`),
    ]
      .filter(Boolean)
      .join("\n");
    const doc = details ? pickAppealDocument(details.documents) : null;
    const pdf = doc ? await fetchAppealDocumentBase64(doc.url, 12_000_000, trace) : null;
    const summary = await summariseAppeal(context, pdf);
    if (debug) return send(res, 200, { case_url: caseUrl, based_on_document: pdf ? doc?.title : null, summary, trace });
    if (!summary) return send(res, 200, { supported: true, summary: null, based_on_document: null });
    const result = { summary, based_on_document: pdf ? doc?.title ?? null : null };
    APPEAL_SUMMARY_CACHE.set(app.id, result);
    return send(res, 200, { supported: true, ...result });
  }

  const dsm = route.match(/^\/api\/applications\/(\d+)\/decision-summary$/);
  if (dsm) {
    const app = BUNDLE.applications.find((a) => a.id === Number(dsm[1]));
    if (!app) return send(res, 404, { error: "Application not found" });
    const listUrl = scannedFilesUrl(app.authority_id, app.source_url, app.planning_reference);
    if (!listUrl || app.authority_id in AGILE_CLIENT_BY_AUTHORITY || !app.decision) {
      return send(res, 200, { supported: false });
    }
    const cached = DECISION_SUMMARY_CACHE.get(app.id);
    if (cached) return send(res, 200, { supported: true, ...cached });
    const debug = p.get("debug") === "1";
    const trace = debug ? [] : undefined;
    const files = await fetchScannedFileList(listUrl, trace);
    const index = files ? findDecisionDocIndex(files) : -1;
    if (debug) {
      const d = index >= 0 ? await fetchScannedDocument(listUrl, index, 10_000_000, trace) : null;
      return send(res, 200, {
        files,
        chosen: index,
        chosen_title: index >= 0 ? files[index].title : null,
        doc: d === "too_large" ? "too_large" : d ? d.contentType : "null",
        trace,
      });
    }
    const empty = { supported: true, summary: null, conditions: [], reasons: [], source_document: null };
    if (!files || index < 0) return send(res, 200, empty);
    const doc = await fetchScannedDocument(listUrl, index, 10_000_000, trace);
    if (!doc || doc === "too_large") return send(res, 200, { ...empty, source_document: files[index].title });
    const isPdf = /pdf/i.test(doc.contentType) || /\.pdf$/i.test(doc.filename ?? "");
    const extract = isPdf ? await extractDecisionDocument(doc.body.toString("base64"), app.decision) : null;
    const source_document = files[index].title;
    if (!extract) return send(res, 200, { ...empty, source_document });
    const result = { ...extract, source_document };
    DECISION_SUMMARY_CACHE.set(app.id, result);
    return send(res, 200, { supported: true, ...result });
  }

  const fm = route.match(/^\/api\/applications\/(\d+)\/files$/);
  if (fm) {
    const app = BUNDLE.applications.find((a) => a.id === Number(fm[1]));
    if (!app) return send(res, 404, { error: "Application not found" });
    const debug = p.get("debug") === "1";
    const trace = debug ? [] : undefined;

    // HTML listing first (Kildare iDocs, South Dublin regref DMS); the
    // remaining Agile councils go via the portal JSON API.
    const listUrl = scannedFilesUrl(app.authority_id, app.source_url, app.planning_reference);
    const slug = AGILE_SLUGS[app.authority_id];
    if (!listUrl && slug) {
      const result = await fetchAgileDocumentList(app.authority_id, app.source_url, app.planning_reference, trace);
      if (debug) return send(res, 200, { agile: true, result, trace });
      if (!result) return send(res, 200, { supported: false, files: null, list_url: null });
      return send(res, 200, {
        supported: true,
        list_url: result.applicationUrl,
        files: result.files.length ? result.files : null,
        objection_count: result.files.length ? countObjectionFiles(result.files) : null,
      });
    }
    if (!listUrl) return send(res, 200, { supported: false, files: null, list_url: null });
    const files = await fetchScannedFileList(listUrl, trace);
    if (debug) return send(res, 200, { agile: false, list_url: listUrl, files, trace });
    return send(res, 200, {
      supported: true,
      list_url: listUrl,
      files,
      objection_count: files ? countObjectionFiles(files) : null,
    });
  }

  const pm = route.match(/^\/api\/applications\/(\d+)\/portal$/);
  if (pm) {
    const app = BUNDLE.applications.find((a) => a.id === Number(pm[1]));
    if (!app) return send(res, 404, { error: "Application not found" });
    const slug = AGILE_SLUGS[app.authority_id];
    const fallback = app.source_url ?? null;
    const debug = p.get("debug") === "1";
    const trace = debug ? [] : undefined;
    let resolved = null;
    if (slug) resolved = await agilePortalUrl(app.authority_id, app.source_url, app.planning_reference, trace);
    if (debug) return send(res, 200, { resolved, fallback, trace });
    const dest = resolved ?? fallback;
    if (!dest) return send(res, 404, { error: "No portal link" });
    res.statusCode = 302;
    res.setHeader("Location", dest);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.end();
    return;
  }

  const m = route.match(/^\/api\/applications\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const app = BUNDLE.applications.find((a) => a.id === id);
    if (!app) return send(res, 404, { error: "Application not found" });
    const related = BUNDLE.applications
      .filter((a) => a.id !== id && a.authority_id === app.authority_id && a.address_text === app.address_text)
      .slice(0, 10)
      .map((a) => ({
        id: a.id,
        planning_reference: a.planning_reference,
        description: a.description,
        status: a.status,
        received_date: a.received_date,
        decision_date: a.decision_date,
      }));
    // Slow upstream work lives on /enrich so the sheet renders immediately;
    // anything already in the warm-instance caches still comes through here.
    return send(res, 200, {
      ...publicApp(app),
      ai_summary: AI_SUMMARY_CACHE.get(app.description) ?? null,
      documents: [],
      related,
    });
  }

  const em = route.match(/^\/api\/applications\/(\d+)\/enrich$/);
  if (em) {
    const app = BUNDLE.applications.find((a) => a.id === Number(em[1]));
    if (!app) return send(res, 404, { error: "Application not found" });

    let description = app.description ?? null;
    let parties = { applicant: null, agent: null };
    const debug = p.get("debug") === "1";
    // The summary runs on the description we already hold, in parallel with
    // the party/description backfill — waiting on the portal before starting
    // the model call is what made the sheet feel slow. Only when the quick
    // pass can't produce a summary (usually a truncated national description)
    // and the portal supplied a fuller one do we summarise again.
    const isAgile = app.authority_id in AGILE_CLIENT_BY_AUTHORITY;
    const [detail, eplanningParties, quickSummary] = await Promise.all([
      isAgile
        ? fetchAgileDetail(app.authority_id, app.source_url, app.planning_reference, debug)
        : null,
      !isAgile && !(app.applicant_name && app.agent_name) && app.source_url
        ? fetchEplanningParties(app.source_url)
        : null,
      summariseDescription(description, app.application_type),
    ]);
    if (isAgile) {
      if (detail) {
        parties = { applicant: detail.applicant, agent: detail.agent };
        if (detail.description && detail.description.length > (description?.length ?? 0)) {
          description = detail.description;
        }
        if (debug)
          return send(res, 200, {
            agile_detail_keys: detail.keys ?? null,
            picked_description_len: detail.description?.length ?? 0,
            description,
          });
      } else if (debug) {
        return send(res, 200, { agile_detail_keys: null, picked_description_len: 0, description });
      }
    } else if (eplanningParties) {
      parties = eplanningParties;
    }

    const aiSummary =
      quickSummary ??
      (description !== (app.description ?? null)
        ? await summariseDescription(description, app.application_type)
        : null);
    return send(res, 200, {
      ai_summary: aiSummary,
      applicant_name: app.applicant_name ?? parties.applicant,
      agent_name: app.agent_name ?? parties.agent,
      description,
      // The national dataset's postcode is ~2% populated; the agile register
      // often has the real Eircode.
      eircode: app.eircode ?? detail?.eircode ?? null,
    });
  }

  return send(res, 404, { error: "Not found" });
}
