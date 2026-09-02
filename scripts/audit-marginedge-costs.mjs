#!/usr/bin/env node
// Toast ↔ MarginEdge cost reconciliation audit.
//
//   node scripts/audit-marginedge-costs.mjs                 # local data/live snapshot
//   node scripts/audit-marginedge-costs.mjs --from-db       # live Supabase selections
//   node scripts/audit-marginedge-costs.mjs --offline       # skip MarginEdge, Toast side only
//
// Writes:
//   audit/marginedge_reconciliation.json   machine-readable artifact
//   docs/MARGINEDGE_COST_AUDIT.md          is maintained by hand from this output
//
// Contains no credentials and no guest PII — Toast item names, quantities and
// purchase prices only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  filterAyceProgram, classifySelection, buildCostIndex, resolveCost,
} from '../src/food-cost-engine.mjs';
import { ruleCostRecords, normalizeName } from '../src/cost-rules.mjs';
import { reconcileItem, STATUS, FOOD_CATEGORY_TYPES } from '../src/marginedge-cost.mjs';
import { clientFromEnv, indexProducts, loadDotEnv, sanitizeError } from './lib/marginedge-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LIVE = path.join(ROOT, 'data', 'live');

const round = (n, d = 4) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

/* -------------------------------------------------------------- Toast side -- */
/** Every distinct genuine cost-bearing AYCE item, with quantity and the cost
 *  ACE resolves today. Modifiers, drinks and entitlements are excluded by the
 *  existing engine rules — this audit does not redefine the tracked universe. */
export function collectToastItems({ selectionsByDate, checksByDate, reference, costRecords }) {
  const index = buildCostIndex([...costRecords, ...ruleCostRecords()]);
  const agg = new Map();
  for (const date of Object.keys(selectionsByDate).sort()) {
    const ayce = filterAyceProgram(selectionsByDate[date], checksByDate[date] ?? [], reference);
    for (const s of ayce.selections) {
      if (classifySelection(s) !== 'item') continue;
      const norm = normalizeName(s.itemName);
      const key = s.itemGuid ? `guid:${s.itemGuid}` : `name:${norm}`;
      if (!agg.has(key)) {
        agg.set(key, {
          toastItemGuid: s.itemGuid ?? null,
          toastItemName: s.itemName ?? '(unnamed)',
          normalizedName: norm,
          quantityObserved: 0, datesObserved: new Set(),
          aceCost: null, aceCostSource: null, aceVerification: null, aceTier: null, aceMatchMethod: null,
        });
      }
      const a = agg.get(key);
      a.quantityObserved += s.quantity ?? 0;
      a.datesObserved.add(date);
      if (a.aceCost === null) {
        const r = resolveCost(s, index, s.businessDate);
        if (r.record) {
          a.aceCost = r.record.costPerUnit;
          a.aceCostSource = r.record.source;
          a.aceVerification = r.record.verification;
          a.aceTier = r.tier;
          a.aceMatchMethod = r.method;
        }
      }
    }
  }
  return [...agg.values()]
    .map((a) => ({ ...a, datesObserved: a.datesObserved.size }))
    .sort((x, y) => y.quantityObserved - x.quantityObserved);
}

function loadLocalSnapshot() {
  const reference = JSON.parse(fs.readFileSync(path.join(LIVE, 'reference.json'), 'utf8'));
  const rawCosts = JSON.parse(fs.readFileSync(path.join(LIVE, 'item_costs.json'), 'utf8'));
  const costRecords = (Array.isArray(rawCosts) ? rawCosts : rawCosts.records ?? rawCosts.rows ?? [])
    .map((r) => r.payload ?? r);
  const selectionsByDate = {}, checksByDate = {};
  for (const f of fs.readdirSync(LIVE)) {
    const m = /^(selections|checks)_(\d{8})\.json$/.exec(f);
    if (!m) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(LIVE, f), 'utf8'));
    const rows = (Array.isArray(parsed) ? parsed : parsed.rows ?? []).map((r) => r.payload ?? r);
    (m[1] === 'selections' ? selectionsByDate : checksByDate)[m[2]] = rows;
  }
  return { reference, costRecords, selectionsByDate, checksByDate };
}

