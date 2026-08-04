// Food-cost calculation engine — pure functions, no I/O.
// Consumed by the dashboard (browser ESM) and the vitest suite (node ESM).
//
// Definitions (see docs/METRICS.md):
//   extended_food_cost      = nonvoided_quantity × effective_cost_per_portion
//   food_cost_dollars       = Σ extended_food_cost over matched food selections
//   eligible_net_food_revenue = Σ (gross − discounts) over nonvoided FOOD-category
//                               selections, excluding gift cards. Tax, tips and
//                               service charges are excluded structurally (they are
//                               not selections). Check-level discounts are prorated
//                               across that check's food selections by gross value.
//   food_cost_pct           = food_cost_dollars / eligible_net_food_revenue
//   baseline (weighted)     = Σ baseline cost / Σ baseline eligible revenue
//                             (NEVER an average of per-server percentages)
//
// Matching hierarchy per selection: (1) Toast item GUID → (2) configured alias →
// (3) normalized item name → (4) unmatched review queue. Unmatched selections are
// NEVER assigned a $0 cost; they are excluded from cost dollars and reported in
// coverage so the shortfall is visible.

export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const DEFAULT_THRESHOLDS = {
  watchPts: 10,      // percentage points over baseline
  criticalPts: 15,
  minChecks: 5,      // minimum sample before a flag is shown
  minNetFoodSales: 500,
  minCoveragePct: 60, // below this cost-mapping coverage a comparison is not fair
};

/** True when a cost record is effective on the given YYYYMMDD business date. */
export function isEffective(record, businessDate) {
  const d = String(businessDate);
  if (record.effectiveFrom && d < String(record.effectiveFrom)) return false;
  if (record.effectiveTo && d > String(record.effectiveTo)) return false;
  return true;
}

/** Build lookup indexes over the cost master. */
export function buildCostIndex(costRecords) {
  const byGuid = new Map();
  const byName = new Map(); // normalized canonical name AND normalized aliases
  for (const rec of costRecords) {
    if (rec.toastItemGuid) {
      if (!byGuid.has(rec.toastItemGuid)) byGuid.set(rec.toastItemGuid, []);
      byGuid.get(rec.toastItemGuid).push(rec);
    }
    const names = [rec.canonicalName, ...(rec.aliases ?? [])];
    for (const n of names) {
      const key = normalizeName(n);
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(rec);
    }
  }
  return { byGuid, byName };
}

function pickEffective(records, businessDate) {
  const eligible = records.filter((r) => isEffective(r, businessDate));
  if (eligible.length === 0) return null;
  // Latest effectiveFrom wins.
  return eligible.sort((a, b) => String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)))[0];
}

/**
 * Resolve the effective cost record for one selection.
 * Returns { record, method } — method ∈ 'guid' | 'alias' | 'name' | null.
 * 'alias' vs 'name': alias = the matched key differs from the record's canonical
 * name (i.e. a configured alternate); name = canonical-name equality.
 */
export function resolveCost(selection, index, businessDate) {
  if (selection.itemGuid && index.byGuid.has(selection.itemGuid)) {
    const rec = pickEffective(index.byGuid.get(selection.itemGuid), businessDate);
    if (rec) return { record: rec, method: 'guid' };
  }
  const key = normalizeName(selection.itemName);
  if (key && index.byName.has(key)) {
    const rec = pickEffective(index.byName.get(key), businessDate);
    if (rec) {
      const method = normalizeName(rec.canonicalName) === key ? 'name' : 'alias';
      return { record: rec, method };
    }
  }
  return { record: null, method: null };
}

const GIFT_CARD_RE = /gift ?card|e-?gift/i;

/** A selection is part of eligible net FOOD revenue when it is non-voided,
 * categorized Food, and not a gift card. */
export function isEligibleFoodSelection(sel, catNames) {
  if (sel.voided) return false;
  if (GIFT_CARD_RE.test(sel.itemName ?? '')) return false;
  const cat = catNames.get(sel.salesCategoryGuid);
  return cat === 'Food';
}

/** Net revenue for a selection: gross minus selection-level discounts. */
export function selectionNet(sel) {
  const gross = sel.gross ?? 0;
  const disc = sel.discount ?? 0;
  return Math.max(0, gross - disc);
}

/**
 * Core aggregation.
 * @param selections normalized selection rows (possibly multiple dates)
 * @param checks     normalized check rows (for check-level discounts + drilldown)
 * @param reference  { salesCategories, employees, tables } from ingestion
 * @param costRecords item-cost master
 * @param opts { thresholds }
 */
