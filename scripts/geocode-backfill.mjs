/**
 * Batch geocode planning records that have no coordinates, using the Google
 * Geocoding API. Results are cached in Neon (geocoded_coordinates) so they
 * persist across builds and the script is idempotent — re-running skips
 * addresses already geocoded.
 *
 * Usage:
 *   DATABASE_URL=... GOOGLE_GEOCODING_KEY=... node scripts/geocode-backfill.mjs [--authority cork-city] [--dry-run] [--limit 100]
 *
 * Without --authority, reads the local bundle (api/_data/planning.json) and
 * geocodes all unpinned records. With --authority cork-city, fetches the Cork
 * open data CSV directly (no local bundle needed).
 *
 * The export pipeline reads cached geocodes from Neon and applies them to
 * records still missing coordinates after fillMissingCoordinates.
 */
import { sql } from "../api/_accounts/db.mjs";

const GEOCODE_BASE = "https://maps.googleapis.com/maps/api/geocode/json";

const CORK_CSV_URL =
  "https://data.corkcity.ie/datastore/dump/8d5bbfa9-3b0c-40ac-8630-4243bed94b2d";

const AUTHORITY_BBOX = {
  "cork-city": [-8.58, 51.85, -8.38, 51.93],
  "dublin-city": [-6.387, 53.298, -6.11, 53.411],
  fingal: [-6.5, 53.35, -6.05, 53.64],
  dlr: [-6.31, 53.2, -6.09, 53.32],
  "south-dublin": [-6.55, 53.22, -6.29, 53.37],
  kildare: [-7.17, 52.94, -6.45, 53.45],
  "cork-county": [-10.2, 51.42, -7.85, 52.2],
  wexford: [-7.08, 52.17, -6.18, 52.66],
  meath: [-7.3, 53.38, -6.21, 53.91],
  wicklow: [-6.79, 52.68, -6.01, 53.23],
};

const AUTHORITY_SUFFIX = {
  "cork-city": ", Cork City, Ireland",
  "dublin-city": ", Dublin, Ireland",
  fingal: ", Co. Dublin, Ireland",
  dlr: ", Co. Dublin, Ireland",
  "south-dublin": ", Co. Dublin, Ireland",
  kildare: ", Co. Kildare, Ireland",
  "cork-county": ", Co. Cork, Ireland",
  wexford: ", Co. Wexford, Ireland",
  meath: ", Co. Meath, Ireland",
  wicklow: ", Co. Wicklow, Ireland",
};

async function ensureTable() {
  await sql(`create table if not exists geocoded_coordinates (
    authority_id text not null,
    address_key text not null,
    lat double precision,
    lng double precision,
    source text not null default 'google',
    created_at timestamptz not null default now(),
    primary key (authority_id, address_key)
  )`);
}

function normalizeAddress(addr) {
  return addr
    .toLowerCase()
    .replace(/[.,;()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function insideBbox(lat, lng, bbox) {
  const [w, s, e, n] = bbox;
  const pad = 0.5;
  return lng >= w - pad && lng <= e + pad && lat >= s - pad && lat <= n + pad;
}

async function geocodeAddress(address, authorityId, apiKey) {
  const suffix = AUTHORITY_SUFFIX[authorityId] ?? ", Ireland";
  const q = `${address}${suffix}`;
  const url = `${GEOCODE_BASE}?address=${encodeURIComponent(q)}&region=ie&key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Geocode HTTP ${res.status}`);
  const data = await res.json();
  if (data.status !== "OK" || !data.results?.length) return null;
  const loc = data.results[0].geometry?.location;
  if (!loc) return null;
  const bbox = AUTHORITY_BBOX[authorityId];
  if (bbox && !insideBbox(loc.lat, loc.lng, bbox)) return null;
  return { lat: loc.lat, lng: loc.lng };
}

function parseCsvLine(line) {
  const fields = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) { fields.push(""); break; }
    if (line[i] === '"') {
      let value = "";
      i++;
      while (i < line.length) {
        if (line[i] === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') { value += '"'; i += 2; }
          else { i++; break; }
        } else { value += line[i]; i++; }
      }
      fields.push(value);
      if (i < line.length && line[i] === ",") i++;
    } else {
      const next = line.indexOf(",", i);
      if (next === -1) { fields.push(line.slice(i)); break; }
      else { fields.push(line.slice(i, next)); i = next + 1; }
    }
  }
  return fields;
}

