/**
 * Load generated description summaries (scripts/summaries/backfill.mjs) into
 * Neon, where the build-time export reads them from.
 *
 * Idempotent — rerun it after every backfill; rows already present are left
 * alone. Kept separate from generation so the slow, key-holding half can run
 * anywhere and the storage half only needs DATABASE_URL.
 *
 *   DATABASE_URL=… node scripts/summaries/upload.mjs [--in FILE]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MODEL = "claude-haiku-4-5-20251001";
const BATCH = 500;

export const CREATE_TABLE = `create table if not exists description_summaries (
  description_hash text primary key,
  summary text not null,
  model text not null,
  created_at timestamptz not null default now()
)`;

/**
 * One multi-row insert per batch — a round trip per summary would take hours.
 * Placeholders must be numbered across the whole batch, not per row, or every
 * row after the first would bind the first row's values.
 */
export function insertStatement(rows) {
  const values = rows.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(",");
  return {
    query:
      `insert into description_summaries (description_hash, summary, model) values ${values} ` +
      `on conflict (description_hash) do nothing`,
    params: rows.flatMap((r) => [r.h, r.s, r.model ?? MODEL]),
  };
}

/** Parse the append-only JSONL the backfill writes, last write per hash winning. */
export function readSummaries(text) {
  const byHash = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r?.h && r?.s) byHash.set(r.h, r);
    } catch {
      // Torn line from an interrupted generation run — it gets regenerated.
    }
  }
  return [...byHash.values()];
}

async function main() {
  const args = process.argv.slice(2);
  const IN = args.includes("--in")
    ? args[args.indexOf("--in") + 1]
    : path.join(ROOT, "api/_data/summaries.jsonl");
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  if (!fs.existsSync(IN)) {
    console.error(`${IN} not found — run scripts/summaries/backfill.mjs first`);
    process.exit(1);
  }
  const { sql } = await import("../../api/_accounts/db.mjs");
  await sql(CREATE_TABLE);

  const rows = readSummaries(fs.readFileSync(IN, "utf8"));
  console.log(`${rows.length.toLocaleString()} summaries in ${path.basename(IN)}.`);

  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { query, params } = insertStatement(rows.slice(i, i + BATCH));
    await sql(query, params);
    written += Math.min(BATCH, rows.length - i);
    if (written % 5000 === 0 || written === rows.length)
      console.log(`  ${written.toLocaleString()}/${rows.length.toLocaleString()}`);
  }
  const [{ count }] = await sql(`select count(*)::int as count from description_summaries`);
  console.log(`Done. description_summaries now holds ${Number(count).toLocaleString()} rows.`);
}

// Importable for tests; only run the load when invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
