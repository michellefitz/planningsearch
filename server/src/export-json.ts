/**
 * Export the demo dataset to a plain JSON bundle for the dependency-free
 * Vercel serverless function (api/_index.mjs). This path deliberately avoids
 * the native better-sqlite3 module so the serverless build/runtime has zero
 * native dependencies.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTHORITIES } from "./config/authorities.js";
import {
  APPLICATION_TYPE_LABELS, extractResidentialUnits, GLOSSARY, mapLiveStatus,
  normalizeApplicationType, STATUS_LABELS,
} from "./normalize.js";
import { generateSeedRecords } from "./seed.js";
import {
  featureToRecord, fetchAllSince, fetchAllSites, SERVICE_URL, siteKey, SITES_URL,
} from "./ingest/arcgis.js";
import { buildPprIndex, lookupPpr } from "./ingest/ppr.js";
import { fetchKildareRecent, eplanningItemToRecord } from "./ingest/eplanning-list.js";
import { ACP_AUTHORITY, fetchAcpDirectRecords } from "./ingest/acp.js";
import { buildCommencementIndex, lookupCommencement } from "./ingest/bcms.js";
import type { ApplicationRecord } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OUT =
  process.env.PLANVIEW_JSON_OUT ??
  path.resolve(__dirname, "../../api/_data/planning.json");

/**
 * Site boundaries ship in their own file beside the bundle, not inside it.
 * api/_index.mjs parses planning.json eagerly at module load, so ~19 MB of
 * polygons in there would be paid by every cold start — including the search
 * and detail requests that never draw a boundary. The polygon layer is the
 * only reader, and it loads this lazily on first use.
 */
const POLYGONS_OUT =
  process.env.PLANVIEW_POLYGONS_OUT ?? path.join(path.dirname(OUT), "polygons.json");

/** Minimal Neon HTTP SQL client (mirrors api/_accounts/db.mjs) — a plain fetch
 *  so the build needs no database driver dependency. */
