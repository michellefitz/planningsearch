#!/usr/bin/env node
/**
 * Fetch and merge Derelict Sites Registers from four councils into one
 * WGS84 GeoJSON file. Run manually when updating; the registers change
 * infrequently.
 *
 * Sources:
 *   SDCC  — ArcGIS REST (point, WGS84)
 *   DCC   — static GeoJSON (point, WGS84)
 *   DLR   — static GeoJSON (polygon, ITM → needs centroid + reprojection)
 *   Wicklow — ArcGIS REST (polygon, ITM → needs centroid + reprojection)
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "../../web/public/derelict.geojson");

// ITM (EPSG:2157) → WGS84 — same algorithm as server/src/ingest/itm.ts
function itmToWgs84(easting, northing) {
  const a = 6378137.0, f = 1 / 298.257222101, b = a * (1 - f);
  const e2 = (a * a - b * b) / (a * a);
  const n = (a - b) / (a + b), n2 = n * n, n3 = n2 * n;
  const k0 = 0.99982, E0 = 600000, N0 = 750000;
  const phi0 = (53.5 * Math.PI) / 180, lam0 = (-8 * Math.PI) / 180;
  const arcM = (phi) => {
    const dp = phi - phi0, sp = phi + phi0;
    return b * k0 * (
      (1 + n + 1.25 * n2 + 1.25 * n3) * dp -
      (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(dp) * Math.cos(sp) +
      (15 / 8 * n2 + 15 / 8 * n3) * Math.sin(2 * dp) * Math.cos(2 * sp) -
      (35 / 24) * n3 * Math.sin(3 * dp) * Math.cos(3 * sp)
    );
  };
  let phi = (northing - N0) / (a * k0) + phi0;
  for (let i = 0; i < 12; i++) {
    const M = arcM(phi);
    if (Math.abs(northing - N0 - M) < 0.00001) break;
    phi += (northing - N0 - M) / (a * k0);
  }
  const sinp = Math.sin(phi), nu = (a * k0) / Math.sqrt(1 - e2 * sinp * sinp);
  const rho = (a * k0 * (1 - e2)) / (1 - e2 * sinp * sinp) ** 1.5;
  const tanp = Math.tan(phi), t2 = tanp * tanp, t4 = t2 * t2, t6 = t4 * t2;
  const secp = 1 / Math.cos(phi), dE = easting - E0, eta2 = nu / rho - 1;
  const lat = phi
    - (tanp / (2 * rho * nu)) * dE ** 2
    + (tanp / (24 * rho * nu ** 3)) * (5 + 3 * t2 + eta2 - 9 * t2 * eta2) * dE ** 4
    - (tanp / (720 * rho * nu ** 5)) * (61 + 90 * t2 + 45 * t4) * dE ** 6;
  const lng = lam0
    + secp / nu * dE
    - (secp / (6 * nu ** 3)) * (nu / rho + 2 * t2) * dE ** 3
    + (secp / (120 * nu ** 5)) * (5 + 28 * t2 + 24 * t4) * dE ** 5
    - (secp / (5040 * nu ** 7)) * (61 + 662 * t2 + 1320 * t4 + 720 * t6) * dE ** 7;
  return [+(lng * 180 / Math.PI).toFixed(6), +(lat * 180 / Math.PI).toFixed(6)];
}

function polygonCentroid(coords) {
  const ring = coords[0];
  if (!ring || ring.length === 0) return null;
  let sx = 0, sy = 0, n = 0;
  for (const [x, y] of ring) { sx += x; sy += y; n++; }
  return [sx / n, sy / n];
}

function reprojectPolygon(coords) {
  return coords.map(ring => ring.map(([x, y]) => itmToWgs84(x, y)));
}

const str = (v) => (v == null ? "" : String(v).trim());
const features = [];

function add(geometry, props) {
  features.push({ type: "Feature", geometry, properties: props });
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.json();
}

// --- SDCC: ArcGIS REST, point geometry, WGS84 ---
async function fetchSdcc() {
  const base = "https://services1.arcgis.com/PxbTDTskGHCe4sv6/arcgis/rest/services/Derelict__Sites__Register__SDCC/FeatureServer/0/query";
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "DS_Ref,Address_of_Property,Section_8_7_Entered_on_to_Register,Valuation,Electoral_Area",
    outSR: "4326",
    returnGeometry: "true",
    resultRecordCount: "2000",
    f: "geojson",
  });
  const data = await fetchJson(`${base}?${params}`);
  let count = 0;
  for (const f of data.features ?? []) {
    const p = f.properties ?? {};
    const ts = p.Section_8_7_Entered_on_to_Register;
    add(f.geometry, {
      address: str(p.Address_of_Property),
      reference: str(p.DS_Ref),
      council: "south-dublin",
      council_label: "South Dublin County Council",
      date_added: ts ? new Date(ts).toISOString().slice(0, 10) : null,
      valuation: str(p.Valuation) || null,
      on_register: true,
      protected_structure: false,
    });
    count++;
  }
  console.log(`  SDCC: ${count} sites`);
}

// --- DCC: static GeoJSON, point geometry, WGS84 ---
async function fetchDcc() {
  const url = "https://data.smartdublin.ie/dataset/83b08920-50c6-45b0-b562-8f68940cadf4/resource/7bdcf921-e0ed-4219-a4ac-2172e6b32dd9/download/dublin_city_council_derelict_sites_register_260427.geojson";
  const data = await fetchJson(url);
  let count = 0;
  for (const f of data.features ?? []) {
    const p = f.properties ?? {};
    if (p.is_on_current_derelict_sites_register === false) continue;
    const dateStr = str(p.date_added_to_the_derelict_sites_register);
    add(f.geometry, {
      address: str(p.full_address) || str(p.derelict_site_description),
      reference: str(p.derelict_site_reference_number),
      council: "dublin-city",
      council_label: "Dublin City Council",
      date_added: dateStr ? dateStr.slice(0, 10) : null,
      valuation: null,
      on_register: true,
      protected_structure: Boolean(p.is_on_current_record_of_protected_structures),
    });
    count++;
  }
  console.log(`  DCC: ${count} sites`);
}

// --- DLR: static GeoJSON, polygon geometry, ITM ---
async function fetchDlr() {
  const url = "https://data.smartdublin.ie/dataset/f991ba64-ab1f-47c4-af28-d1c0bc1be4a5/resource/68d6d6af-9e20-4563-acf6-058e16752368/download/derelict-sites-register-dlr.geojson";
  const data = await fetchJson(url);
  let count = 0;
  for (const f of data.features ?? []) {
    const p = f.properties ?? {};
    const addr = [str(p.ADDRESS_1), str(p.ADDRESS_2), str(p.ADDRESS_3)].filter(Boolean).join(", ");
    const ref = str(p.DerelictSi) || str(p.FID);
    // Reproject polygon from ITM to WGS84
    let geometry = f.geometry;
    if (geometry?.type === "Polygon") {
      geometry = { type: "Polygon", coordinates: reprojectPolygon(geometry.coordinates) };
    } else if (geometry?.type === "MultiPolygon") {
      geometry = { type: "MultiPolygon", coordinates: geometry.coordinates.map(reprojectPolygon) };
    }
    add(geometry, {
      address: addr,
      reference: ref,
      council: "dlr",
      council_label: "Dún Laoghaire-Rathdown County Council",
      date_added: null,
      valuation: null,
      on_register: true,
      protected_structure: false,
    });
    count++;
  }
  console.log(`  DLR: ${count} sites`);
}

// --- Wicklow: ArcGIS REST, polygon geometry, ITM ---
async function fetchWicklow() {
  const base = "https://services.arcgis.com/hQOfkHGHCu8mgDpG/arcgis/rest/services/Derelict_Sites_Register/FeatureServer/16/query";
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "Derelict",
    outSR: "4326",
    returnGeometry: "true",
    resultRecordCount: "2000",
    f: "geojson",
  });
  const data = await fetchJson(`${base}?${params}`);
  let count = 0;
  for (const f of data.features ?? []) {
    const p = f.properties ?? {};
    add(f.geometry, {
      address: "",
      reference: str(p.Derelict),
      council: "wicklow",
      council_label: "Wicklow County Council",
      date_added: null,
      valuation: null,
      on_register: true,
      protected_structure: false,
    });
    count++;
  }
  console.log(`  Wicklow: ${count} sites`);
}

// --- Kildare: geocoded from PDF, curated in kildare.json ---
async function loadKildare() {
  const { readFileSync } = await import("fs");
  const sites = JSON.parse(readFileSync(join(__dirname, "kildare.json"), "utf8"));
  let count = 0;
  for (const s of sites) {
    add(
      { type: "Point", coordinates: [s.lng, s.lat] },
      {
        address: s.address,
        reference: s.ref,
        council: "kildare",
        council_label: "Kildare County Council",
        date_added: s.date,
        valuation: null,
        on_register: true,
        protected_structure: false,
      }
    );
    count++;
  }
  console.log(`  Kildare: ${count} sites (geocoded from PDF, ${sites.length} of ~63 addresses resolved)`);
}

// --- Main ---
console.log("Fetching derelict sites registers...");
const results = await Promise.allSettled([fetchSdcc(), fetchDcc(), fetchDlr(), fetchWicklow()]);
for (const [i, r] of results.entries()) {
  if (r.status === "rejected") {
    console.error(`  FAILED [${["SDCC", "DCC", "DLR", "Wicklow"][i]}]:`, r.reason?.message ?? r.reason);
  }
}
await loadKildare();

const fc = { type: "FeatureCollection", features };
writeFileSync(OUT, JSON.stringify(fc));
const sizeKb = Math.round(Buffer.byteLength(JSON.stringify(fc)) / 1024);
console.log(`\nWrote ${features.length} derelict sites to ${OUT} (${sizeKb} KB)`);

const byConcil = {};
for (const f of features) {
  const c = f.properties.council;
  byConcil[c] = (byConcil[c] ?? 0) + 1;
}
console.log("By council:", byConcil);
