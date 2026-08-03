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
import { handleAccountRoute, isAccountRoute } from "./_accounts/routes.mjs";
import { handlePreplanRoute, isPreplanRoute } from "./_preplan/routes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = JSON.parse(fs.readFileSync(path.join(__dirname, "_data/planning.json"), "utf8"));
const AUTH = new Map(BUNDLE.authorities.map((a) => [a.id, a]));

/**
 * Site boundaries, keyed by application id, in their own file beside the bundle
 * (see export-json.ts). Read on first use rather than at module load: it is the
 * larger of the two files and only /api/map/polygons touches it, so search and
 * detail cold starts shouldn't pay for geometry they never draw. A missing
 * sidecar means no boundaries, not a broken deployment.
 */
let POLYGONS = null;
function sitePolygons() {
  if (POLYGONS) return POLYGONS;
  try {
    POLYGONS = JSON.parse(fs.readFileSync(path.join(__dirname, "_data/polygons.json"), "utf8"));
  } catch {
    POLYGONS = {};
  }
  return POLYGONS;
}

const haystackOf = (a) =>
  [a.planning_reference, a.address_text, a.applicant_name, a.description]
    .filter(Boolean)
    .join(" • ")
    .toLowerCase();
const HAYSTACK = new Map(BUNDLE.applications.map((a) => [a.id, haystackOf(a)]));

/** Map pins per request — see /api/map/applications. */
const MAP_FEATURE_LIMIT = 2000;

function trigrams(s) {
  const set = new Set();
  for (const w of s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" "))
    for (let i = 0; i + 3 <= w.length; i++) set.add(w.slice(i, i + 3));
  return set;
}

// Inverted trigram index, built lazily: per-app trigram Sets cost ~300 MB and
// ~2.5 s at cold start on the full-depth bundle, and only the fuzzy fallback
// (no exact hits) ever needs them.
let TRI_INDEX = null;
function triIndex() {
  if (!TRI_INDEX) {
    TRI_INDEX = new Map();
    for (const a of BUNDLE.applications) {
      for (const g of trigrams(HAYSTACK.get(a.id))) {
        const arr = TRI_INDEX.get(g);
        if (arr) arr.push(a.id);
        else TRI_INDEX.set(g, [a.id]);
      }
    }
  }
  return TRI_INDEX;
}

/**
 * Normalised address key — mirrors normalizeAddress() in server/src/ingest/ppr.ts.
 * Council staff type these free-hand, so "31 Mount Prospect Drive, Dublin 3",
 * "31, Mount Prospect Dr." and "No. 31 Mount Prospect Drive" are one property.
 * Exact string equality split a house's history into unrelated halves.
 */
function addressKey(s) {
  if (!s) return "";
  let n = String(s).toUpperCase();
  n = n.replace(/[^A-Z0-9 ]/g, " ");
  n = n.replace(/\b(D6W|[A-Z]\d{2})\s?[A-Z0-9]{4}\b/g, " ");
  n = n.replace(/\b(CO|COUNTY)\s+(KILDARE|DUBLIN|WICKLOW|MEATH)\b/g, " ");
  // "No. 31 ..." is the same house as "31 ..." — a standalone NO before a
  // digit is always "number".
  n = n.replace(/\bNO\s+(?=\d)/g, " ");
  n = n.replace(/\s+/g, " ").trim();
  n = n.replace(/\s(KILDARE|DUBLIN)$/g, "");
  return n.trim();
}

/** authority_id + normalised address -> application ids, built once per cold start. */
let ADDRESS_INDEX = null;
function addressIndex() {
  if (ADDRESS_INDEX) return ADDRESS_INDEX;
  ADDRESS_INDEX = new Map();
  for (const a of BUNDLE.applications) {
    if (!a.address_text) continue;
    const key = a.authority_id + "|" + addressKey(a.address_text);
    const list = ADDRESS_INDEX.get(key);
    if (list) list.push(a.id);
    else ADDRESS_INDEX.set(key, [a.id]);
  }
  return ADDRESS_INDEX;
}

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
/** iDocs document servers for the LGMA eplanning councils — same product, one
 *  host each. Mirrors IDOCS_HOST in server/src/documents.ts. */
const IDOCS_HOST = {
  kildare: "https://idocsweb.kildarecoco.ie/iDocsWebDPSS",
  meath: "https://idocswebdpss.meathcoco.ie/iDocsWebDPSS",
  wicklow: "https://WicklowCoCo.ePlanning.ie/idocswebDPSS",
};

