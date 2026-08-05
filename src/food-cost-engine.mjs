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
// Classification precedence per selection (src/cost-rules.mjs):
//   A. Toast modifiers / non-cost signals (structural parentSelectionGuid, plus
//      curated name fallback) → EXCLUDED: no cost, no missing-cost entry, out of
//      coverage denominators, never the $2 fallback.
//   B. Trivial drinks → EXCLUDED the same way.
//   C. Explicit portion overrides (1/2-lb shrimp $2.50, 1-pc crab cake $4).
//   D. Explicit canonical temporary costs (WDT $10, Catfish $3, …).
//   E. $2 supplied-menu fallback for genuine menu items without explicit costs.
//   Chef-confirmed costs outrank every temporary rule (C–E).
// Cost lookup routes per record: (1) Toast item GUID → (2) configured alias →
// (3) normalized item name; precedence between records uses costRank(). A real
// food item with no cost stays in the MISSING queue — never silently $0.
import {
  isModifierName, isDrinkName, portionOverrideFor, ruleCostRecords, costRank, costTierOf,
} from './cost-rules.mjs?v=20260805-open-access';

export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classify one selection for the food-cost model.
 * 'modifier' — Toast modifier / preparation note / kitchen batching marker
 * 'drink'    — trivial drink (even when Toast miscategorizes it as Food)
 * 'entitlement' — AYCE per-person entitlement (revenue side, $0 direct cost)
 * 'item'     — genuine cost-bearing food item
 */
