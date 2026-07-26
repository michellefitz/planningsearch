import mapshaper from "mapshaper";
import { writeFileSync, readdirSync } from "fs";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, "data");
const OUT = resolve(__dirname, "../../web/public/flood.geojson");

const ITM_PROJ =
  "+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=0.99982 +x_0=600000 +y_0=750000 +ellps=GRS80 +units=m";

const AEP_MAP = {
  "0010": "10% AEP",
  "0020": "5% AEP",
  "0100": "1% AEP",
  "0200": "0.5% AEP",
  "1000": "0.1% AEP",
};

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
  console.log(`  ${basename(shpPath)} → "${scenario}"`);

  const cmd = [
    `-i "${shpPath}"`,
    `-proj wgs84 from='${ITM_PROJ}'`,
    `-each 'flood_type="${floodType}", scenario="${scenario}"'`,
    `-filter-fields flood_type,scenario`,
    `-dissolve2 flood_type,scenario`,
    `-simplify dp 0.1% keep-shapes`,
    `-o output.geojson format=geojson precision=0.00001`,
  ].join(" ");

  const result = await mapshaper.applyCommands(cmd);
  return JSON.parse(result["output.geojson"]);
}

const allFeatures = [];

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

const output = { type: "FeatureCollection", features: allFeatures };
const json = JSON.stringify(output);
writeFileSync(OUT, json);

const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
console.log(`\nOutput: ${output.features.length} features, ${sizeMB} MB`);
console.log(`Written to ${OUT}`);

if (parseFloat(sizeMB) > 3) {
  console.warn(
    "WARNING: File exceeds 3 MB — consider increasing simplification or switching to vector tiles"
  );
}
