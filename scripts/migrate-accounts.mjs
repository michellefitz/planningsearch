import { sql } from "../api/accounts/db.mjs";

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
];

for (const stmt of STATEMENTS) {
  await sql(stmt);
  console.log("ok:", stmt.slice(0, 60).replace(/\s+/g, " "));
}
console.log("migration complete");
