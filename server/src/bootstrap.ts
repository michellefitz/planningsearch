/**
 * First-boot data bootstrap for hosted deployments: if the database is empty,
 * populate it before the server starts.
 *
 * PLANVIEW_BOOTSTRAP=ingest — pull live data from the national ArcGIS service,
 *   falling back to the demo seed if the pull fails (e.g. field-map mismatch
 *   or blocked network), so the app always comes up with something to show.
 * PLANVIEW_BOOTSTRAP=seed (default) — load the fictional demo fixture.
 */
import { openDb } from "./db.js";
import { seedDemoData } from "./seed.js";
import { runIngest } from "./ingest/run.js";

async function bootstrap() {
  const db = openDb();
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM applications").get() as { c: number };
  db.close();
  if (c > 0) {
    console.log(`Database already has ${c} applications — skipping bootstrap.`);
    return;
  }
  const mode = process.env.PLANVIEW_BOOTSTRAP ?? "seed";
  if (mode === "ingest") {
    try {
      await runIngest();
      return;
    } catch (err) {
      console.error("Live ingest failed, falling back to demo seed:", err);
    }
  }
  seedDemoData();
}

bootstrap().catch((err) => {
  console.error("Bootstrap failed:", err);
  process.exit(1);
});
