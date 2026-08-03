/**
 * Demo fixture data: ~60 realistic (but entirely fictional) applications
 * across the five v1 authorities, so search/map/detail run end-to-end without
 * network access. Real data comes from `npm run ingest` (national ArcGIS
 * service). Names are invented; any resemblance to real applications is
 * coincidental.
 */
import type { ApplicationRecord } from "./db.js";
import { AUTHORITY_BY_ID } from "./config/authorities.js";
import { guessIsDomestic, normalizeApplicationType, normalizeStatus } from "./normalize.js";

interface SeedTown {
  name: string;
  lat: number;
  lng: number;
}

const TOWNS: Record<string, SeedTown[]> = {
  "dublin-city": [
    { name: "Drumcondra, Dublin 9", lat: 53.3697, lng: -6.2531 },
    { name: "Rathmines, Dublin 6", lat: 53.3211, lng: -6.2654 },
    { name: "Clontarf, Dublin 3", lat: 53.3636, lng: -6.2081 },
    { name: "Crumlin, Dublin 12", lat: 53.3239, lng: -6.3128 },
  ],
  fingal: [
    { name: "Swords, Co. Dublin", lat: 53.4597, lng: -6.2181 },
    { name: "Malahide, Co. Dublin", lat: 53.4509, lng: -6.1544 },
    { name: "Blanchardstown, Dublin 15", lat: 53.3928, lng: -6.3764 },
    { name: "Skerries, Co. Dublin", lat: 53.5828, lng: -6.1083 },
  ],
  dlr: [
    { name: "Dún Laoghaire, Co. Dublin", lat: 53.2941, lng: -6.1339 },
    { name: "Dundrum, Dublin 16", lat: 53.2892, lng: -6.2453 },
    { name: "Blackrock, Co. Dublin", lat: 53.3015, lng: -6.1778 },
    { name: "Stepaside, Dublin 18", lat: 53.2537, lng: -6.2107 },
  ],
  "south-dublin": [
    { name: "Tallaght, Dublin 24", lat: 53.2859, lng: -6.3733 },
    { name: "Lucan, Co. Dublin", lat: 53.3573, lng: -6.4489 },
    { name: "Clondalkin, Dublin 22", lat: 53.3208, lng: -6.3946 },
    { name: "Rathfarnham, Dublin 14", lat: 53.2986, lng: -6.2841 },
  ],
  kildare: [
    { name: "Maynooth, Co. Kildare", lat: 53.3813, lng: -6.5919 },
    { name: "Naas, Co. Kildare", lat: 53.2158, lng: -6.6669 },
    { name: "Leixlip, Co. Kildare", lat: 53.3652, lng: -6.4954 },
    { name: "Newbridge, Co. Kildare", lat: 53.1811, lng: -6.7967 },
    { name: "Celbridge, Co. Kildare", lat: 53.3382, lng: -6.5388 },
  ],
};

const STREETS = [
  "Main Street", "Chapel Lane", "The Green", "Castle Road", "Mill Lane",
  "Station Road", "Abbey View", "Riverside Park", "The Grove", "College Wood",
  "Church Avenue", "Meadow Court", "Willow Drive", "Beech Park", "Harbour Road",
];

const DOMESTIC_DESCRIPTIONS = [
  "Construction of a single storey extension to the rear of the existing dwelling, with internal alterations and all associated site works",
  "Two storey extension to the side of the existing dwelling house, new porch to front, and widening of vehicular entrance",
  "Attic conversion with dormer window to the rear, rooflights to the front, and all associated works",
  "Demolition of existing garage and construction of a single storey granny flat to the side of the dwelling",
  "Retention of existing single storey extension and shed to the rear of the dwelling",
  "Construction of a detached two storey dwelling, new site entrance, connection to public services and all associated site works",
  "Conversion of garage to habitable use, first floor extension over, and new bay window to the front of the dwelling",
  "New single storey conservatory to the rear, alterations to boundary wall and piers, and all ancillary works",
  "Construction of a bungalow, domestic garage, wastewater treatment system and percolation area, and a new field entrance",
];

