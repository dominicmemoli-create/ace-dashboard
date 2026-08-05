#!/usr/bin/env node
// Nightly ingestion orchestrator — runs in GitHub Actions at ~6:00 AM
// America/New_York (see .github/workflows/nightly-ingest.yml) or manually:
//   node scripts/nightly.mjs [YYYYMMDD]
//
// For the target business day (default: yesterday in America/New_York) plus any
// missing four-week comparable baseline dates:
//   1. record an ingestion run (status=running) in Supabase
//   2. pull Toast orders via the API (credentials from env — never committed)
//   3. normalize → upsert ace_checks / ace_selections (idempotent by GUID)
//   4. rebuild ace_metrics / ace_item_metrics rows for those dates only
//   5. merge the date into ace_manifest and stamp last_toast_sync
//   6. on ANY failure: mark the run failed and leave every previously valid
//      row untouched (per-date staging — a corrupt run is never published)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ToastClient, resolveCredentials, loadDotEnv } from './lib/toast-client.mjs';
import { isPilotDate, resolveTargetDate, missingSecrets } from './lib/ingest-rules.mjs';
import { comparableBaselineDates } from '../src/food-cost-engine.mjs';
import { buildMetricsForDate } from './build-metrics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
loadDotEnv(ROOT);
const RESTAURANT_GUID = process.env.TOAST_RESTAURANT_GUID || 'e574444c-c511-4468-ab89-93d0abbec72b';

export { PILOT_WINDOW, isPilotDate, nyYesterday, resolveTargetDate, missingSecrets } from './lib/ingest-rules.mjs';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

function flattenSelection(sel, ctx, parentGuid = null, out = []) {
  const selDiscount = sum(sel.appliedDiscounts ?? [], (d) => d.discountAmount);
  const gross = sel.preDiscountPrice ?? sel.price ?? 0;
  out.push({
    businessDate: ctx.businessDate, orderGuid: ctx.orderGuid, checkGuid: ctx.checkGuid,
    selectionGuid: sel.guid, parentSelectionGuid: parentGuid,
    itemGuid: sel.item?.guid ?? null, itemGroupGuid: sel.itemGroup?.guid ?? null,
    itemName: sel.displayName ?? null, quantity: sel.quantity ?? 0,
    gross: round2(gross), discount: round2(selDiscount), net: round2(sel.price ?? gross),
    preDiscountPrice: round2(gross), voided: Boolean(sel.voided),
    salesCategoryGuid: sel.salesCategory?.guid ?? ctx.parentSalesCategoryGuid ?? null,
    diningOptionGuid: sel.diningOption?.guid ?? ctx.diningOptionGuid,
    selectionType: sel.selectionType ?? null,
    serverGuid: ctx.serverGuid, tableGuid: ctx.tableGuid,
    revenueCenterGuid: ctx.revenueCenterGuid, serviceAreaGuid: ctx.serviceAreaGuid,
  });
  const childCtx = { ...ctx, parentSalesCategoryGuid: sel.salesCategory?.guid ?? ctx.parentSalesCategoryGuid ?? null };
  for (const mod of sel.modifiers ?? []) flattenSelection(mod, childCtx, sel.guid, out);
  return out;
}

