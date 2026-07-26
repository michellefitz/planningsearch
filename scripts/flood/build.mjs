import mapshaper from "mapshaper";
import { writeFileSync, readdirSync } from "fs";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { gzipSync } from "zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, "data");
const OUT = resolve(__dirname, "../../web/public/flood.geojson");

// Simplification setting. v1 used "dp 0.1%" (vertex retention) — fine
// nationally, but street-level boundaries were hundreds of metres off.
// interval=40 bounds the error: no boundary deviates more than ~40 m.
// Override for experiments: SIMPLIFY="dp interval=20" node build.mjs
const SIMPLIFY = process.env.SIMPLIFY ?? "dp interval=40";

const ITM_PROJ =
  "+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=0.99982 +x_0=600000 +y_0=750000 +ellps=GRS80 +units=m";

const AEP_MAP = {
  "0010": "10% AEP",
  "0020": "5% AEP",
  "0100": "1% AEP",
  "0200": "0.5% AEP",
  "1000": "0.1% AEP",
};

// Probability band for map styling: the bands nest (high sits inside
// medium inside low), so the map shades them differently and draws
// high-probability extents on top.
const BAND_MAP = {
  "10% AEP": "high",
  "5% AEP": "high",
  "1% AEP": "medium",
  "0.5% AEP": "medium",
  "0.1% AEP": "low",
};
const BAND_ORDER = { low: 0, medium: 1, high: 2 };

function findShpFiles(dir) {
  const entries = readdirSync(dir, { recursive: true });
  return entries
    .filter((f) => f.toString().endsWith(".shp"))
    .map((f) => resolve(dir, f.toString()));
}

function parseAep(filename) {
  const match = basename(filename, ".shp").match(/_(\d{4})$/);
  return match ? AEP_MAP[match[1]] ?? match[1] : "unknown";
}

async function processShapefile(shpPath, floodType) {
  const aep = parseAep(shpPath);
  const scenario = `${floodType === "fluvial" ? "Fluvial" : "Coastal"} — ${aep}`;
  const band = BAND_MAP[aep] ?? "low";
  console.log(`  ${basename(shpPath)} → "${scenario}" (${band})`);

  const cmd = [
    `-i "${shpPath}"`,
    `-proj wgs84 from='${ITM_PROJ}'`,
    `-each 'flood_type="${floodType}", scenario="${scenario}", band="${band}"'`,
    `-filter-fields flood_type,scenario,band`,
    `-dissolve2 flood_type,scenario,band`,
    `-simplify ${SIMPLIFY} keep-shapes`,
    `-o output.geojson format=geojson precision=0.00001`,
  ].join(" ");

  const result = await mapshaper.applyCommands(cmd);
  return JSON.parse(result["output.geojson"]);
}

const allFeatures = [];

console.log(`Simplification: ${SIMPLIFY} retention`);
console.log("Processing NIFM (fluvial)...");
for (const shp of findShpFiles(resolve(DATA, "nifm"))) {
  const fc = await processShapefile(shp, "fluvial");
  allFeatures.push(...fc.features);
  console.log(`    → ${fc.features.length} dissolved feature(s)`);
}

console.log("Processing NCFHM (coastal)...");
for (const shp of findShpFiles(resolve(DATA, "ncfhm"))) {
  const fc = await processShapefile(shp, "coastal");
  allFeatures.push(...fc.features);
  console.log(`    → ${fc.features.length} dissolved feature(s)`);
}

// Low-probability (largest) extents first so higher-probability bands
// render on top of them.
allFeatures.sort((a, b) => BAND_ORDER[a.properties.band] - BAND_ORDER[b.properties.band]);

const output = { type: "FeatureCollection", features: allFeatures };
const json = JSON.stringify(output);
writeFileSync(OUT, json);

const rawMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
const gzMB = (gzipSync(Buffer.from(json)).length / 1024 / 1024).toFixed(2);
console.log(`\nOutput: ${output.features.length} features, ${rawMB} MB raw / ${gzMB} MB gzipped`);
console.log(`Written to ${OUT}`);

if (parseFloat(gzMB) > 3) {
  console.warn(
    "WARNING: gzipped size exceeds 3 MB — consider lower retention or vector tiles (PMTiles)"
  );
}
