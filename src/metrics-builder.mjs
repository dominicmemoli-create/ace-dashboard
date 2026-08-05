// Pure per-date aggregate builder — the ONE implementation of the AYCE metric
// rows, shared by the CLI (scripts/build-metrics.mjs, scripts/nightly.mjs) and
// the browser (Food Costs upload recalculates affected dates with this exact
// code before writing them through the protected ace_replace_metrics function).
import {
  computeFoodCost, filterAyceProgram, isIncludedCheck, servicePeriodOf, weekdayOf,
} from './food-cost-engine.mjs';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function buildMetricsForDate(date, selections, checks, reference, costs, ops) {
  const rows = [];
  const itemRows = [];
  for (const period of ['lunch', 'dinner']) {
    const inScope = checks.filter((c) => isIncludedCheck(c, ops) && servicePeriodOf(c, ops) === period);
    if (!inScope.length) continue;
    const guids = new Set(inScope.map((c) => c.checkGuid));
    const sel = selections.filter((s) => guids.has(s.checkGuid));
    const ayce = filterAyceProgram(sel, inScope, reference);
    const fc = computeFoodCost(ayce.selections, ayce.checks, reference, costs);

    // guests are recorded per ORDER (table visit); split checks repeat the
    // value, so count each order once
    const seenOrders = new Set();
    let guests = 0;
    for (const c of inScope) {
      if (seenOrders.has(c.orderGuid)) continue;
      seenOrders.add(c.orderGuid);
      guests += c.numberOfGuests || 0;
    }
    const base = {
      businessDate: date, weekday: weekdayOf(date), period,
      checks: inScope.length,
      visits: seenOrders.size,
      guests,
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
