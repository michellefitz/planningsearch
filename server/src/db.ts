import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTHORITIES } from "./config/authorities.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PLANVIEW_DATA_DIR ?? path.resolve(__dirname, "../data");
export const DB_PATH = process.env.PLANVIEW_DB ?? path.join(DATA_DIR, "planview.db");

/**
 * Canonical store (PRD §8). SQLite for v1 so the whole stack runs anywhere;
 * the schema is deliberately portable to Postgres+PostGIS (geometry kept as
 * plain lat/lng plus an optional GeoJSON polygon payload).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS authorities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  source_system TEXT NOT NULL,
  portal_base_url TEXT NOT NULL,
  gis_url TEXT,
  last_synced TEXT
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY,
  authority_id TEXT NOT NULL REFERENCES authorities(id),
  planning_reference TEXT NOT NULL,
  description TEXT,
  application_type TEXT,
  application_type_raw TEXT,
  is_domestic_guess INTEGER NOT NULL DEFAULT 0,
  is_one_off INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  status_raw TEXT,
  received_date TEXT,
  validated_date TEXT,
  further_info_requested_date TEXT,
  further_info_received_date TEXT,
  decision_due_date TEXT,
  submissions_by_date TEXT,
  decision TEXT,
  decision_raw TEXT,
  decision_date TEXT,
  appeal_status TEXT,
  appeal_reference TEXT,
  appeal_lodged_date TEXT,
  appeal_decision TEXT,
  appeal_decision_date TEXT,
  final_grant_date TEXT,
  applicant_name TEXT,
  agent_name TEXT,
  address_text TEXT,
  eircode TEXT,
  num_residential_units INTEGER,
  floor_area_sqm REAL,
  site_area_ha REAL,
  expiry_date TEXT,
  commencement_notice TEXT,
  commencement_date TEXT,
  completion_date TEXT,
  commencement_units INTEGER,
  commencement_count INTEGER,
  lat REAL,
  lng REAL,
  geom_polygon TEXT,
  source_url TEXT,
  last_synced TEXT,
  ai_summary TEXT,
  UNIQUE(authority_id, planning_reference)
);

CREATE INDEX IF NOT EXISTS idx_apps_authority ON applications(authority_id);
CREATE INDEX IF NOT EXISTS idx_apps_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_apps_received ON applications(received_date);
CREATE INDEX IF NOT EXISTS idx_apps_decision_date ON applications(decision_date);
CREATE INDEX IF NOT EXISTS idx_apps_latlng ON applications(lat, lng);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  title TEXT NOT NULL,
  doc_type TEXT,
  page_count INTEGER,
  access_mode TEXT NOT NULL DEFAULT 'link' CHECK (access_mode IN ('link','cached')),
  source_url TEXT,
  cached_object_key TEXT,
  ocr_status TEXT,
  is_withheld INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_docs_app ON documents(application_id);

-- Ranked full-text search over the fields users actually query (PRD F1.2).
CREATE VIRTUAL TABLE IF NOT EXISTS fts_apps USING fts5(
  reference, address, applicant, description,
  application_id UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2",
  prefix = '2 3 4'
);

-- Trigram index for typo tolerance ("manooth" -> Maynooth, PRD F1.3).
CREATE VIRTUAL TABLE IF NOT EXISTS fts_tri USING fts5(
  haystack,
  application_id UNINDEXED,
  tokenize = "trigram"
);
`;

export interface OpenDbOptions {
  /**
   * Open an existing database without writing (serverless deployments bundle
   * a pre-built DB on a read-only filesystem). Skips schema creation and the
   * WAL pragma — the bundled file must be in a non-WAL journal mode.
   */
  readonly?: boolean;
}

