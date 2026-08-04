#!/usr/bin/env node
// Deploy the ACE food-cost data layer to Supabase (POC).
//
// Creates flat `ace_*` tables that mirror the normalized JSON shapes the
// dashboard engine consumes, loads the pilot dataset, and enables RLS with
// read-only anon access (the same PII-free data already published on GitHub
// Pages — no new exposure). Writes require the service-role key (this script).
// The fully-normalized schema in supabase/migrations/ remains the target for
// the auth/server-portal phase.
//
// Usage: node scripts/deploy-supabase.mjs   (reads .env for SUPABASE_URL,
//        SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) { console.error('SUPABASE_DB_URL missing from .env'); process.exit(1); }

const DDL = `
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
create table if not exists ace_item_costs (
  id text primary key,
  payload jsonb not null,
  canonical_name text generated always as (payload->>'canonicalName') stored,
  effective_from text generated always as (payload->>'effectiveFrom') stored,
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
create table if not exists ace_ingestion_runs (
  run_id text primary key,
  payload jsonb not null
);

alter table ace_manifest enable row level security;
alter table ace_reference enable row level security;
alter table ace_item_costs enable row level security;
alter table ace_checks enable row level security;
alter table ace_selections enable row level security;
alter table ace_ingestion_runs enable row level security;

-- POC read policy: anon may SELECT (identical data is already public on the
-- static site). No anon/authenticated write policies exist — writes go through
-- the service role only. Replaced by role-based policies in the auth phase.
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'ace_manifest' and policyname = 'poc_read') then
    create policy poc_read on ace_manifest for select using (true);
    create policy poc_read on ace_reference for select using (true);
    create policy poc_read on ace_item_costs for select using (true);
    create policy poc_read on ace_checks for select using (true);
    create policy poc_read on ace_selections for select using (true);
    create policy poc_read on ace_ingestion_runs for select using (true);
  end if;
end $$;
`;

async function main() {
  const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connected. Applying ace_* schema…');
  await client.query(DDL);

  const live = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'live', f), 'utf8'));
  const manifest = live('manifest.json');
  const reference = live('reference.json');
  const costs = live('item_costs.json');
  const runs = live('ingestion_runs.json');

  await client.query(
    `insert into ace_manifest (id, restaurant_guid, dates, last_toast_sync, updated_at)
     values (1, $1, $2, $3, now())
     on conflict (id) do update set restaurant_guid = excluded.restaurant_guid,
       dates = excluded.dates, last_toast_sync = excluded.last_toast_sync, updated_at = now()`,
    [manifest.restaurantGuid, JSON.stringify(manifest.dates), manifest.lastToastSync]);
  await client.query(
    `insert into ace_reference (id, payload, updated_at) values (1, $1, now())
     on conflict (id) do update set payload = excluded.payload, updated_at = now()`,
    [JSON.stringify(reference)]);

  console.log(`Loading ${costs.length} cost records…`);
  for (const rec of costs) {
    await client.query(
      `insert into ace_item_costs (id, payload, updated_at) values ($1, $2, now())
       on conflict (id) do update set payload = excluded.payload, updated_at = now()`,
      [rec.id, JSON.stringify(rec)]);
  }

  for (const date of manifest.dates) {
    const checks = live(`checks_${date}.json`);
    const selections = live(`selections_${date}.json`);
    console.log(`Loading ${date}: ${checks.length} checks, ${selections.length} selections…`);
    // idempotent full replace per date
    await client.query('delete from ace_selections where business_date = $1', [date]);
    await client.query('delete from ace_checks where business_date = $1', [date]);
    for (let i = 0; i < checks.length; i += 500) {
      const batch = checks.slice(i, i + 500);
      await client.query(
        `insert into ace_checks (check_guid, business_date, payload)
         select (x->>'checkGuid')::uuid, x->>'businessDate', x from jsonb_array_elements($1::jsonb) x
         on conflict (check_guid) do update set payload = excluded.payload`,
        [JSON.stringify(batch)]);
    }
    for (let i = 0; i < selections.length; i += 500) {
      const batch = selections.slice(i, i + 500);
      await client.query(
        `insert into ace_selections (selection_guid, check_guid, business_date, payload)
         select (x->>'selectionGuid')::uuid, (x->>'checkGuid')::uuid, x->>'businessDate', x
         from jsonb_array_elements($1::jsonb) x
         on conflict (selection_guid) do update set payload = excluded.payload`,
        [JSON.stringify(batch)]);
    }
  }

  for (const run of runs) {
    await client.query(
      `insert into ace_ingestion_runs (run_id, payload) values ($1, $2)
       on conflict (run_id) do nothing`, [run.runId, JSON.stringify(run)]);
  }

  const counts = await client.query(`
    select (select count(*) from ace_checks) checks,
           (select count(*) from ace_selections) selections,
           (select count(*) from ace_item_costs) costs`);
  console.log('Deployed:', counts.rows[0]);
  await client.end();
}

main().catch((e) => { console.error('DEPLOY FAILED:', e.message); process.exit(1); });
