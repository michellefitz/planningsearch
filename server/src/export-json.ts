/**
 * Export the demo dataset to a plain JSON bundle for the dependency-free
 * Vercel serverless function (api/index.mjs). This path deliberately avoids
 * the native better-sqlite3 module so the serverless build/runtime has zero
 * native dependencies.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTHORITIES } from "./config/authorities.js";
import { APPLICATION_TYPE_LABELS, GLOSSARY, STATUS_LABELS } from "./normalize.js";
import { generateSeedRecords } from "./seed.js";
import { featureToRecord, fetchAllSince, SERVICE_URL } from "./ingest/arcgis.js";
import { buildPprIndex, lookupPpr } from "./ingest/ppr.js";
import { fetchKildareRecent, eplanningItemToRecord } from "./ingest/eplanning-list.js";
import { buildCommencementIndex, lookupCommencement } from "./ingest/bcms.js";
import type { ApplicationRecord } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OUT =
  process.env.PLANVIEW_JSON_OUT ??
  path.resolve(__dirname, "../../api/_data/planning.json");

/** Live pull from the national service: applications received in the window. */
async function fetchLiveRecords(): Promise<{
  records: ApplicationRecord[];
  sourceUpdatedAt: string | null;
}> {
  const days = Number(process.env.PLANVIEW_EXPORT_DAYS ?? 1825); // default: last 5 years
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
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
  return {
    records: [...byKey.values()],
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

  const apps: BundledApp[] = records.map((r, i) => ({ id: i + 1, ...r }));

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
  }

  const counts = new Map<string, number>();
  for (const a of apps) counts.set(a.authority_id, (counts.get(a.authority_id) ?? 0) + 1);

  const bundle = {
    generated_at: now,
    data_source: dataSource,
    source_updated_at: sourceUpdatedAt,
    authorities: AUTHORITIES.map((a) => ({
      id: a.id,
      name: a.name,
      short_name: a.shortName,
      source_system: a.sourceSystem,
      portal_base_url: a.portalBaseUrl,
      gis_url: a.gisUrl,
      last_synced: now,
      application_count: counts.get(a.id) ?? 0,
    })),
    statuses: STATUS_LABELS,
    application_types: APPLICATION_TYPE_LABELS,
    glossary: GLOSSARY,
    attribution:
      dataSource === "live"
        ? "Contains Irish Public Sector Data (Department of Housing, Local Government and Heritage) licensed under CC-BY 4.0. The local authority registers remain the authoritative source."
        : "DEMO DATA — fictional applications for demonstration only. Real data: National Planning Applications (DHLGH), CC-BY 4.0.",
    applications: apps,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(bundle));
  const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
  console.log(`Wrote ${apps.length} applications (${dataSource}) to ${OUT} (${mb} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