const NON_DOMESTIC_DESCRIPTIONS = [
  "Construction of 48 no. residential units (24 houses, 24 apartments), a creche, public open space, and all associated infrastructure",
  "Change of use from retail to restaurant/cafe at ground floor, new shopfront and signage, and all associated works",
  "Construction of a two storey office block with basement car parking and landscaping",
  "Demolition of existing warehouse and construction of a light industrial unit with ancillary office space",
  "Erection of a 60m x 30m agricultural shed with slatted tank and associated yard works",
  "Construction of a single storey creche facility with outdoor play area, car parking and a new access road",
];

interface StatusPlan {
  statusRaw: string;
  decisionRaw: string | null;
  weight: number;
}

const STATUS_PLANS: StatusPlan[] = [
  { statusRaw: "New Application", decisionRaw: null, weight: 3 },
  { statusRaw: "Further Information Requested", decisionRaw: null, weight: 2 },
  { statusRaw: "Decision Made", decisionRaw: "Grant Permission", weight: 5 },
  { statusRaw: "Decision Made", decisionRaw: "Refuse Permission", weight: 2 },
  { statusRaw: "Application Withdrawn", decisionRaw: null, weight: 1 },
  { statusRaw: "Invalid Application", decisionRaw: null, weight: 1 },
  { statusRaw: "Appealed to An Bord Pleanala", decisionRaw: "Grant Permission", weight: 1 },
];

const APPLICANTS = [
  "P. Byrne", "A. & S. Nolan", "M. Ó Cearúil", "D. Whelan", "C. Fitzgibbon",
  "R. Kavanagh", "L. & T. Dempsey", "E. Sheridan", "Glenveld Homes Ltd",
  "Harbourline Developments Ltd", "N. Mulcahy", "S. Ashworth",
];

// Deterministic PRNG so the seed is stable run-to-run.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

function pickWeighted(rand: () => number, plans: StatusPlan[]): StatusPlan {
  const total = plans.reduce((s, p) => s + p.weight, 0);
  let roll = rand() * total;
  for (const p of plans) {
    roll -= p.weight;
    if (roll <= 0) return p;
  }
  return plans[plans.length - 1];
}