async function loadCorkAddresses() {
  console.log("Fetching Cork City CSV …");
  const res = await fetch(CORK_CSV_URL, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Cork CSV: HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.split("\n");
  const headers = parseCsvLine(lines[0]);
  const addrIdx = headers.indexOf("DevelopmentAddress");
  if (addrIdx === -1) throw new Error("DevelopmentAddress column not found");

  const addresses = new Map();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCsvLine(line);
    const addr = (values[addrIdx] ?? "").trim();
    if (!addr) continue;
    const key = normalizeAddress(addr);
    if (!addresses.has(key)) addresses.set(key, addr);
  }
  console.log(`Cork CSV: ${lines.length - 1} rows, ${addresses.size} unique addresses`);
  return [...addresses.entries()].map(([key, addr]) => ({
    authorityId: "cork-city",
    addressKey: key,
    address: addr,
  }));
}

async function loadFromBundle(authorityFlag) {
  const { default: fs } = await import("node:fs");
  const { default: path } = await import("node:path");
  const bundlePath = path.resolve(
    new URL("../api/_data/planning.json", import.meta.url).pathname
  );
  if (!fs.existsSync(bundlePath)) {
    console.error(`Bundle not found at ${bundlePath}`);
    console.error("Run with --authority cork-city to fetch from the CSV directly");
    process.exit(1);
  }
  console.log("Loading bundle …");
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  const unpinned = bundle.applications.filter((a) => {
    if (a.lat != null && a.lng != null) return false;
    if (!a.address_text) return false;
    if (authorityFlag && a.authority_id !== authorityFlag) return false;
    return true;
  });
  const byAddress = new Map();
  for (const app of unpinned) {
    const key = `${app.authority_id}|${normalizeAddress(app.address_text)}`;
    if (!byAddress.has(key)) {
      byAddress.set(key, {
        authorityId: app.authority_id,
        addressKey: normalizeAddress(app.address_text),
        address: app.address_text,
      });
    }
  }
  return [...byAddress.values()];
}

async function main() {
  const args = process.argv.slice(2);
  const authorityFlag = args.includes("--authority")
    ? args[args.indexOf("--authority") + 1]
    : null;
  const dryRun = args.includes("--dry-run");
  const limitFlag = args.includes("--limit")
    ? Number(args[args.indexOf("--limit") + 1])
    : null;

  const apiKey = process.env.GOOGLE_GEOCODING_KEY;
  if (!apiKey) {
    console.error("GOOGLE_GEOCODING_KEY not set");
    process.exit(1);
  }

  await ensureTable();

  const allAddresses =
    authorityFlag === "cork-city"
      ? await loadCorkAddresses()
      : await loadFromBundle(authorityFlag);

  console.log(`Found ${allAddresses.length} unique addresses to consider`);

  // Check what's already cached
  const cached = await sql(
    `select authority_id, address_key from geocoded_coordinates`
  );
  const cachedKeys = new Set(cached.map((r) => `${r.authority_id}|${r.address_key}`));

  let toProcess = allAddresses.filter(
    (e) => !cachedKeys.has(`${e.authorityId}|${e.addressKey}`)
  );
  console.log(`${toProcess.length} addresses to geocode (${cachedKeys.size} already cached)`);

  if (limitFlag) {
    toProcess = toProcess.slice(0, limitFlag);
    console.log(`Limited to ${toProcess.length} addresses`);
  }

  if (dryRun) {
    console.log("Dry run — not geocoding. Sample addresses:");
    for (const entry of toProcess.slice(0, 20)) {
      console.log(`  ${entry.authorityId}: ${entry.address}`);
    }
    return;
  }

  let geocoded = 0;
  let failed = 0;
  let noResult = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const entry = toProcess[i];
    try {
      const result = await geocodeAddress(entry.address, entry.authorityId, apiKey);
      if (result) {
        await sql(
          `insert into geocoded_coordinates (authority_id, address_key, lat, lng)
           values ($1, $2, $3, $4)
           on conflict (authority_id, address_key) do update set lat = $3, lng = $4`,
          [entry.authorityId, entry.addressKey, result.lat, result.lng]
        );
        geocoded++;
      } else {
        await sql(
          `insert into geocoded_coordinates (authority_id, address_key, lat, lng)
           values ($1, $2, null, null)
           on conflict do nothing`,
          [entry.authorityId, entry.addressKey]
        );
        noResult++;
      }
    } catch (err) {
      console.error(`  Failed: ${entry.address} — ${err.message}`);
      failed++;
    }

    if ((i + 1) % 50 === 0 || i === toProcess.length - 1) {
      console.log(
        `  Progress: ${i + 1}/${toProcess.length} — ` +
        `${geocoded} geocoded, ${noResult} no result, ${failed} failed`
      );
    }

    // ~10 requests/sec (well within Google's 50/sec default)
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(
    `\nDone: ${geocoded} geocoded, ${noResult} no result/out-of-bounds, ${failed} failed`
  );
  if (geocoded > 0) {
    console.log("Trigger a redeploy to pick up the new coordinates in the next build.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
