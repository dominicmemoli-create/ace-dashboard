#!/usr/bin/env node
// Build per-(business date × service period) operational aggregates from the
// normalized Toast data + cost master, and publish them to Supabase (plus a
// local metrics.json used as the static fallback for pilot dates).
//
// This is what lets the dashboard compute AYCE food cost and the four-week
// comparable baseline WITHOUT downloading 30+ days of raw selections.
// Re-run after any ingestion or cost import: `npm run build:metrics`
// (add --no-supabase to skip the database write).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMetricsForDate as buildPure } from '../src/metrics-builder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'live', f), 'utf8'));
const OPS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'operations.json'), 'utf8'));

// The implementation lives in src/metrics-builder.mjs (shared with the
// browser's Food Costs recalculation). This wrapper binds the repo config.
export function buildMetricsForDate(date, selections, checks, reference, costs) {
  return buildPure(date, selections, checks, reference, costs, OPS);
}

async function main() {
  const manifest = live('manifest.json');
  const reference = live('reference.json');
  const costs = live('item_costs.json');
  const allRows = [], allItems = [];
  for (const date of manifest.dates) {
    const { rows, itemRows } = buildMetricsForDate(
      date, live(`selections_${date}.json`), live(`checks_${date}.json`), reference, costs);
    allRows.push(...rows);
    allItems.push(...itemRows);
    process.stdout.write('.');
  }
  console.log(`\n${allRows.length} metric rows, ${allItems.length} item rows across ${manifest.dates.length} dates`);

  fs.writeFileSync(path.join(ROOT, 'data', 'live', 'metrics.json'),
    JSON.stringify({ builtAt: new Date().toISOString(), config: OPS, rows: allRows, items: allItems }));

  if (process.argv.includes('--no-supabase')) return;
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`
    create table if not exists ace_metrics (
      unique_key text primary key,
      business_date text not null, period text not null, server_guid uuid,
      payload jsonb not null
    );
    create index if not exists ace_metrics_date_idx on ace_metrics (business_date);
    create table if not exists ace_item_metrics (
      unique_key text primary key,
      business_date text not null, period text not null,
      payload jsonb not null
    );
    alter table ace_metrics enable row level security;
    alter table ace_item_metrics enable row level security;
    do $$ begin
      if not exists (select 1 from pg_policies where tablename='ace_metrics' and policyname='poc_read') then
        create policy poc_read on ace_metrics for select using (true);
        create policy poc_read on ace_item_metrics for select using (true);
      end if;
    end $$;`);
  // full rebuild: clear the covered dates first so reclassified items (e.g.
  // modifiers that used to appear as unmatched rows) cannot linger as stale
  // ace_item_metrics entries
  await client.query('delete from ace_metrics where business_date = any($1)', [manifest.dates.map(String)]);
  await client.query('delete from ace_item_metrics where business_date = any($1)', [manifest.dates.map(String)]);
  for (let i = 0; i < allRows.length; i += 500) {
    const batch = allRows.slice(i, i + 500).map((r) => ({
      unique_key: `${r.businessDate}|${r.period}|${r.serverGuid ?? '-'}`,
      business_date: r.businessDate, period: r.period, server_guid: r.serverGuid, payload: r,
    }));
    await client.query(
      `insert into ace_metrics (unique_key, business_date, period, server_guid, payload)
       select x->>'unique_key', x->>'business_date', x->>'period', (x->>'server_guid')::uuid, x->'payload'
       from jsonb_array_elements($1::jsonb) x
       on conflict (unique_key) do update set payload = excluded.payload`,
      [JSON.stringify(batch)]);
  }
  for (let i = 0; i < allItems.length; i += 500) {
    const batch = allItems.slice(i, i + 500).map((r) => ({
      unique_key: `${r.businessDate}|${r.period}|${r.name}`,
      business_date: r.businessDate, period: r.period, payload: r,
    }));
    await client.query(
      `insert into ace_item_metrics (unique_key, business_date, period, payload)
       select x->>'unique_key', x->>'business_date', x->>'period', x->'payload'
       from jsonb_array_elements($1::jsonb) x
       on conflict (unique_key) do update set payload = excluded.payload`,
      [JSON.stringify(batch)]);
  }
  const c = await client.query('select count(*) n from ace_metrics');
  console.log(`Supabase: ace_metrics now holds ${c.rows[0].n} rows.`);
  await client.end();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
