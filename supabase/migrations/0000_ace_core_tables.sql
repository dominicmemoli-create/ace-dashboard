-- ACE core data tables — the flat `ace_*` layer the live dashboard actually reads.
--
-- Historically these tables were created as a side effect of running
-- scripts/deploy-supabase.mjs, scripts/build-metrics.mjs and
-- scripts/import-opentable.mjs, which meant `supabase/migrations/` alone could
-- never bootstrap a working project. This migration owns the schema instead:
-- the ingestion scripts keep their `create table if not exists` guards, but a
-- clean project is fully defined here.
--
-- Runs FIRST. Apply with:
--   node scripts/admin/bootstrap.mjs
-- or individually:
--   node scripts/admin/apply-sql.mjs supabase/migrations/0000_ace_core_tables.sql
-- Idempotent: safe to re-run.
--
-- Read posture is deliberately NOT set here — 0006_manager_writes.sql owns every
-- policy and grant so the whole authorization surface is reviewable in one file.

-- ------------------------------------------------------------- toast source --
create table if not exists ace_manifest (
  id int primary key default 1 check (id = 1),
  restaurant_guid uuid,
  dates jsonb not null default '[]',
  last_toast_sync timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists ace_reference (
  id int primary key default 1 check (id = 1),
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists ace_checks (
  check_guid uuid primary key,
  business_date text not null,
  payload jsonb not null
);
create index if not exists ace_checks_date_idx on ace_checks (business_date);

create table if not exists ace_selections (
  selection_guid uuid primary key,
  check_guid uuid not null,
  business_date text not null,
  payload jsonb not null
);
create index if not exists ace_selections_date_idx on ace_selections (business_date);

-- Selection lookups in ace_upload_costs and ace_save_review_fix filter on
-- payload keys, not on the indexed columns; these keep both off sequential scans.
create index if not exists ace_selections_order_idx on ace_selections ((payload ->> 'orderGuid'));
create index if not exists ace_checks_order_idx on ace_checks ((payload ->> 'orderGuid'));

create table if not exists ace_ingestion_runs (
  run_id text primary key,
  payload jsonb not null
);

-- -------------------------------------------------------------- food costs --
create table if not exists ace_item_costs (
  id text primary key,
  payload jsonb not null,
  canonical_name text generated always as (payload ->> 'canonicalName') stored,
  effective_from text generated always as (payload ->> 'effectiveFrom') stored,
  updated_at timestamptz not null default now()
);
create index if not exists ace_item_costs_name_idx on ace_item_costs (canonical_name, effective_from desc);

-- ---------------------------------------------------------- derived metrics --
create table if not exists ace_metrics (
  unique_key text primary key,
  business_date text not null,
  period text not null,
  server_guid uuid,
  payload jsonb not null
);
create index if not exists ace_metrics_date_idx on ace_metrics (business_date);

create table if not exists ace_item_metrics (
  unique_key text primary key,
  business_date text not null,
  period text not null,
  payload jsonb not null
);
create index if not exists ace_item_metrics_date_idx on ace_item_metrics (business_date);

-- ------------------------------------------------------ opentable intents --
-- PII-free by construction: ace_upload_opentable rejects any payload carrying
-- guestName / phone / guestRequests / visitNotes / raw.
create table if not exists ace_intents (
  row_hash text primary key,
  business_date text not null,
  payload jsonb not null,
  imported_at timestamptz not null default now()
);
create index if not exists ace_intents_date_idx on ace_intents (business_date);

-- RLS on every table. Deny-by-default until 0006 grants the narrow public read.
alter table ace_manifest       enable row level security;
alter table ace_reference      enable row level security;
alter table ace_checks         enable row level security;
alter table ace_selections     enable row level security;
alter table ace_ingestion_runs enable row level security;
alter table ace_item_costs     enable row level security;
alter table ace_metrics        enable row level security;
alter table ace_item_metrics   enable row level security;
alter table ace_intents        enable row level security;