export function computeFoodCost(selections, checks, reference, costRecords, opts = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const index = buildCostIndex(costRecords);
  const catNames = new Map((reference.salesCategories ?? []).map((c) => [c.guid, c.name]));

  // Check-level discount proration: discount applies to the whole check; spread it
  // across the check's eligible food selections proportionally to gross.
  const checkByGuid = new Map(checks.map((c) => [c.checkGuid, c]));
  const foodGrossByCheck = new Map();
  for (const s of selections) {
    if (!isEligibleFoodSelection(s, catNames)) continue;
    foodGrossByCheck.set(s.checkGuid, (foodGrossByCheck.get(s.checkGuid) ?? 0) + (s.gross ?? 0));
  }

  const perCheck = new Map();   // checkGuid -> accumulator
  const perServer = new Map();  // serverGuid -> accumulator
  const perItem = new Map();    // itemKey -> accumulator (cost drivers)
  const unmatched = new Map();  // normalized name -> {name, qty, net, checks:Set}
  const total = {
    foodCostDollars: 0, eligibleNetFoodRevenue: 0,
    matchedQty: 0, totalQty: 0, matchedNet: 0,
    unmatchedQty: 0, unmatchedNet: 0,
    checksAffectedByUnmatched: new Set(),
  };

  const acc = () => ({ foodCostDollars: 0, eligibleNetFoodRevenue: 0, matchedNet: 0, unmatchedNet: 0, matchedQty: 0, totalQty: 0, checks: new Set() });

  for (const s of selections) {
    if (!isEligibleFoodSelection(s, catNames)) continue;
    const chk = checkByGuid.get(s.checkGuid);
    if (chk?.voided) continue;

    let net = selectionNet(s);
    // prorate check-level discount
    const checkDisc = chk?.checkLevelDiscount ?? 0;
    const checkFoodGross = foodGrossByCheck.get(s.checkGuid) ?? 0;
    if (checkDisc > 0 && checkFoodGross > 0) {
      net = Math.max(0, net - checkDisc * ((s.gross ?? 0) / checkFoodGross));
    }

    const qty = s.quantity ?? 0;
    const { record, method } = resolveCost(s, index, s.businessDate);

    const buckets = [total];
    if (!perServer.has(s.serverGuid)) perServer.set(s.serverGuid, acc());
    buckets.push(perServer.get(s.serverGuid));
    if (!perCheck.has(s.checkGuid)) perCheck.set(s.checkGuid, { ...acc(), serverGuid: s.serverGuid, tableGuid: s.tableGuid, businessDate: s.businessDate, orderGuid: s.orderGuid, unmatchedItems: [] });
    buckets.push(perCheck.get(s.checkGuid));

    for (const b of buckets) {
      b.eligibleNetFoodRevenue += net;
      b.totalQty += qty;
      if (b.checks) b.checks.add(s.checkGuid);
    }

    if (record) {
      const ext = qty * record.costPerUnit;
      for (const b of buckets) {
        b.foodCostDollars += ext;
        b.matchedNet += net;
        b.matchedQty += qty;
      }
      const itemKey = record.canonicalName;
      if (!perItem.has(itemKey)) perItem.set(itemKey, { canonicalName: itemKey, qty: 0, costDollars: 0, net: 0, method, source: record.source, verification: record.verification, costPerUnit: record.costPerUnit });
      const it = perItem.get(itemKey);
      it.qty += qty; it.costDollars += ext; it.net += net;
    } else {
      const key = normalizeName(s.itemName) || '(unnamed)';
      if (!unmatched.has(key)) unmatched.set(key, { name: s.itemName ?? '(unnamed)', qty: 0, net: 0, checks: new Set() });
      const u = unmatched.get(key);
      u.qty += qty; u.net += net; u.checks.add(s.checkGuid);
      total.unmatchedQty += qty; total.unmatchedNet += net;
      total.checksAffectedByUnmatched.add(s.checkGuid);
      const pc = perCheck.get(s.checkGuid);
      pc.unmatchedNet += net;
      pc.unmatchedItems.push(s.itemName);
      perServer.get(s.serverGuid).unmatchedNet += net;
    }
  }

  const coverage = (b) => ({
    qtyPct: b.totalQty > 0 ? (b.matchedQty / b.totalQty) * 100 : null,
    netPct: b.eligibleNetFoodRevenue > 0 ? (b.matchedNet / b.eligibleNetFoodRevenue) * 100 : null,
  });

  return {
    thresholds,
    total: {
      ...total,
      checksAffectedByUnmatched: total.checksAffectedByUnmatched.size,
      foodCostPct: total.eligibleNetFoodRevenue > 0 ? (total.foodCostDollars / total.eligibleNetFoodRevenue) * 100 : null,
      coverage: coverage(total),
      unmatchedItemCount: unmatched.size,
    },
    perServer,
    perCheck,
    itemDrivers: [...perItem.values()].sort((a, b) => b.costDollars - a.costDollars),
    unmatchedQueue: [...unmatched.values()]
      .map((u) => ({ ...u, checks: u.checks.size }))
      .sort((a, b) => b.net - a.net),
  };
}