async function neonSql(query: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error("DATABASE_URL not set");
  const host = new URL(cs).hostname;
  const res = await fetch(`https://${host}/sql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": cs,
    },
    body: JSON.stringify({ query, params }),
  });
  if (!res.ok) throw new Error(`neon: HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { rows?: Array<Record<string, unknown>> };
  return data.rows ?? [];
}

/** Live pull from the national service: applications received in the window. */
async function fetchLiveRecords(): Promise<{
  records: ApplicationRecord[];
  sourceUpdatedAt: string | null;
}> {
  // Everything the feed holds, by default. The old 2012 floor was set when the
  // dataset was believed to start there; it doesn't. Measured 2026-07-30, the
  // feed reaches back to 1992 for South Dublin and 2001 for Dún Laoghaire-
  // Rathdown, and those rows are complete (100% description, address and
  // geometry, ~99.7% decision). For a house's planning history a 1990s
  // extension is often the whole answer, so the cutoff was discarding the
  // most valuable part of the record for two of the five councils.
  // PLANVIEW_EXPORT_DAYS/SINCE remain as overrides for quick partial exports.
  const days = process.env.PLANVIEW_EXPORT_DAYS ? Number(process.env.PLANVIEW_EXPORT_DAYS) : null;
  const since = days
    ? new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
    : process.env.PLANVIEW_EXPORT_SINCE ?? "1900-01-01";
  console.log(`Fetching live data since ${since} from ${SERVICE_URL} …`);
  const features = await fetchAllSince(since, (n) => console.log(`  fetched ${n} features…`));
  const now = new Date().toISOString();
  const records: ApplicationRecord[] = [];
  let skipped = 0;
  // ETL_DATE is when DHLGH last loaded each row; the max across the pull is
  // the honest "source last updated" stamp (ReceivedDate can be in the future
  // — councils sometimes mistype dates).
  let maxEtl = 0;
  for (const f of features) {
    const etl = f.attributes.ETL_DATE;
    if (typeof etl === "number" && etl > maxEtl) maxEtl = etl;
    const rec = featureToRecord(f, now);
    if (rec) records.push(rec);
    else skipped++;
  }
  // Dedup on authority+reference (source occasionally repeats rows).
  const byKey = new Map<string, ApplicationRecord>();
  for (const r of records) byKey.set(`${r.authority_id}|${r.planning_reference}`, r);
  console.log(
    `Mapped ${byKey.size} applications (${skipped} outside the five authorities/unmappable, ${records.length - byKey.size} duplicates).`
  );
  if (byKey.size === 0) throw new Error("Live fetch returned zero mappable applications");
  const deduped = [...byKey.values()];

  // Site boundaries from layer 1 of the same service. Best-effort: an
  // application is still worth showing without its outline, so a failed pull
  // must not sink the deploy — it just costs the boundaries and the site areas.
  try {
    console.log(`Fetching site boundaries since ${since} from ${SITES_URL} …`);
    const sites = await fetchAllSites(since, (n) => console.log(`  fetched ${n} boundaries…`));
    let matched = 0;
    for (const r of deduped) {
      const site = sites.get(siteKey(r.authority_id, r.planning_reference));
      if (!site) continue;
      r.geom_polygon = site.geomPolygon;
      r.site_area_ha = site.siteAreaHa;
      matched++;
    }
    console.log(
      `Site boundaries: ${sites.size} fetched, matched ${matched} of ${deduped.length} applications.`
    );
  } catch (err) {
    console.error("Site-boundary fetch failed (applications unaffected):", err);
  }

  return {
    records: deduped,
    sourceUpdatedAt: maxEtl ? new Date(maxEtl).toISOString().slice(0, 10) : null,
  };
}

async function main() {
  const source = process.env.PLANVIEW_EXPORT_SOURCE ?? "seed";
  let records: ApplicationRecord[];
  let dataSource: "live" | "seed";
  let sourceUpdatedAt: string | null = null;
  if (source === "live") {
    try {
      ({ records, sourceUpdatedAt } = await fetchLiveRecords());
      dataSource = "live";
    } catch (err) {
      console.error("=== LIVE FETCH FAILED — falling back to DEMO SEED DATA ===");
      console.error(err);
      records = generateSeedRecords();
      dataSource = "seed";
    }
  } else {
    records = generateSeedRecords();
    dataSource = "seed";
  }
  // Assign stable ids by generation order (matches SQLite rowid ordering).
  type BundledApp = ApplicationRecord & {
    id: number;
    ppr_sales?: Array<{
      date: string;
      price: number;
      description: string | null;
      vat_exclusive: boolean;
      not_full_market: boolean;
    }>;
    commencement_notice?: string | null;
    commencement_date?: string | null;
    completion_date?: string | null;
    commencement_units?: number | null;
    commencement_count?: number | null;
    /** Case officer from the nightly agile-portal harvest (agile_enrichment). */
    officer_name?: string | null;
  };
  const now = new Date().toISOString();

  // Kildare live top-up: the national DHLGH feed trails Kildare by ~months, so
  // pull the last 42 days straight off the council register (eplanning list
  // search) and add any not yet in the feed. Best-effort — a failure must not
  // sink the deploy. Coordinates come from each detail page's Site Location tab.
  if (dataSource === "live") {
    try {
      console.log("Fetching recent Kildare applications from eplanning (list search) …");
      const items = await fetchKildareRecent(42, console.log);
      const have = new Set(
        records.filter((r) => r.authority_id === "kildare").map((r) => r.planning_reference)
      );
      let added = 0;
      for (const item of items) {
        if (have.has(item.reference)) continue;
        have.add(item.reference);
        records.push(eplanningItemToRecord(item, now));
        added++;
      }
      console.log(`Kildare live: added ${added} recent applications ahead of the national feed.`);
    } catch (err) {
      console.error("Kildare live top-up failed (national data unaffected):", err);
    }
  }

  // Direct applications to An Coimisiún Pleanála (SHD/SID/substitute consent)
  // never pass through a council register, so the national feed misses them —
  // and they're most of the 100+-home schemes from 2017–2022. Best-effort.
  let acpCommencements = new Map<string, string>();
  if (dataSource === "live") {
    try {
      console.log("Fetching An Coimisiún Pleanála direct cases …");
      const acp = await fetchAcpDirectRecords(now, console.log);
      records.push(...acp.records);
      acpCommencements = acp.commencementByRef;
      console.log(`ACP: added ${acp.records.length} direct cases.`);
    } catch (err) {
      console.error("ACP direct-case fetch failed (national data unaffected):", err);
    }
  }

  const apps: BundledApp[] = records.map((r, i) => ({ id: i + 1, ...r }));

  // SHD tracker commencement dates for ACP cases (BCMS matching is keyed on
  // council permission numbers, so it can't cover these).
  for (const app of apps) {
    if (app.authority_id !== ACP_AUTHORITY.id) continue;
    const commenced = acpCommencements.get(app.planning_reference);
    if (commenced) app.commencement_date = commenced;
  }

  // Join Property Price Register sales by normalized address — only for
  // addresses with a house/unit number (townland-only addresses are shared
  // by many properties). Live data only; the fictional seed won't match.
  if (dataSource === "live") {
    // PPR spans its own (wider) window, independent of the applications window:
    // a property's sale history is worth showing however old the applications
    // are. The register starts in 2010.
    const sinceYear = Number(process.env.PLANVIEW_PPR_SINCE_YEAR ?? 2010);
    const nowYear = new Date().getFullYear();
    const years = [];
    for (let y = sinceYear; y <= nowYear; y++) years.push(y);
    console.log(`Fetching Property Price Register (Dublin, Kildare; ${sinceYear}–now) …`);
    const ppr = await buildPprIndex(["Dublin", "Kildare"], years, console.log);
    let matched = 0;
    for (const app of apps) {
      // Eircode first (unique per property, works for apartments), then a
      // specific-address match.
      const sales = lookupPpr(ppr, app);
      if (!sales?.length) continue;
      app.ppr_sales = sales.map((s) => ({
        date: s.date,
        price: s.price,
        description: s.description,
        vat_exclusive: s.vatExclusive,
        not_full_market: s.notFullMarket,
      }));
      matched++;
    }
    console.log(`Matched PPR sales for ${matched} of ${apps.length} applications.`);

    // Join BCMS commencement notices by the permission number cited on the
    // notice — tells users whether granted permissions were actually built.
    // The portal can be flaky; a failed pull must not sink the deploy.
    try {
      console.log("Fetching BCMS commencement notices (data.nbco.gov.ie) …");
      const bcms = await buildCommencementIndex(undefined, console.log);
      let commenced = 0;
      for (const app of apps) {
        const hit = lookupCommencement(
          bcms,
          app.authority_id,
          app.planning_reference,
          app.appeal_reference
        );
        if (!hit) continue;
        app.commencement_notice = hit.notice;
        app.commencement_date = hit.commencement_date;
        app.completion_date = hit.completion_date;
        app.commencement_units = hit.units;
        app.commencement_count = hit.count;
        commenced++;
      }
      console.log(`Matched commencement notices for ${commenced} of ${apps.length} applications.`);
    } catch (err) {
      console.error("BCMS fetch failed — bundle ships without commencement data:", err);
    }

    // Overlay the nightly agile-portal harvest (Neon agile_enrichment): full
    // untruncated descriptions, applicant/agent, case officer, Eircodes, and
    // live status corrections. Best-effort — a failure must not sink the deploy.
    if (process.env.DATABASE_URL) {
      try {
        console.log("Fetching agile enrichment (Neon agile_enrichment) …");
        const rows = await neonSql(
          `select authority_id, planning_reference, full_description, applicant_name,
                  agent_name, officer_name, eircode, application_type, live_status, live_decision
           from agile_enrichment where not resolve_failed`
        );
        const byKey = new Map(apps.map((a) => [`${a.authority_id}|${a.planning_reference}`, a]));
        // Same decision-flip safety as /enrich (api/_index.mjs): only correct a
        // not-yet-resolved baked status, and only to a terminal live outcome —
        // a stale harvest must never clobber a fresher national decision.
        const CORRECTABLE_BAKED = new Set(["unknown", "pending", "further_info", "incomplete"]);
        const TERMINAL_LIVE = new Set(["granted", "refused", "invalid", "withdrawn"]);
        const applied = { description: 0, applicant: 0, agent: 0, officer: 0, eircode: 0, type: 0, status: 0 };
        for (const r of rows) {
          const app = byKey.get(`${r.authority_id}|${r.planning_reference}`);
          if (!app) continue;
          const fullDescription = r.full_description as string | null;
          if (fullDescription && fullDescription.length > (app.description?.length ?? 0)) {
            app.description = fullDescription;
            applied.description++;
          }
          if (r.applicant_name && !app.applicant_name) {
            app.applicant_name = r.applicant_name as string;
            applied.applicant++;
          }
          if (r.agent_name && !app.agent_name) {
            app.agent_name = r.agent_name as string;
            applied.agent++;
          }
          if (r.officer_name) {
            app.officer_name = r.officer_name as string;
            applied.officer++;
          }
          if (r.eircode && !app.eircode) {
            app.eircode = r.eircode as string;
            applied.eircode++;
          }
          // The portal's applicationType is the council's own record — use it
          // to reclassify apps the national feed left as "other".
          if (r.application_type && app.application_type === "other") {
            const t = normalizeApplicationType(r.application_type as string);
            if (t !== "other") {
              app.application_type = t;
              applied.type++;
            }
          }
          if (r.live_status || r.live_decision) {
            const liveStatus = mapLiveStatus(
              r.live_status as string | null,
              r.live_decision as string | null
            );
            const baked = String(app.status ?? "unknown");
            if (
              liveStatus !== "unknown" &&
              liveStatus !== baked &&
              (baked === "unknown" ||
                (CORRECTABLE_BAKED.has(baked) && TERMINAL_LIVE.has(liveStatus)))
            ) {
              app.status = liveStatus;
              applied.status++;
            }
          }
        }
        console.log(
          `Agile enrichment: ${rows.length} rows; applied — description ${applied.description}, applicant ${applied.applicant}, agent ${applied.agent}, officer ${applied.officer}, eircode ${applied.eircode}, type ${applied.type}, status ${applied.status}.`
        );
      } catch (err) {
        console.error("Agile enrichment merge failed — bundle ships without it:", err);
      }
    } else {
      console.log("DATABASE_URL not set — skipping agile enrichment merge.");
    }
  }

  // The agile merge above can swap in a much longer description than the
  // truncated national one, revealing unit counts the ingest-time extraction
  // couldn't see — retry where the count is still missing.
  let reextracted = 0;
  for (const app of apps) {
    if (app.num_residential_units) continue;
    const u = extractResidentialUnits(app.description);
    if (u) {
      app.num_residential_units = u;
      reextracted++;
    }
  }
  if (reextracted) console.log(`Unit counts: extracted ${reextracted} more from enriched descriptions.`);

  // Lift the boundaries into the sidecar, keyed by application id, and drop the
  // field from the bundle rows entirely — left in place as `null` it would cost
  // ~2 MB across the register for no information. Concatenating the stored
  // strings avoids parsing and re-serialising ~90k polygons.
  const polygonParts: string[] = [];
  for (const app of apps) {
    if (app.geom_polygon) polygonParts.push(`"${app.id}":${app.geom_polygon}`);
    delete (app as { geom_polygon?: unknown }).geom_polygon;
  }

  const counts = new Map<string, number>();
  for (const a of apps) counts.set(a.authority_id, (counts.get(a.authority_id) ?? 0) + 1);

  // How far back we actually hold each council's register. The national feed's
  // depth is very uneven — Dublin City starts 2019 and Kildare 2017, while
  // South Dublin reaches 1992 — so a search before a council's floor returns
  // nothing and, unstated, reads as "no planning history exists".
  const earliest = new Map<string, string>();
  for (const a of apps) {
    if (!a.received_date) continue;
    const held = earliest.get(a.authority_id);
    if (!held || a.received_date < held) earliest.set(a.authority_id, a.received_date);
  }

  const bundle = {
    generated_at: now,
    data_source: dataSource,
    source_updated_at: sourceUpdatedAt,
    authorities: [
      ...AUTHORITIES.map((a) => ({
        id: a.id,
        name: a.name,
        short_name: a.shortName,
        source_system: a.sourceSystem as string,
        portal_base_url: a.portalBaseUrl,
        gis_url: a.gisUrl,
        last_synced: now,
        application_count: counts.get(a.id) ?? 0,
        earliest_received: earliest.get(a.id) ?? null,
      })),
      // Present even with zero cases (e.g. seed builds) so the id always
      // resolves to a name.
      {
        ...ACP_AUTHORITY,
        last_synced: now,
        application_count: counts.get(ACP_AUTHORITY.id) ?? 0,
        earliest_received: earliest.get(ACP_AUTHORITY.id) ?? null,
      },
    ],
    statuses: STATUS_LABELS,
    application_types: APPLICATION_TYPE_LABELS,
    glossary: GLOSSARY,
    attribution:
      dataSource === "live"
        ? "Contains Irish Public Sector Data (Department of Housing, Local Government and Heritage; An Coimisiún Pleanála) licensed under CC-BY 4.0. The local authority registers and the commission's case files remain the authoritative sources."
        : "DEMO DATA — fictional applications for demonstration only. Real data: National Planning Applications (DHLGH), CC-BY 4.0.",
    applications: apps,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(bundle));
  const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
  console.log(`Wrote ${apps.length} applications (${dataSource}) to ${OUT} (${mb} MB)`);

  // Always written, even when empty, so the polygon layer can distinguish "no
  // boundaries in this build" from "sidecar missing".
  fs.writeFileSync(POLYGONS_OUT, `{${polygonParts.join(",")}}`);
  const polyMb = (fs.statSync(POLYGONS_OUT).size / 1024 / 1024).toFixed(1);
  console.log(
    `Wrote ${polygonParts.length} site boundaries to ${POLYGONS_OUT} (${polyMb} MB)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
