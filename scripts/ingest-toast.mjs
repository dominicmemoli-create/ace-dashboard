#!/usr/bin/env node
// Toast ingestion (ToastApiAdapter) — pulls order + item-selection detail for one or
// more business dates and writes:
//   data/raw/<date>/orders.json.gz   raw immutable source payloads (GITIGNORED — may
//                                    contain guest PII; kept on the operator machine only)
//   data/live/reference.json         employees / revenue centers / service areas /
//                                    dining options / tables / sales categories (names + GUIDs)
//   data/live/selections_<date>.json normalized, PII-free item-selection rows
//   data/live/checks_<date>.json     normalized, PII-free check rows
//   data/live/ingestion_runs.json    append-only run log (counts, warnings, freshness)
//
// Usage:
//   node scripts/ingest-toast.mjs 20260731 20260801 20260802 [--allow-desktop-config]
//
// Idempotent: re-running a date fully replaces that date's normalized files and
// raw snapshot; nothing is ever double-counted because files are keyed by date
// and rows are keyed by stable Toast GUIDs.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ToastClient, resolveCredentials, loadDotEnv } from './lib/toast-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RESTAURANT_GUID = process.env.TOAST_RESTAURANT_GUID || 'e574444c-c511-4468-ab89-93d0abbec72b'; // Chasin' Tails — Founders Row, Falls Church

const args = process.argv.slice(2);
const allowDesktopConfig = args.includes('--allow-desktop-config');
const dates = args.filter((a) => /^\d{8}$/.test(a));
if (dates.length === 0) {
  console.error('Usage: node scripts/ingest-toast.mjs <YYYYMMDD> [...more dates] [--allow-desktop-config]');
  process.exit(1);
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}

/** Flatten a Toast selection (and nested modifier selections) into PII-free rows. */
function flattenSelection(sel, ctx, parentGuid = null, out = []) {
  const selDiscount = sum(sel.appliedDiscounts ?? [], (d) => d.discountAmount);
  const gross = sel.preDiscountPrice ?? sel.price ?? 0;
  out.push({
    businessDate: ctx.businessDate,
    orderGuid: ctx.orderGuid,
    checkGuid: ctx.checkGuid,
    selectionGuid: sel.guid,
    parentSelectionGuid: parentGuid,
    itemGuid: sel.item?.guid ?? null,
    itemGroupGuid: sel.itemGroup?.guid ?? null,
    itemName: sel.displayName ?? null,
    quantity: sel.quantity ?? 0,
    gross: round2(gross),
    discount: round2(selDiscount),
    net: round2((sel.price ?? gross) - 0), // Toast `price` is post-modifier; discounts recorded separately
    preDiscountPrice: round2(gross),
    voided: Boolean(sel.voided),
    salesCategoryGuid: sel.salesCategory?.guid ?? ctx.parentSalesCategoryGuid ?? null,
    diningOptionGuid: sel.diningOption?.guid ?? ctx.diningOptionGuid,
    selectionType: sel.selectionType ?? null,
    // attribution: selection-level owner is not exposed by orders API; check/order server recorded below
    serverGuid: ctx.serverGuid,
    tableGuid: ctx.tableGuid,
    revenueCenterGuid: ctx.revenueCenterGuid,
    serviceAreaGuid: ctx.serviceAreaGuid,
  });
  const childCtx = { ...ctx, parentSalesCategoryGuid: sel.salesCategory?.guid ?? ctx.parentSalesCategoryGuid ?? null };
  for (const mod of sel.modifiers ?? []) flattenSelection(mod, childCtx, sel.guid, out);
  return out;
}