async function loadDbSnapshot() {
  const pg = (await import('pg')).default;
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const ref = await client.query('select payload from ace_reference where id = 1');
    const costs = await client.query('select payload from ace_item_costs');
    const sel = await client.query('select business_date, payload from ace_selections');
    const chk = await client.query('select business_date, payload from ace_checks');
    const selectionsByDate = {}, checksByDate = {};
    for (const r of sel.rows) (selectionsByDate[r.business_date] ??= []).push(r.payload);
    for (const r of chk.rows) (checksByDate[r.business_date] ??= []).push(r.payload);
    return {
      reference: ref.rows[0]?.payload ?? { salesCategories: [] },
      costRecords: costs.rows.map((r) => r.payload),
      selectionsByDate, checksByDate,
    };
  } finally {
    await client.end();
  }
}

async function loadMappings() {
  if (!process.env.SUPABASE_DB_URL) return [];
  try {
    const pg = (await import('pg')).default;
    const client = new pg.Client({
      connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      const r = await client.query('select id, payload from ace_marginedge_mappings');
      return r.rows.map((x) => ({ ...x.payload, id: x.id }));
    } finally {
      await client.end();
    }
  } catch {
    return [];   // the mapping table may not exist yet; audit still runs
  }
}

/* ------------------------------------------------------- MarginEdge quality -- */
export function productQualityFlags(products) {
  const food = products.filter((p) => p.isFood);
  const zeroPriced = food.filter((p) => p.latestPrice === 0);
  const nullPriced = food.filter((p) => p.latestPrice == null);
  const opaqueUnit = food.filter((p) => {
    const u = String(p.reportByUnit ?? '').trim().toLowerCase();
    return u === '' || /^(case|box|bushel|pack|other)$/.test(u) || /^\d/.test(u);
  });
  const unmappedToVendorItems = food.filter((p) => p.itemCount === 0);
  const byName = new Map();
  for (const p of food) {
    const k = normalizeName(p.productName);
    (byName.get(k) ?? byName.set(k, []).get(k)).push(p);
  }
  const duplicates = [...byName.entries()].filter(([, v]) => v.length > 1)
    .map(([k, v]) => ({ normalizedName: k, productIds: v.map((p) => p.productId) }));
  return {
    foodProducts: food.length,
    zeroPricedFoodProducts: zeroPriced.map((p) => ({ productId: p.productId, productName: p.productName })),
    nullPricedFoodProducts: nullPriced.map((p) => ({ productId: p.productId, productName: p.productName })),
    opaqueUnitFoodProducts: opaqueUnit.length,
    foodProductsWithNoVendorItems: unmappedToVendorItems.length,
    duplicateFoodProductNames: duplicates,
  };
}

/* --------------------------------------------------------------------- main -- */
async function main() {
  loadDotEnv(ROOT);
  const argv = process.argv.slice(2);
  const fromDb = argv.includes('--from-db');
  const offline = argv.includes('--offline');

  const snap = fromDb ? await loadDbSnapshot() : loadLocalSnapshot();
  const items = collectToastItems(snap);
  const mappings = await loadMappings();
  const mapByGuid = new Map(mappings.filter((m) => m.toastItemGuid).map((m) => [m.toastItemGuid, m]));
  const mapByName = new Map(mappings.map((m) => [normalizeName(m.canonicalName ?? m.toastItemName), m]));

  let products = [], categories = [], unit = null, meError = null;
  if (!offline) {
    try {
      const me = clientFromEnv();
      const units = await me.restaurantUnits();
      unit = units.find((u) => u.id === me.restaurantUnitId) ?? { id: me.restaurantUnitId, name: '(not accessible)' };
      categories = await me.categories();
      products = await me.products({ categories });
    } catch (e) {
      meError = sanitizeError(e.message, process.env.MARGINEDGE_API_KEY);
      console.error(`MarginEdge unavailable — Toast side only: ${meError}`);
    }
  }
  const productIndex = indexProducts(products);

  const rows = items.map((it) => {
    const mapping = (it.toastItemGuid && mapByGuid.get(it.toastItemGuid)) || mapByName.get(it.normalizedName);
    const rec = products.length
      ? reconcileItem({ item: it, mapping, productIndex, products })
      : { status: meError ? 'MARGINEDGE_UNAVAILABLE' : STATUS.NO_MARGINEDGE_PRODUCT, candidates: [], derived: null, notes: meError ?? '' };
    return {
      toastItemGuid: it.toastItemGuid,
      toastItemName: it.toastItemName,
      normalizedName: it.normalizedName,
      quantityObserved: round(it.quantityObserved, 3),
      datesObserved: it.datesObserved,
      aceCost: round(it.aceCost),
      aceCostSource: it.aceCostSource,
      aceVerification: it.aceVerification,
      aceTier: it.aceTier,
      aceMatchMethod: it.aceMatchMethod,
      marginedgeRestaurantUnitId: unit?.id ?? null,
      mappingId: mapping?.id ?? null,
      mappingType: mapping?.mappingType ?? null,
      mappingReviewStatus: mapping?.reviewStatus ?? null,
      portionBasis: mapping?.portionBasis ?? null,
      candidateProducts: rec.candidates,
      proposedCostPerToastUnit: round(rec.derived),
      derivedComponents: rec.components ?? [],
      status: rec.status,
      notes: rec.notes,
    };
  });

  const qty = (f) => round(rows.filter(f).reduce((s, r) => s + r.quantityObserved, 0), 3);
  const totalQty = qty(() => true);
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const qtyByStatus = {};
  for (const r of rows) qtyByStatus[r.status] = round((qtyByStatus[r.status] ?? 0) + r.quantityObserved, 3);
  const qtyByAceTier = {};
  for (const r of rows) {
    const k = r.aceTier ?? 'uncosted';
    qtyByAceTier[k] = round((qtyByAceTier[k] ?? 0) + r.quantityObserved, 3);
  }

  const verifiedStatuses = new Set([STATUS.EXACT_CONFIRMED_MAPPING, STATUS.VALID_PORTION_CONVERSION]);
  const artifact = {
    generatedFor: 'Chasin\' Tails — CT: Founders Row, Falls Church (CTFC)',
    toastRestaurantGuid: process.env.TOAST_RESTAURANT_GUID ?? 'e574444c-c511-4468-ab89-93d0abbec72b',
    marginedge: {
      restaurantUnitId: unit?.id ?? null,
      restaurantUnitName: unit?.name ?? null,
      productsFetched: products.length,
      foodCategoryTypes: [...FOOD_CATEGORY_TYPES],
      foodCategories: categories.filter((c) => c.isFood).map((c) => ({ id: c.categoryId, name: c.categoryName })),
      error: meError,
      apiLimitation:
        'The MarginEdge public API exposes no recipe, recipe-ingredient, yield, '
        + 'conversion, plated-recipe-cost or recipe-cost-history endpoints. Plated '
        + 'costs cannot be read from MarginEdge; only ingredient prices can.',
    },
    summary: {
      datesCovered: Object.keys(snap.selectionsByDate).length,
      distinctCostBearingItems: rows.length,
      totalCostBearingQuantity: totalQty,
      itemsByStatus: byStatus,
      quantityByStatus: qtyByStatus,
      quantityByCurrentAceTier: qtyByAceTier,
      itemsWithNoAceCost: rows.filter((r) => r.aceCost == null).length,
      quantityWithNoAceCost: qty((r) => r.aceCost == null),
      roughOrFallbackItems: rows.filter((r) => ['rough_estimate', 'fallback_2'].includes(r.aceTier)).length,
      roughOrFallbackQuantity: qty((r) => ['rough_estimate', 'fallback_2'].includes(r.aceTier)),
      chefConfirmedItems: rows.filter((r) => r.aceTier === 'confirmed').length,
      verifiedMarginedgeItems: rows.filter((r) => verifiedStatuses.has(r.status)).length,
      verifiedMarginedgeQuantity: qty((r) => verifiedStatuses.has(r.status)),
      quantityWeightedVerifiedCoveragePct: totalQty > 0
        ? round((qty((r) => verifiedStatuses.has(r.status)) / totalQty) * 100, 2) : null,
    },
    marginedgeDataQuality: products.length ? productQualityFlags(products) : null,
    items: rows,
  };

  const outDir = path.join(ROOT, 'audit');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'marginedge_reconciliation.json');
  fs.writeFileSync(outFile, `${JSON.stringify(artifact, null, 2)}\n`);

  console.log(JSON.stringify(artifact.summary, null, 2));
  console.log(`\nArtifact written: ${path.relative(ROOT, outFile)}`);
}

if (process.argv[1]?.endsWith('audit-marginedge-costs.mjs')) {
  main().catch((e) => {
    console.error('AUDIT FAILED:', sanitizeError(e.message, process.env.MARGINEDGE_API_KEY));
    process.exit(1);
  });
}