function normalize(orders, businessDate) {
  const selections = [], checks = [];
  for (const order of orders) {
    const serverGuid = order.server?.guid ?? null;
    for (const check of order.checks ?? []) {
      const ctx = {
        businessDate, orderGuid: order.guid, checkGuid: check.guid, serverGuid,
        tableGuid: order.table?.guid ?? null,
        revenueCenterGuid: order.revenueCenter?.guid ?? null,
        serviceAreaGuid: order.serviceArea?.guid ?? null,
        diningOptionGuid: order.diningOption?.guid ?? null,
      };
      checks.push({
        businessDate, orderGuid: order.guid, checkGuid: check.guid, serverGuid,
        tableGuid: ctx.tableGuid, revenueCenterGuid: ctx.revenueCenterGuid,
        serviceAreaGuid: ctx.serviceAreaGuid, diningOptionGuid: ctx.diningOptionGuid,
        openedDate: check.openedDate ?? order.openedDate ?? null,
        closedDate: check.closedDate ?? order.closedDate ?? null,
        numberOfGuests: order.numberOfGuests ?? null,
        voided: Boolean(check.voided || order.voided),
        amount: round2(check.amount ?? 0), taxAmount: round2(check.taxAmount ?? 0),
        totalAmount: round2(check.totalAmount ?? 0),
        checkLevelDiscount: round2(sum(check.appliedDiscounts ?? [], (d) => d.discountAmount)),
        tips: round2(sum(check.payments ?? [], (p) => p.tipAmount)),
        serviceCharges: round2(sum(check.appliedServiceCharges ?? [], (s) => s.chargeAmount)),
      });
      if (check.voided || order.voided) continue;
      for (const sel of check.selections ?? []) flattenSelection(sel, ctx, null, selections);
    }
  }
  return { selections, checks };
}

async function upsertDate(client, date, checks, selections, reference, costs) {
  await client.query('begin');
  try {
    await client.query('delete from ace_selections where business_date = $1', [date]);
    await client.query('delete from ace_checks where business_date = $1', [date]);
    for (let i = 0; i < checks.length; i += 500) {
      await client.query(
        `insert into ace_checks (check_guid, business_date, payload)
         select (x->>'checkGuid')::uuid, x->>'businessDate', x from jsonb_array_elements($1::jsonb) x
         on conflict (check_guid) do update set payload = excluded.payload`,
        [JSON.stringify(checks.slice(i, i + 500))]);
    }
    for (let i = 0; i < selections.length; i += 500) {
      await client.query(
        `insert into ace_selections (selection_guid, check_guid, business_date, payload)
         select (x->>'selectionGuid')::uuid, (x->>'checkGuid')::uuid, x->>'businessDate', x
         from jsonb_array_elements($1::jsonb) x
         on conflict (selection_guid) do update set payload = excluded.payload`,
        [JSON.stringify(selections.slice(i, i + 500))]);
    }
    const { rows, itemRows } = buildMetricsForDate(date, selections, checks, reference, costs);
    await client.query('delete from ace_metrics where business_date = $1', [date]);
    await client.query('delete from ace_item_metrics where business_date = $1', [date]);
    for (const r of rows) {
      await client.query(
        `insert into ace_metrics (unique_key, business_date, period, server_guid, payload)
         values ($1,$2,$3,$4,$5)
         on conflict (unique_key) do update set payload = excluded.payload`,
        [`${r.businessDate}|${r.period}|${r.serverGuid ?? '-'}`, r.businessDate, r.period, r.serverGuid, JSON.stringify(r)]);
    }
    for (const r of itemRows) {
      await client.query(
        `insert into ace_item_metrics (unique_key, business_date, period, payload)
         values ($1,$2,$3,$4) on conflict (unique_key) do update set payload = excluded.payload`,
        [`${r.businessDate}|${r.period}|${r.name}`, r.businessDate, r.period, JSON.stringify(r)]);
    }
    await client.query(
      `update ace_manifest set dates = (
         select jsonb_agg(d order by d) from (
           select distinct jsonb_array_elements_text(dates) d from ace_manifest
           union select $1) s),
       last_toast_sync = now(), updated_at = now() where id = 1`, [date]);
    await client.query('commit');
    return { checks: checks.length, selections: selections.length, metricRows: rows.length };
  } catch (e) {
    await client.query('rollback'); // previous valid rows for this date remain published
    throw e;
  }
}