export function classifySelection(sel) {
  if (sel.parentSelectionGuid) return 'modifier';        // Toast structural metadata
  if (isModifierName(sel.itemName)) return 'modifier';   // curated name fallback
  if (isDrinkName(sel.itemName)) return 'drink';
  if (isAyceEntitlement(sel)) return 'entitlement';
  return 'item';
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

/**
 * Resolve the effective cost record for one selection using the full
 * precedence model. Returns { record, method, tier } — method ∈ 'guid' |
 * 'alias' | 'name' | 'override' | null. 'alias' vs 'name': alias = the matched
 * key differs from the record's canonical name; name = canonical equality.
 * tier (see costTierOf): 'confirmed' | 'override' | 'explicit_temp' |
 * 'rough_estimate' | 'fallback_2'.
 */
export function resolveCost(selection, index, businessDate) {
  const candidates = [];
  if (selection.itemGuid && index.byGuid.has(selection.itemGuid)) {
    for (const rec of index.byGuid.get(selection.itemGuid)) {
      if (isEffective(rec, businessDate)) candidates.push({ record: rec, method: 'guid' });
    }
  }
  const key = normalizeName(selection.itemName);
  if (key && index.byName.has(key)) {
    for (const rec of index.byName.get(key)) {
      if (!isEffective(rec, businessDate)) continue;
      candidates.push({ record: rec, method: normalizeName(rec.canonicalName) === key ? 'name' : 'alias' });
    }
  }
  const po = portionOverrideFor(selection.itemName);
  if (po) {
    candidates.push({
      record: {
        id: `rule-override-${key.replace(/ /g, '-')}`, toastItemGuid: null,
        canonicalName: po.canonicalName, aliases: [], costPerUnit: po.cost,
        effectiveFrom: '20260101', effectiveTo: null,
        source: 'portion_override', verification: 'unverified',
        notes: 'Explicit portion override — replace via chef upload',
      },
      method: 'override',
    });
  }
  if (!candidates.length) return { record: null, method: null, tier: null };
  const M_RANK = { guid: 0, override: 1, alias: 2, name: 2 };
  candidates.sort((a, b) =>
    (costRank(a.record) - costRank(b.record))
    || (M_RANK[a.method] - M_RANK[b.method])
    || String(b.record.effectiveFrom).localeCompare(String(a.record.effectiveFrom)));
  const best = candidates[0];
  return { record: best.record, method: best.method, tier: costTierOf(best.record) };
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
 * Core aggregation — the ONE canonical food-cost pipeline. The headline, the
 * server metrics, the tables and the drill-downs all flow through here.
 * @param selections normalized selection rows (possibly multiple dates)
 * @param checks     normalized check rows (for check-level discounts + drilldown)
 * @param reference  { salesCategories, employees, tables } from ingestion
 * @param costRecords item-cost master (temporary rule records are merged in)
 * @param opts { thresholds }
 */
export function computeFoodCost(selections, checks, reference, costRecords, opts = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const index = buildCostIndex([...costRecords, ...ruleCostRecords()]);
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
  const excludedMods = new Map();   // normalized name -> {name, qty, kind}
  const excludedDrinks = new Map();
  const total = {
    foodCostDollars: 0, eligibleNetFoodRevenue: 0,
    matchedQty: 0, totalQty: 0, matchedNet: 0,
    unmatchedQty: 0, unmatchedNet: 0,
    entitlementQty: 0,
    excludedModifierQty: 0, excludedDrinkQty: 0,
    checksAffectedByUnmatched: new Set(),
    costByTier: { confirmed: 0, override: 0, explicit_temp: 0, rough_estimate: 0, fallback_2: 0 },
    qtyByTier: { confirmed: 0, override: 0, explicit_temp: 0, rough_estimate: 0, fallback_2: 0 },
  };

  const acc = () => ({
    foodCostDollars: 0, eligibleNetFoodRevenue: 0, matchedNet: 0, unmatchedNet: 0,
    matchedQty: 0, totalQty: 0, excludedModifierQty: 0, excludedDrinkQty: 0, checks: new Set(),
  });

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
    const cls = classifySelection(s);

    const buckets = [total];
    if (!perServer.has(s.serverGuid)) perServer.set(s.serverGuid, acc());
    buckets.push(perServer.get(s.serverGuid));
    if (!perCheck.has(s.checkGuid)) {
      perCheck.set(s.checkGuid, {
        ...acc(), serverGuid: s.serverGuid, tableGuid: s.tableGuid,
        businessDate: s.businessDate, orderGuid: s.orderGuid,
        unmatchedItems: [], excludedItems: [], items: [],
      });
    }
    buckets.push(perCheck.get(s.checkGuid));
    const pc = perCheck.get(s.checkGuid);

    // A/B — excluded modifiers and drinks: no cost, no missing entry, no
    // coverage effect, no revenue (their prices, when any, are à-la-carte
    // add-ons outside the tracked model). Identified per check for drill-downs.
    if (cls === 'modifier' || cls === 'drink') {
      const bag = cls === 'modifier' ? excludedMods : excludedDrinks;
      const key = normalizeName(s.itemName) || '(unnamed)';
      if (!bag.has(key)) bag.set(key, { name: s.itemName ?? '(unnamed)', qty: 0, kind: cls });
      bag.get(key).qty += qty;
      for (const b of buckets) {
        if (cls === 'modifier') b.excludedModifierQty += qty; else b.excludedDrinkQty += qty;
        if (b.checks) b.checks.add(s.checkGuid);
      }
      pc.excludedItems.push({ name: s.itemName, qty, kind: cls });
      continue;
    }

    // Entitlements carry the revenue (and a documented $0 direct cost); they
    // are not "rounds", so they stay out of the qty-coverage denominator.
    if (cls === 'entitlement') {
      for (const b of buckets) {
        b.eligibleNetFoodRevenue += net;
        b.matchedNet += net;
        if (b.checks) b.checks.add(s.checkGuid);
      }
      total.entitlementQty += qty;
      pc.items.push({ name: s.itemName, qty, net, cls: 'entitlement', cost: 0, tier: 'confirmed' });
      continue;
    }

    // Genuine cost-bearing food item.
    const { record, method, tier } = resolveCost(s, index, s.businessDate);
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
      total.costByTier[tier] += ext;
      total.qtyByTier[tier] += qty;
      const itemKey = record.canonicalName;
      if (!perItem.has(itemKey)) perItem.set(itemKey, { canonicalName: itemKey, qty: 0, costDollars: 0, net: 0, method, source: record.source, verification: record.verification, tier, costPerUnit: record.costPerUnit });
      const it = perItem.get(itemKey);
      it.qty += qty; it.costDollars += ext; it.net += net;
      pc.items.push({ name: s.itemName, qty, net, cls: 'item', cost: ext, costPerUnit: record.costPerUnit, canonicalName: record.canonicalName, tier });
    } else {
      const key = normalizeName(s.itemName) || '(unnamed)';
      if (!unmatched.has(key)) unmatched.set(key, { name: s.itemName ?? '(unnamed)', qty: 0, net: 0, checks: new Set() });
      const u = unmatched.get(key);
      u.qty += qty; u.net += net; u.checks.add(s.checkGuid);
      total.unmatchedQty += qty; total.unmatchedNet += net;
      total.checksAffectedByUnmatched.add(s.checkGuid);
      pc.unmatchedNet += net;
      pc.unmatchedItems.push(s.itemName);
      pc.items.push({ name: s.itemName, qty, net, cls: 'missing', cost: null, tier: null });
      perServer.get(s.serverGuid).unmatchedNet += net;
    }
  }

  // Coverage counts genuine cost-bearing items only — modifiers, drinks and
  // entitlements are out of the denominator by construction.
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
      .sort((a, b) => b.net - a.net || b.qty - a.qty),
    excludedModifiers: [...excludedMods.values()].sort((a, b) => b.qty - a.qty),
    excludedDrinks: [...excludedDrinks.values()].sort((a, b) => b.qty - a.qty),
  };
}