export function openDb(dbPath: string = DB_PATH, opts: OpenDbOptions = {}): Database.Database {
  if (opts.readonly) {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // Migrate existing databases that predate later columns.
  try { db.exec("ALTER TABLE applications ADD COLUMN ai_summary TEXT"); } catch {}
  try { db.exec("ALTER TABLE applications ADD COLUMN is_one_off INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE applications ADD COLUMN num_residential_units INTEGER"); } catch {}
  try { db.exec("ALTER TABLE applications ADD COLUMN floor_area_sqm REAL"); } catch {}
  try { db.exec("ALTER TABLE applications ADD COLUMN site_area_ha REAL"); } catch {}
  try { db.exec("ALTER TABLE applications ADD COLUMN expiry_date TEXT"); } catch {}
  try { db.exec("ALTER TABLE applications ADD COLUMN appeal_reference TEXT"); } catch {}
  try { db.exec("ALTER TABLE applications ADD COLUMN appeal_lodged_date TEXT"); } catch {}
  try { db.exec("ALTER TABLE applications ADD COLUMN appeal_decision TEXT"); } catch {}
  try { db.exec("ALTER TABLE applications ADD COLUMN appeal_decision_date TEXT"); } catch {}
  // BCMS commencement/completion join (ingest/bcms.ts) — enrichment columns
  // applied after the register upsert, like ai_summary.
  try { db.exec("ALTER TABLE applications ADD COLUMN commencement_notice TEXT"); } catch {}
  try { db.exec("ALTER TABLE applications ADD COLUMN commencement_date TEXT"); } catch {}
  try { db.exec("ALTER TABLE applications ADD COLUMN completion_date TEXT"); } catch {}
  try { db.exec("ALTER TABLE applications ADD COLUMN commencement_units INTEGER"); } catch {}
  try { db.exec("ALTER TABLE applications ADD COLUMN commencement_count INTEGER"); } catch {}
  seedAuthorities(db);
  return db;
}

function seedAuthorities(db: Database.Database) {
  const upsert = db.prepare(`
    INSERT INTO authorities (id, name, short_name, source_system, portal_base_url, gis_url)
    VALUES (@id, @name, @shortName, @sourceSystem, @portalBaseUrl, @gisUrl)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      short_name = excluded.short_name,
      source_system = excluded.source_system,
      portal_base_url = excluded.portal_base_url,
      gis_url = excluded.gis_url
  `);
  for (const a of AUTHORITIES) {
    upsert.run({
      id: a.id,
      name: a.name,
      shortName: a.shortName,
      sourceSystem: a.sourceSystem,
      portalBaseUrl: a.portalBaseUrl,
      gisUrl: a.gisUrl,
    });
  }
}

export interface ApplicationRecord {
  authority_id: string;
  planning_reference: string;
  description: string | null;
  application_type: string;
  application_type_raw: string | null;
  is_domestic_guess: number;
  /** An application to build a one-off house — see isOneOffHouse. */
  is_one_off: number;
  status: string;
  status_raw: string | null;
  received_date: string | null;
  validated_date: string | null;
  further_info_requested_date: string | null;
  further_info_received_date: string | null;
  decision_due_date: string | null;
  /** Deadline for public submissions/observations, where the council publishes it. */
  submissions_by_date: string | null;
  decision: string | null;
  decision_raw: string | null;
  decision_date: string | null;
  appeal_status: string | null;
  appeal_reference: string | null;
  appeal_lodged_date: string | null;
  appeal_decision: string | null;
  appeal_decision_date: string | null;
  final_grant_date: string | null;
  applicant_name: string | null;
  agent_name: string | null;
  address_text: string | null;
  eircode: string | null;
  num_residential_units: number | null;
  floor_area_sqm: number | null;
  site_area_ha: number | null;
  expiry_date: string | null;
  lat: number | null;
  lng: number | null;
  geom_polygon: string | null;
  source_url: string | null;
  last_synced: string;
}

/** Upsert an application and keep both FTS indexes in sync. */
export function upsertApplication(db: Database.Database, rec: ApplicationRecord): number {
  const upsert = db.prepare(`
    INSERT INTO applications (
      authority_id, planning_reference, description, application_type, application_type_raw,
      is_domestic_guess, is_one_off, status, status_raw, received_date, validated_date,
      further_info_requested_date, further_info_received_date, decision_due_date,
      submissions_by_date,
      decision, decision_raw, decision_date, appeal_status, appeal_reference,
      appeal_lodged_date, appeal_decision, appeal_decision_date, final_grant_date,
      applicant_name, agent_name, address_text, eircode,
      num_residential_units, floor_area_sqm, site_area_ha, expiry_date,
      lat, lng, geom_polygon, source_url, last_synced
    ) VALUES (
      @authority_id, @planning_reference, @description, @application_type, @application_type_raw,
      @is_domestic_guess, @is_one_off, @status, @status_raw, @received_date, @validated_date,
      @further_info_requested_date, @further_info_received_date, @decision_due_date,
      @submissions_by_date,
      @decision, @decision_raw, @decision_date, @appeal_status, @appeal_reference,
      @appeal_lodged_date, @appeal_decision, @appeal_decision_date, @final_grant_date,
      @applicant_name, @agent_name, @address_text, @eircode,
      @num_residential_units, @floor_area_sqm, @site_area_ha, @expiry_date,
      @lat, @lng, @geom_polygon, @source_url, @last_synced
    )
    ON CONFLICT(authority_id, planning_reference) DO UPDATE SET
      description = excluded.description,
      application_type = excluded.application_type,
      application_type_raw = excluded.application_type_raw,
      is_domestic_guess = excluded.is_domestic_guess,
      is_one_off = excluded.is_one_off,
      status = excluded.status,
      status_raw = excluded.status_raw,
      received_date = excluded.received_date,
      validated_date = excluded.validated_date,
      further_info_requested_date = excluded.further_info_requested_date,
      further_info_received_date = excluded.further_info_received_date,
      decision_due_date = excluded.decision_due_date,
      submissions_by_date = excluded.submissions_by_date,
      decision = excluded.decision,
      decision_raw = excluded.decision_raw,
      decision_date = excluded.decision_date,
      appeal_status = excluded.appeal_status,
      appeal_reference = excluded.appeal_reference,
      appeal_lodged_date = excluded.appeal_lodged_date,
      appeal_decision = excluded.appeal_decision,
      appeal_decision_date = excluded.appeal_decision_date,
      final_grant_date = excluded.final_grant_date,
      applicant_name = excluded.applicant_name,
      agent_name = excluded.agent_name,
      address_text = excluded.address_text,
      eircode = excluded.eircode,
      num_residential_units = excluded.num_residential_units,
      floor_area_sqm = excluded.floor_area_sqm,
      site_area_ha = excluded.site_area_ha,
      expiry_date = excluded.expiry_date,
      lat = excluded.lat,
      lng = excluded.lng,
      geom_polygon = excluded.geom_polygon,
      source_url = excluded.source_url,
      last_synced = excluded.last_synced
  `);
  upsert.run(rec as unknown as Record<string, unknown>);
  const row = db
    .prepare(
      "SELECT id FROM applications WHERE authority_id = ? AND planning_reference = ?"
    )
    .get(rec.authority_id, rec.planning_reference) as { id: number };

  db.prepare("DELETE FROM fts_apps WHERE application_id = ?").run(row.id);
  db.prepare("DELETE FROM fts_tri WHERE application_id = ?").run(row.id);
  db.prepare(
    "INSERT INTO fts_apps (reference, address, applicant, description, application_id) VALUES (?, ?, ?, ?, ?)"
  ).run(
    rec.planning_reference,
    rec.address_text ?? "",
    rec.applicant_name ?? "",
    rec.description ?? "",
    row.id
  );
  db.prepare("INSERT INTO fts_tri (haystack, application_id) VALUES (?, ?)").run(
    [rec.planning_reference, rec.address_text, rec.applicant_name, rec.description]
      .filter(Boolean)
      .join(" • "),
    row.id
  );
  return row.id;
}

export function setAuthoritySynced(db: Database.Database, authorityId: string, when: string) {
  db.prepare("UPDATE authorities SET last_synced = ? WHERE id = ?").run(when, authorityId);
}
