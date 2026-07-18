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
import { buildPprIndex, isSpecificAddress, normalizeAddress } from "./ingest/ppr.js";
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
  };
  const apps: BundledApp[] = records.map((r, i) => ({ id: i + 1, ...r }));
  const now = new Date().toISOString();

  // Join Property Price Register sales by normalized address — only for
  // addresses with a house/unit number (townland-only addresses are shared
  // by many properties). Live data only; the fictional seed won't match.
  if (dataSource === "live") {
    const days = Number(process.env.PLANVIEW_EXPORT_DAYS ?? 1825);
    const fromYear = new Date(Date.now() - days * 86400_000).getFullYear();
    const years = [];
    for (let y = fromYear; y <= new Date().getFullYear(); y++) years.push(y);
    console.log(`Fetching Property Price Register (Dublin, Kildare; ${fromYear}–now) …`);
    const ppr = await buildPprIndex(["Dublin", "Kildare"], years, console.log);
    let matched = 0;
    for (const app of apps) {
      if (!app.address_text) continue;
      const key = normalizeAddress(app.address_text);
      if (!isSpecificAddress(key)) continue;
      const sales = ppr.get(key);
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
