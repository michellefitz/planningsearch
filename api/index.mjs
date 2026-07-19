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
  if (authorityId !== "kildare" || !sourceUrl) return null;
  const m = sourceUrl.match(/AppFileRefDetails\/(\d+)/i);
  return m
    ? `https://idocsweb.kildarecoco.ie/iDocsWebDPSS/listFiles.aspx?catalog=planning&id=${m[1]}`
    : null;
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

function parseFileListHtml(html, baseUrl) {
  const files = [];
  const seen = new Set();
  const push = (url, title, fallback) => {
    if (seen.has(url)) return;
    seen.add(url);
    files.push({ title: title || fallback, url });
  };

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
    push(url, GENERIC_LABEL_RE.test(label) ? title : fullerCell ?? label ?? title, filename);
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

async function fetchScannedFileList(listUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(listUrl, { signal: controller.signal, headers: UA_HEADERS });
    if (!res.ok) return null;
    const files = parseFileListHtml(await res.text(), listUrl);
    return files.length > 0 ? files : null;
  } catch {
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
    return { contentType, disposition: docRes.headers.get("content-disposition"), body };
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
const AGILE_CLIENT_BY_AUTHORITY = { "south-dublin": "SD", "dublin-city": "DCC", fingal: "FG" };

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

async function fetchAgileParties(authorityId, sourceUrl, reference) {
  const none = { applicant: null, agent: null };
  const client = AGILE_CLIENT_BY_AUTHORITY[authorityId];
  if (!client) return none;
  const cacheKey = `agile:${authorityId}:${reference}`;
  if (PARTIES_CACHE.has(cacheKey)) return PARTIES_CACHE.get(cacheKey);
  let id = sourceUrl?.match(/application-details\/(\d+)/i)?.[1];
  if (!id) {
    const found = await agileGetJson(
      `${AGILE_API}/application/search?query=${encodeURIComponent(reference)}`,
      client
    );
    const hit = found?.results?.find(
      (r) => r.reference?.trim().toLowerCase() === reference.trim().toLowerCase()
    );
    id = hit ? String(hit.id) : null;
  }
  if (!id) return none;
  const d = await agileGetJson(`${AGILE_API}/application/${id}`, client);
  if (!d || typeof d !== "object") return none;
  const parties = {
    applicant: joinName(d.applicantForename, d.applicantSurname, d.applicantName),
    agent: joinName(d.agentForename, d.agentSurname, d.agentName),
  };
  if (parties.applicant || parties.agent) PARTIES_CACHE.set(cacheKey, parties);
  return parties;
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

async function summariseDescription(description, applicationType) {
  if (!ANTHROPIC_API_KEY || !description) return null;
  const cacheKey = description;
  if (AI_SUMMARY_CACHE.has(cacheKey)) return AI_SUMMARY_CACHE.get(cacheKey);
  const systemPrompt =
    "You summarise Irish planning applications in one short sentence of plain English. " +
    "The reader is a regular person, not a planner or architect. " +
    "Say what the project actually is: an extension, a new house, a commercial unit, solar panels, etc. " +
    "Include key details like number of bedrooms or storeys only when stated. " +
    'Never start with "This application is for". Just state what it is. ' +
    "Keep it under 30 words.";
  const userMsg = applicationType
    ? `Application type: ${applicationType}\nDescription: ${description}`
    : description;
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
        max_tokens: 100,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content?.find((b) => b.type === "text")?.text?.trim() || null;
    if (text) AI_SUMMARY_CACHE.set(cacheKey, text);
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function publicApp(a) {
  const auth = AUTH.get(a.authority_id);
  return {
    ...a,
    is_domestic_guess: Boolean(a.is_domestic_guess),
    status_label: BUNDLE.statuses[a.status] ?? a.status,
    application_type_label: BUNDLE.application_types[a.application_type] ?? a.application_type ?? "",
    authority_name: auth?.name ?? a.authority_id,
    authority_short_name: auth?.short_name ?? a.authority_id,
    portal_url: a.source_url ?? null,
    scanned_files_url: scannedFilesUrl(a.authority_id, a.source_url, a.planning_reference),
  };
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
  const rf = p.get("receivedFrom"), rt = p.get("receivedTo");
  const df = p.get("decisionFrom"), dt = p.get("decisionTo");
  const bbox = parseBbox(p.get("bbox"));
  return rows.filter((a) => {
    if (auths && !auths.includes(a.authority_id)) return false;
    if (statuses && !statuses.includes(a.status)) return false;
    if (types && !types.includes(a.application_type)) return false;
    if (domestic && a.is_domestic_guess !== 1) return false;
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
    const listUrl = app
      ? scannedFilesUrl(app.authority_id, app.source_url, app.planning_reference)
      : null;
    if (!listUrl) return send(res, 404, { error: "No scanned files source" });
    const debug = p.get("debug") === "1";
    const trace = debug ? [] : undefined;
    const doc = await fetchScannedDocument(listUrl, Number(dm[2]), 4_000_000, trace);
    if (debug) {
      return send(res, 200, { listUrl, index: Number(dm[2]), result: doc === null ? "null" : doc === "too_large" ? "too_large" : "ok", trace });
    }
    if (doc === "too_large" || doc === null) {
      const reason =
        doc === "too_large"
          ? "This document is too large to display here."
          : "Couldn't retrieve this document from the council just now.";
      res.statusCode = doc === "too_large" ? 413 : 502;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><meta charset="utf-8"><title>PlanView</title>` +
          `<p>${reason}</p><p><a href="${listUrl}">Open it on the council's scanned-files viewer instead</a>.</p>`
      );
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", doc.contentType);
    if (doc.disposition) res.setHeader("Content-Disposition", doc.disposition);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.end(doc.body);
    return;
  }

  const fm = route.match(/^\/api\/applications\/(\d+)\/files$/);
  if (fm) {
    const app = BUNDLE.applications.find((a) => a.id === Number(fm[1]));
    if (!app) return send(res, 404, { error: "Application not found" });
    const listUrl = scannedFilesUrl(app.authority_id, app.source_url, app.planning_reference);
    if (!listUrl) return send(res, 200, { supported: false, files: null, list_url: null });
    const files = await fetchScannedFileList(listUrl);
    return send(res, 200, {
      supported: true,
      list_url: listUrl,
      files,
      objection_count: files ? countObjectionFiles(files) : null,
    });
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
    const needsParties = !(app.applicant_name && app.agent_name);
    const [aiSummary, parties] = await Promise.all([
      summariseDescription(app.description, app.application_type),
      !needsParties
        ? Promise.resolve({ applicant: null, agent: null })
        : app.authority_id in AGILE_CLIENT_BY_AUTHORITY
          ? fetchAgileParties(app.authority_id, app.source_url, app.planning_reference)
          : app.source_url
            ? fetchEplanningParties(app.source_url)
            : Promise.resolve({ applicant: null, agent: null }),
    ]);
    const merged = {
      ...app,
      applicant_name: app.applicant_name ?? parties.applicant,
      agent_name: app.agent_name ?? parties.agent,
    };
    return send(res, 200, { ...publicApp(merged), ai_summary: aiSummary, documents: [], related });
  }

  return send(res, 404, { error: "Not found" });
}
