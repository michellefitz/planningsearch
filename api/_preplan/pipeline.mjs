/**
 * Pre-planner pipeline — serverless mirror of server/src/preplan/*.
 * Keep the two in sync: sections, event shapes and prompts are identical.
 */

// ---------- geo ----------

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(lng, lat, poly) {
  let count = 0;
  for (const ring of poly) if (inRing(lng, lat, ring)) count++;
  return count % 2 === 1;
}

export function pointInFeature(lng, lat, feature) {
  const g = feature?.geometry;
  if (!g?.type || !Array.isArray(g.coordinates)) return false;
  if (g.type === "Polygon") return inPolygon(lng, lat, g.coordinates);
  if (g.type === "MultiPolygon") return g.coordinates.some((poly) => inPolygon(lng, lat, poly));
  return false;
}

// ---------- point data ----------

const GZT_URL =
  process.env.PLANVIEW_GZT_URL ??
  "https://services.arcgis.com/NzlPQPKn5QF9v2US/ArcGIS/rest/services/GZT_Current_Plan/FeatureServer/0/query";
const NPWS_URL =
  process.env.PLANVIEW_NPWS_URL ??
  "https://services-eu1.arcgis.com/Jhij7i46ouO8Cc0N/arcgis/rest/services/NPWSDesignatedAreas/FeatureServer";
const SAC_URL = process.env.PLANVIEW_SAC_URL ?? `${NPWS_URL}/3/query`;
const SMR_ZONE_URL =
  process.env.PLANVIEW_SMR_ZONE_URL ??
  "https://services-eu1.arcgis.com/HyjXgkV6KGMSF3jt/arcgis/rest/services/SMRZoneOpenData/FeatureServer/0/query";
const GSI_GWV_URL =
  process.env.PLANVIEW_GSI_GWV_URL ??
  "https://gsi.geodata.gov.ie/server/rest/services/Groundwater/IE_GSI_Groundwater_Vulnerability_40K_IE26_ITM/FeatureServer/0/query";
const NIAH_URL =
  process.env.PLANVIEW_NIAH_URL ??
  "https://services-eu1.arcgis.com/HyjXgkV6KGMSF3jt/arcgis/rest/services/NIAHBuildingsOpenData/FeatureServer/0/query";
const SMR_POINT_URL =
  process.env.PLANVIEW_SMR_POINT_URL ??
  "https://services-eu1.arcgis.com/HyjXgkV6KGMSF3jt/arcgis/rest/services/SMROpenData/FeatureServer/0/query";

export const DESIGNATION_MEANING = {
  zoning:
    "Your proposal must be a use that is permitted, or open for consideration, under this zoning objective.",
  "Special Area of Conservation":
    "EU-protected habitat. An application near or affecting it may need Appropriate Assessment screening.",
  "Special Protection Area":
    "EU-protected bird habitat. An application near or affecting it may need Appropriate Assessment screening.",
  "Natural Heritage Area":
    "Nationally protected habitat — works affecting it need extra scrutiny and may need ecological input.",
  "Proposed Natural Heritage Area":
    "Proposed for national protection; councils treat it as a material consideration.",
  archaeology:
    "Zone of Archaeological Notification — works here must be notified to the National Monuments Service, and an archaeological assessment may be required.",
  aca: "Architectural Conservation Area — external works that would normally be exempt development usually need permission here, and design standards are higher.",
  flood:
    "Indicative flood extent — a Site-Specific Flood Risk Assessment may be required, and some uses are restricted under the Flood Risk Management Guidelines.",
  groundwater_high:
    "High groundwater vulnerability — matters for wastewater treatment (septic tanks) and some ground works.",
};

function pointQueryUrl(base, lat, lng, outFields, extra = {}) {
  const params = new URLSearchParams({
    f: "geojson",
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    where: "1=1",
    outFields,
    returnGeometry: extra.returnGeometry ?? "false",
    resultRecordCount: "25",
    ...extra,
  });
  const geometry = encodeURIComponent(JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }));
  return `${base}?${params}&geometry=${geometry}`;
}

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));