function refFor(authorityId: string, year: number, seq: number): string {
  const yy = String(year).slice(2);
  const n = String(seq).padStart(4, "0");
  switch (authorityId) {
    case "dublin-city":
      return `${2900 + seq}/${yy}`;
    case "fingal":
      return `F${yy}A/${n}`;
    case "dlr":
      return `D${yy}A/${n}`;
    case "south-dublin":
      return `SD${yy}A/${n}`;
    case "kildare":
      return `${yy}/${400 + seq}`;
    default:
      return `${yy}/${n}`;
  }
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Deterministically generate the demo application records without touching the
 * database. Shared by the SQLite seed (below) and the JSON export used by the
 * dependency-free serverless deployment (export-json.ts).
 */
export function generateSeedRecords(): ApplicationRecord[] {
  const rand = mulberry32(20260718);
  const now = new Date().toISOString();
  const records: ApplicationRecord[] = [];

  for (const [authorityId, towns] of Object.entries(TOWNS)) {
    const auth = AUTHORITY_BY_ID.get(authorityId)!;
    const perAuthority = 12;
    for (let i = 0; i < perAuthority; i++) {
      const town = pick(rand, towns);
      const street = pick(rand, STREETS);
      const houseNo = 1 + Math.floor(rand() * 120);
      const domestic = rand() < 0.7;
      const description = domestic
        ? pick(rand, DOMESTIC_DESCRIPTIONS)
        : pick(rand, NON_DOMESTIC_DESCRIPTIONS);
      const plan = pickWeighted(rand, STATUS_PLANS);
      const year = rand() < 0.55 ? 2026 : rand() < 0.6 ? 2025 : 2024;
      const monthCap = year === 2026 ? 6 : 11;
      const received = `${year}-${String(1 + Math.floor(rand() * monthCap)).padStart(2, "0")}-${String(1 + Math.floor(rand() * 27)).padStart(2, "0")}`;

      const decided = plan.decisionRaw !== null;
      const fi = plan.statusRaw.includes("Further Information");
      const decisionDue = addDays(received, fi ? 120 : 56);
      const decisionDate = decided ? addDays(received, 50 + Math.floor(rand() * 40)) : null;
      const appealed = plan.statusRaw.includes("Appealed");

      const rec: ApplicationRecord = {
        authority_id: authorityId,
        planning_reference: refFor(authorityId, year, 100 + i * 7 + Math.floor(rand() * 6)),
        description,
        application_type: normalizeApplicationType(
          /retention/i.test(description) ? "Retention" : "Permission"
        ),
        application_type_raw: /retention/i.test(description) ? "Retention" : "Permission",
        is_domestic_guess: guessIsDomestic(description) ? 1 : 0,
        is_one_off: 0,
        status: normalizeStatus(plan.statusRaw, plan.decisionRaw),
        status_raw: plan.statusRaw,
        received_date: received,
        validated_date: addDays(received, 2),
        further_info_requested_date: fi ? addDays(received, 40) : null,
        further_info_received_date: null,
        decision_due_date: decisionDue,
        submissions_by_date: null,
        decision: plan.decisionRaw,
        decision_raw: plan.decisionRaw,
        decision_date: decisionDate,
        appeal_status: appealed ? "Appeal lodged with An Bord Pleanála" : null,
        appeal_reference: appealed
          ? `ABP-${300000 + Math.floor(rand() * 30000)}-${String(year).slice(2)}`
          : null,
        appeal_lodged_date: appealed && decisionDate ? addDays(decisionDate, 21) : null,
        appeal_decision: null,
        appeal_decision_date: null,
        final_grant_date:
          decided && !appealed && plan.decisionRaw === "Grant Permission" && decisionDate
            ? addDays(decisionDate, 28)
            : null,
        applicant_name: pick(rand, APPLICANTS),
        agent_name: rand() < 0.5 ? pick(rand, ["Atelier North", "Boyle + Crowe Architects", "M2 Design Studio"]) : null,
        address_text: `${houseNo} ${street}, ${town.name}`,
        eircode: null,
        num_residential_units: rand() < 0.15 ? 2 + Math.floor(rand() * 40) : null,
        floor_area_sqm: rand() < 0.6 ? Math.round(40 + rand() * 260) : null,
        site_area_ha: rand() < 0.5 ? Math.round(rand() * 80) / 100 : null,
        expiry_date:
          decided && plan.decisionRaw === "Grant Permission" && decisionDate
            ? addDays(decisionDate, 365 * 5)
            : null,
        lat: town.lat + (rand() - 0.5) * 0.02,
        lng: town.lng + (rand() - 0.5) * 0.03,
        geom_polygon: null,
        source_url: null,
        last_synced: now,
      };
      rec.source_url = auth.portalUrlForReference(rec.planning_reference);
      records.push(rec);
    }
  }
  return records;
}

export async function seedDemoData() {
  // Loaded lazily so importing generateSeedRecords (e.g. from export-json.ts,
  // the dependency-free Vercel build) never pulls in the native better-sqlite3
  // module.
  const { openDb, setAuthoritySynced, upsertApplication } = await import("./db.js");
  const db = openDb();
  const now = new Date().toISOString();
  const records = generateSeedRecords();
  for (const rec of records) upsertApplication(db, rec);
  for (const authorityId of Object.keys(TOWNS)) setAuthoritySynced(db, authorityId, now);
  console.log(`Seeded ${records.length} demo applications across ${Object.keys(TOWNS).length} authorities.`);
  console.log("(Fixture data — run `npm run ingest` against the national service for real data.)");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  seedDemoData().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