async function main() {
  loadDotEnv(ROOT);
  const creds = resolveCredentials({ allowDesktopConfig });
  const client = new ToastClient({ ...creds, restaurantGuid: RESTAURANT_GUID });

  console.log('Authenticating with Toast…');
  await client.authenticate();

  // Reference data (names for GUIDs) — safe to publish, no guest data.
  console.log('Fetching reference data…');
  const [employees, revenueCenters, serviceAreas, diningOptions, tables, salesCategories] = await Promise.all([
    client.employees(),
    client.revenueCenters(),
    client.serviceAreas(),
    client.diningOptions(),
    client.tables(),
    client.get('/config/v2/salesCategories', { pageSize: 200 }),
  ]);
  const reference = {
    generatedAt: new Date().toISOString(),
    restaurantGuid: RESTAURANT_GUID,
    employees: (employees ?? []).map((e) => ({
      guid: e.guid,
      name: [e.firstName, e.lastName].filter(Boolean).join(' ') || e.externalEmployeeId || e.guid,
      deleted: Boolean(e.deleted),
    })),
    revenueCenters: (revenueCenters ?? []).map((r) => ({ guid: r.guid, name: r.name })),
    serviceAreas: (serviceAreas ?? []).map((r) => ({ guid: r.guid, name: r.name })),
    diningOptions: (diningOptions ?? []).map((r) => ({ guid: r.guid, name: r.name, behavior: r.behavior })),
    tables: (tables ?? []).map((t) => ({ guid: t.guid, name: t.name })),
    salesCategories: (salesCategories ?? []).map((s) => ({ guid: s.guid, name: s.name })),
  };
  writeJson(path.join(ROOT, 'data', 'live', 'reference.json'), reference);

  const runLogPath = path.join(ROOT, 'data', 'live', 'ingestion_runs.json');
  const runLog = fs.existsSync(runLogPath) ? JSON.parse(fs.readFileSync(runLogPath, 'utf8')) : [];

  for (const businessDate of dates) {
    const run = {
      runId: `toast-${businessDate}-${Date.now()}`,
      source: 'toast_api',
      adapter: 'ToastApiAdapter',
      businessDate,
      startedAt: new Date().toISOString(),
      status: 'running',
      warnings: [],
    };
    try {
      console.log(`Pulling orders for ${businessDate}…`);
      const orders = await client.ordersForBusinessDate(businessDate);
      console.log(`  ${orders.length} orders`);

      // Raw immutable snapshot (local only — data/raw is gitignored; may contain guest PII).
      const rawPath = path.join(ROOT, 'data', 'raw', businessDate, 'orders.json.gz');
      fs.mkdirSync(path.dirname(rawPath), { recursive: true });
      fs.writeFileSync(rawPath, zlib.gzipSync(JSON.stringify(orders)));

      const selections = [];
      const checks = [];
      for (const order of orders) {
        const serverGuid = order.server?.guid ?? null;
        for (const check of order.checks ?? []) {
          const ctx = {
            businessDate,
            orderGuid: order.guid,
            checkGuid: check.guid,
            serverGuid,
            tableGuid: order.table?.guid ?? null, // GUID; resolve display name via reference.tables
            revenueCenterGuid: order.revenueCenter?.guid ?? null,
            serviceAreaGuid: order.serviceArea?.guid ?? null,
            diningOptionGuid: order.diningOption?.guid ?? null,
          };
          const checkDiscount = sum(check.appliedDiscounts ?? [], (d) => d.discountAmount);
          const tips = sum(check.payments ?? [], (p) => p.tipAmount);
          const serviceCharges = sum(check.appliedServiceCharges ?? [], (s) => s.chargeAmount);
          checks.push({
            businessDate,
            orderGuid: order.guid,
            checkGuid: check.guid,
            serverGuid,
            tableGuid: ctx.tableGuid,
            revenueCenterGuid: ctx.revenueCenterGuid,
            serviceAreaGuid: ctx.serviceAreaGuid,
            diningOptionGuid: ctx.diningOptionGuid,
            openedDate: check.openedDate ?? order.openedDate ?? null,
            closedDate: check.closedDate ?? order.closedDate ?? null,
            numberOfGuests: order.numberOfGuests ?? null,
            voided: Boolean(check.voided || order.voided),
            amount: round2(check.amount ?? 0),               // net sales excl. tax
            taxAmount: round2(check.taxAmount ?? 0),
            totalAmount: round2(check.totalAmount ?? 0),
            checkLevelDiscount: round2(checkDiscount),
            tips: round2(tips),
            serviceCharges: round2(serviceCharges),
          });
          if (check.voided || order.voided) continue; // voided checks contribute no selections
          for (const sel of check.selections ?? []) flattenSelection(sel, ctx, null, selections);
        }
      }

      writeJson(path.join(ROOT, 'data', 'live', `selections_${businessDate}.json`), selections);
      writeJson(path.join(ROOT, 'data', 'live', `checks_${businessDate}.json`), checks);

      run.status = 'success';
      run.orders = orders.length;
      run.checks = checks.length;
      run.selections = selections.length;
      run.voidedChecks = checks.filter((c) => c.voided).length;
    } catch (err) {
      run.status = 'failed';
      run.error = String(err?.message ?? err);
      console.error(`FAILED ${businessDate}: ${run.error}`);
      // Previous valid normalized files for this date are left untouched on failure.
    }
    run.finishedAt = new Date().toISOString();
    runLog.push(run);
    writeJson(runLogPath, runLog);
  }

  // Manifest of available dates for the frontend data layer.
  const liveDir = path.join(ROOT, 'data', 'live');
  const available = fs.readdirSync(liveDir)
    .map((f) => /^selections_(\d{8})\.json$/.exec(f)?.[1])
    .filter(Boolean)
    .sort();
  writeJson(path.join(liveDir, 'manifest.json'), {
    restaurantGuid: RESTAURANT_GUID,
    dates: available,
    lastToastSync: new Date().toISOString(),
  });
  console.log('Done. Dates available:', available.join(', '));
}

main().catch((e) => { console.error(e); process.exit(1); });