async function features(deps, url) {
  const body = await deps.fetchJson(url);
  if (body?.error || !Array.isArray(body?.features)) throw new Error("bad ArcGIS response");
  return body.features;
}

export async function getDesignations(lat, lng, deps) {
  const items = [];
  const checked = [];
  const failed = [];
  const npws = [
    { url: SAC_URL, designation: "Special Area of Conservation" },
    { url: `${NPWS_URL}/0/query`, designation: "Special Protection Area" },
    { url: `${NPWS_URL}/2/query`, designation: "Natural Heritage Area" },
    { url: `${NPWS_URL}/1/query`, designation: "Proposed Natural Heritage Area" },
  ];
  const sources = [
    {
      label: "zoning",
      async run() {
        const feats = await features(
          deps,
          pointQueryUrl(GZT_URL, lat, lng, "ZONE_ORIG,ZONE_DESC,GZT_DESC,PLAN_NAME", { where: "CURRENT_PLAN=1" })
        );
        return feats.slice(0, 1).map((f) => {
          const p = f.properties ?? {};
          return {
            kind: "Zoning",
            name: str(p.ZONE_DESC) || str(p.ZONE_ORIG) || "Zoned land",
            detail: [str(p.ZONE_ORIG), str(p.GZT_DESC), str(p.PLAN_NAME)].filter(Boolean).join(" · "),
            meaning: DESIGNATION_MEANING.zoning,
          };
        });
      },
    },
    ...npws.map((src) => ({
      label: src.designation,
      async run() {
        const feats = await features(deps, pointQueryUrl(src.url, lat, lng, "SITECODE,SITE_NAME,URL"));
        return feats.map((f) => {
          const p = f.properties ?? {};
          return {
            kind: src.designation,
            name: str(p.SITE_NAME) || src.designation,
            detail: str(p.SITECODE),
            meaning: DESIGNATION_MEANING[src.designation],
          };
        });
      },
    })),
    {
      label: "archaeology",
      async run() {
        const feats = await features(deps, pointQueryUrl(SMR_ZONE_URL, lat, lng, "ZONE_ID"));
        return feats.map((f) => ({
          kind: "Zone of Archaeological Notification",
          name: `Zone ${str(f.properties?.ZONE_ID) || "(recorded monuments)"}`,
          detail: "",
          meaning: DESIGNATION_MEANING.archaeology,
        }));
      },
    },
    {
      label: "aca",
      async run() {
        const fc = await deps.loadStaticGeojson("aca");
        return fc.features
          .filter((f) => pointInFeature(lng, lat, f))
          .map((f) => {
            const p = f.properties ?? {};
            return {
              kind: "Architectural Conservation Area",
              name: str(p.aca_name) || "ACA",
              detail: [str(p.ref), str(p.council_label)].filter(Boolean).join(" · "),
              meaning: DESIGNATION_MEANING.aca,
            };
          });
      },
    },
  ];
  const results = await Promise.allSettled(sources.map((s) => s.run()));
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      checked.push(sources[i].label);
      items.push(...r.value);
    } else failed.push(sources[i].label);
  });
  return { items, checked, failed };
}

const HERITAGE_RADIUS_M = 250;

function itemDistance(lat, lng, f) {
  const g = f.geometry;
  if (g?.type !== "Point" || !Array.isArray(g.coordinates)) return null;
  const [x, y] = g.coordinates;
  return Math.round(haversineMeters(lat, lng, y, x));
}