function scannedFilesUrl(authorityId, sourceUrl, reference) {
  if (authorityId === "south-dublin" && reference) {
    return `https://planning.southdublin.ie/Home/Documents?regref=${encodeURIComponent(reference)}`;
  }
  if (authorityId === "dublin-city" && reference) {
    // DCC's PublicAccess document server, addressable by planning reference.
    const ref = encodeURIComponent(reference).replace(/%2F/gi, "/");
    return `https://webapps.dublincity.ie/PublicAccess_Live/SearchResult/RunThirdPartySearch?FileSystemId=PL&Folder1_Ref=${ref}`;
  }
  const idocs = IDOCS_HOST[authorityId];
  if (!idocs || !sourceUrl) return null;
  const m = sourceUrl.match(/AppFileRefDetails\/(\d+)/i);
  return m
    ? `${idocs}/listFiles.aspx?catalog=planning&id=${m[1]}`
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
// …but never a status/decision narrative: Fingal's "statusDescriptionOwner"
// ("On 24 Jun 2025, a decision REFUSE PERMISSION was made…") is longer than
// the real proposal and was winning the longest-string contest.
const NOT_DESCRIPTION_KEY_RE = /status|decision/i;
function pickDescription(d) {
  let best = null;
  for (const [key, value] of Object.entries(d)) {
    if (typeof value !== "string" || !DESCRIPTION_KEY_RE.test(key) || NOT_DESCRIPTION_KEY_RE.test(key)) continue;
    const v = value.trim();
    if (v && v.length > (best?.length ?? 0)) best = v;
  }
  return best;
}

// The current status lives under a status-ish key whose name varies by tenant;
// take the longest human string on a /status/ key (description beats a short
// code), skipping appeal-status and date fields. The live portal reflects
// "Invalid" etc. long before the national dataset does.
const STATUS_KEY_RE = /status/i;
function pickAgileStatus(d) {
  let best = null;
  for (const [key, value] of Object.entries(d)) {
    if (typeof value !== "string" || !STATUS_KEY_RE.test(key)) continue;
    if (/appeal/i.test(key) || /date/i.test(key)) continue;
    const v = value.trim();
    if (!v || /^\d{4}-\d{2}-\d{2}/.test(v)) continue;
    if (v.length > (best?.length ?? 0)) best = v;
  }
  return best;
}

// The real outcome ("Grant Permission", "Application Declared Invalid") lives on
// a decision-ish key, distinct from the status stage; reading it lets
// mapLiveStatus defer to the outcome. Skip date/appeal keys; longest wins.
const DECISION_KEY_RE = /decision/i;
/** Keys that carry *who* or *how* decided rather than *what* was decided. */
const DECISION_ROLE_KEY_RE = /appeal|date|level|officer|planner|maker|author|staff|user|\bby\b/i;
/**
 * A decision is an outcome. Requiring the value to read like one is the only
 * reliable filter: the agile payload has several "…decision…" keys and no
 * documented winner, so picking the longest string chose "Senior Planner West"
 * (the decision maker, 19 chars) over "GRANT PERMISSION" (16) — which then
 * reached users as "Decision issued: Senior Planner West".
 */
const DECISION_OUTCOME_RE =
  /\b(grant|refus|approv|reject|withdraw|invalid|declar|exempt|permission|split|uphold|overturn|conditional)/i;

function pickAgileDecision(d) {
  let best = null;
  for (const [key, value] of Object.entries(d)) {
    if (typeof value !== "string" || !DECISION_KEY_RE.test(key)) continue;
    if (DECISION_ROLE_KEY_RE.test(key)) continue;
    const v = value.trim();
    if (!v || /^\d{4}-\d{2}-\d{2}/.test(v)) continue;
    // No outcome vocabulary, no decision — better to report nothing than a
    // person's job title.
    if (!DECISION_OUTCOME_RE.test(v)) continue;
    // Among genuine outcomes the longest wins, so a split decision
    // ("GRANT PERMISSION AND REFUSE PERMISSION") beats a truncated one.
    if (v.length > (best?.length ?? 0)) best = v;
  }
  return best;
}

// Canonical status labels + a lightweight mapper for a single live portal
// status string (the bundle already carries the baked national status; this
// only maps the live value we read on demand). Mirrors server/src/normalize.ts.
const STATUS_LABELS = {
  pending: "Pending decision",
  further_info: "Further information",
  granted: "Granted",
  refused: "Refused",
  withdrawn: "Withdrawn",
  invalid: "Invalid",
  incomplete: "Incomplete",
  appealed: "Under appeal",
  split: "Split decision",
  decided: "Decided",
  unknown: "Unknown",
};
const LIVE_STATUS_RULES = [
  [/appeal/i, "appealed"],
  [/further\s*info|f\.?i\.?\s*(req|rec)|additional information/i, "further_info"],
  [/withdraw/i, "withdrawn"],
  [/incomplete|not\s*valid/i, "incomplete"],
  [/invalid/i, "invalid"],
  [/split\s*decision|part\s*(ly)?\s*grant|grant.*(and|&|,|\/).*refus|refus.*(and|&|,|\/).*grant/i, "split"],
  [/refus|reject/i, "refused"],
  [/grant|approv|conditional|unconditional/i, "granted"],
  [/pending|new application|under consideration|awaiting|received|registered|live|validat|assess|lodged|acknowledg|referral/i, "pending"],
];
// A stage that means "a decision exists, read the Decision field" — mirrors
// DECIDED_OPAQUE in server/src/normalize.ts. Without "decision notice", the
// agile portals' "Decision Notice Issued" stage maps to nothing.
const DECIDED_OPAQUE =
  /finalised|finalized|decision made|decision notice|notification of decision|decided|closed|\bcomplete/i;
function liveDecisionToStatus(dec) {
  const d = String(dec ?? "").trim();
  if (!d) return null;
  if (/split\s*decision/i.test(d) || (/grant|approv|conditional/i.test(d) && /refus|reject/i.test(d)))
    return "split";
  // Section 5 outcomes — before grant/refuse: councils phrase certificates as
  // "GRANT/REFUSE CERTIFICATE OF EXEMPTION". Mirrors normalize.ts.
  if (/exempt/i.test(d)) {
    const no = /not\s+exempt|refus|reject/i.test(d);
    const yes = /exempt/i.test(d.replace(/not\s+exempt/gi, "")) && !/refus|reject/i.test(d);
    if (yes && no) return "split";
    return no ? "not_exempt" : "exempt";
  }
  if (/refus|reject/i.test(d)) return "refused";
  if (/grant|approv|conditional/i.test(d)) return "granted";
  if (/withdraw/i.test(d)) return "withdrawn";
  if (/invalid|declared\s+inv/i.test(d)) return "invalid";
  if (/declar|is\s+(not\s+)?development/i.test(d)) return "decided";
  return null;
}
function liveStatusFromRules(s) {
  for (const [re, status] of LIVE_STATUS_RULES) if (re.test(s)) return status;
  return null;
}
// Maps a live portal status (and its decision, when present) onto a canonical
// status. Unlike the ingest normaliser it never defaults a blank read to
// "pending" — this is only ever used to correct a baked status, and an empty
// live read carries no signal.
function mapLiveStatus(raw, decision) {
  const s = String(raw ?? "").trim();
  if (s) {
    if (DECIDED_OPAQUE.test(s)) return liveDecisionToStatus(decision) ?? liveStatusFromRules(s) ?? "unknown";
    const viaRules = liveStatusFromRules(s);
    if (viaRules) return viaRules;
  }
  return liveDecisionToStatus(decision) ?? "unknown";
}

// Normalise to the canonical "D15 YF1W" form; null unless a real Eircode
// (routing key + 4-char unique identifier, D6W special-cased) — Dublin
// tenants often put old postal districts ("2.") in the same field.
function normaliseEircode(raw) {
  const s = String(raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const m = s.match(/^(D6W|[A-Z]\d{2})([A-Z0-9]{4})$/);
  return m ? `${m[1]} ${m[2]}` : null;
}

// The case officer's name ("officerName", tenant naming varies) — skip their
// contact fields and the separate planning-manager role.
function pickOfficer(d) {
  let best = null;
  for (const [key, value] of Object.entries(d)) {
    if (typeof value !== "string" || !/officer/i.test(key)) continue;
    if (/email|tel|phone/i.test(key)) continue;
    const v = value.trim();
    if (v && v.length > (best?.length ?? 0)) best = v;
  }
  return best;
}

// Detail fetch for a known agile id — the nightly harvest caches resolved ids
// in Neon and skips the slow resolveAgileId search step entirely.
async function fetchAgileDetailById(authorityId, id, debug = false) {
  const client = AGILE_CLIENT_BY_AUTHORITY[authorityId];
  if (!client) return null;
  const d = await agileGetJson(`${AGILE_API}/application/${id}`, client);
  if (!d || typeof d !== "object") return null;
  return {
    applicant: joinName(d.applicantForename, d.applicantSurname, d.applicantName),
    agent: joinName(d.agentForename, d.agentSurname, d.agentName),
    status: pickAgileStatus(d),
    decision: pickAgileDecision(d),
    description: pickDescription(d),
    eircode: normaliseEircode(d.postcode),
    officer: pickOfficer(d),
    application_type:
      typeof d.applicationType === "string" && d.applicationType.trim() ? d.applicationType.trim() : null,
    ...(debug ? { keys: Object.keys(d) } : {}),
  };
}

async function fetchAgileDetail(authorityId, sourceUrl, reference, debug = false) {
  const client = AGILE_CLIENT_BY_AUTHORITY[authorityId];
  if (!client) return null;
  const cacheKey = `agile-detail:${authorityId}:${reference}`;
  if (!debug && PARTIES_CACHE.has(cacheKey)) return PARTIES_CACHE.get(cacheKey);
  const id = await resolveAgileId(client, sourceUrl, reference);
  if (!id) return null;
  const detail = await fetchAgileDetailById(authorityId, id, debug);
  if (!detail) return null;
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

// Map overlays (zoning, conservation, archaeology) as GeoJSON for a
// viewport. Mirrors server/src/overlays.ts.
// NPWS designated areas: the npws.ie webservices host is dead; this DHLGH
// ArcGIS Online mirror is the live public endpoint (CC-BY, via data.gov.ie).
// Sub-layers: 0=SPA, 1=pNHA, 2=NHA, 3=SAC.
const NPWS_URL =
  process.env.PLANVIEW_NPWS_URL ??
  "https://services-eu1.arcgis.com/Jhij7i46ouO8Cc0N/arcgis/rest/services/NPWSDesignatedAreas/FeatureServer";
const SAC_URL = process.env.PLANVIEW_SAC_URL ?? `${NPWS_URL}/3/query`;
const NPWS_SOURCES = [
  { url: SAC_URL, designation: "Special Area of Conservation" },
  { url: `${NPWS_URL}/0/query`, designation: "Special Protection Area" },
  { url: `${NPWS_URL}/2/query`, designation: "Natural Heritage Area" },
  { url: `${NPWS_URL}/1/query`, designation: "Proposed Natural Heritage Area" },
];
// National Monuments Service: Zones of Archaeological Notification (RMP).
const SMR_ZONE_URL =
  process.env.PLANVIEW_SMR_ZONE_URL ??
  "https://services-eu1.arcgis.com/HyjXgkV6KGMSF3jt/arcgis/rest/services/SMRZoneOpenData/FeatureServer/0/query";
const OVERLAY_CONFIG = {
  zoning: { url: GZT_URL, where: "CURRENT_PLAN=1", outFields: "ZONE_ORIG,ZONE_DESC,GZT_DESC,PLAN_NAME" },
  archaeology: { url: SMR_ZONE_URL, where: "1=1", outFields: "ZONE_ID" },
};
const CONSERVATION_FIELDS = "SITECODE,SITE_NAME,URL";
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
function ovTransform(layer, features, designation) {
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
    } else if (layer === "conservation") {
      f.properties = {
        site_name: ovStr(p.SITE_NAME) || designation || "Designated site",
        site_code: ovStr(p.SITECODE),
        site_url: ovStr(p.URL),
        designation: designation ?? "",
      };
    } else if (layer === "archaeology") {
      f.properties = { zone_ref: ovStr(p.ZONE_ID) };
    }
    return f;
  });
}
async function ovQueryArcGis(cfg, bbox) {
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
    if (!res.ok) return [];
    const body = await res.json();
    if (body.error || body.type !== "FeatureCollection" || !Array.isArray(body.features)) return [];
    return body.features;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
async function fetchOverlay(layer, bbox) {
  if (layer === "conservation") {
    const batches = await Promise.all(
      NPWS_SOURCES.map((src) =>
        ovQueryArcGis({ url: src.url, where: "1=1", outFields: CONSERVATION_FIELDS }, bbox)
      )
    );
    const features = batches.flatMap((feats, i) => ovTransform(layer, feats, NPWS_SOURCES[i].designation));
    return { type: "FeatureCollection", features };
  }
  const cfg = OVERLAY_CONFIG[layer];
  if (!cfg) return EMPTY_FC;
  const features = await ovQueryArcGis(cfg, bbox);
  return { type: "FeatureCollection", features: ovTransform(layer, features) };
}

const CONDITIONS_CACHE = new Map();

/**
 * Decision substance from /application/{id}/conditions — "prescriptions"
 * coded by kind: C condition of grant, R reason for refusal, D directive
 * (what an F.I. request asked for), I informative, N note.
 */
async function fetchAgileConditions(authorityId, sourceUrl, reference, trace) {
  const client = AGILE_CLIENT_BY_AUTHORITY[authorityId];
  if (!client) return null;
  const cacheKey = `${authorityId}:${reference}`;
  if (!trace && CONDITIONS_CACHE.has(cacheKey)) return CONDITIONS_CACHE.get(cacheKey);
  const id = await resolveAgileId(client, sourceUrl, reference, trace);
  if (!id) return null;
  const url = `${AGILE_API}/application/${id}/conditions`;
  const d = await agileGetJson(url, client);
  trace?.push({
    step: "agile_conditions",
    url,
    bodySnippet: JSON.stringify({
      keys: d && typeof d === "object" ? Object.keys(d) : null,
      decisionText: d?.decisionText ?? null,
      prescriptionCount: d?.applicationPrescriptions?.length ?? 0,
      codes: (d?.applicationPrescriptions ?? []).map((p) => p.prescriptionCode),
      // The raw payload so a differently-shaped tenant response (reasons under
      // an unexpected key) is visible rather than silently read as empty.
      raw: JSON.stringify(d ?? null).slice(0, 1500),
    }).slice(0, 2500),
  });
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

// Parse the eplanning "Related Applications" table (Kildare): a table inside
// <div id="DivRelatedApplications"> with columns File No, Status, Type,
// Decision, Received, Name, Address, Description. Loose markup (unclosed <a>),
// so parse by rows/cells. Empty when the section is absent — never a wrong guess.
function parseEplanningRelated(html, selfId) {
  const section = html.match(/id="DivRelatedApplications"[\s\S]*?<table[\s\S]*?<\/table>/i);
  if (!section) return [];
  const out = [];
  const seen = new Set();
  for (const row of section[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const body = row[1];
    if (/<th[\s>]/i.test(body)) continue;
    const cells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length < 8) continue;
    const eplanningId = cells[0].match(/AppFileRefDetails\/(\d+)/i)?.[1];
    if (!eplanningId || eplanningId === selfId || seen.has(eplanningId)) continue;
    seen.add(eplanningId);
    const text = (i) => decodeEntities(stripTags(cells[i] ?? "")).trim() || null;
    const dm = (cells[4] ?? "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
    out.push({
      reference: text(0) ?? eplanningId,
      eplanningId,
      statusText: text(1),
      decisionCode: text(3),
      received: dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : null,
      address: text(6),
      description: text(7),
    });
  }
  return out;
}

// Kildare single-letter decision codes → decision text mapLiveStatus understands.
function expandDecisionCode(code) {
  const c = String(code ?? "").trim().toUpperCase();
  if (c === "R") return "REFUSE PERMISSION";
  if (c === "C" || c === "G" || c === "U") return "GRANT PERMISSION";
  if (c === "W") return "WITHDRAWN";
  if (c === "I") return "INVALID";
  return null;
}

async function fetchEplanningRelated(sourceUrl) {
  if (!/eplanning\.ie\/.+AppFileRefDetails/i.test(sourceUrl)) return [];
  const selfId = sourceUrl.match(/AppFileRefDetails\/(\d+)/i)?.[1] ?? null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
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

/**
 * Every failure here returns null, which is right for callers (a missing
 * summary must never break a sheet) but leaves "the AI isn't generating"
 * indistinguishable from a timeout, a rate limit and a refusal. Pass `trace`
 * to record which one it was; /enrich?debug=1 surfaces it.
 */
async function callHaiku(systemPrompt, userMsg, trace) {
  if (!ANTHROPIC_API_KEY) {
    trace?.push({ step: "haiku", error: "ANTHROPIC_API_KEY not set" });
    return null;
  }
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
    if (!res.ok) {
      trace?.push({ step: "haiku", status: res.status, error: (await res.text()).slice(0, 300) });
      return null;
    }
    const data = await res.json();
    const text = data.content?.find((b) => b.type === "text")?.text?.trim() || null;
    trace?.push({
      step: "haiku",
      status: res.status,
      stop_reason: data.stop_reason ?? null,
      reply: text,
    });
    return text;
  } catch (err) {
    // An abort here is the 10s timeout, which is worth telling apart from a
    // network failure — long descriptions are the ones that hit it.
    trace?.push({
      step: "haiku",
      error: err?.name === "AbortError" ? "timed out after 10s" : String(err?.message ?? err),
    });
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

const DOC_READ_PROMPT =
  "You read a document from an Irish planning application file (inspector's report, decision order, " +
  "planner's report, submission…) and answer a question about it for a planning research assistant. " +
  "Be concrete and specific: report what the document actually says — recommendations, conditions, " +
  "reasons, figures, dates, who said what — in plain English a regular person follows. " +
  "FORMAT: plain prose only — no Markdown, headings or bullet points. " +
  "If the document does not answer the question, say so briefly and state what it does contain. " +
  "Use only what the document states — never invent details.";

// Agent tool backend: unlike the summary prompts, "the document doesn't say"
// is a legitimate answer here — the agent relays it — so no INSUFFICIENT gate.
async function readDocumentWithClaude(pdfBase64, context, question) {
  const ask = question?.trim() || "Summarise this document's key points for a general reader.";
  const content = [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
    { type: "text", text: `${context}\n\n${ask}` },
  ];
  const text = await callClaude(DOC_READ_PROMPT, content, 700, 45000);
  return text ? sanitiseSummary(text) : null;
}

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
// Appeal docs (ABP/ACP board order, inspector's report) carry the appeal
// reasons, surfaced separately — never pick them for the council decision.
const APPEAL_DOC_RE =
  /board\s*(order|direction)|an\s*bord|coimisi|plean[aá]la|\babp\b|\bacp\b|inspector|\bappeal/i;
// Not the planning decision order: forms, Part V / social-housing exemption
// certs (s.96/97), maps/drawings, notices, correspondence, submissions.
const NON_DECISION_DOC_RE =
  /application form|part\s*v\b|exemption|section\s*9[67]\b|social housing|site (notice|location)|\bmaps?\b|drawing|\bplans?\b|elevation|photograph|receipt|\bfees?\b|cover(ing)? letter|acknowledg|further information|\bf\.?i\.?\b|submission|observation|objection|correspond/i;
// Pick the council's own decision order: exclude appeal/non-decision docs, then
// score by how decision-order-like the title is, preferring one consistent with
// the recorded outcome. -1 when none, so the box shows its empty state.
function findDecisionDocIndex(files, decision) {
  const wantRefusal = /refus|reject/i.test(decision ?? "");
  const wantGrant = /grant|approv|conditional/i.test(decision ?? "");
  let best = -1;
  let bestScore = 0;
  files.forEach((f, i) => {
    const t = f.title;
    if (APPEAL_DOC_RE.test(t) || NON_DECISION_DOC_RE.test(t)) return;
    let score = 0;
    if (/notification of decision/i.test(t)) score += 5;
    if (/order to (grant|refuse)/i.test(t)) score += 5;
    if (/decision order|\bdecision\b/i.test(t)) score += 3;
    if (/manager.?s order|chief executive.?s order/i.test(t)) score += 2;
    if (/\border\b/i.test(t)) score += 1;
    if (score === 0) return;
    if (wantRefusal && /refus|reject/i.test(t)) score += 2;
    if (wantGrant && /\bgrant/i.test(t)) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
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

async function summariseDescription(description, applicationType, trace) {
  if (!description) {
    trace?.push({ step: "summarise", error: "no description to summarise" });
    return null;
  }
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
  const raw = await callHaiku(systemPrompt, userMsg, trace);
  const text = isUsableSummary(raw);
  // The guard drops INSUFFICIENT and anything that addresses the reader. That
  // is a different failure from the model never answering, and used to look
  // identical from outside.
  if (raw && !text) trace?.push({ step: "summarise", error: "reply rejected by isUsableSummary" });
  if (text) AI_SUMMARY_CACHE.set(description, text);
  return text;
}

const REFUSAL_SUMMARY_CACHE = new Map();

async function summariseRefusal(appId, reasons) {
  if (!reasons.length) return null;
  if (REFUSAL_SUMMARY_CACHE.has(appId)) return REFUSAL_SUMMARY_CACHE.get(appId);
  const systemPrompt =
    "You explain why an Irish council refused a planning application, in one short sentence " +
    'of plain English starting with "Refused because". The reader is a regular person, not a planner. ' +
    "For refusals on planning merits, name the actual problems (too close to a sewer, would overlook " +
    "neighbours, no drainage details, out of character with the area…) rather than the policy or plan " +
    "citation numbers. For procedural or statutory refusals — e.g. an extension of duration refused " +
    "because works had not commenced or the legal basis was removed, or an application refused as " +
    "invalid or out of time — explain that reason plainly in everyday terms (say why permission or the " +
    "extension could no longer be granted). Always produce a sentence when a reason is given. " +
    "If there are several reasons, mention the main ones. Keep it under 40 words. " +
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

/**
 * Null-valued fields are stripped from the bundle rows at export (see
 * export-json.ts) — most applications have most fields empty, so writing them
 * out cost roughly a quarter of the file. This puts them back on the way out,
 * so every API response keeps the shape it has always had. Empty for an older
 * bundle that has no field list, which simply means nothing to restore.
 */
const NULL_ROW = Object.freeze(
  Object.fromEntries((BUNDLE.application_fields ?? []).map((k) => [k, null]))
);

function publicApp(a) {
  const auth = AUTH.get(a.authority_id);
  const agile = Boolean(AGILE_SLUGS[a.authority_id]);
  // Boundaries are served by /api/map/polygons from the sidecar and are no
  // longer written into bundle rows at all; stripped here so an older bundle
  // that still carries the field can't inline kilobytes per row.
  const { geom_polygon: _gp, ...rest } = a;
  return {
    ...NULL_ROW,
    ...rest,
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
  // Absent params must stay absent: Number(null) is 0, which put "near" at
  // lat/lng 0,0 and annotated every result with a ~5,950 km distance.
  const latRaw = p.get("lat"), lngRaw = p.get("lng");
  if (!latRaw || !lngRaw) return null;
  const lat = Number(latRaw), lng = Number(lngRaw);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function applyFilters(rows, p) {
  const auths = csv(p.get("authority"));
  const statuses = csv(p.get("status"));
  const excludeStatuses = csv(p.get("excludeStatus"));
  const types = csv(p.get("type"));
  const domestic = p.get("domestic") === "1" || p.get("domestic") === "true";
  const oneOff = p.get("one_off") === "1" || p.get("one_off") === "true";
  const appealed = p.get("appealed") === "1" || p.get("appealed") === "true";
  const commenced = p.get("commenced") === "1" || p.get("commenced") === "true";
  const rf = p.get("receivedFrom"), rt = p.get("receivedTo");
  const df = p.get("decisionFrom"), dt = p.get("decisionTo");
  const minUnits = Number(p.get("minUnits")) || 0;
  const bbox = parseBbox(p.get("bbox"));
  return rows.filter((a) => {
    if (auths && !auths.includes(a.authority_id)) return false;
    if (statuses && !statuses.includes(a.status)) return false;
    if (excludeStatuses && excludeStatuses.includes(a.status)) return false;
    if (types && !types.includes(a.application_type)) return false;
    if (domestic && a.is_domestic_guess !== 1) return false;
    if (oneOff && a.is_one_off !== 1) return false;
    if (appealed && !a.appeal_reference) return false;
    if (commenced && !a.commencement_date) return false;
    if (rf && (!a.received_date || a.received_date < rf)) return false;
    if (rt && (!a.received_date || a.received_date > rt)) return false;
    if (df && (!a.decision_date || a.decision_date < df)) return false;
    if (dt && (!a.decision_date || a.decision_date > dt)) return false;
    if (minUnits && !(a.num_residential_units >= minUnits)) return false;
    if (bbox) {
      const [w, s, e, n] = bbox;
      if (a.lng == null || a.lat == null) return false;
      if (a.lng < w || a.lng > e || a.lat < s || a.lat > n) return false;
    }
    return true;
  });
}

/**
 * Does this query look like a planning reference — "3456/25", "D25A/0123",
 * "WEB1234/25", "211277"? Reference-shaped queries must never fall back to
 * fuzzy matching: a "close match" on a reference is a *different property*,
 * and someone who typed a reference wants that file or nothing.
 */
/**
 * A full or partial Eircode — "W23 Y2W8", "W23Y2W8", or a bare routing key
 * ("W23", "D15", "D6W"). Same protection as a reference: an Eircode identifies
 * one property, so a trigram "close match" is always a *different* address.
 */
function looksLikeEircode(q) {
  const s = q.trim().toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9]+$/.test(s)) return false;
  if (!/^(D6W|[A-Z]\d{2})/.test(s)) return false;
  return s.length === 3 || s.length === 7;
}

function looksLikeReference(q) {
  const s = q.trim();
  if (!s || /\s/.test(s)) return false;
  if (!/^[A-Za-z0-9/\-.]+$/.test(s)) return false;
  return (s.match(/\d/g)?.length ?? 0) >= 2;
}

/**
 * Field-weighted relevance: a reference match beats an address match, which
 * beats an applicant, which beats a passing mention in the description.
 * Mirrors the BM25 column weights the SQLite backend uses — without it, exact
 * matches came back in bundle order, so a road-name search was arbitrary.
 */
function relevanceScore(app, tokens) {
  const fields = [
    [String(app.planning_reference ?? "").toLowerCase(), 12],
    [String(app.address_text ?? "").toLowerCase(), 8],
    [String(app.applicant_name ?? "").toLowerCase(), 4],
    [String(app.description ?? "").toLowerCase(), 1],
  ];
  let score = 0;
  for (const t of tokens) {
    for (const [text, weight] of fields) {
      if (text.includes(t)) {
        score += weight;
        break; // strongest field wins for this token
      }
    }
  }
  return score;
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
      // Relevance is the default order for a keyword search; an explicit date
      // sort below overrides it.
      rows = exact
        .map((a) => ({ a, s: relevanceScore(a, tokens) }))
        .sort((x, y) => y.s - x.s)
        .map((x) => ({ ...x.a, match_quality: "exact" }));
    } else if (looksLikeReference(q) || looksLikeEircode(q)) {
      rows = [];
    } else {
      fuzzy = true;
      const qt = trigrams(q);
      const idx = triIndex();
      const hits = new Map();
      for (const g of qt) {
        const ids = idx.get(g);
        if (ids) for (const id of ids) hits.set(id, (hits.get(id) ?? 0) + 1);
      }
      rows = rows
        .map((a) => ({ a, score: qt.size ? (hits.get(a.id) ?? 0) / qt.size : 0 }))
        .filter((x) => x.score >= 0.45)
        .sort((x, y) => y.score - x.score)
        .map((x) => ({ ...x.a, match_quality: "fuzzy" }));
    }
  }

  const near = parseNear(p);
  if (near) {
    // Copy before annotating — the no-q path returns shared BUNDLE rows, and
    // mutating them leaks this request's distances into later responses.
    rows = rows.map((r) =>
      r.lat != null && r.lng != null
        ? { ...r, distance_km: Math.round(haversineKm(near.lat, near.lng, r.lat, r.lng) * 100) / 100 }
        : r
    );
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

/* ------------------------------------------------------------------ */
/* Planning agent (POST /api/agent) — mirror of server/src/agent/*     */
/* ------------------------------------------------------------------ */

const AGENT_MODEL = "claude-sonnet-5";
const AGENT_MAX_TURNS = 12;
const AGENT_MAX_TOKENS = 4000;
const AGENT_TOOL_RESULT_CAP = 30_000;

/** Per-council register depth, appended to the agent prompt at call time so the
 *  model can tell "we don't hold that year" from "it doesn't exist". */
function coverageFloorsClause() {
  const held = BUNDLE.authorities.filter((a) => a.earliest_received && a.application_count > 0);
  if (!held.length) return "";
  const list = held.map((a) => `${a.name}: from ${a.earliest_received}`).join("; ");
  return `\n\nCOVERAGE HELD (earliest application on file per council) — ${list}.`;
}

const AGENT_SYSTEM_PROMPT = `You are the PlanView planning agent. You help people in Ireland understand what has \
happened with planning applications so they can form their own picture — typically a homeowner wondering about an \
extension, rebuild or new dwelling, or a professional researching an area.

COVERAGE: Dublin City, Fingal, Dún Laoghaire-Rathdown, South Dublin and Kildare county councils. Data comes from the \
statutory planning registers. Appeals are decided nationally by An Coimisiún Pleanála (formerly An Bord Pleanála) and \
a decided appeal replaces the council's decision.

EVIDENCE, NOT PREDICTIONS: You present what the register shows — grant/refusal outcomes on comparable applications, \
the conditions imposed, refusal reasons, appeal outcomes, zoning. You never predict whether the user would get \
permission, never estimate probabilities, and never give legal or professional advice. Let the evidence speak; the \
user draws the conclusion. If asked "will I get permission", explain you can only show what happened in comparable \
cases nearby.

CLARIFY VAGUE LOCATIONS: A townland or town name alone ("Maynooth") is usually too broad — zoning and comparables \
differ street to street. When the location is vague, ask one short clarifying question requesting a more specific \
address, street or eircode, and stop. When it is specific enough, proceed without nagging.

RESEARCH APPROACH: Typically geocode_location first. Then call count_applications scoped near those coordinates \
(with keywords and likely-domestic filter where relevant) to establish the full set BEFORE looking at examples. Then \
call search_applications for a sample of specific applications to cite. Then examine the most comparable ones: \
get_conditions on granted ones, get_conditions on refused ones (reasons), get_appeal on any with an appeal reference, \
and get_zoning on the closest application to describe the area's designation. Fetch conditions for at most 5 \
applications per reply. Prefer recent applications (last ~5 years) when plenty exist.

READING DOCUMENTS: You can open and read the actual documents, not just list them. read_appeal_document fetches a \
document from an An Coimisiún Pleanála case file (inspector's report, Board order, Board direction) and answers a \
question about what it says — use it when the user asks what the inspector recommended, why the Board decided as it \
did, or what changed on appeal. read_document does the same for the council's own file: call get_documents first, \
then pass words from the chosen title (planner's reports, decision orders and submissions are usually PDFs and \
readable; drawings and maps often are not). Pass the user's actual question in the question field so the answer is \
specific. These are slow — read at most 2 documents per reply, and only when the register fields and get_conditions \
don't already answer the question.

SCOPE AND SAMPLING — BE EXPLICIT, NEVER GUESS FROM A HANDFUL: All rates and counts you quote (grant vs refusal, how \
many domestic, how many commenced) must come from count_applications over the WHOLE set — never inferred from the \
capped sample. search_applications returns at most 50 rows: that is a SAMPLE for citing individual examples, not the \
basis for statistics. Always open an area answer by stating the size of the set and the scope, e.g. "There are 214 \
domestic applications within 1 km — 63% granted, 22% refused." Then say which sample you looked at and on what basis, \
e.g. "I've highlighted the 25 nearest." Default scope for a specific address is a 1 km radius and the nearest 25 as \
the example sample. When the matching set is much larger than the sample, or the area is broad, proactively offer to \
adjust — a wider or tighter radius (e.g. 500 m or 3 km), a larger sample (up to 50), or a different basis (nearest, \
most recent) — and invite the user to change it. Honour such requests via radius_km, limit and sort. Invalid and \
incomplete applications are excluded by default (abandoned part-submissions); do not mention them unless asked, and \
only include them if the user specifically wants them.

PLANNING AUTHORITY MATTERS: Each council decides independently, with its own development plan, zoning and house \
style, so comparables are most relevant when they are in the SAME authority that would decide the user's proposal — \
the authority_id returned by geocode_location for their location. A radius near a county/city boundary can span two \
or more authorities; count_applications returns by_authority for exactly this reason. When the set spans more than \
one authority, say so and give the split, lead with the authority that would decide the user's case, and treat other \
authorities as secondary context — never present a single blended grant/refusal rate across authorities as if one \
body produced it. If the user's own authority has few local comparables, say that plainly rather than leaning on a \
neighbouring council's record.

COVERAGE FLOORS — WHAT "NONE FOUND" MEANS: The register depth here is uneven per council, and the floors are \
supplied to you below. A search that returns nothing before a council's floor means WE DO NOT HOLD THAT YEAR, not \
that nothing was applied for. Never say a property has no planning history, or that a precedent does not exist, on \
the basis of an empty result that falls outside the years held — say what we hold and point at the council's own \
register for anything earlier.

CONDITIONS — SUBSTANTIVE VS BOILERPLATE: Most grants carry near-identical boilerplate conditions (construction hours, \
noise limits, site tidiness, development contributions, water/drainage standards). Do not present these as a pattern — \
mention at most in passing. Emphasise substantive conditions that changed what could be built: omit or reduce part of \
the works, ridge-height reductions, obscure glazing or fixed windows, matching materials, setbacks from boundaries, \
removal of permitted-development rights.

COMMENCEMENT: Applications carry BCMS building-control fields — commencement_date (a commencement notice was \
filed; works started, or start within ~4 weeks when the date is in the future) and completion_date (certified \
complete). Use these to say whether a granted permission was actually acted on, and search with commenced_only to \
find building activity in an area (disruption nearby, supply actually materialising, competitor activity). Absence \
of a notice is evidence work has not started, not proof — some notices cite unmatchable reference numbers.

ZONING: When zoning is relevant to the question, name the zone and what it is designated for, and relate it to the \
proposal type (e.g. residential extensions in an established-residential zone are routine matters of amenity and design).

FORMAT: Short paragraphs and **bold** for key facts only — no headings, no numbered section titles, no tables, no \
links, no long essays. Do NOT use bullet lists to present applications: write each property as a short paragraph — \
bold its address, then put its token on the next line. When you reference a specific application, put a token like \
[app:id:35269] — the literal text "app:id:" followed by the numeric id from a tool result — on its own line where \
its card should appear; the interface renders it as a clickable card. Cite each application only once, the first time \
you discuss it — do not repeat its token if the property comes up again. Do not fabricate ids; only use ids returned \
by tools. Do not put the token inside a sentence.

If a tool returns an error or nothing, say plainly what could not be checked rather than guessing.`;

const AGENT_STATUSES = [
  "pending", "further_info", "granted", "refused",
  "withdrawn", "invalid", "incomplete", "appealed", "split", "decided",
];

const AGENT_TOOLS = [
  {
    name: "count_applications",
    description:
      "Count and break down ALL applications matching the filters — the true size of the set, with no " +
      "result cap. Returns total plus breakdowns by status, type and year and counts of domestic, " +
      "granted, refused, appealed and commenced. Use this FIRST for any area/pattern question to " +
      "establish the denominator and compute rates over the whole set — never estimate rates from a " +
      "sample. Same filters as search_applications. Invalid/incomplete applications are excluded by " +
      "default (set include_invalid to count them).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, e.g. 'two storey extension'" },
        statuses: { type: "array", items: { type: "string", enum: AGENT_STATUSES } },
        domestic_only: { type: "boolean" },
        appealed_only: { type: "boolean" },
        commenced_only: { type: "boolean" },
        include_invalid: {
          type: "boolean",
          description: "Include invalid/incomplete applications (excluded by default as they are usually junk)",
        },
        near: {
          type: "object",
          properties: { lat: { type: "number" }, lng: { type: "number" } },
          required: ["lat", "lng"],
        },
        radius_km: { type: "number", description: "Search radius in km, used with near" },
        received_from: { type: "string", description: "ISO date lower bound on received date" },
        received_to: { type: "string", description: "ISO date upper bound on received date" },
      },
    },
  },
  {
    name: "search_applications",
    description:
      "Return a sample of individual applications (for citing specific examples). Full-text over address, " +
      "planning reference, applicant and description, with filters. Returns summaries including id, status, " +
      "decision, dates and coordinates. Capped at 50, so this is a SAMPLE — get the full-set stats from " +
      "count_applications, and use this for the specific examples you cite. Choose the sample basis with " +
      "sort (nearest / recent / relevance) and say which you used. Invalid/incomplete applications are " +
      "excluded by default.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, e.g. 'two storey extension'" },
        statuses: { type: "array", items: { type: "string", enum: AGENT_STATUSES } },
        domestic_only: { type: "boolean", description: "Restrict to likely-domestic applications" },
        appealed_only: { type: "boolean", description: "Only applications that went to appeal" },
        commenced_only: {
          type: "boolean",
          description:
            "Only permissions where a commencement notice was filed with building control — i.e. work actually started (or is about to)",
        },
        include_invalid: {
          type: "boolean",
          description: "Include invalid/incomplete applications (excluded by default as they are usually junk)",
        },
        sort: {
          type: "string",
          enum: ["nearest", "recent", "relevance"],
          description:
            "Sample basis: 'nearest' (needs near; the true closest N), 'recent' (most recently received), " +
            "or 'relevance' (best keyword match). Defaults to nearest when near is given, else recent.",
        },
        near: {
          type: "object",
          properties: { lat: { type: "number" }, lng: { type: "number" } },
          required: ["lat", "lng"],
        },
        radius_km: { type: "number", description: "Search radius in km, used with near" },
        received_from: { type: "string", description: "ISO date lower bound on received date" },
        received_to: { type: "string", description: "ISO date upper bound on received date" },
        limit: { type: "number", description: "Sample size, default 25, cap 50" },
      },
    },
  },
  {
    name: "get_application_detail",
    description:
      "Full register detail for one application by id: description, applicant, all dates, decision, " +
      "appeal fields, units, floor area, commencement, portal link.",
    input_schema: {
      type: "object",
      properties: { application_id: { type: "number" } },
      required: ["application_id"],
    },
  },
  {
    name: "get_conditions",
    description:
      "Conditions of grant or reasons for refusal for one application. Only available for the four " +
      "Dublin (agile) councils; for Kildare the register holds the outcome but not the conditions text. " +
      "Codes: C=condition, R=refusal reason, D=further-info directive, I=informative, N=note.",
    input_schema: {
      type: "object",
      properties: { application_id: { type: "number" } },
      required: ["application_id"],
    },
  },
  {
    name: "get_zoning",
    description:
      "Land-use zoning at an application's location (zone code, name, generalised type) from the " +
      "national Generalised Zoning dataset. Use to explain what development the area is designated for.",
    input_schema: {
      type: "object",
      properties: { application_id: { type: "number" } },
      required: ["application_id"],
    },
  },
  {
    name: "get_appeal",
    description:
      "Appeal case details from An Coimisiún Pleanála for an application that was appealed: " +
      "parties, status, decision and case documents. Only call when the application has an appeal reference.",
    input_schema: {
      type: "object",
      properties: { application_id: { type: "number" } },
      required: ["application_id"],
    },
  },
  {
    name: "get_documents",
    description:
      "List the scanned files / documents the council holds for an application (drawings, reports, " +
      "decision orders), with titles. Slow: only call when the user asks about documents.",
    input_schema: {
      type: "object",
      properties: { application_id: { type: "number" } },
      required: ["application_id"],
    },
  },
  {
    name: "read_appeal_document",
    description:
      "Fetch one document from an appeal case file on An Coimisiún Pleanála — the inspector's report, " +
      "Board order or Board direction — read it, and answer a question about what it says (or summarise " +
      "it). Use after get_appeal when the user asks what a case document actually says, e.g. what the " +
      "inspector recommended. Slow: fetches and reads a full PDF.",
    input_schema: {
      type: "object",
      properties: {
        application_id: { type: "number" },
        document: {
          type: "string",
          description:
            "Which document, as words from its title: e.g. 'inspector', 'board order', 'direction'. " +
            "Omit to read the main decision document.",
        },
        question: {
          type: "string",
          description: "What to find out from the document. Omit for a general summary.",
        },
      },
      required: ["application_id"],
    },
  },
  {
    name: "read_document",
    description:
      "Fetch one of the council's documents for an application (from the get_documents listing), read " +
      "it, and answer a question about what it says (or summarise it). Call get_documents first and " +
      "pass words from the chosen title. Works for PDFs only (most reports and orders are PDFs; " +
      "drawings often aren't). Slow: fetches and reads a full PDF.",
    input_schema: {
      type: "object",
      properties: {
        application_id: { type: "number" },
        title: { type: "string", description: "Words from the document title as listed by get_documents" },
        question: {
          type: "string",
          description: "What to find out from the document. Omit for a general summary.",
        },
      },
      required: ["application_id", "title"],
    },
  },
  {
    name: "geocode_location",
    description:
      "Resolve a placename, street or eircode within the covered counties to approximate coordinates " +
      "and the local authority, by matching addresses in the planning register. Returns null when no match — " +
      "then ask the user for a more specific address.",
    input_schema: {
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"],
    },
  },
];

/** Pick the listed title that best matches the model's words: prefer a title
    containing every word, fall back to any word. -1 when nothing matches. */
function matchDocumentTitle(titles, want) {
  const words = want.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return -1;
  const all = titles.findIndex((t) => words.every((w) => t.toLowerCase().includes(w)));
  if (all >= 0) return all;
  return titles.findIndex((t) => words.some((w) => t.toLowerCase().includes(w)));
}

function agentBboxAround(lat, lng, km) {
  const dLat = km / 111.32;
  const dLng = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

const AGENT_JUNK_STATUSES = ["invalid", "incomplete"];

/** Map tool input onto the query params runSearch() already understands. */
function agentSearchParams(input) {
  const p = new URLSearchParams();
  if (typeof input.query === "string" && input.query.trim()) p.set("q", input.query.trim());
  const statuses = Array.isArray(input.statuses) && input.statuses.length ? input.statuses.map(String) : null;
  if (statuses) p.set("status", statuses.join(","));
  // Drop invalid/incomplete junk unless a status set was given or opted in.
  else if (input.include_invalid !== true) p.set("excludeStatus", AGENT_JUNK_STATUSES.join(","));
  if (input.domestic_only === true) p.set("domestic", "1");
  if (input.appealed_only === true) p.set("appealed", "1");
  if (input.commenced_only === true) p.set("commenced", "1");
  if (typeof input.received_from === "string") p.set("receivedFrom", input.received_from);
  if (typeof input.received_to === "string") p.set("receivedTo", input.received_to);
  const lat = Number(input.near?.lat);
  const lng = Number(input.near?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    p.set("lat", String(lat));
    p.set("lng", String(lng));
    const radius = Number(input.radius_km);
    if (Number.isFinite(radius) && radius > 0) p.set("bbox", agentBboxAround(lat, lng, radius).join(","));
  }
  // Sample basis: nearest (needs near), recent, or relevance.
  const sort =
    input.sort === "recent" ? "received" :
    input.sort === "relevance" ? "relevance" :
    input.sort === "nearest" ? "distance" :
    (Number.isFinite(lat) && Number.isFinite(lng) ? "distance" : "received");
  if (sort === "distance" && Number.isFinite(lat) && Number.isFinite(lng)) p.set("sort", "distance");
  else if (sort === "received") p.set("sort", "received");
  return p;
}

/** Counts + breakdowns over the whole matching set (count_applications). */
function agentAggregate(input) {
  const rows = runSearch(agentSearchParams(input)).rows;
  const by = (key) => {
    const m = {};
    for (const a of rows) {
      const k = key(a);
      if (k != null && String(k).length) m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  };
  return {
    total: rows.length,
    by_authority: by((a) => a.authority_id),
    by_status: by((a) => a.status),
    by_type: by((a) => a.application_type),
    by_year: by((a) => (a.received_date ? a.received_date.slice(0, 4) : null)),
    domestic: rows.filter((a) => a.is_domestic_guess === 1).length,
    commenced: rows.filter((a) => a.commencement_date).length,
    appealed: rows.filter((a) => a.appeal_reference).length,
    granted: rows.filter((a) => a.status === "granted").length,
    refused: rows.filter((a) => a.status === "refused").length,
  };
}

function agentAppSummary(a) {
  return {
    id: a.id,
    authority_id: a.authority_id,
    planning_reference: a.planning_reference,
    description: a.description ?? null,
    status: a.status,
    status_label: BUNDLE.statuses[a.status] ?? a.status,
    application_type: a.application_type ?? null,
    is_domestic_guess: Boolean(a.is_domestic_guess),
    received_date: a.received_date ?? null,
    decision: a.decision ?? null,
    decision_date: a.decision_date ?? null,
    address_text: a.address_text ?? null,
    lat: a.lat ?? null,
    lng: a.lng ?? null,
    appeal_reference: a.appeal_reference ?? null,
    commencement_date: a.commencement_date ?? null,
    completion_date: a.completion_date ?? null,
    distance_km: a.distance_km,
  };
}

async function executeAgentTool(name, input) {
  const getApp = () => {
    const id = Number(input.application_id);
    return Number.isFinite(id) ? BUNDLE.applications.find((a) => a.id === id) ?? null : null;
  };
  switch (name) {
    case "count_applications": {
      return agentAggregate(input);
    }
    case "search_applications": {
      const limit = Math.min(Number(input.limit) || 25, 50);
      const p = agentSearchParams(input);
      const { rows, fuzzy } = runSearch(p);
      const sortParam = p.get("sort");
      const sample_basis = sortParam === "distance" ? "nearest" : sortParam === "received" ? "recent" : "relevance";
      const sample = rows.slice(0, limit);
      return { total: rows.length, fuzzy, returned: sample.length, sample_basis, results: sample.map(agentAppSummary) };
    }
    case "get_application_detail": {
      const app = getApp();
      if (!app) return { error: "Application not found" };
      const { geom_polygon: _g, ai_summary: _s, ...rest } = app;
      return rest;
    }
    case "get_conditions": {
      const app = getApp();
      if (!app) return { error: "Application not found" };
      if (!AGILE_CLIENT_BY_AUTHORITY[app.authority_id]) {
        return {
          available: false,
          note: "Conditions text is not published in a fetchable form by this council; the register holds only the decision outcome.",
        };
      }
      const conditions = await fetchAgileConditions(app.authority_id, app.source_url, app.planning_reference);
      return conditions ?? { available: false, note: "No conditions returned by the council system." };
    }
    case "get_zoning": {
      const app = getApp();
      if (!app) return { error: "Application not found" };
      if (app.lat == null || app.lng == null) return { error: "Application has no coordinates" };
      return (await fetchZoning(app.lat, app.lng)) ?? { error: "Zoning lookup failed" };
    }
    case "get_appeal": {
      const app = getApp();
      if (!app) return { error: "Application not found" };
      const url = abpCaseUrl(app.appeal_reference);
      if (!app.appeal_reference || !url) return { error: "No appeal on this application" };
      const kase = await fetchAppealCase(url);
      return kase ?? { error: "Could not load the appeal case page", case_url: url };
    }
    case "get_documents": {
      const app = getApp();
      if (!app) return { error: "Application not found" };
      const listUrl = scannedFilesUrl(app.authority_id, app.source_url, app.planning_reference);
      if (listUrl) {
        const files = await fetchScannedFileList(listUrl);
        if (!files) return { error: "Could not load the document list" };
        return { count: files.length, files: files.map((f) => ({ title: f.title })) };
      }
      if (AGILE_SLUGS[app.authority_id]) {
        const result = await fetchAgileDocumentList(app.authority_id, app.source_url, app.planning_reference);
        if (!result) return { error: "Could not load the document list" };
        return { count: result.files.length, files: result.files.map((f) => ({ title: f.title })) };
      }
      return { error: "No document listing available for this council" };
    }
    case "read_appeal_document": {
      const app = getApp();
      if (!app) return { error: "Application not found" };
      const url = abpCaseUrl(app.appeal_reference);
      if (!app.appeal_reference || !url) return { error: "No appeal on this application" };
      const kase = await fetchAppealCase(url);
      if (!kase) return { error: "Could not load the appeal case page", case_url: url };
      const pdfs = (kase.documents ?? []).filter((doc) => PDF_URL_RE.test(doc.url));
      if (!pdfs.length) return { error: "The case file lists no fetchable PDF documents", case_url: url };
      const want = typeof input.document === "string" ? input.document.trim() : "";
      let doc = null;
      if (want) {
        const idx = matchDocumentTitle(pdfs.map((d) => d.title), want);
        doc = idx >= 0 ? pdfs[idx] : null;
        if (!doc) return { error: "No case document matches that name", available: pdfs.map((d) => d.title) };
      } else {
        doc = pickAppealDocument(kase.documents ?? []);
      }
      if (!doc) return { error: "No readable case document", available: pdfs.map((d) => d.title) };
      const pdf = await fetchAppealDocumentBase64(doc.url);
      if (!pdf) {
        return {
          error: "Could not fetch that document (unreachable, not a PDF, or too large to read)",
          document: doc.title,
          available: pdfs.map((d) => d.title),
        };
      }
      const context =
        `Appeal ${app.appeal_reference} to An Coimisiún Pleanála — ` +
        `${app.address_text ?? app.planning_reference}. Document: ${doc.title}.`;
      const answer = await readDocumentWithClaude(pdf, context, input.question);
      if (!answer) return { error: "Fetched the document but could not read it", document: doc.title };
      return { document: doc.title, other_documents: pdfs.filter((d) => d !== doc).map((d) => d.title), answer };
    }
    case "read_document": {
      const app = getApp();
      if (!app) return { error: "Application not found" };
      const want = typeof input.title === "string" ? input.title.trim() : "";
      if (!want) return { error: "title is required — call get_documents first to see the titles" };
      const listUrl = scannedFilesUrl(app.authority_id, app.source_url, app.planning_reference);
      let fetched;
      let title;
      let titles;
      if (listUrl) {
        const files = await fetchScannedFileList(listUrl);
        if (!files) return { error: "Could not load the document list" };
        titles = files.map((f) => f.title);
        const idx = matchDocumentTitle(titles, want);
        if (idx < 0) return { error: "No document matches that title", available: titles };
        title = titles[idx];
        fetched = await fetchScannedDocument(listUrl, idx, 10_000_000);
      } else if (AGILE_CLIENT_BY_AUTHORITY[app.authority_id]) {
        const result = await fetchAgileDocumentList(app.authority_id, app.source_url, app.planning_reference);
        if (!result) return { error: "Could not load the document list" };
        titles = result.files.map((f) => f.title);
        const idx = matchDocumentTitle(titles, want);
        if (idx < 0) return { error: "No document matches that title", available: titles };
        title = titles[idx];
        fetched = await fetchAgileDocument(app.authority_id, app.source_url, app.planning_reference, idx, 10_000_000);
      } else {
        return { error: "No document listing available for this council" };
      }
      if (fetched === "too_large") return { error: "That document is too large to read", document: title };
      if (!fetched) return { error: "Could not fetch the document", document: title };
      const isPdf = /pdf/i.test(fetched.contentType) || /\.pdf$/i.test(fetched.filename ?? "");
      if (!isPdf) {
        return { error: `That document is not a PDF (${fetched.contentType}) — only PDFs can be read`, document: title };
      }
      const context =
        `Council document for planning application ${app.planning_reference} — ` +
        `${app.address_text ?? app.planning_reference}. Document: ${title}.`;
      const answer = await readDocumentWithClaude(fetched.body.toString("base64"), context, input.question);
      if (!answer) return { error: "Fetched the document but could not read it", document: title };
      return { document: title, answer };
    }
    case "geocode_location": {
      const q = typeof input.location === "string" ? input.location.trim() : "";
      if (!q) return { error: "location is required" };
      const params = new URLSearchParams({ q, sort: "relevance" });
      const { rows, fuzzy } = runSearch(params);
      const hit = rows.find((r) => r.lat != null);
      if (!hit) return null;
      return {
        matched_address: hit.address_text ?? hit.planning_reference,
        lat: hit.lat,
        lng: hit.lng,
        authority_id: hit.authority_id,
        confidence: fuzzy ? "approximate" : "exact",
      };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function* parseAgentSse(body) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.split("\n").find((l) => l.startsWith("data: "));
      if (data) {
        try {
          yield JSON.parse(data.slice(6));
        } catch {
          // skip malformed frames
        }
      }
    }
  }
}

async function* runAgent(messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    yield { type: "error", message: "The agent is not configured on this deployment (missing API key)." };
    yield { type: "done" };
    return;
  }
  const msgs = messages.map((m) => ({ role: m.role, content: m.content }));

  for (let turn = 0; turn < AGENT_MAX_TURNS; turn++) {
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: AGENT_MODEL,
          max_tokens: AGENT_MAX_TOKENS,
          stream: true,
          system: AGENT_SYSTEM_PROMPT + coverageFloorsClause(),
          tools: AGENT_TOOLS,
          messages: msgs,
        }),
      });
    } catch {
      yield { type: "error", message: "Could not reach the AI service." };
      yield { type: "done" };
      return;
    }
    if (!res.ok || !res.body) {
      yield { type: "error", message: `AI service error (${res.status}).` };
      yield { type: "done" };
      return;
    }

    const blocks = [];
    const partialJson = {};
    let stopReason = null;
    try {
      for await (const ev of parseAgentSse(res.body)) {
        if (ev.type === "error") {
          yield { type: "error", message: "The AI service reported an error." };
          yield { type: "done" };
          return;
        }
        if (ev.type === "content_block_start" && ev.content_block && ev.index !== undefined) {
          if (ev.content_block.type === "text") {
            blocks[ev.index] = { type: "text", text: ev.content_block.text ?? "" };
          } else if (ev.content_block.type === "tool_use") {
            blocks[ev.index] = {
              type: "tool_use",
              id: ev.content_block.id ?? "",
              name: ev.content_block.name ?? "",
              input: {},
            };
            partialJson[ev.index] = "";
          }
        } else if (ev.type === "content_block_delta" && ev.delta && ev.index !== undefined) {
          const block = blocks[ev.index];
          if (ev.delta.type === "text_delta" && block?.type === "text" && ev.delta.text) {
            block.text += ev.delta.text;
            yield { type: "text", text: ev.delta.text };
          } else if (ev.delta.type === "input_json_delta" && block?.type === "tool_use") {
            partialJson[ev.index] += ev.delta.partial_json ?? "";
          }
        } else if (ev.type === "content_block_stop" && ev.index !== undefined) {
          const block = blocks[ev.index];
          if (block?.type === "tool_use" && partialJson[ev.index]) {
            try {
              block.input = JSON.parse(partialJson[ev.index]);
            } catch {
              block.input = {};
            }
          }
        } else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
          stopReason = ev.delta.stop_reason;
        }
      }
    } catch {
      yield { type: "error", message: "The AI service connection dropped." };
      yield { type: "done" };
      return;
    }

    const toolUses = blocks.filter((b) => b?.type === "tool_use");
    if (stopReason === "tool_use" && toolUses.length) {
      msgs.push({ role: "assistant", content: blocks.filter(Boolean) });
      const results = [];
      for (const tu of toolUses) {
        yield { type: "tool_start", name: tu.name, input: tu.input };
        let out;
        try {
          out = await executeAgentTool(tu.name, tu.input);
        } catch (e) {
          out = { error: `Tool failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        yield { type: "tool_result", name: tu.name, result: out };
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(out ?? null).slice(0, AGENT_TOOL_RESULT_CAP),
        });
      }
      msgs.push({ role: "user", content: results });
      continue;
    }

    yield { type: "done" };
    return;
  }
  yield { type: "error", message: "The agent hit its research step limit — try a narrower question." };
  yield { type: "done" };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

async function handleAgentRoute(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  const body = await readJsonBody(req);
  const messages = (body?.messages ?? [])
    .filter(
      (m) =>
        (m?.role === "user" || m?.role === "assistant") &&
        typeof m?.content === "string" &&
        m.content.trim().length > 0
    )
    .map((m) => ({ role: m.role, content: m.content }))
    .slice(-30);
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return send(res, 400, { error: "messages must end with a user message" });
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  try {
    for await (const ev of runAgent(messages)) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  } catch {
    res.write(`data: ${JSON.stringify({ type: "error", message: "Agent crashed" })}\n\n`);
  } finally {
    res.end();
  }
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.searchParams;
  // Normalise the path: Build Output API may invoke this function with the
  // original path (/api/meta) or a rewritten one (/meta); accept both.
  let route = url.pathname.replace(/\/$/, "");
  if (!route.startsWith("/api")) route = "/api" + route;

  if (route === "/api/agent") {
    return handleAgentRoute(req, res);
  }

  if (isPreplanRoute(route)) {
    return handlePreplanRoute(req, res, route, url, {
      bundle: BUNDLE,
      executeAgentTool,
      callClaude,
    });
  }

  if (isAccountRoute(route)) {
    return handleAccountRoute(req, res, route, url, {
      findApp: (authorityId, reference) =>
        BUNDLE.applications.find(
          (a) => a.authority_id === authorityId && a.planning_reference === reference
        ) ?? null,
      appSummary: (app) => publicApp(app),
      fetchAgileDetail,
      mapLiveStatus: (detail) => mapLiveStatus(detail?.status, detail?.decision),
      // For the nightly agile harvest (accounts/harvest.mjs).
      applications: BUNDLE.applications,
      resolveAgileId: (app) =>
        resolveAgileId(AGILE_CLIENT_BY_AUTHORITY[app.authority_id], app.source_url, app.planning_reference),
      fetchAgileDetailById,
    });
  }

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
    const located = rows.filter((r) => r.lat != null && r.lng != null);
    // The register goes back to 2012, so uncapped this was ~94k features and
    // 22.7 MB on first load and on every search — the old five-year window had
    // been acting as an accidental cap. The client sends its viewport, so this
    // is a ceiling on dense areas, not the normal case. `truncated` lets the UI
    // say so; a silently cut map reads as "this is everything here".
    const shown = located.slice(0, MAP_FEATURE_LIMIT);
    return send(res, 200, {
      type: "FeatureCollection",
      matched: located.length,
      truncated: located.length > shown.length,
      features: shown
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

  // Site-boundary polygons for whatever the pins query matches; shown on pin
  // hover/selection. Council applications carry a boundary from the national
  // sites layer, ACP direct cases from the commission's case service.
  if (route === "/api/map/polygons") {
    const { rows } = runSearch(p);
    const polygons = sitePolygons();
    const features = [];
    for (const r of rows) {
      const geometry = polygons[r.id];
      if (!geometry) continue;
      features.push({
        type: "Feature",
        geometry,
        properties: { id: r.id, status: r.status },
      });
      // Matched to the pin limit deliberately: any pin on screen can be
      // hovered, so a lower cap here would leave most of them with no boundary
      // to reveal. Harmless while only 470 ACP cases had geometry; not once
      // every council application does. ~2,000 sites ≈ 440 KB, ~130 KB gzipped.
      if (features.length >= MAP_FEATURE_LIMIT) break;
    }
    return send(res, 200, { type: "FeatureCollection", features });
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

  const om = route.match(/^\/api\/overlays\/(zoning|conservation|archaeology)$/);
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
    const debug = p.get("debug") === "1";
    const trace = debug ? [] : undefined;
    const conditions = await fetchAgileConditions(
      app.authority_id,
      app.source_url,
      app.planning_reference,
      trace
    );
    if (debug) {
      return send(res, 200, {
        reference: app.planning_reference,
        source_url: app.source_url,
        conditions,
        codes_present: conditions?.items.map((i) => i.code) ?? null,
        trace,
      });
    }
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
    const index = files ? findDecisionDocIndex(files, app.decision) : -1;
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
    // Kildare (eplanning) addresses are townlands, so same-address matching is
    // meaningless — its real related applications load on demand from /related.
    const relatedIds =
      app.authority_id === "kildare" || !app.address_text
        ? []
        : (addressIndex().get(app.authority_id + "|" + addressKey(app.address_text)) ?? []);
    const related =
      relatedIds.length === 0
        ? []
        : BUNDLE.applications
            .filter((a) => a.id !== id && relatedIds.includes(a.id))
            .sort((x, y) => (y.received_date ?? "").localeCompare(x.received_date ?? ""))
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

  const rel = route.match(/^\/api\/applications\/(\d+)\/related$/);
  if (rel) {
    const app = BUNDLE.applications.find((a) => a.id === Number(rel[1]));
    if (!app) return send(res, 404, { error: "Application not found" });
    if (app.authority_id !== "kildare" || !app.source_url) {
      return send(res, 200, { supported: false, related: [] });
    }
    const found = await fetchEplanningRelated(app.source_url);
    const related = found.map((r) => {
      const match = BUNDLE.applications.find(
        (a) =>
          a.authority_id === app.authority_id &&
          typeof a.source_url === "string" &&
          a.source_url.includes(`AppFileRefDetails/${r.eplanningId}/`)
      );
      return {
        id: match?.id ?? null,
        planning_reference: match?.planning_reference ?? r.reference,
        description: r.description ?? match?.description ?? null,
        address: r.address,
        received_date: r.received,
        status: match?.status ?? mapLiveStatus(r.statusText, expandDecisionCode(r.decisionCode)),
        eplanning_url: app.source_url.replace(
          /AppFileRefDetails\/\d+(\/\d*)?.*/i,
          `AppFileRefDetails/${r.eplanningId}/0`
        ),
      };
    });
    if (p.get("debug") === "1") return send(res, 200, { supported: true, found, related });
    return send(res, 200, { supported: true, related });
  }

  const em = route.match(/^\/api\/applications\/(\d+)\/enrich$/);
  if (em) {
    const app = BUNDLE.applications.find((a) => a.id === Number(em[1]));
    if (!app) return send(res, 404, { error: "Application not found" });

    let description = app.description ?? null;
    let parties = { applicant: null, agent: null };
    const debug = p.get("debug") === "1";
    const summaryTrace = debug ? [] : undefined;
    // Summarise in parallel only for non-agile councils, whose description we
    // already hold in full. Agile councils get a fuller description from the
    // portal, so we summarise after that fetch (below) — otherwise the summary
    // is built from the truncated national text.
    const isAgile = app.authority_id in AGILE_CLIENT_BY_AUTHORITY;
    const [detail, eplanningParties, quickSummary] = await Promise.all([
      isAgile
        ? fetchAgileDetail(app.authority_id, app.source_url, app.planning_reference, debug)
        : null,
      !isAgile && !(app.applicant_name && app.agent_name) && app.source_url
        ? fetchEplanningParties(app.source_url)
        : null,
      isAgile ? null : summariseDescription(description, app.application_type, summaryTrace),
    ]);
    // The council portal reflects the true current outcome (e.g. "Invalid",
    // "Grant Permission") long before the national dataset does. The portal
    // status is often just a stage ("Decision Notice Issued"), so we read the
    // live decision too and let mapLiveStatus defer to the real outcome.
    const bakedStatus = String(app.status ?? "unknown");
    const liveStatusRaw = isAgile ? detail?.status ?? null : null;
    const liveDecisionRaw = isAgile ? detail?.decision ?? null : null;
    const liveRaw = liveStatusRaw ?? liveDecisionRaw;
    const liveStatus =
      liveStatusRaw || liveDecisionRaw ? mapLiveStatus(liveStatusRaw, liveDecisionRaw) : "unknown";
    // Correct the baked status when it never mapped (fill an "unknown"), or when
    // the portal shows a terminal outcome the register hasn't caught up to —
    // but only override a not-yet-resolved baked state, never a decided one.
    const CORRECTABLE_BAKED = new Set(["unknown", "pending", "further_info", "incomplete"]);
    const TERMINAL_LIVE = new Set(["granted", "refused", "invalid", "withdrawn"]);
    const useLiveStatus =
      liveStatus !== "unknown" &&
      liveStatus !== bakedStatus &&
      (bakedStatus === "unknown" ||
        (CORRECTABLE_BAKED.has(bakedStatus) && TERMINAL_LIVE.has(liveStatus)));

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
            picked_status: liveStatusRaw,
            picked_decision: liveDecisionRaw,
            normalised_status: liveStatus,
            baked_status: bakedStatus,
            would_override: useLiveStatus,
            description,
          });
      } else if (debug) {
        return send(res, 200, { agile_detail_keys: null, picked_description_len: 0, description });
      }
    } else if (eplanningParties) {
      parties = eplanningParties;
    }

    // Summarise the final description now when we deferred it (agile) or when the
    // portal lengthened the text; otherwise reuse the parallel summary.
    const descriptionImproved = description !== (app.description ?? null);
    const aiSummary =
      descriptionImproved || (isAgile && !quickSummary)
        ? (await summariseDescription(description, app.application_type, summaryTrace)) ??
          quickSummary
        : quickSummary;
    return send(res, 200, {
      ai_summary: aiSummary,
      // debug=1 only: why a null summary is null.
      ...(summaryTrace ? { summary_trace: summaryTrace, description_len: description?.length ?? 0 } : {}),
      applicant_name: app.applicant_name ?? parties.applicant,
      agent_name: app.agent_name ?? parties.agent,
      description,
      // The national dataset's postcode is ~2% populated; the agile register
      // often has the real Eircode.
      eircode: app.eircode ?? detail?.eircode ?? null,
      officer_name: detail?.officer ?? null,
      // Present only when the live portal outcome supersedes the baked status,
      // so the panel can correct the badge.
      status: useLiveStatus ? liveStatus : null,
      status_raw: useLiveStatus ? liveRaw : null,
      status_label: useLiveStatus ? STATUS_LABELS[liveStatus] : null,
    });
  }

  return send(res, 404, { error: "Not found" });
}