/** Weighted baseline: Σcost / Σrevenue over the baseline result. */
export function weightedBaselinePct(baselineTotal) {
  if (!baselineTotal || baselineTotal.eligibleNetFoodRevenue <= 0) return null;
  return (baselineTotal.foodCostDollars / baselineTotal.eligibleNetFoodRevenue) * 100;
}

/**
 * Classify a server (or any bucket) against the baseline.
 * Returns { status, variancePts } — status ∈
 *   'normal' | 'watch' | 'critical' | 'insufficient_sample' | 'insufficient_coverage' | 'no_baseline'
 */
export function classifyVariance(bucket, baselinePct, thresholds = DEFAULT_THRESHOLDS) {
  const checksCount = bucket.checks instanceof Set ? bucket.checks.size : (bucket.checks ?? 0);
  if (checksCount < thresholds.minChecks || bucket.eligibleNetFoodRevenue < thresholds.minNetFoodSales) {
    return { status: 'insufficient_sample', variancePts: null };
  }
  const cov = bucket.eligibleNetFoodRevenue > 0 ? (bucket.matchedNet / bucket.eligibleNetFoodRevenue) * 100 : 0;
  if (cov < thresholds.minCoveragePct) {
    return { status: 'insufficient_coverage', variancePts: null };
  }
  if (baselinePct == null) return { status: 'no_baseline', variancePts: null };
  const pct = bucket.eligibleNetFoodRevenue > 0 ? (bucket.foodCostDollars / bucket.eligibleNetFoodRevenue) * 100 : null;
  if (pct == null) return { status: 'insufficient_sample', variancePts: null };
  const variancePts = pct - baselinePct;
  let status = 'normal';
  if (variancePts >= thresholds.criticalPts) status = 'critical';
  else if (variancePts >= thresholds.watchPts) status = 'watch';
  return { status, variancePts };
}

// ---------------------------------------------------------------------------
// Conversion rules (binding — see docs/METRICS.md). Intent values:
//   UNDECIDED | ALC | PREDECIDED_AYCE | UNKNOWN
// Eligible: UNDECIDED or ALC only. Converted: eligible AND qualifying AYCE sales.
// UNKNOWN and PREDECIDED_AYCE are excluded from BOTH numerator and denominator,
// still count toward AYCE mix / revenue / food cost, and never earn commission.
// ---------------------------------------------------------------------------

export function normalizeIntent(raw) {
  const v = String(raw ?? '').trim().toUpperCase();
  if (v === 'UNDECIDED') return 'UNDECIDED';
  if (v === 'ALC' || v === 'A LA CARTE' || v === 'ALACARTE') return 'ALC';
  if (v === 'PREDECIDED_AYCE' || v === 'AYCE' || v === 'PRE-DECIDED AYCE') return 'PREDECIDED_AYCE';
  return 'UNKNOWN';
}

export function isConversionEligible(intent) {
  const n = normalizeIntent(intent);
  return n === 'UNDECIDED' || n === 'ALC';
}

export function conversionStats(tables) {
  let eligible = 0, converted = 0, unknown = 0, predecided = 0;
  for (const t of tables) {
    const intent = normalizeIntent(t.intent);
    if (intent === 'UNKNOWN') { unknown++; continue; }
    if (intent === 'PREDECIDED_AYCE') { predecided++; continue; }
    eligible++;
    if (t.hasAyceSales) converted++;
  }
  return {
    eligibleTables: eligible,
    convertedTables: converted,
    conversionRate: eligible > 0 ? (converted / eligible) * 100 : null,
    unknownIntentTables: unknown,
    predecidedTables: predecided,
  };
}

export function commissionEligible(table) {
  return isConversionEligible(table.intent) && Boolean(table.hasAyceSales) && !table.ambiguousMatch;
}
