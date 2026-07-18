/**
 * Scheduled metadata pull from the national service (PRD §5.3): paginated,
 * politely rate-limited, resumable, idempotent (upserts on
 * authority + planning_reference).
 *
 * Usage:
 *   npm run ingest                  # everything since PLANVIEW_INGEST_SINCE (default 2019-01-01)
 *   PLANVIEW_INGEST_SINCE=2024-01-01 npm run ingest
 */
import { openDb, setAuthoritySynced, upsertApplication } from "../db.js";
import { AUTHORITIES } from "../config/authorities.js";
import { buildWhereClause, featureToRecord, fetchPage, SERVICE_URL } from "./arcgis.js";

const PAGE_SIZE = 1000;
const PAGE_DELAY_MS = 500; // be polite to the public service

export async function runIngest() {
  const since = process.env.PLANVIEW_INGEST_SINCE ?? "2019-01-01";
  const db = openDb();
  const where = buildWhereClause(since);
  const startedAt = new Date().toISOString();
  console.log(`Ingesting from ${SERVICE_URL}`);
  console.log(`WHERE ${where}`);

  let offset = 0;
  let totalUpserted = 0;
  let totalSkipped = 0;

  for (;;) {
    const features = await fetchPage({ where, offset, pageSize: PAGE_SIZE });
    if (features.length === 0) break;
    const tx = db.transaction(() => {
      for (const feature of features) {
        const rec = featureToRecord(feature, startedAt);
        if (!rec) {
          totalSkipped++;
          continue;
        }
        upsertApplication(db, rec);
        totalUpserted++;
      }
    });
    tx();
    offset += features.length;
    console.log(`  page done — offset ${offset}, upserted ${totalUpserted}, skipped ${totalSkipped}`);
    if (features.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }

  for (const a of AUTHORITIES) setAuthoritySynced(db, a.id, startedAt);
  console.log(`Done: ${totalUpserted} applications upserted, ${totalSkipped} outside scope/unmappable.`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runIngest().catch((err) => {
    console.error("Ingest failed:", err);
    process.exitCode = 1;
  });
}