async function main() {
  const absent = missingSecrets();
  if (absent.length) {
    console.error(`Missing required secret(s): ${absent.join(', ')}. `
      + 'Set them as GitHub Actions repository secrets (see docs/CREDENTIALS.md).');
    process.exit(1);
  }
  const target = resolveTargetDate(process.argv[2]);
  if (isPilotDate(target)) {
    console.error(`Refusing to ingest ${target}: Jul 31 – Aug 2 2026 pilot history is frozen.`);
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const manifest = await client.query('select dates from ace_manifest where id = 1');
  const have = new Set(manifest.rows[0]?.dates ?? []);
  const { dates: baselineDates } = comparableBaselineDates([target], [...have, target], 4);
  const wantedBaseline = comparableBaselineDates([target], // recompute against "all possible" to find gaps
    Array.from({ length: 40 }, (_, i) => {
      const d = new Date(Date.UTC(+target.slice(0, 4), +target.slice(4, 6) - 1, +target.slice(6, 8)));
      d.setUTCDate(d.getUTCDate() - i);
      return d.toISOString().slice(0, 10).replace(/-/g, '');
    }), 4).perDate[target].requested;
  const toIngest = [target, ...wantedBaseline.filter((d) => !have.has(d))].filter((d) => !isPilotDate(d));
  console.log(`Target ${target}; ingesting: ${toIngest.join(', ')} (baseline gaps included)`);

  const runId = `nightly-${target}-${Date.now()}`;
  await client.query(
    `insert into ace_ingestion_runs (run_id, payload) values ($1, $2)`,
    [runId, JSON.stringify({ runId, source: 'toast_api', adapter: 'ToastApiAdapter/nightly', target, dates: toIngest, startedAt: new Date().toISOString(), status: 'running' })]);

  const results = {};
  let failed = null;
  try {
    const creds = resolveCredentials({ allowDesktopConfig: process.argv.includes('--allow-desktop-config') });
    const toast = new ToastClient({ ...creds, restaurantGuid: RESTAURANT_GUID });
    await toast.authenticate();

    const refRow = await client.query('select payload from ace_reference where id = 1');
    if (!refRow.rows[0]) {
      throw new Error('ace_reference is empty — seed the project first (node scripts/deploy-supabase.mjs).');
    }
    const reference = refRow.rows[0].payload;
    const costRows = await client.query('select payload from ace_item_costs');
    const costs = costRows.rows.map((r) => r.payload);

    for (const date of toIngest) {
      try {
        const orders = await toast.ordersForBusinessDate(date);
        // raw snapshot (CI artifact / local dir; never public)
        const rawDir = path.join(ROOT, 'data', 'raw', date);
        fs.mkdirSync(rawDir, { recursive: true });
        fs.writeFileSync(path.join(rawDir, 'orders.json.gz'), zlib.gzipSync(JSON.stringify(orders)));
        const { selections, checks } = normalize(orders, date);
        results[date] = await upsertDate(client, date, checks, selections, reference, costs);
        console.log(`${date}: ${orders.length} orders → ${results[date].checks} checks, ${results[date].selections} selections, ${results[date].metricRows} metric rows`);
      } catch (e) {
        failed = `${date}: ${e.message}`;
        console.error(`FAILED ${failed}`);
        break;
      }
    }
  } catch (e) {
    // Toast auth, reference lookup and connection failures used to escape
    // before the run row was finalized, leaving it stuck on "running" and the
    // dashboard unable to distinguish a failure from an update in progress.
    failed = failed ?? `setup: ${e.message}`;
    console.error(`FAILED ${failed}`);
  }

  try {
    await client.query(
      `update ace_ingestion_runs set payload = payload || $2 where run_id = $1`,
      [runId, JSON.stringify({ status: failed ? 'failed' : 'success', error: failed, results, finishedAt: new Date().toISOString() })]);
  } finally {
    await client.end();
  }
  if (failed) process.exit(1);
  console.log('Nightly ingestion complete.');
}

// Only run when executed directly — the date and secret helpers above are
// imported by the unit tests, which must not open a database connection.
if (process.argv[1]?.endsWith('nightly.mjs')) {
  main().catch((e) => { console.error('NIGHTLY FAILED:', e.message); process.exit(1); });
}