export async function getHeritagePoints(lat, lng, deps) {
  const radius = { distance: String(HERITAGE_RADIUS_M), units: "esriSRUnit_Meter", returnGeometry: "true" };
  const [niah, smr] = await Promise.allSettled([
    features(deps, pointQueryUrl(NIAH_URL, lat, lng, "*", radius)),
    features(deps, pointQueryUrl(SMR_POINT_URL, lat, lng, "*", radius)),
  ]);
  const sort = (xs) => xs.sort((a, b) => (a.distance_m ?? 9e9) - (b.distance_m ?? 9e9)).slice(0, 12);
  return {
    niah:
      niah.status === "fulfilled"
        ? sort(
            niah.value.map((f) => {
              const p = f.properties ?? {};
              return {
                ref: str(p.REG_NO),
                name: str(p.NAME) || [str(p.NUMBER), str(p.STREET1)].filter(Boolean).join(" ") || "NIAH building",
                distance_m: itemDistance(lat, lng, f),
                detail: [str(p.ORIGINAL_TYPE), str(p.IN_USE_AS_TYPE) && `now ${str(p.IN_USE_AS_TYPE)}`]
                  .filter(Boolean)
                  .join(", "),
                url: str(p.REG_NO)
                  ? `https://www.buildingsofireland.ie/buildings-search/building/${str(p.REG_NO)}`
                  : undefined,
              };
            })
          )
        : { unavailable: true, reason: "NIAH service did not respond" },
    smr:
      smr.status === "fulfilled"
        ? sort(
            smr.value.map((f) => {
              const p = f.properties ?? {};
              const notes = str(p.WEB_NOTES);
              return {
                ref: str(p.SMRS) || str(p.ENTITY_ID),
                name: str(p.CLASSDESC) || str(p.CLASS_CODE) || "Recorded monument",
                distance_m: itemDistance(lat, lng, f),
                detail: str(p.TOWNLAND),
                notes: notes ? (notes.length > 280 ? `${notes.slice(0, 277)}…` : notes) : undefined,
                url: str(p.WEBSITE_LINK) || undefined,
              };
            })
          )
        : { unavailable: true, reason: "SMR service did not respond" },
  };
}

export async function getFloodGround(lat, lng, deps) {
  const [flood, gwv] = await Promise.allSettled([
    deps.loadStaticGeojson("flood").then((fc) => {
      const hits = fc.features.filter((f) => pointInFeature(lng, lat, f));
      const scenarios = [...new Set(hits.map((f) => str(f.properties?.scenario)).filter(Boolean))];
      return { at_risk: hits.length > 0, scenarios };
    }),
    features(deps, pointQueryUrl(GSI_GWV_URL, lat, lng, "VUL_CAT,VUL_DESC", { f: "json" })).then((feats) => {
      const attrs = feats[0]?.attributes ?? feats[0]?.properties;
      if (!attrs) return null;
      const cat = str(attrs.VUL_CAT);
      return {
        category: cat,
        description: str(attrs.VUL_DESC),
        meaning: /^(E|X|H)$/i.test(cat) ? DESIGNATION_MEANING.groundwater_high : "",
      };
    }),
  ]);
  return {
    flood: flood.status === "fulfilled" ? flood.value : { unavailable: true, reason: "flood extents could not be checked" },
    groundwater:
      gwv.status === "fulfilled" ? gwv.value : { unavailable: true, reason: "GSI groundwater service did not respond" },
    radon: { unavailable: true, reason: "the EPA radon map service is not publicly accessible" },
  };
}

// ---------- precedents & stats ----------

const STOPWORDS = new Set([
  "with", "that", "this", "from", "into", "onto", "over", "under", "have",
  "want", "would", "like", "build", "building", "house", "home", "property",
  "site", "planning", "permission", "application", "works", "existing",
  "proposed", "construction", "construct", "development",
]);

export function intentTokens(intent) {
  return [
    ...new Set(
      intent
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    ),
  ];
}

export const PRECEDENT_RADIUS_M = 1000;

/** Decisions read per report for the rural section. Each is a live fetch (and
 *  for Kildare a scanned PDF through the model), so the count is bounded. */
export const RURAL_REASON_READS = 5;