/** Weighted baseline: Σcost / Σrevenue over the baseline result. */
export function weightedBaselinePct(baselineTotal) {
  if (!baselineTotal || baselineTotal.eligibleNetFoodRevenue <= 0) return null;
  return (baselineTotal.foodCostDollars / baselineTotal.eligibleNetFoodRevenue) * 100;
}

/** Linear-interpolated quantile of an ASCENDING array. */
export function quantile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

/**
 * Distribution statistics over per-check (or per-table) food-cost buckets.
 * Two DIFFERENT truths, shown together, never substituted for each other:
 *   weightedPct — Σ cost ÷ Σ revenue: the actual financial impact.
 *   medianPct   — the typical check, robust to "whale" tables.
 * Also returns quartiles / IQR and a Tukey outlier threshold (Q3 + 1.5·IQR)
 * so unusually expensive checks can be identified.
 * @param buckets array of { foodCostDollars, eligibleNetFoodRevenue }
 */
export function perCheckCostStats(buckets) {
  let cost = 0, revenue = 0;
  const pcts = [];
  for (const b of buckets ?? []) {
    cost += b.foodCostDollars ?? 0;
    revenue += b.eligibleNetFoodRevenue ?? 0;
    if ((b.eligibleNetFoodRevenue ?? 0) > 0) {
      pcts.push(((b.foodCostDollars ?? 0) / b.eligibleNetFoodRevenue) * 100);
    }
  }
  pcts.sort((a, b) => a - b);
  const q1 = quantile(pcts, 0.25), q3 = quantile(pcts, 0.75);
  const iqr = q1 != null && q3 != null ? q3 - q1 : null;
  const outlierAbove = iqr != null ? q3 + 1.5 * iqr : null;
  return {
    weightedPct: revenue > 0 ? (cost / revenue) * 100 : null,
    medianPct: quantile(pcts, 0.5),
    q1Pct: q1, q3Pct: q3, iqrPct: iqr,
    outlierAbovePct: outlierAbove,
    outlierCount: outlierAbove != null ? pcts.filter((p) => p > outlierAbove).length : 0,
    samples: pcts.length,
  };
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

// ---------------------------------------------------------------------------
// AYCE program scope — the tracked food-cost universe.
// Management tracks ONLY: AYCE tables, and the items rung at $0 as AYCE rounds.
// À-la-carte priced items (including Royal Feast trays sold at menu price) are
// out of scope even when they appear on an AYCE check.
//   AYCE check      = a check containing an AYCE entitlement selection
//   revenue basis   = entitlement net (the per-person AYCE price)
//   cost basis      = zero-priced Food-category selections on AYCE checks
//   ayce_food_cost% = round cost ÷ entitlement net revenue
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Operational scope: included areas, service periods, comparable baselines.
// ---------------------------------------------------------------------------

/** A check is in management scope only when it sits at a table in an
 * allowlisted dining area (dining room / patio). Bar, takeout, delivery and
 * anything without a recognized floor/patio table are excluded. */
export function isIncludedCheck(check, opsConfig) {
  if (!check.tableGuid || check.voided) return false;
  const areas = opsConfig.includedAreas;
  if (check.serviceAreaGuid) return check.serviceAreaGuid in areas.serviceAreaGuids;
  if (check.revenueCenterGuid) return check.revenueCenterGuid in areas.revenueCenterGuids;
  return false;
}

/** Local-time hour in the configured restaurant timezone. */
export function localHour(isoTimestamp, timezone) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false })
    .format(new Date(isoTimestamp));
  return Number(h) % 24;
}

