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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OUT =
  process.env.PLANVIEW_JSON_OUT ??
  path.resolve(__dirname, "../../api/_data/planning.json");

function main() {
  const records = generateSeedRecords();
  // Assign stable ids by generation order (matches SQLite rowid ordering).
  const apps = records.map((r, i) => ({ id: i + 1, ...r }));
  const now = new Date().toISOString();

  const counts = new Map<string, number>();
  for (const a of apps) counts.set(a.authority_id, (counts.get(a.authority_id) ?? 0) + 1);

  const bundle = {
    generated_at: now,
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
      "Contains Irish Public Sector Data (Department of Housing, Local Government and Heritage) licensed under CC-BY 4.0. The local authority registers remain the authoritative source.",
    applications: apps,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(bundle));
  console.log(`Wrote ${apps.length} applications to ${OUT}`);
}

main();
