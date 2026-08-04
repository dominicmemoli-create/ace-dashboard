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
import {
  computeFoodCost, filterAyceProgram, isIncludedCheck, servicePeriodOf, weekdayOf,
} from '../src/food-cost-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'live', f), 'utf8'));
const OPS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'operations.json'), 'utf8'));

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function buildMetricsForDate(date, selections, checks, reference, costs) {
  const rows = [];
  const itemRows = [];
  for (const period of ['lunch', 'dinner']) {
    const inScope = checks.filter((c) => isIncludedCheck(c, OPS) && servicePeriodOf(c, OPS) === period);
    if (!inScope.length) continue;
    const guids = new Set(inScope.map((c) => c.checkGuid));
    const sel = selections.filter((s) => guids.has(s.checkGuid));
    const ayce = filterAyceProgram(sel, inScope, reference);
    const fc = computeFoodCost(ayce.selections, ayce.checks, reference, costs);

    const base = {
      businessDate: date, weekday: weekdayOf(date), period,
      checks: inScope.length,
      guests: inScope.reduce((a, c) => a + (c.numberOfGuests || 0), 0),
      floorNet: round2(inScope.reduce((a, c) => a + (c.amount || 0), 0)),
      ayceChecks: ayce.checks.length,
      entitlementNet: round2(ayce.entitlementNet),
      entitlementCovers: ayce.entitlementCovers,
      roundCost: round2(fc.total.foodCostDollars),
      matchedQty: fc.total.matchedQty,
      totalQty: fc.total.totalQty,
      unmatchedItems: fc.total.unmatchedItemCount,
    };
    rows.push({ ...base, serverGuid: null });

    // per-server AYCE buckets (entitlement revenue attributed by check server)
    const perServerEnt = new Map();
    for (const s of ayce.selections) {
      if (!/PER PERSON|\(kids\)/i.test(s.itemName ?? '')) continue;
      const cur = perServerEnt.get(s.serverGuid) ?? { net: 0, covers: 0 };
      cur.net += Math.max(0, (s.gross ?? 0) - (s.discount ?? 0));
      cur.covers += s.quantity ?? 0;
      perServerEnt.set(s.serverGuid, cur);
    }
    for (const [serverGuid, b] of fc.perServer.entries()) {
      const ent = perServerEnt.get(serverGuid) ?? { net: 0, covers: 0 };
      rows.push({
        businessDate: date, weekday: base.weekday, period, serverGuid,
        checks: b.checks.size,
        entitlementNet: round2(ent.net),
        entitlementCovers: ent.covers,
        roundCost: round2(b.foodCostDollars),
        matchedQty: b.matchedQty,
        totalQty: b.totalQty,
      });
    }

    for (const d of fc.itemDrivers) {
      itemRows.push({ businessDate: date, period, name: d.canonicalName, matched: true, qty: d.qty, cost: round2(d.costDollars), source: d.source, verification: d.verification });
    }
    for (const u of fc.unmatchedQueue) {
      itemRows.push({ businessDate: date, period, name: u.name, matched: false, qty: u.qty, cost: 0 });
    }
  }
  return { rows, itemRows };
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