/** 'lunch' before the configured cutoff hour, else 'dinner'. */
export function servicePeriodOf(check, opsConfig) {
  const sp = opsConfig.servicePeriods;
  const ts = check.openedDate ?? check.closedDate;
  if (!ts) return 'dinner';
  return localHour(ts, sp.timezone) < sp.lunchBeforeHour ? 'lunch' : 'dinner';
}

export function weekdayOf(yyyymmdd) {
  const s = String(yyyymmdd);
  return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8))).getUTCDay();
}

/**
 * Comparable baseline dates: for each selected date, the prior `weeks`
 * same-weekday dates that exist in `availableDates`. The selected dates are
 * NEVER part of their own baseline. Returns { dates: sorted unique list,
 * requestedPerDate, foundPerDate } so the UI can disclose partial baselines.
 */
export function comparableBaselineDates(selectedDates, availableDates, weeks = 4) {
  const avail = new Set(availableDates.map(String));
  const selected = new Set(selectedDates.map(String));
  const out = new Set();
  const perDate = {};
  for (const sel of selected) {
    const wanted = [];
    const d = new Date(Date.UTC(+sel.slice(0, 4), +sel.slice(4, 6) - 1, +sel.slice(6, 8)));
    for (let w = 1; w <= weeks; w++) {
      const prior = new Date(d);
      prior.setUTCDate(prior.getUTCDate() - 7 * w);
      const key = prior.toISOString().slice(0, 10).replace(/-/g, '');
      wanted.push(key);
      if (avail.has(key) && !selected.has(key)) out.add(key);
    }
    perDate[sel] = { requested: wanted, found: wanted.filter((k) => avail.has(k) && !selected.has(k)) };
  }
  return { dates: [...out].sort(), perDate };
}

export const AYCE_ENTITLEMENT_RE = /PER PERSON|\(kids\)/i;
const ZERO_NET = 0.01; // rung-at-zero tolerance

export function isAyceEntitlement(sel) {
  return AYCE_ENTITLEMENT_RE.test(sel.itemName ?? '');
}

/**
 * Filter to the AYCE program universe.
 * Returns { selections, checks, entitlementNet, entitlementCovers } where
 * selections = entitlement rows (revenue) + zero-priced Food rounds (cost).
 */
export function filterAyceProgram(selections, checks, reference) {
  const catNames = new Map((reference.salesCategories ?? []).map((c) => [c.guid, c.name]));
  const ayceCheckGuids = new Set(
    selections.filter((s) => !s.voided && isAyceEntitlement(s)).map((s) => s.checkGuid));
  const outChecks = checks.filter((c) => ayceCheckGuids.has(c.checkGuid));
  const outSelections = [];
  let entitlementNet = 0, entitlementCovers = 0;
  for (const s of selections) {
    if (!ayceCheckGuids.has(s.checkGuid)) continue;
    if (s.voided) continue;
    if (isAyceEntitlement(s)) {
      outSelections.push(s);
      entitlementNet += selectionNet(s);
      entitlementCovers += s.quantity ?? 0;
      continue;
    }
    // zero-priced rounds only; à-la-carte priced add-ons are out of tracked scope
    if ((s.net ?? 0) <= ZERO_NET && (s.gross ?? 0) <= ZERO_NET && catNames.get(s.salesCategoryGuid) === 'Food') {
      outSelections.push(s);
    }
  }
  return { selections: outSelections, checks: outChecks, entitlementNet, entitlementCovers };
}
