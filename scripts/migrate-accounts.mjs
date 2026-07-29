import { sql } from "../api/_accounts/db.mjs";

const STATEMENTS = [
  `create table if not exists users (
    id bigint generated always as identity primary key,
    email text not null unique,
    created_at timestamptz not null default now(),
    last_digest_at timestamptz
  )`,
  `create table if not exists auth_tokens (
    token_hash text primary key,
    email text not null,
    expires_at timestamptz not null,
    used_at timestamptz
  )`,
  `create table if not exists sessions (
    token_hash text primary key,
    user_id bigint not null references users(id) on delete cascade,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
  )`,
  `create table if not exists saved_apps (
    id bigint generated always as identity primary key,
    user_id bigint not null references users(id) on delete cascade,
    authority_id text not null,
    planning_reference text not null,
    alerts_enabled boolean not null default true,
    events_seen_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (user_id, authority_id, planning_reference)
  )`,
  `create table if not exists lists (
    id bigint generated always as identity primary key,
    user_id bigint not null references users(id) on delete cascade,
    name text not null,
    position int not null default 0,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists list_items (
    list_id bigint not null references lists(id) on delete cascade,
    saved_app_id bigint not null references saved_apps(id) on delete cascade,
    primary key (list_id, saved_app_id)
  )`,
  `create table if not exists app_snapshots (
    authority_id text not null,
    planning_reference text not null,
    snapshot jsonb not null,
    fetched_at timestamptz not null default now(),
    primary key (authority_id, planning_reference)
  )`,
  `create table if not exists app_events (
    id bigint generated always as identity primary key,
    authority_id text not null,
    planning_reference text not null,
    event_type text not null,
    field text not null,
    old_value text,
    new_value text,
    summary text not null,
    detected_at timestamptz not null default now()
  )`,
  `create index if not exists app_events_app_idx
     on app_events (authority_id, planning_reference, detected_at desc)`,
  `create table if not exists preplan_projects (
    id bigint generated always as identity primary key,
    user_id bigint not null references users(id) on delete cascade,
    label text not null,
    lat double precision not null,
    lng double precision not null,
    address text not null,
    eircode text,
    intent text not null,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists agile_enrichment (
    authority_id text not null,
    planning_reference text not null,
    agile_id integer,
    full_description text,
    applicant_name text,
    agent_name text,
    officer_name text,
    eircode text,
    application_type text,
    live_status text,
    live_decision text,
    resolve_failed boolean not null default false,
    fetched_at timestamptz not null default now(),
    primary key (authority_id, planning_reference)
  )`,
  `alter table agile_enrichment add column if not exists application_type text`,
  `create index if not exists agile_enrichment_fetched_idx
     on agile_enrichment (fetched_at)`,
  `create table if not exists preplan_reports (
    id bigint generated always as identity primary key,
    project_id bigint not null references preplan_projects(id) on delete cascade,
    status text not null default 'running',
    sections jsonb,
    narrative text,
    error text,
    generated_at timestamptz not null default now()
  )`,
];

for (const stmt of STATEMENTS) {
  await sql(stmt);
  console.log("ok:", stmt.slice(0, 60).replace(/\s+/g, " "));
}
console.log("migration complete");