/** Asked of a scanned decision order when a council publishes no structured
 *  reasons. Quote-shaped on purpose: the value is the council's own wording of
 *  the test, not our paraphrase of it. */
export const RURAL_REASON_QUESTION =
  "This application to build a one-off house was refused. List the council's reasons for refusal, " +
  "quoting the operative wording of each. If a reason concerns rural housing policy or local need, " +
  "quote that reason in full. Do not summarise or interpret \u2014 reproduce what the order says.";

// Invalid/incomplete applications never got a planning judgement, so they say
// nothing about how this proposal would fare.
const IRRELEVANT_STATUSES = new Set(["invalid", "incomplete"]);

export function selectPrecedents(rows, lat, lng, intent, limit = 8) {
  const tokens = intentTokens(intent);
  const scored = [];
  for (const row of rows) {
    if (row.lat == null || row.lng == null) continue;
    if (row.status && IRRELEVANT_STATUSES.has(row.status)) continue;
    const distance_m = Math.round(haversineMeters(lat, lng, row.lat, row.lng));
    if (distance_m > PRECEDENT_RADIUS_M) continue;
    const desc = (row.description ?? "").toLowerCase();
    const hits = tokens.filter((t) => desc.includes(t));
    scored.push({ ...row, distance_m, score: hits.length * 2 + (1 - distance_m / PRECEDENT_RADIUS_M), keyword_hits: hits });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function deepDiveCandidates(precedents, max = 3) {
  return precedents
    .filter((p) => p.decision || p.appeal_reference)
    .sort((a, b) => Number(Boolean(b.appeal_reference)) - Number(Boolean(a.appeal_reference)) || b.score - a.score)
    .slice(0, max);
}

const GRANT_RE = /grant|conditional|approve/i;
const REFUSE_RE = /refus|reject/i;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function rateBlock(rows) {
  let granted = 0;
  let refused = 0;
  let appealed = 0;
  const days = [];
  for (const r of rows) {
    if (r.decision && GRANT_RE.test(r.decision)) granted++;
    else if (r.decision && REFUSE_RE.test(r.decision)) refused++;
    if (r.appeal_reference) appealed++;
    if (r.received_date && r.decision_date) {
      const d = (Date.parse(r.decision_date) - Date.parse(r.received_date)) / 86400000;
      if (d >= 0 && d < 1500) days.push(Math.round(d));
    }
  }
  const decided = granted + refused;
  return {
    total: rows.length,
    decided,
    granted,
    refused,
    grant_rate: decided ? Math.round((granted / decided) * 100) : null,
    appealed,
    median_decision_days: median(days),
  };
}

/* ---------- one-off houses ---------- */

/**
 * Is the user proposing to build a house on a site, rather than alter one?
 * Only then is the rural-housing section relevant — for an extension none of
 * this applies.
 */
export function isOneOffIntent(intent) {
  const t = `${intent ?? ""}`;
  if (/\b(extension|extend|attic|conversion|convert|garage|dormer|porch|retention)\b/i.test(t)) {
    return false;
  }
  return /\b(?:build|construct|erect|new)\b[\s\S]{0,40}\b(?:house|dwelling|home|bungalow)\b|\b(?:one[- ]off|self[- ]build)\b/i.test(
    t
  );
}

/**
 * What one-off houses are actually refused for. Counted over refusal reasons
 * read from 36 refused one-off houses across the three councils that publish
 * them: zoning 86%, local need 61%, sightlines 50%, visual amenity 47%,
 * precedent 36%, sprawl 28%, ribbon 25%, wastewater 19%.
 *
 * These are the tests an applicant is judged against, so the labels are
 * written as the thing to satisfy rather than as jargon.
 */
export const RURAL_REFUSAL_THEMES = [
  {
    key: "local_need",
    label: "Rural housing policy — demonstrating a local need",
    re: /\blocal need|housing need|rural housing policy|genuine need|intrinsic (?:part of|link)|local rural|bona ?fide|social or economic (?:need|link)/i,
  },
  {
    key: "zoning",
    label: "The site's zoning objective (greenbelt and similar)",
    re: /\bgreenbelt|green belt|zoning objective|zoned\b/i,
  },
  {
    key: "ribbon",
    label: "Ribbon development along the road",
    re: /\bribbon(?: development)?|linear development/i,
  },
  {
    key: "sprawl",
    label: "Urban-generated housing / suburbanising the countryside",
    re: /\bsprawl|suburbanis|urban generated|urban-generated/i,
  },
  {
    key: "wastewater",
    label: "Wastewater treatment and percolation on the site",
    re: /\bpercolation|waste ?water|effluent|groundwater|septic/i,
  },
  {
    key: "access",
    label: "Site access, sightlines and road safety",
    re: /\bsight ?lines?|traffic hazard|road safety|vehicular access/i,
  },
  {
    key: "visual",
    label: "Visual amenity and landscape character",
    re: /\bvisual (?:amenity|impact)|landscape|character of the area/i,
  },
  {
    key: "precedent",
    label: "Setting a precedent for further development",
    re: /\bprecedent\b/i,
  },
];

/** Which of the rural tests a refusal cites. */
export function classifyRefusalThemes(text) {
  const t = `${text ?? ""}`;
  if (!t.trim()) return [];
  return RURAL_REFUSAL_THEMES.filter((th) => th.re.test(t)).map((th) => th.key);
}

/**
 * The sentence a refusal uses to state the local-need test, for quoting
 * verbatim — it is the clearest statement of what an applicant has to prove,
 * and it is the council's own wording rather than ours.
 */
export function localNeedQuote(text) {
  const theme = RURAL_REFUSAL_THEMES[0];
  for (const sentence of `${text ?? ""}`.split(/(?<=[.;])\s+/)) {
    const s = sentence.replace(/\s+/g, " ").trim();
    if (s.length >= 40 && s.length <= 400 && theme.re.test(s)) return s;
  }
  return null;
}

/**
 * How one-off houses fare here against everything else the council decides.
 * The contrast is the point: measured over the register they run at 20-57%
 * against council baselines of 82-87%.
 */
export function oneOffRates(authorityRows, lat, lng, radiusM = 5000) {
  const oneOff = authorityRows.filter((r) => r.is_one_off);
  const near = oneOff.filter(
    (r) => r.lat != null && r.lng != null && haversineMeters(lat, lng, r.lat, r.lng) <= radiusM
  );
  return {
    radius_m: radiusM,
    within_radius: rateBlock(near),
    authority_one_off: rateBlock(oneOff),
    authority_all: rateBlock(authorityRows),
  };
}

export function areaStats(authorityRows, lat, lng) {
  const near = authorityRows.filter(
    (r) => r.lat != null && r.lng != null && haversineMeters(lat, lng, r.lat, r.lng) <= 2000
  );
  return { authority: rateBlock(authorityRows), within_2km: rateBlock(near) };
}

// ---------- report generator ----------

// County development plan landing pages, verified live 2026-07-27. The plan
// is the document a proposal is actually judged against — always link it.
export const LOCAL_PLANS = {
  "dublin-city": {
    name: "Dublin City Development Plan 2022–2028",
    url: "https://www.dublincity.ie/residential/planning/strategic-planning/dublin-city-development-plan",
  },
  fingal: {
    name: "Fingal Development Plan 2023–2029",
    url: "https://www.fingal.ie/planning",
  },
  dlr: {
    name: "Dún Laoghaire-Rathdown County Development Plan 2022–2028",
    url: "https://www.dlrcoco.ie/planning",
  },
  "south-dublin": {
    name: "South Dublin County Development Plan 2022–2028",
    url: "https://www.sdcc.ie/en/devplan2022/",
  },
  kildare: {
    name: "Kildare County Development Plan 2023–2029",
    url: "https://kildarecoco.ie/AllServices/Planning/DevelopmentPlansLocalAreaPlans/KildareCountyDevelopmentPlan2023-2029/",
  },
};

export const DEEP_DIVE_QUESTION =
  "Answer with exactly this structure and nothing else — no preamble, no closing remarks. " +
  "**Outcome**: one sentence — what was decided and the core reason. " +
  "**Key conditions**: at most 5 short bullets naming the themes of the conditions imposed, not verbatim " +
  "clauses; always call out any condition concerning flood risk, heritage/conservation or ground/site " +
  "conditions specifically. " +
  "**Refusal reasons**: short bullets — include this heading only if the application was refused or split.";

export const PRECEDENT_SUMMARY_PROMPT = `You are given a JSON array of nearby planning applications, each with a
planning_reference and a description copied verbatim from an Irish planning register.
For each one write a 1-2 sentence plain-English summary of what was applied for —
no legalese, no register boilerplate, no addresses.
Reply with only a JSON object mapping each planning_reference to its summary. No other text.`;

export const PREPLAN_SYNTHESIS_PROMPT = `You are writing the "Considerations" section of a pre-planning research report
for a member of the public in Ireland. You are given a JSON evidence pack gathered
for their site plus their stated intention.

Rules:
- Ground every statement in the evidence pack. Never invent designations,
  precedents or statistics. If a section was unavailable, you may note it was
  not checked.
- You are NOT predicting a decision and NOT giving professional advice. Never
  state or imply a likelihood of permission.
- Structure: **Overview** (2-3 sentences: the headline of what this research
  found for this site and intent — a person should get the gist from this
  alone), **Site constraints** (what the designations mean for this intent),
  **What nearby decisions show** (themes from precedents and their documents,
  cited by planning reference), **Likely condition themes**, **Worth checking
  before applying** (exempt-development thresholds, a pre-planning meeting with
  the council, and the specific chapters of the local development plan named in
  the evidence pack that bear on this proposal).
- Plain English, no legalese. 350-550 words. Markdown with the five bold
  headings above only.`;

const unavailable = (reason) => ({ unavailable: true, reason });

export async function* generateReport(input, deps) {
  const sections = {};

  yield { type: "progress", step: "Checking designations, heritage and ground conditions…" };

  const rowsPromise = deps.getRows(input.lat, input.lng).catch(() => null);
  const pending = new Map();
  const track = (name, p, failReason) =>
    pending.set(
      name,
      p.then(
        (data) => ({ name, data }),
        () => ({ name, data: unavailable(failReason) })
      )
    );

  track("designations", deps.getDesignations(input.lat, input.lng), "designation services did not respond");
  track("heritage_points", deps.getHeritagePoints(input.lat, input.lng), "heritage services did not respond");
  track("flood_ground", deps.getFloodGround(input.lat, input.lng), "flood and ground services did not respond");
  track(
    "precedents",
    rowsPromise.then((rows) => {
      if (!rows) throw new Error("rows unavailable");
      return { items: selectPrecedents(rows.nearby, input.lat, input.lng, input.intent), deep_dives: [] };
    }),
    "the planning register could not be searched"
  );
  track(
    "area_stats",
    rowsPromise.then((rows) => {
      if (!rows) throw new Error("rows unavailable");
      return areaStats(rows.authority, input.lat, input.lng);
    }),
    "area statistics could not be computed"
  );
  track(
    "local_plan",
    rowsPromise.then((rows) => {
      const plan = rows?.authority_id ? LOCAL_PLANS[rows.authority_id] : null;
      if (!plan) throw new Error("no plan known");
      return { authority_id: rows.authority_id, ...plan };
    }),
    "the local development plan could not be identified"
  );

  while (pending.size) {
    const done = await Promise.race(pending.values());
    pending.delete(done.name);
    sections[done.name] = done.data;
    yield { type: "section", name: done.name, data: done.data };
  }

  const precedents = sections.precedents;
  if (Array.isArray(precedents?.items) && precedents.items.length) {
    const unsummarised = precedents.items.filter((p) => !p.ai_summary && p.description);
    if (unsummarised.length && deps.summarisePrecedents) {
      yield { type: "progress", step: "Summarising the nearby applications…" };
      try {
        const summaries = await deps.summarisePrecedents(
          unsummarised.map((p) => ({ planning_reference: p.planning_reference, description: p.description }))
        );
        for (const p of unsummarised) {
          const s = summaries?.[p.planning_reference];
          if (typeof s === "string" && s.trim()) p.ai_summary = s.trim();
        }
        yield { type: "section", name: "precedents", data: precedents };
      } catch {
        // Raw descriptions still render; a failed summary batch only costs polish.
      }
    }
    const dives = [];
    for (const cand of deepDiveCandidates(precedents.items)) {
      yield { type: "progress", step: `Reading the decision documents for ${cand.planning_reference}…` };
      try {
        const read = await deps.readPrecedentDocument(cand, DEEP_DIVE_QUESTION);
        if (read) {
          dives.push({
            planning_reference: cand.planning_reference,
            authority_id: cand.authority_id,
            document: read.document,
            extract: read.answer,
          });
        }
      } catch {
        // One unreadable document never sinks the report.
      }
    }
    precedents.deep_dives = dives;
    sections.precedents = precedents;
    yield { type: "section", name: "precedents", data: precedents };
  }

  // Rural housing: only for a proposal to build a house, and only where the
  // register actually holds one-off houses nearby to learn from.
  if (isOneOffIntent(input.intent)) {
    const rows = await rowsPromise;
    if (rows?.authority?.length) {
      const rates = oneOffRates(rows.authority, input.lat, input.lng);
      // Refused ones first and nearest first: a refusal states the test, a
      // grant rarely explains why it passed.
      const refused = rows.nearby
        .filter((r) => r.is_one_off && r.status === "refused")
        .map((r) => ({ ...r, distance_m: Math.round(haversineMeters(input.lat, input.lng, r.lat, r.lng)) }))
        .sort((a, b) => a.distance_m - b.distance_m)
        .slice(0, RURAL_REASON_READS);

      const themeCounts = new Map();
      const decisions = [];
      let quote = null;
      if (refused.length && deps.getDecisionReasons) {
        yield { type: "progress", step: "Reading why nearby one-off houses were refused…" };
        for (const r of refused) {
          let read = null;
          try {
            read = await deps.getDecisionReasons(r);
          } catch {
            // A council that won't answer costs one precedent, not the section.
          }
          if (!read?.text) continue;
          const themes = classifyRefusalThemes(read.text);
          for (const t of themes) themeCounts.set(t, (themeCounts.get(t) ?? 0) + 1);
          if (!quote) quote = localNeedQuote(read.text);
          decisions.push({
            planning_reference: r.planning_reference,
            authority_id: r.authority_id,
            distance_m: r.distance_m,
            decision_date: r.decision_date ?? null,
            source: read.source,
            themes,
          });
        }
      }

      sections.rural_housing = {
        rates,
        reasons_read: decisions.length,
        // Ranked by how often each test actually appeared, not by our ordering.
        themes: [...themeCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([key, count]) => ({
            key,
            label: RURAL_REFUSAL_THEMES.find((t) => t.key === key)?.label ?? key,
            count,
            of: decisions.length,
          })),
        local_need_quote: quote,
        decisions,
      };
      yield { type: "section", name: "rural_housing", data: sections.rural_housing };
    }
  }

  yield { type: "progress", step: "Writing the considerations…" };
  let narrative = null;
  try {
    narrative = await deps.synthesise(JSON.stringify({ intent: input.intent, address: input.address, sections }));
  } catch {
    narrative = null;
  }
  if (narrative) yield { type: "narrative", text: narrative };

  yield { type: "done", sections, narrative };
}
