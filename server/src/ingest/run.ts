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
import { buildCommencementIndex, lookupCommencement } from "./bcms.js";

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

  // Join BCMS commencement notices onto the freshly-upserted applications.
  // Best-effort: the portal can be flaky and the register data stands alone.
  try {
    console.log("Fetching BCMS commencement notices (data.nbco.gov.ie) …");
    const bcms = await buildCommencementIndex(undefined, console.log);
    const rows = db
      .prepare("SELECT id, authority_id, planning_reference, appeal_reference FROM applications")
      .all() as Array<{ id: number; authority_id: string; planning_reference: string; appeal_reference: string | null }>;
    const update = db.prepare(
      `UPDATE applications SET commencement_notice = ?, commencement_date = ?, completion_date = ?,
       commencement_units = ?, commencement_count = ? WHERE id = ?`
    );
    let commenced = 0;
    const tx = db.transaction(() => {
      for (const r of rows) {
        const hit = lookupCommencement(bcms, r.authority_id, r.planning_reference, r.appeal_reference);
        if (!hit) continue;
        update.run(hit.notice, hit.commencement_date, hit.completion_date, hit.units, hit.count, r.id);
        commenced++;
      }
    });
    tx();
    console.log(`Matched commencement notices for ${commenced} of ${rows.length} applications.`);
  } catch (err) {
    console.error("BCMS join failed (register data unaffected):", err);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runIngest().catch((err) => {
    console.error("Ingest failed:", err);
    process.exitCode = 1;
  });
}
