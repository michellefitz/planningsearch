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
import { sql } from "./_accounts/db.mjs";
import { handlePreplanRoute, isPreplanRoute } from "./_preplan/routes.mjs";
import { conditionHighlights, HIGHLIGHTS_PROMPT } from "./_conditions/highlights.mjs";
import { conditionTitles, TITLES_PROMPT, untitledItems } from "./_conditions/titles.mjs";
import { echoesText, isDecisionSchedule, isGenericTitle } from "./_conditions/labels.mjs";
import {
  FURTHER_INFO_PROMPT,
  cleanSummary,
  FI_SELECTION_VERSION,
  RETURNED_POST_RE,
  findFurtherInfoDocIndex,
  furtherInfoItems,
  furtherInfoSummary,
} from "./_conditions/further-info.mjs";
import { decisionStage, isFurtherInfoRequest, realDecision } from "./_conditions/decision.mjs";
import { appealOutcome, bestAppealDecision, contradictsOutcome } from "./_conditions/appeal.mjs";
import { AI_CACHE_KINDS, aiCacheGet, aiCachePut, aiCached, versionedKind } from "./_ai/store.mjs";
import { descriptionKey } from "./_ai/descriptions.mjs";
import { closeTruncatedJson } from "./_ai/json.mjs";
import { sameSite } from "./_related/footprint.mjs";
import {
  citationPortalUrl,
  extractCitations,
  referenceKey,
} from "./_related/citations.mjs";
import { idfOver, queryHouseNumbers, relevanceScore } from "./_search/relevance.mjs";
import {
  ANCHOR_RE,
  decodeEntities,
  parseFileListHtml,
  stripTags,
  TITLE_JOIN,
  matchDocumentIndexes,
} from "./_documents/listing.mjs";
import { djvuToImageBlocks, djvuToPdf, isDjvu } from "./_documents/djvu.mjs";
import { documentLoadingShell } from "./_documents/loading-page.mjs";

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

/**
 * Site extents, keyed by application id — the four numbers the related list
 * needs to tell one site from the property beside it (see _related/footprint).
 * A separate sidecar from the boundaries themselves: this is read on ordinary
 * detail views, and parsing 19 MB of geometry to compare two rectangles would
 * undo the reason the polygons were lifted out of the bundle at all.
 */
let BOUNDS = null;
function siteBounds() {
  if (BOUNDS) return BOUNDS;
  try {
    BOUNDS = JSON.parse(fs.readFileSync(path.join(__dirname, "_data/bounds.json"), "utf8"));
  } catch {
    BOUNDS = {};
  }
  return BOUNDS;
}

/**
 * Precomputed description summaries, keyed by description hash (see
 * export-json.ts and scripts/summaries/backfill.mjs). Lazy for the same reason
 * as the polygons: only detail views read them, so the far more numerous
 * search and map cold starts shouldn't parse ~15 MB they never touch.
 */
let SUMMARIES = null;
function descriptionSummaries() {
  if (SUMMARIES) return SUMMARIES;
  try {
    SUMMARIES = JSON.parse(fs.readFileSync(path.join(__dirname, "_data/summaries.json"), "utf8"));
  } catch {
    SUMMARIES = {};
  }
  return SUMMARIES;
}

/** The baked summary for an application's description, if one was generated. */
function bakedSummary(description) {
  const key = descriptionKey(description);
  return key ? descriptionSummaries()[key] ?? null : null;
}

const haystackOf = (a) =>
  [a.planning_reference, a.address_text, a.applicant_name, a.description]
    .filter(Boolean)
    .join(" • ")
    .toLowerCase();
const HAYSTACK = new Map(BUNDLE.applications.map((a) => [a.id, haystackOf(a)]));

/**
 * The same text with every space and punctuation mark removed.
 *
 * Estates get written both ways. The register files Leixlip's as "Glen Easton
 * Gardens"; people type "Gleneaston". Neither spelling is wrong and exact
 * matching found nothing for the second, so the search fell through to the
 * fuzzy fallback and returned the wrong end of the county. Squashed, the two
 * are the same string. Built lazily, like the trigram index — it is only ever
 * consulted when the ordinary pass came back empty.
 */
const squash = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
let SQUASHED = null;
function squashedHaystack() {
  SQUASHED ??= new Map(BUNDLE.applications.map((a) => [a.id, squash(HAYSTACK.get(a.id))]));
  return SQUASHED;
}

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

/** Street types written both ways — see STREET_TYPES in
 *  server/src/ingest/ppr.ts for how this list was chosen. */
const STREET_TYPES = {
  ROAD: "RD",
  AVENUE: "AVE",
  AV: "AVE",
  STREET: "ST",
  STR: "ST",
  SAINT: "ST",
  DRIVE: "DR",
  DRV: "DR",
  SQUARE: "SQ",
  CRESCENT: "CRES",
  LOWER: "LWR",
  UPPER: "UPR",
  APARTMENT: "APT",
  APARTMENTS: "APT",
  APTS: "APT",
};

/**
 * Normalised address key — mirrors normalizeAddress() in server/src/ingest/ppr.ts.
 * Council staff type these free-hand, so "31 Mount Prospect Drive, Dublin 3",
 * "31, Mount Prospect Dr." and "No. 31 Mount Prospect Drive" are one property.
 * Exact string equality split a house's history into unrelated halves.
 */
function addressKey(s) {
  if (!s) return "";
  let n = String(s).toUpperCase();
  // Apostrophes close up rather than becoming a space, so "St Brigid's Road"
  // and "ST BRIGIDS RD" are one address. Straight and curly both appear.
  n = n.replace(/[\u2019']/g, "");
  n = n.replace(/[^A-Z0-9 ]/g, " ");
  n = n.replace(/\b(D6W|[A-Z]\d{2})\s?[A-Z0-9]{4}\b/g, " ");
  n = n.replace(/\b(CO|COUNTY)\s+(KILDARE|DUBLIN|WICKLOW|MEATH)\b/g, " ");
  // "No. 31 ..." is the same house as "31 ..." — a standalone NO before a
  // digit is always "number".
  n = n.replace(/\bNO\s+(?=\d)/g, " ");
  n = n.replace(/\s+/g, " ").trim();
  n = n.replace(/\s(KILDARE|DUBLIN)$/g, "");
  return n
    .trim()
    .split(" ")
    .map((w) => STREET_TYPES[w] ?? w)
    .join(" ");
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

/** authority_id + normalised reference -> application, for resolving the
 *  references an application names in its own text. Built once per cold start,
 *  from data already in memory. */
let REFERENCE_INDEX = null;
function referenceIndex() {
  if (REFERENCE_INDEX) return REFERENCE_INDEX;
  REFERENCE_INDEX = new Map();
  for (const a of BUNDLE.applications) {
    if (!a.planning_reference) continue;
    REFERENCE_INDEX.set(a.authority_id + "|" + referenceKey(a.planning_reference), a);
  }
  return REFERENCE_INDEX;
}

/**
 * The applications this one names in its description, resolved where we hold
 * them and pointed at the council's own register where we do not.
 *
 * Both outcomes matter. Half the citations sampled pointed at applications we
 * already had and were not showing, because they were only ever linked by
 * address. The rest are the register's older history — 8-16 Annamoe Road cites
 * a 2015 permission and its 2020 extension of duration, and we hold neither:
 * one predates our Dublin City records, and Dublin City publishes no
 * extension-of-duration applications to the national dataset at all.
 */
function citationsFor(app) {
  const cites = extractCitations(app.description, app.authority_id, app.planning_reference);
  if (cites.length === 0) return [];
  const index = referenceIndex();
  const authority = AUTH.get(app.authority_id);
  return cites.map(({ reference, kind }) => {
    const held = index.get(app.authority_id + "|" + referenceKey(reference));
    if (held) {
      return {
        reference,
        kind,
        id: held.id,
        planning_reference: held.planning_reference,
        description: held.description ?? null,
        status: held.status,
        received_date: held.received_date ?? null,
        decision_date: held.decision_date ?? null,
      };
    }
    return {
      reference,
      kind,
      id: null,
      // An appeal reference is not a council application, so a keyword search
      // of the council's register would not find it.
      portal_url: kind === "appeal" ? null : citationPortalUrl(authority, reference),
    };
  });
}

async function resolveCitedUrls(app) {
  const client = AGILE_CLIENT_BY_AUTHORITY[app.authority_id];
  if (!client) return {};
  const cites = citationsFor(app);
  const unresolved = cites.filter((c) => c.id === null && c.kind !== "appeal" && c.portal_url);
  if (unresolved.length === 0) return {};
  const authority = AUTH.get(app.authority_id);
  const base = authority?.portal_base_url ?? null;
  if (!base) return {};
  const urls = {};
  await Promise.all(
    unresolved.map(async (c) => {
      const agileId = await resolveAgileId(client, null, c.reference);
      if (agileId) urls[c.reference] = `${base}/application-details/${agileId}`;
    })
  );
  return urls;
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

/**
 * The id in .../AppFileRefDetails/{id}/0.
 *
 * It used to be read as `(\d+)`, which is right for Kildare and Wicklow and
 * wrong for Meath: every Meath application before about 2020 carries its
 * electoral-area prefix in the reference — RA171525, AA170842, LB..., KA...,
 * NA..., TA... — so the match failed and the whole pre-2020 Meath register
 * came back with no documents at all, and a sheet saying "use the portal link
 * above" above no link. The listing accepts the lettered id perfectly well;
 * only this regex did not.
 */
const EPLANNING_ID_RE = /AppFileRefDetails\/([^/?#]+)/i;

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
  const m = sourceUrl.match(EPLANNING_ID_RE);
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
const abpClean = (h) => decodeEntities(ABP_STRIP(h));

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
const ABP_CASE_FIELD_RE =
  /<p[^>]*class="[^"]*\bcase-sub\b[^"]*"[^>]*>([\s\S]*?)<\/p>[\s\S]{0,400}?<p[^>]*class="[^"]*\bcase-summary\b[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;

function parseAppealCaseFields(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(ABP_CASE_FIELD_RE)) abpPushPair(out, seen, m[1], m[2]);
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
    const href = decodeEntities(m[1]).trim();
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
  "cork-city": "CORKCITY",
  "cork-county": "CORKCOCO",
  wexford: "WEXFORD",
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

/**
 * The close of the public consultation window — the portal's "Due date to
 * submit observations". Mirrors pickSubmissionsBy() in server/src/agile.ts.
 *
 * publicityEndDate is the only one populated across all four councils:
 * sampled 2026-08-18, Dublin City and DLR carry it alone, while Fingal and
 * South Dublin carry submissionExpiryDate too — always the same date.
 */
function pickSubmissionsBy(d) {
  for (const key of ["publicityEndDate", "submissionExpiryDate"]) {
    const v = d[key];
    const iso = typeof v === "string" ? v.slice(0, 10) : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  }
  return null;
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
    submissionsBy: pickSubmissionsBy(d),
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
const RZLT_CACHE = new Map();
const GZT_URL =
  "https://services.arcgis.com/NzlPQPKn5QF9v2US/ArcGIS/rest/services/GZT_Current_Plan/FeatureServer/0/query";
const RZLT_URL =
  "https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/Residential_Zoned_Land_Tax_Final_Map2026_view/FeatureServer/0/query";

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

async function fetchRzlt(lat, lng) {
  const cacheKey = `${lat},${lng}`;
  if (RZLT_CACHE.has(cacheKey)) return RZLT_CACHE.get(cacheKey);
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    spatialRel: "esriSpatialRelIntersects",
    where: "1=1",
    outFields: "PARCEL_ID,LOCAL_AUTHORITY_NAME,ZONE_GZT,GZT_DESC,ZONE_ORIG,SITE_AREA,DATE_ADDED",
    returnGeometry: "false",
    f: "json",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${RZLT_URL}?${params}`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json();
    if (body.error || !Array.isArray(body.features)) return null;
    const result = body.features.map((f) => {
      const a = f.attributes;
      const ts = typeof a.DATE_ADDED === "number" ? a.DATE_ADDED : null;
      return {
        parcel_id: String(a.PARCEL_ID ?? "").trim(),
        authority: String(a.LOCAL_AUTHORITY_NAME ?? "").trim(),
        zone: String(a.ZONE_GZT ?? "").trim(),
        zone_desc: String(a.GZT_DESC ?? a.ZONE_ORIG ?? "").trim(),
        area_ha: typeof a.SITE_AREA === "number" ? Math.round(a.SITE_AREA * 1000) / 1000 : null,
        date_added: ts ? new Date(ts).toISOString().slice(0, 10) : null,
      };
    });
    RZLT_CACHE.set(cacheKey, result);
    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Map overlays (zoning, conservation, archaeology, rzlt) as GeoJSON for a
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
  rzlt: { url: RZLT_URL, where: "1=1", outFields: "PARCEL_ID,LOCAL_AUTHORITY_NAME,ZONE_GZT,GZT_DESC,ZONE_ORIG,SITE_AREA" },
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
    } else if (layer === "rzlt") {
      f.properties = {
        parcel_id: ovStr(p.PARCEL_ID),
        authority: ovStr(p.LOCAL_AUTHORITY_NAME),
        zone: ovStr(p.ZONE_GZT),
        zone_desc: ovStr(p.GZT_DESC) || ovStr(p.ZONE_ORIG),
        area_ha: typeof p.SITE_AREA === "number" ? Math.round(p.SITE_AREA * 1000) / 1000 : null,
      };
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
    const eplanningId = cells[0].match(EPLANNING_ID_RE)?.[1];
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
  const selfId = sourceUrl.match(EPLANNING_ID_RE)?.[1] ?? null;
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

/**
 * Why there is no summary.
 *
 * "Not enough information to generate a summary" was shown for both, which
 * blamed the council's description when the truth was often that our own call
 * to the model timed out or came back 429. On a 300-word description that
 * reads as a claim about the data, and it is wrong.
 */
function summaryStatus(trace, description) {
  if (trace.some((t) => t.step === "haiku" && t.error)) return "unavailable";
  // The model answered and the guard threw the answer away — it said
  // INSUFFICIENT, or addressed the reader instead of the application.
  if (trace.some((t) => t.step === "summarise" && t.error === "reply rejected by isUsableSummary"))
    return "insufficient";
  if (!description || description.trim().length < 40) return "insufficient";
  return "unavailable";
}

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
  "height and scale, drainage…), never policy or plan citations. Break it into two or three short " +
  "paragraphs separated by a blank line — a single block this long goes unread. " +
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
  if (start < 0) return null;
  const end = cleaned.lastIndexOf("}");
  if (end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      // Falls through: a complete-looking object can still be truncated
      // inside, when the cut landed after some inner "}".
    }
  }
  // Cut off mid-write. Salvage every element that finished.
  try {
    return JSON.parse(closeTruncatedJson(cleaned.slice(start)));
  } catch {
    return null;
  }
}
const ovClip = (v, max) => String(v ?? "").trim().slice(0, max);
const ovNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * An appeal order, read the way a council decision order is.
 *
 * The Commission's order carries the same two things a council's does — what
 * was decided, and the schedule the applicant is now bound by — and when an
 * appeal overturns a refusal that schedule is the most useful thing on the
 * file: it is the list of changes that turned a no into a yes. It was
 * invisible here, because an appeal produced a paragraph of prose and nothing
 * else.
 *
 * The recorded outcome is passed in and the model is told not to argue with
 * it. That is belt; `contradictsOutcome` is braces.
 */
const APPEAL_EXTRACT_PROMPT =
  "You read an order of An Coimisiún Pleanála — the national body that decides Irish planning " +
  "appeals — and extract it as JSON for a public planning viewer. Return ONLY a JSON object, no " +
  "prose and no Markdown fences, with exactly this shape:\n" +
  '{"summary": string, "conditions": [{"number": number|null, "title": string, "text": string}], ' +
  '"reasons": [{"number": number|null, "text": string}]}\n' +
  "- summary: plain English for a regular person, as two or three short paragraphs separated by a " +
  "blank line — who appealed and what was at stake, then the case each side made, then what the " +
  "Commission decided and the real reasons: overlooking, traffic, height and scale, drainage, " +
  "rural housing need. Never policy or plan citations. The paragraph breaks matter — this is the " +
  "longest summary in the app and a single block of it goes unread.\n" +
  "- conditions: every condition attached to a grant. number = its number; title = a short (max 8 " +
  'words) plain-English label of what it controls ("Construction hours", "Materials and finishes"); ' +
  "text = the condition wording, lightly trimmed.\n" +
  "- reasons: every reason for refusal (number + wording).\n" +
  "THE OUTCOME IS GIVEN TO YOU and is not yours to determine. The inspector's recommendation is " +
  "not the decision — the Commission departs from it often — so if the document you are reading " +
  "is a report rather than the order, do not report its recommendation as the outcome. Never write " +
  "that a refusal stood when the outcome given says permission was granted, or the reverse.\n" +
  "If granted, reasons is []. If refused, conditions is []. Use only what the document states.";

const appealCacheKind = () => versionedKind(AI_CACHE_KINDS.APPEAL, APPEAL_EXTRACT_PROMPT);
const decisionCacheKind = () =>
  versionedKind(AI_CACHE_KINDS.DECISION, DECISION_EXTRACT_PROMPT + HIGHLIGHTS_PROMPT);

async function extractAppealOrder(pages, context) {
  if (!pages?.length) return null;
  const raw = await callClaude(
    APPEAL_EXTRACT_PROMPT,
    [...pages, { type: "text", text: `${context}\n\nExtract this appeal order as JSON.` }],
    4000,
    60000
  );
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
  if (!summary && !conditions.length && !reasons.length) return null;
  return { summary, conditions, reasons };
}

/**
 * `pages` is what the model is given to look at: one PDF block for a modern
 * order, or one image block per page for an older scan that had to be decoded
 * out of DjVu first. Everything downstream is the same either way — the model
 * reads a picture of a page in both cases.
 */
async function extractDecisionDocument(pages, decision) {
  if (!pages?.length) return null;
  const content = [
    ...pages,
    { type: "text", text: `Recorded decision: ${decision ?? "unknown"}. Extract the decision order as JSON.` },
  ];
  const raw = await callClaude(DECISION_EXTRACT_PROMPT, content, 4000, 60000);
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
/**
 * The schedule the decision letter refers to but does not contain.
 *
 * Kildare issues the decision in two parts: a "Notification of Decision
 * Letters" that says permission is granted "subject to 6 conditions set out in
 * the schedule attached", and a separate "Schedule of Conditions" holding the
 * six. Reading only the first produced a conditions list of exactly one item
 * whose text was the sentence promising the other document — the reader was
 * told there were six conditions and shown none of them.
 *
 * Returned alongside the decision order rather than instead of it: the letter
 * carries the outcome and its date, the schedule carries what the permission
 * actually requires, and the model is given both.
 */
const SCHEDULE_DOC_RE = /schedule of conditions|conditions? schedule/i;

function findConditionsScheduleIndex(files, decisionIndex) {
  let best = -1;
  let bestScore = 0;
  (files ?? []).forEach((f, i) => {
    if (i === decisionIndex) return;
    const t = String(f?.title ?? "");
    if (!SCHEDULE_DOC_RE.test(t) || APPEAL_DOC_RE.test(t)) return;
    if (RETURNED_POST_RE.test(t)) return;
    // A dated schedule is the one issued with the decision; an undated
    // duplicate is usually the working copy filed later. Prefer the dated one,
    // and the first of them, since registers append.
    const score = /\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2}/.test(t) ? 2 : 1;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

function findDecisionDocIndex(files, decision) {
  const wantRefusal = /refus|reject/i.test(decision ?? "");
  const wantGrant = /grant|approv|conditional/i.test(decision ?? "");
  let best = -1;
  let bestScore = 0;
  files.forEach((f, i) => {
    const t = f.title;
    if (APPEAL_DOC_RE.test(t) || NON_DECISION_DOC_RE.test(t)) return;
    // The copy the post brought back is not the decision. Meath files it
    // beside the original under the same document type — 212214 carries two,
    // "Decision Documentation Returned" and "Decision Documentation -
    // Returned" — and they scored identically to the real notification. The
    // right one won on filing order alone.
    if (RETURNED_POST_RE.test(t)) return;
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

const PDF_URL_RE = /\.pdf($|[?#])/i;

/**
 * Which document on an appeal file says what was decided.
 *
 * The inspector recommends and the Commission decides, and the two disagree
 * often enough that the difference is the whole point of reading the right
 * one. This used to take the first title matching any of order, direction,
 * inspector or decision — and the Commission lists the inspector's report
 * first, so the recommendation won every time. On case 322612 the inspector
 * recommended refusal, the Commission granted with conditions, and the sheet
 * told the reader the refusal had been upheld.
 *
 * Scored rather than first-matched, so the Order wins wherever it appears in
 * the list. The Direction (the members' vote) comes next, and the inspector's
 * report is a distant last: it is the fullest account of the case and the
 * wrong account of the outcome.
 */
const APPEAL_DOC_SCORES = [
  [/\border\b/i, 10],
  [/\bdirection\b/i, 6],
  [/\bdecision|determination\b/i, 5],
  [/\binspector/i, 2],
];

function appealDocScore(title) {
  const t = String(title ?? "");
  for (const [re, score] of APPEAL_DOC_SCORES) if (re.test(t)) return score;
  return 0;
}

function pickAppealDocument(documents) {
  const pdfs = (documents ?? []).filter((d) => PDF_URL_RE.test(d.url));
  if (!pdfs.length) return null;
  let best = null;
  let bestScore = -1;
  for (const doc of pdfs) {
    const score = appealDocScore(doc.title);
    if (score > bestScore) {
      bestScore = score;
      best = doc;
    }
  }
  return best ?? pdfs[0];
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

const AI_RATE_WINDOW = 60_000;
const AI_RATE_MAX = 30;
let aiRateStart = Date.now();
let aiRateCount = 0;
function aiRateOk() {
  const now = Date.now();
  if (now - aiRateStart > AI_RATE_WINDOW) {
    aiRateStart = now;
    aiRateCount = 0;
  }
  return ++aiRateCount <= AI_RATE_MAX;
}

const DAILY_IP_LIMIT = 200;
const DAILY_GLOBAL_LIMIT = 2000;
let dailyCapTableReady = false;

async function ensureDailyCapTable() {
  if (dailyCapTableReady) return;
  try {
    await sql(`create table if not exists ai_usage (
      ip text not null,
      day date not null,
      count integer not null default 0,
      primary key (ip, day)
    )`);
    dailyCapTableReady = true;
  } catch { /* best-effort — don't block requests if Neon is down */ }
}

async function dailyAiCapOk(ip) {
  try {
    await ensureDailyCapTable();
    const today = new Date().toISOString().slice(0, 10);
    await sql(
      `insert into ai_usage (ip, day, count) values ($1, $2, 1)
       on conflict (ip, day) do update set count = ai_usage.count + 1`,
      [ip, today]
    );
    const [ipRow] = await sql(
      `select count from ai_usage where ip = $1 and day = $2`,
      [ip, today]
    );
    if (ipRow && ipRow.count > DAILY_IP_LIMIT) return { ok: false, reason: "ip" };
    const [globalRow] = await sql(
      `select coalesce(sum(count), 0) as total from ai_usage where day = $1`,
      [today]
    );
    if (globalRow && globalRow.total > DAILY_GLOBAL_LIMIT) return { ok: false, reason: "global" };
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

function clientIp(req) {
  return (req.headers?.["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "").split(",")[0].trim();
}

async function aiDailyCapCheck(req, res) {
  if (!aiRateOk()) {
    send(res, 429, { error: "Too many AI requests — try again shortly." });
    return false;
  }
  const ip = clientIp(req);
  const cap = await dailyAiCapOk(ip);
  if (!cap.ok) {
    send(res, 429, {
      error: "daily_limit",
      message: cap.reason === "ip"
        ? "You've reached the daily limit for AI features. Check back tomorrow."
        : "The daily limit for AI features has been reached. Check back tomorrow.",
    });
    return false;
  }
  return true;
}

async function summariseDescription(description, applicationType, trace) {
  if (!description) {
    trace?.push({ step: "summarise", error: "no description to summarise" });
    return null;
  }
  // The whole register is summarised in bulk ahead of time, so the model only
  // sees wording the last build didn't have — a new application, or a fuller
  // description the council's portal returned just now.
  const baked = bakedSummary(description);
  if (baked) {
    trace?.push({ step: "summarise", source: "precomputed bundle" });
    return baked;
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
  if (text) {
    AI_SUMMARY_CACHE.set(description, text);
    const hash = descriptionKey(description);
    if (hash && process.env.DATABASE_URL) {
      sql(
        `insert into description_summaries (description_hash, summary, model)
         values ($1, $2, $3) on conflict (description_hash) do nothing`,
        [hash, text, "claude-haiku-4-5"]
      ).catch(() => {});
    }
  }
  return text;
}

/** Still read by /conditions to inline a summary it already has; the durable
 *  copy lives in ai_cache (api/_ai/store.mjs). */
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
  "cork-city": "corkcity",
  "cork-county": "corkcoco",
  wexford: "wexford",
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
    title: e.date ? `${e.date} — ${e.title}` : e.title,
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
  // DjVu is a scanning format from the 1990s that the iDocs councils still
  // hold their older files in, and it arrives labelled "image/x.djvu" — which
  // passes for an image and is not one any browser can draw. Told to display
  // it inline, the tab opened empty. Sent as a download it at least says what
  // it is, and the council's own viewer (linked under the list) renders it.
  const djvu = /djvu/i.test(contentType) || ext === "djvu";
  const inlineable =
    !djvu && (/^application\/pdf$/i.test(contentType) || /^image\//i.test(contentType));
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

function runSearch(p) {
  let rows = applyFilters(BUNDLE.applications, p);
  let fuzzy = false;
  const q = (p.get("q") ?? "").trim().toLowerCase();
  if (q) {
    // Trailing punctuation is dropped, but not internal: "Rathgar Road," and
    // "Rathgar Road" are the same street, while "4034/22" and "17a/18" are one
    // token each. Picking a geocoded suggestion types the commas for you, and
    // requiring the register to have written them the same way lost rows.
    const rawTokens = q.split(/\s+/).filter(Boolean);
    const include = [];
    const exclude = [];
    let negateNext = false;
    for (const t of rawTokens) {
      if (t.toUpperCase() === "NOT") { negateNext = true; continue; }
      const negate = negateNext || t.startsWith("-");
      negateNext = false;
      const clean = (negate ? t.replace(/^-+/, "") : t)
        .replace(/\*+$/, "")
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (!clean) continue;
      (negate ? exclude : include).push(clean);
    }
    const tokens = include;
    const exact = rows.filter((a) => {
      const h = HAYSTACK.get(a.id);
      return tokens.every((t) => h.includes(t)) && exclude.every((t) => !h.includes(t));
    });
    // A place written as one word where the register writes it as two (or the
    // other way round) is still an exact match, not a near one — so this runs
    // before the fuzzy fallback, and its hits keep match_quality "exact".
    const positiveQ = include.join(" ");
    const squashedQ = squash(positiveQ);
    const loose =
      exact.length || squashedQ.length < 4
        ? []
        : (() => {
            const hay = squashedHaystack();
            return rows.filter((a) =>
              hay.get(a.id).includes(squashedQ) && exclude.every((t) => !HAYSTACK.get(a.id).includes(t))
            );
          })();
    const hits = exact.length ? exact : loose;
    if (hits.length) {
      // Relevance is the default order for a keyword search; an explicit date
      // sort below overrides it.
      // Weighted against this result set rather than the whole register: what
      // separates 59 Rathgar addresses is not the word "Rathgar".
      const idf = idfOver(hits, tokens, (a) => HAYSTACK.get(a.id));
      const wanted = queryHouseNumbers(positiveQ);
      rows = hits
        .map((a) => ({ a, s: relevanceScore(a, tokens, idf, wanted) }))
        .sort((x, y) => y.s - x.s)
        .map((x) => ({ ...x.a, match_quality: "exact" }));
    } else if (looksLikeReference(positiveQ) || looksLikeEircode(positiveQ)) {
      rows = [];
    } else {
      fuzzy = true;
      const qt = trigrams(positiveQ);
      const idx = triIndex();
      const hits = new Map();
      for (const g of qt) {
        const ids = idx.get(g);
        if (ids) for (const id of ids) hits.set(id, (hits.get(id) ?? 0) + 1);
      }
      rows = rows
        .map((a) => ({ a, score: qt.size ? (hits.get(a.id) ?? 0) / qt.size : 0 }))
        .filter((x) => x.score >= 0.45 && exclude.every((t) => !HAYSTACK.get(x.a.id).includes(t)))
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

COVERAGE: Dublin City, Fingal, Dún Laoghaire-Rathdown, South Dublin, Cork City, Cork County, Wexford, Kildare, Meath \
and Wicklow county councils. Data comes from the statutory planning registers. Appeals are decided nationally by An Coimisiún Pleanála (formerly An Bord Pleanála) and \
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

RZLT: The Residential Zoned Land Tax map identifies serviced, residentially zoned land that is vacant or idle. If a \
site is on the RZLT map, mention it — it signals development potential and means the landowner is liable for an annual \
tax (3% of market value) intended to activate the land for housing. Not all residential land is on the RZLT map; only \
land the local authority considers underused.

DERELICT SITES: Some properties are on the statutory Derelict Sites Register (Derelict Sites Act 1990). This is a \
formal designation by the local authority — distinct from merely appearing neglected. Being on the register means \
the council has served notices and may levy charges. Coverage: Dublin City, South Dublin, DLR, Wicklow, Kildare only.

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

async function* runAgent(messages, signal) {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    yield { type: "error", message: "The agent is not configured on this deployment (missing API key)." };
    yield { type: "done" };
    return;
  }
  const msgs = messages.map((m) => ({ role: m.role, content: m.content }));

  for (let turn = 0; turn < AGENT_MAX_TURNS; turn++) {
    if (signal?.aborted) return;
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal,
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
      if (signal?.aborted) return;
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

const AGENT_BODY_MAX = 100_000;
async function readJsonBody(req, maxBytes = AGENT_BODY_MAX) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) return null;
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

const AGENT_MSG_MAX_CHARS = 10_000;
const AGENT_RATE_WINDOW = 3600_000;
const AGENT_RATE_MAX = 20;
const agentRateMap = new Map();
function agentRateOk(ip) {
  const now = Date.now();
  let rec = agentRateMap.get(ip);
  if (!rec || now - rec.start > AGENT_RATE_WINDOW) {
    rec = { start: now, count: 0 };
    agentRateMap.set(ip, rec);
  }
  rec.count++;
  if (agentRateMap.size > 10_000) {
    for (const [k, v] of agentRateMap) {
      if (now - v.start > AGENT_RATE_WINDOW) agentRateMap.delete(k);
    }
  }
  return rec.count <= AGENT_RATE_MAX;
}

async function handleAgentRoute(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  const ip = (req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "").split(",")[0].trim();
  if (!agentRateOk(ip)) return send(res, 429, { error: "Rate limit exceeded — try again later." });
  if (!(await aiDailyCapCheck(req, res))) return;
  const body = await readJsonBody(req);
  if (!body) return send(res, 400, { error: "Invalid or oversized request body" });
  const messages = (body?.messages ?? [])
    .filter(
      (m) =>
        (m?.role === "user" || m?.role === "assistant") &&
        typeof m?.content === "string" &&
        m.content.trim().length > 0
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, AGENT_MSG_MAX_CHARS) }))
    .slice(-30);
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return send(res, 400, { error: "messages must end with a user message" });
  }
  const ac = new AbortController();
  req.on("close", () => ac.abort());
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  try {
    for await (const ev of runAgent(messages, ac.signal)) {
      if (res.destroyed) break;
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  } catch {
    if (!res.destroyed)
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
    if (!q) return send(res, 200, { suggestions: [], places: [] });
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
    const places = [];
    if (q.length >= 3 && !/^\d/.test(q) && !looksLikeReference(q)) {
      try {
        const geo = await fetch(
          `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
            q: q + ", Ireland",
            format: "json",
            limit: "3",
            countrycodes: "ie",
            addressdetails: "1",
          })}`,
          { headers: { "User-Agent": UA_HEADERS["User-Agent"] }, signal: AbortSignal.timeout(3000) }
        );
        if (geo.ok) {
          for (const r of await geo.json()) {
            const name = r.display_name?.split(",").slice(0, 3).join(",").trim();
            if (name && r.lat && r.lon) {
              places.push({ name, lat: Number(r.lat), lng: Number(r.lon) });
            }
          }
        }
      } catch {}
    }
    return send(res, 200, { suggestions: out, places });
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
            received_date: r.received_date ?? null,
            description: r.description ?? null,
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
    // A browser navigating here gets the waiting page; anything else — our own
    // fetches, the agent's tools, curl — gets the document. Only a navigation
    // sends `Accept: text/html`, which is exactly the case that has a blank
    // tab to fill.
    if (!debug && !p.has("open") && /text\/html/i.test(req.headers.accept ?? "")) {
      const target = `${route}?${new URLSearchParams({ ...Object.fromEntries(p), open: "1" })}`;
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(documentLoadingShell(target));
      return;
    }
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
    // The older council scans are DjVu, which no browser draws. Handing one
    // over was a download nobody could open; sending the reader to the
    // council's viewer instead worked but was a detour with instructions
    // attached. Decoded here, it arrives as what it always should have been.
    const converted =
      doc && doc !== "too_large" && isDjvu(doc.contentType, doc.filename)
        ? await djvuToPdf(doc.body, { title: doc.filename ?? "" })
        : null;
    if (converted && converted !== "too_large") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${safeFilename(String(doc.filename ?? "document").replace(/\.djvu$/i, "") + ".pdf")}"`
      );
      res.setHeader("Cache-Control", "private, max-age=300");
      res.end(converted);
      return;
    }
    // A DjVu that would not decode is a failure to read, not an empty file;
    // one that decoded to more than a response can carry is a size problem,
    // and says so like any other.
    const oversize = doc === "too_large" || converted === "too_large";
    const undecodable = converted === null && doc && doc !== "too_large" && isDjvu(doc.contentType, doc.filename);
    if (oversize || doc === null || undecodable) {
      // Land the user on the specific application, not the generic portal.
      const fallbackUrl =
        listUrl ??
        (slug
          ? (await agilePortalUrl(app.authority_id, app.source_url, app.planning_reference)) ?? `${AGILE_BASE}/${slug}`
          : "");
      const reason = oversize
        ? "This document is too large to display here."
        : undecodable
          ? "Couldn't read this scanned document."
          : "Couldn't retrieve this document from the council just now.";
      res.statusCode = oversize ? 413 : 502;
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

  const rm = route.match(/^\/api\/applications\/(\d+)\/rzlt$/);
  if (rm) {
    const app = BUNDLE.applications.find((a) => a.id === Number(rm[1]));
    if (!app) return send(res, 404, { error: "Application not found" });
    if (app.lat == null || app.lng == null) return send(res, 200, { supported: false, rzlt: null });
    const rzlt = await fetchRzlt(app.lat, app.lng);
    return send(res, 200, { supported: true, rzlt });
  }

  const om = route.match(/^\/api\/overlays\/(zoning|conservation|archaeology|rzlt)$/);
  if (om) {
    const bbox = parseBbox(p.get("bbox"));
    if (!bbox) return send(res, 200, { type: "FeatureCollection", features: [] });
    return send(res, 200, await fetchOverlay(om[1], bbox));
  }

  if (route === "/api/geocode") {
    const gKey = process.env.GOOGLE_GEOCODING_KEY ?? process.env.VITE_GOOGLE_MAPS_KEY;
    if (!gKey) return send(res, 503, { error: "Geocoding not configured" });
    const q = p.get("q");
    if (!q || q.trim().length < 3) return send(res, 200, { results: [] });
    const placeId = p.get("placeId");
    if (placeId) {
      try {
        const dRes = await fetch(
          `https://places.googleapis.com/v1/places/${placeId}?languageCode=en`,
          {
            headers: { "X-Goog-Api-Key": gKey, "X-Goog-FieldMask": "location,formattedAddress" },
            signal: AbortSignal.timeout(5000),
          }
        );
        if (!dRes.ok) return send(res, 200, { results: [] });
        const place = await dRes.json();
        const loc = place.location;
        if (!loc) return send(res, 200, { results: [] });
        return send(res, 200, {
          results: [{
            display: (place.formattedAddress ?? "").replace(/, Ireland$/i, ""),
            lat: loc.latitude,
            lng: loc.longitude,
          }],
        });
      } catch {
        return send(res, 200, { results: [] });
      }
    }
    try {
      const acRes = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": gKey,
        },
        body: JSON.stringify({
          input: q.trim(),
          includedRegionCodes: ["ie"],
          languageCode: "en",
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!acRes.ok) return send(res, 200, { results: [] });
      const data = await acRes.json();
      const results = (data.suggestions ?? []).slice(0, 6).map((s) => {
        const pp = s.placePrediction;
        if (!pp) return null;
        return {
          display: (pp.text?.text ?? "").replace(/, Ireland$/i, ""),
          placeId: pp.placeId,
        };
      }).filter(Boolean);
      return send(res, 200, { results });
    } catch {
      return send(res, 200, { results: [] });
    }
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
    //
    // The portal's decision field doubles as a progress log, so an application
    // still being assessed comes back as "Seek Clarification of Additional
    // Information" with the request itself in the items. Resolved here rather
    // than in the browser: decision carries only a real outcome, and
    // further_info says the file is waiting on the applicant.
    return send(res, 200, {
      supported: true,
      conditions: conditions
        ? {
            ...conditions,
            decision: realDecision(conditions.decision),
            decision_stage: decisionStage(conditions.decision),
            further_info: isFurtherInfoRequest(conditions.decision),
            refusal_summary: REFUSAL_SUMMARY_CACHE.get(app.id) ?? null,
          }
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
    // Code "R" is the portal's "Reason", which on a *grant* is the First
    // Schedule reasons and considerations — asking for a refusal sentence
    // there spends a model call to describe a refusal that never happened.
    const decision = conditions?.decision ?? app.decision ?? null;
    if (decision && !/refus/i.test(decision)) {
      return send(res, 200, { supported: true, summary: null });
    }
    const reasons = conditions?.items.filter((i) => i.code === "R") ?? [];
    if (!reasons.length) return send(res, 200, { supported: true, summary: null });
    const summary = await aiCached(
      AI_CACHE_KINDS.REFUSAL,
      app.authority_id,
      app.planning_reference,
      () => summariseRefusal(app.id, reasons)
    );
    if (summary) REFUSAL_SUMMARY_CACHE.set(app.id, summary);
    return send(res, 200, { supported: true, summary });
  }

  // What the conditions actually change about the approved scheme. Its own
  // endpoint so the conditions themselves paint without waiting on the model.
  /**
   * Titles for the conditions the council did not title.
   *
   * Separate from the highlights on purpose — that prompt decides what is
   * notable and was tuned against 1,133 conditions to do it; this one writes
   * five-word labels. Separate caches too, so a change to either does not
   * throw away the other.
   */
  const ctm = route.match(/^\/api\/applications\/(\d+)\/condition-titles$/);
  if (ctm) {
    const app = BUNDLE.applications.find((a) => a.id === Number(ctm[1]));
    if (!app) return send(res, 404, { error: "Application not found" });
    if (!(app.authority_id in AGILE_CLIENT_BY_AUTHORITY)) {
      return send(res, 200, { supported: false, titles: null });
    }
    const titles = await aiCached(
      versionedKind(AI_CACHE_KINDS.TITLES, TITLES_PROMPT),
      app.authority_id,
      app.planning_reference,
      async () => {
        const conditions = await fetchAgileConditions(
          app.authority_id,
          app.source_url,
          app.planning_reference
        );
        // Only the ones with nothing worth showing. South Dublin writes real
        // titles and costs nothing here, and DLR's whole-decision schedule is
        // named deterministically — asked for a five-word label for a 4,000
        // character document, the model picks a sentence out of it.
        const untitled = untitledItems(
          conditions?.items ?? [],
          (i) =>
            isDecisionSchedule(i?.text) ||
            (!isGenericTitle(i?.title) && !echoesText(i?.title, i?.text))
        );
        return untitled.length ? conditionTitles(untitled, callClaude) : [];
      }
    );
    return send(res, 200, { supported: true, titles });
  }

  const chm = route.match(/^\/api\/applications\/(\d+)\/condition-highlights$/);
  if (chm) {
    const app = BUNDLE.applications.find((a) => a.id === Number(chm[1]));
    if (!app) return send(res, 404, { error: "Application not found" });
    if (!(app.authority_id in AGILE_CLIENT_BY_AUTHORITY)) {
      return send(res, 200, { supported: false, highlights: null });
    }
    // null is "we couldn't read them", [] is "nothing here binds you" — only
    // the real answer is stored, so a timeout retries on the next view.
    const highlights = await aiCached(
      // Tied to the prompt: a change to it must not keep serving the old
      // answer for every application already looked at.
      versionedKind(AI_CACHE_KINDS.HIGHLIGHTS, HIGHLIGHTS_PROMPT),
      app.authority_id,
      app.planning_reference,
      async () => {
        const conditions = await fetchAgileConditions(
          app.authority_id,
          app.source_url,
          app.planning_reference
        );
        return conditionHighlights(conditions?.items ?? [], callClaude);
      }
    );
    return send(res, 200, { supported: true, highlights });
  }

  // What the council has asked for before it will decide. Its own endpoint, so
  // the request itself renders without waiting on the model — the same shape
  // as the refusal line and the condition highlights.
/**
 * Why a scanned document could not be turned into a summary.
 *
 * Silence was the old answer to all of these, and silence on a decision reads
 * as "there were no conditions" — the most expensive thing this app can imply.
 * The commonest cause on Meath is a file scanned before the councils moved to
 * PDF: the decision order is there, we fetch it successfully, and it is a DjVu,
 * which the model cannot read and no converter here can turn into one.
 */
/**
 * A fetched council document as something the model can look at.
 *
 * A PDF goes straight through. An older scan has to be decoded first — see
 * _documents/djvu.mjs for why the councils hold these in DjVu and why nobody
 * else can render it for us. Returns [] when neither applies, which the
 * callers report as a fact about the document rather than about the decision.
 */
async function documentAsContent(doc) {
  if (!doc || doc === "too_large") return [];
  const isPdf = /pdf/i.test(doc.contentType) || /\.pdf$/i.test(doc.filename ?? "");
  if (isPdf) {
    return [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: doc.body.toString("base64") },
      },
    ];
  }
  if (isDjvu(doc.contentType, doc.filename)) return djvuToImageBlocks(doc.body);
  return [];
}

/**
 * Put the document index back on a cached answer that predates it.
 *
 * The summaries were cached before the sheet could link to their source, so
 * every application anyone has already looked at holds a title and no index.
 * Re-reading the document to fill that in would cost a model call for a link;
 * the file listing alone answers it, and only for the entries that are
 * missing it, so nothing already correct pays anything.
 */
async function withDocumentIndex(app, stored, findIndex) {
  if (!stored || typeof stored !== "object") return stored;
  if (!stored.source_document || stored.source_document_index != null) return stored;
  const listUrl = scannedFilesUrl(app.authority_id, app.source_url, app.planning_reference);
  if (!listUrl) return stored;
  const files = await fetchScannedFileList(listUrl);
  if (!files) return stored;
  // By title first — it is what was stored — then by asking the same matcher
  // that chose it in the first place.
  const byTitle = files.findIndex((f) => f?.title === stored.source_document);
  const index = byTitle >= 0 ? byTitle : findIndex(files);
  return index >= 0 ? { ...stored, source_document_index: index } : stored;
}

/**
 * The same, for a cached decision extract.
 *
 * Its titles were stored joined — `A" and "B` — because that string was
 * dropped straight into a sentence in quotes. Split back apart and matched
 * against the listing, so an answer cached before this can still link to both
 * documents it was read from.
 */
async function withDecisionDocuments(app, stored) {
  if (!stored || typeof stored !== "object") return stored;
  if (!stored.source_document || stored.source_documents?.length) return stored;
  const listUrl = scannedFilesUrl(app.authority_id, app.source_url, app.planning_reference);
  if (!listUrl) return stored;
  const files = await fetchScannedFileList(listUrl);
  if (!files) return stored;
  const source_documents = matchDocumentIndexes(files, stored.source_document);
  return source_documents.length ? { ...stored, source_documents } : stored;
}

const readableReason = (doc, content) => {
  if (!doc) return "unavailable";
  if (doc === "too_large") return "too_large";
  if (content?.length) return null;
  // A DjVu that produced no pages is a decode that failed, not a format we
  // decline to read — those are read now, out of a page of pixels.
  return isDjvu(doc.contentType, doc.filename) ? "djvu" : "unreadable_format";
};

  const fim = route.match(/^\/api\/applications\/(\d+)\/further-info-summary$/);
  if (fim) {
    const app = BUNDLE.applications.find((a) => a.id === Number(fim[1]));
    if (!app) return send(res, 404, { error: "Application not found" });
    const isAgileApp = app.authority_id in AGILE_CLIENT_BY_AUTHORITY;
    // Versioned on the document choice as well as the prompt: a summary read
    // from the wrong letter is not made right by the prompt staying the same.
    const cacheKind = versionedKind(
      AI_CACHE_KINDS.FURTHER_INFO,
      `${FURTHER_INFO_PROMPT}#${FI_SELECTION_VERSION}`
    );

    if (isAgileApp) {
      const conditions = await fetchAgileConditions(
        app.authority_id,
        app.source_url,
        app.planning_reference
      );
      // Only while the request is the live state of the file. Once a decision
      // issues, the D/I items are history and the decision is the answer.
      // Not only while the council is waiting: the request is the clearest
      // record of what the planner was worried about, and that is worth
      // reading on a decided application too — often more so.
      const asked = furtherInfoItems(conditions?.items ?? []);
      if (asked.length) {
        const summary = await aiCached(cacheKind, app.authority_id, app.planning_reference, () =>
          furtherInfoSummary(asked, callClaude)
        );
        return send(res, 200, { supported: true, summary });
      }
      /**
       * No structured request — which is not the same as no request.
       *
       * South Dublin's conditions endpoint answers only once a decision has
       * issued, so on SD26B/0100W — asked for more in April, answered in July,
       * still undecided — there was nothing to read and the sheet said the
       * council "publishes the request as a letter on the file", which is the
       * note written for Kildare, Meath and Wicklow. The letter is genuinely
       * there ("Notification of Decision ADDITIONAL INFORMATION"), so read it
       * the same way those councils' letters are read rather than giving up
       * on a council that simply has not filed the structured version yet.
       *
       * Only where a file listing exists: Dublin City, Fingal and DLR are
       * served by the portal's JSON document API instead, and they publish the
       * structured items anyway, so they fall through to a null summary.
       */
      if (!scannedFilesUrl(app.authority_id, app.source_url, app.planning_reference)) {
        return send(res, 200, { supported: true, summary: null });
      }
    }

    /**
     * eplanning councils (Kildare, Wicklow, Meath) publish no structured
     * conditions, so the request is a scanned letter in the file list —
     * "F.I. Request Letter". Read like the decision order: find it, fetch it,
     * hand the PDF to the model. Cached, because a scanned letter is the most
     * expensive thing a page view can trigger and the request never changes
     * once issued.
     */
    // Answered and decided both count: what the council asked for is the
    // clearest published record of what the planner was worried about.
    if (app.status !== "further_info" && !app.further_info_requested_date) {
      return send(res, 200, { supported: true, summary: null });
    }
    const listUrl = scannedFilesUrl(app.authority_id, app.source_url, app.planning_reference);
    if (!listUrl) return send(res, 200, { supported: false, summary: null });
    const stored = await aiCacheGet(cacheKind, app.authority_id, app.planning_reference);
    if (stored !== undefined)
      return send(res, 200, {
        supported: true,
        ...(await withDocumentIndex(app, stored, (fs) =>
          findFurtherInfoDocIndex(fs, app.further_info_requested_date)
        )),
      });
    if (!(await aiDailyCapCheck(req, res))) return;
    const files = await fetchScannedFileList(listUrl);
    // The register's own record of when it asked — on Dublin City that is the
    // only thing separating the request from the decision, since both are
    // filed as "Decision Notices".
    const index = files ? findFurtherInfoDocIndex(files, app.further_info_requested_date) : -1;
    const empty = { supported: true, summary: null, source_document: null, source_document_index: null };
    if (index < 0) return send(res, 200, empty);
    const doc = await fetchScannedDocument(listUrl, index, 10_000_000);
    // The index travels with the title so the sheet can link to the letter
    // rather than telling the reader to go and find it.
    const source_document = files[index].title;
    const source_document_index = index;
    const content = await documentAsContent(doc);
    const unreadable = readableReason(doc, content);
    if (unreadable)
      return send(res, 200, { ...empty, source_document, source_document_index, reason: unreadable });
    const raw = await callClaude(
      FURTHER_INFO_PROMPT,
      [
        ...content,
        { type: "text", text: "Say what this request is about, within the word limit." },
      ],
      // Tokens sized to the word budget rather than to the letter: a cap the
      // model can comfortably reach is a cap it will reach, and a multi-page
      // request invites it to reproduce rather than summarise.
      220,
      30000
    );
    // Same cleanup and word budget as the structured path, so a request read
    // from a PDF and one read from conditions come out the same length.
    const summary = cleanSummary(raw);
    const result = { summary, source_document, source_document_index };
    if (summary) await aiCachePut(cacheKind, app.authority_id, app.planning_reference, result);
    return send(res, 200, { supported: true, ...result });
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
      // The Commission's own word for what it decided, where its case page
      // gave us one — the register's code is coarser and, for MODIFIED,
      // ambiguous enough that it must not be stated as an outcome.
      decision: bestAppealDecision(details?.fields, app.appeal_decision),
      decision_label: appealOutcome(bestAppealDecision(details?.fields, app.appeal_decision)).label,
      outcome: appealOutcome(bestAppealDecision(details?.fields, app.appeal_decision)).kind,
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
    const debug = p.get("debug") === "1";
    if (!debug) {
      // An appeal PDF is the priciest read in the app — never repeat it for a
      // case the Commission has already decided.
      // Versioned on the prompt: the summaries written before this change were
      // read off the inspector's report and some of them say the opposite of
      // what was decided. They must not survive it.
      const stored = await aiCacheGet(
        appealCacheKind(),
        app.authority_id,
        app.planning_reference
      );
      if (stored !== undefined) return send(res, 200, { supported: true, ...stored });
    }
    const cached = APPEAL_SUMMARY_CACHE.get(app.id);
    if (cached) return send(res, 200, { supported: true, ...cached });
    if (!(await aiDailyCapCheck(req, res))) return;

    const trace = debug ? [] : undefined;
    const details = await fetchAppealCase(caseUrl, trace);
    // The Commission's own wording where its case page gave us one, the
    // council's register code otherwise — and the outcome stated first, so it
    // frames everything the model reads rather than competing with it.
    const decisionText = bestAppealDecision(details?.fields, app.appeal_decision);
    const outcome = appealOutcome(decisionText);
    const context = [
      outcome.kind
        ? `THE COMMISSION'S DECISION: ${decisionText} (${outcome.label})${app.appeal_decision_date ? ` on ${app.appeal_decision_date}` : ""}. This is the outcome. Do not contradict it.`
        : decisionText
          ? `An Coimisiún Pleanála decision: ${decisionText}${app.appeal_decision_date ? ` on ${app.appeal_decision_date}` : ""}`
          : null,
      app.description ? `Development: ${app.description}` : null,
      `Council decision: ${app.decision ?? "unknown"}`,
      app.appeal_status ? `Appeal status: ${app.appeal_status}` : null,
      ...(details?.fields ?? []).map((f) => `${f.label}: ${f.value}`),
    ]
      .filter(Boolean)
      .join("\n");
    const doc = details ? pickAppealDocument(details.documents) : null;
    const pdf = doc ? await fetchAppealDocumentBase64(doc.url, 12_000_000, trace) : null;
    /**
     * Nothing to read means nothing to say.
     *
     * The context above is built from fields the sheet already displays — the
     * development, the council's decision, the Commission's decision and its
     * date. Handed only that and asked who appealed and why, the model has to
     * invent both, and it does: DLR D07B/0746 (case page unreachable, no
     * documents, no fields) produced "A householder appealed against the
     * council's decision… their property" — which describes an applicant
     * appealing their own grant — and "finding that the proposed development
     * was not acceptable", a tautology standing in for the reasons. Five named
     * third-party observers are on that file; it was a neighbour appeal.
     *
     * So a summary requires something the reader cannot already see: the
     * board order or inspector's report, or enough of the case record to carry
     * facts of its own. The sheet handles a null summary honestly already —
     * it says the case file has the full record and links to it.
     */
    const hasSource = Boolean(pdf) || (details?.fields?.length ?? 0) >= 3;
    if (!hasSource) {
      if (debug) {
        return send(res, 200, {
          case_url: caseUrl,
          summary: null,
          declined: "no case document and too little of the case record to summarise",
          fields: details?.fields?.length ?? 0,
          trace,
        });
      }
      return send(res, 200, { supported: true, summary: null, based_on_document: null });
    }
    /**
     * With the order in hand, read it the way a council decision order is
     * read: the narrative and the schedule of conditions in one pass. Without
     * one, the old prose-only path still applies to whatever the case record
     * carries.
     */
    const extracted = pdf
      ? await extractAppealOrder(
          [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } }],
          context
        )
      : null;
    let summary = extracted?.summary ?? (await summariseAppeal(context, pdf));
    let conditions = extracted?.conditions ?? [];
    let reasons = extracted?.reasons ?? [];
    /**
     * The last line of defence, and the one that would have caught case
     * 322612: a summary that says the opposite of the decision printed beside
     * it is worse than no summary, because the reader has no way to know which
     * half to believe. Dropped rather than shown.
     */
    const contradicted = contradictsOutcome(summary, outcome.kind);
    if (contradicted) summary = null;
    // Conditions belong to a grant and reasons to a refusal; anything else is
    // the model having filled in a field it should have left empty.
    if (outcome.kind === "granted") reasons = [];
    if (outcome.kind === "refused") conditions = [];
    if (debug)
      return send(res, 200, {
        case_url: caseUrl,
        based_on_document: pdf ? doc?.title : null,
        decision: decisionText,
        outcome,
        contradicted,
        summary,
        conditions,
        reasons,
        fields: details?.fields ?? [],
        trace,
      });
    const result = {
      summary,
      based_on_document: summary && pdf ? doc?.title ?? null : null,
      // The Commission publishes its orders as ordinary PDFs on its own site,
      // so this one needs no proxy — the sheet links straight to it.
      based_on_document_url: summary && pdf ? doc?.url ?? null : null,
      decision: decisionText,
      decision_label: outcome.label,
      outcome: outcome.kind,
      conditions,
      reasons,
    };
    if (!summary && !conditions.length && !reasons.length)
      return send(res, 200, { supported: true, ...result });
    APPEAL_SUMMARY_CACHE.set(app.id, result);
    // Only once the Commission has decided: a live case still changes.
    if (app.appeal_decision) {
      await aiCachePut(appealCacheKind(), app.authority_id, app.planning_reference, result);
    }
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
    const debug = p.get("debug") === "1";
    if (!debug) {
      // A 4-page scanned order is ~8k input tokens and this fires
      // automatically on every eplanning refusal — by far the most expensive
      // thing a single page view can trigger.
      // Versioned on both prompts that shape the stored payload — it now
      // carries the notable conditions as well as the extract, and entries
      // written before that must not keep being served without them.
      const stored = await aiCacheGet(
        decisionCacheKind(),
        app.authority_id,
        app.planning_reference
      );
      if (stored !== undefined)
        return send(res, 200, { supported: true, ...(await withDecisionDocuments(app, stored)) });
    }
    const cached = DECISION_SUMMARY_CACHE.get(app.id);
    if (cached) return send(res, 200, { supported: true, ...cached });
    if (!(await aiDailyCapCheck(req, res))) return;
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
    const empty = {
      supported: true,
      summary: null,
      conditions: [],
      reasons: [],
      highlights: null,
      source_document: null,
      source_documents: [],
    };
    if (!files || index < 0) return send(res, 200, { ...empty, reason: "not_found" });
    const doc = await fetchScannedDocument(listUrl, index, 10_000_000, trace);
    /**
     * Which documents this was read out of, and where to find each one.
     *
     * The title alone made the reader hunt for it in a list of a hundred —
     * Kildare 2660420 carries twenty-two — so the index travels with it and
     * the sheet links straight through the document proxy. An array because a
     * decision is not always one file: where the council keeps the conditions
     * in a schedule of their own, two were read.
     */
    const sourceDocuments = [{ title: files[index].title, index }];
    const named = () => ({
      source_document: sourceDocuments.map((d) => d.title).join(TITLE_JOIN),
      source_documents: sourceDocuments,
    });
    const content = await documentAsContent(doc);
    const unreadable = readableReason(doc, content);
    if (unreadable) return send(res, 200, { ...empty, ...named(), reason: unreadable });
    // Where the council keeps the conditions in a schedule of their own, read
    // that too — the letter alone says how many there are and not what they say.
    const scheduleIndex = findConditionsScheduleIndex(files, index);
    if (scheduleIndex >= 0) {
      const schedule = await fetchScannedDocument(listUrl, scheduleIndex, 10_000_000, trace);
      const scheduleContent = await documentAsContent(schedule);
      if (scheduleContent.length) {
        content.push(...scheduleContent);
        sourceDocuments.push({ title: files[scheduleIndex].title, index: scheduleIndex });
      }
    }
    const extract = await extractDecisionDocument(content, app.decision);
    if (!extract) return send(res, 200, { ...empty, ...named(), reason: "unavailable" });
    /**
     * The same "notable conditions" the other four councils get.
     *
     * It was only ever built for the councils with a conditions API, because
     * that is where the conditions came from — so Kildare, Meath and Wicklow
     * showed a bare list and the other four showed the list with the ones that
     * bind pulled out on top. Same app, different answer, for no reason the
     * reader could see. The conditions have just been extracted from the
     * order; they go through the same reader as everyone else's.
     */
    const highlights = extract.conditions.length
      ? await conditionHighlights(
          extract.conditions.map((c, i) => ({
            code: "C",
            order: c.number ?? i + 1,
            title: c.title,
            text: c.text,
          })),
          callClaude
        )
      : null;
    const result = { ...extract, highlights, ...named() };
    DECISION_SUMMARY_CACHE.set(app.id, result);
    await aiCachePut(decisionCacheKind(), app.authority_id, app.planning_reference, result);
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
        ? new Set()
        : new Set(addressIndex().get(app.authority_id + "|" + addressKey(app.address_text)) ?? []);
    // Read only once there is something to compare, so a detail view with no
    // address matches never touches the sidecar.
    const boundsFor =
      relatedIds && relatedIds.size > 0 ? (a) => siteBounds()[String(a.id)] ?? null : null;
    const related =
      !relatedIds || relatedIds.size === 0
        ? []
        : BUNDLE.applications
            .filter((a) => a.id !== id && relatedIds.has(a.id) && sameSite(app, a, boundsFor))
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
      // Baked at build time for the whole register, so this is a lookup rather
      // than the model call every view used to trigger. The warm-instance map
      // still covers anything generated since the last build.
      ai_summary: bakedSummary(app.description) ?? AI_SUMMARY_CACHE.get(app.description) ?? null,
      documents: [],
      related,
      cited: citationsFor(app),
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
          /AppFileRefDetails\/[^/?#]+(\/\d*)?.*/i,
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
    if (!(await aiDailyCapCheck(req, res))) return;

    let description = app.description ?? null;
    let parties = { applicant: null, agent: null };
    const debug = p.get("debug") === "1";
    const summaryTrace = [];
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
      // Only meaningful when ai_summary is null: "insufficient" is a fact
      // about the description, "unavailable" is a fact about us.
      summary_status: aiSummary ? "ok" : summaryStatus(summaryTrace, description),
      // debug=1 only: why a null summary is null.
      ...(debug ? { summary_trace: summaryTrace, description_len: description?.length ?? 0 } : {}),
      applicant_name: app.applicant_name ?? parties.applicant,
      agent_name: app.agent_name ?? parties.agent,
      description,
      // The national dataset's postcode is ~2% populated; the agile register
      // often has the real Eircode.
      eircode: app.eircode ?? detail?.eircode ?? null,
      officer_name: detail?.officer ?? null,
      // The window for public observations. Only the agile portals publish it;
      // the national dataset leaves the column empty for these councils, so an
      // application open for submissions showed no deadline and no countdown.
      submissions_by_date: detail?.submissionsBy ?? null,
      // Present only when the live portal outcome supersedes the baked status,
      // so the panel can correct the badge.
      status: useLiveStatus ? liveStatus : null,
      status_raw: useLiveStatus ? liveRaw : null,
      status_label: useLiveStatus ? STATUS_LABELS[liveStatus] : null,
      cited_urls: await resolveCitedUrls(app),
    });
  }

  return send(res, 404, { error: "Not found" });
}
