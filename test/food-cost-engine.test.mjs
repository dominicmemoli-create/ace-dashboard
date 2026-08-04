import { describe, it, expect } from 'vitest';
import {
  buildCostIndex, resolveCost, isEffective, computeFoodCost, weightedBaselinePct,
  classifyVariance, normalizeIntent, isConversionEligible, conversionStats,
  commissionEligible, normalizeName, DEFAULT_THRESHOLDS,
} from '../src/food-cost-engine.mjs';

const REF = {
  salesCategories: [
    { guid: 'cat-food', name: 'Food' },
    { guid: 'cat-liquor', name: 'Liquor' },
    { guid: 'cat-retail', name: 'Retail*' },
  ],
  employees: [{ guid: 'srv-a', name: 'Server A' }, { guid: 'srv-b', name: 'Server B' }],
  tables: [{ guid: 'tbl-1', name: '21' }],
};

const COSTS = [
  {
    id: 'c1', toastItemGuid: 'item-crab', canonicalName: 'Snow Crab (1)',
    aliases: ['SNOW CRAB (1 Cluster)'], costPerUnit: 7.5,
    effectiveFrom: '20260601', effectiveTo: null, source: 'rough_workbook', verification: 'unverified',
  },
  {
    id: 'c2', toastItemGuid: null, canonicalName: 'Lamb Chops',
    aliases: [], costPerUnit: 4,
    effectiveFrom: '20260601', effectiveTo: null, source: 'rough_workbook', verification: 'unverified',
  },
];

const sel = (over = {}) => ({
  businessDate: '20260801', orderGuid: 'o1', checkGuid: 'k1', selectionGuid: Math.random().toString(36).slice(2),
  parentSelectionGuid: null, itemGuid: 'item-crab', itemName: 'SNOW CRAB (1 Cluster)', quantity: 1,
  gross: 20, discount: 0, net: 20, voided: false, salesCategoryGuid: 'cat-food',
  serverGuid: 'srv-a', tableGuid: 'tbl-1', ...over,
});
const chk = (over = {}) => ({
  businessDate: '20260801', orderGuid: 'o1', checkGuid: 'k1', serverGuid: 'srv-a', tableGuid: 'tbl-1',
  voided: false, amount: 20, taxAmount: 2, totalAmount: 22, checkLevelDiscount: 0, tips: 4, serviceCharges: 0,
  numberOfGuests: 2, ...over,
});

describe('cost matching hierarchy', () => {
  const index = buildCostIndex(COSTS);
  it('matches by Toast item GUID first', () => {
    const { record, method } = resolveCost(sel(), index, '20260801');
    expect(method).toBe('guid');
    expect(record.id).toBe('c1');
  });
  it('falls back to configured alias when GUID is absent', () => {
    const { record, method } = resolveCost(sel({ itemGuid: null }), index, '20260801');
    expect(method).toBe('alias');
    expect(record.id).toBe('c1');
  });
  it('falls back to normalized canonical name', () => {
    const { record, method } = resolveCost(sel({ itemGuid: null, itemName: 'lamb  CHOPS!' }), index, '20260801');
    expect(method).toBe('name');
    expect(record.id).toBe('c2');
  });
  it('returns null (review queue) for unknown items — never $0 cost', () => {
    const { record, method } = resolveCost(sel({ itemGuid: null, itemName: 'Mystery Item' }), index, '20260801');
    expect(record).toBeNull();
    expect(method).toBeNull();
  });
});

describe('effective dating', () => {
  const versioned = [
    { ...COSTS[0], id: 'v1', costPerUnit: 7.5, effectiveFrom: '20260601', effectiveTo: '20260809' },
    { ...COSTS[0], id: 'v2', costPerUnit: 8.25, effectiveFrom: '20260810', effectiveTo: null },
  ];
  const index = buildCostIndex(versioned);
  it('uses the historical cost for historical business dates', () => {
    expect(resolveCost(sel(), index, '20260801').record.costPerUnit).toBe(7.5);
  });
  it('uses the new cost from its effective date forward', () => {
    expect(resolveCost(sel(), index, '20260815').record.costPerUnit).toBe(8.25);
  });
  it('isEffective respects both bounds', () => {
    expect(isEffective(versioned[0], '20260531')).toBe(false);
    expect(isEffective(versioned[0], '20260809')).toBe(true);
    expect(isEffective(versioned[0], '20260810')).toBe(false);
  });
});

describe('computeFoodCost core', () => {
  it('extended cost = quantity × effective cost; pct = cost / eligible net food revenue', () => {
    const r = computeFoodCost([sel({ quantity: 2, gross: 40 })], [chk({ amount: 40 })], REF, COSTS);
    expect(r.total.foodCostDollars).toBe(15); // 2 × 7.50
    expect(r.total.eligibleNetFoodRevenue).toBe(40);
    expect(r.total.foodCostPct).toBeCloseTo(37.5);
  });
  it('excludes voided selections', () => {
    const r = computeFoodCost([sel(), sel({ voided: true, selectionGuid: 'x2' })], [chk()], REF, COSTS);
    expect(r.total.foodCostDollars).toBe(7.5);
    expect(r.total.eligibleNetFoodRevenue).toBe(20);
  });
  it('excludes selections on voided checks', () => {
    const r = computeFoodCost([sel()], [chk({ voided: true })], REF, COSTS);
    expect(r.total.eligibleNetFoodRevenue).toBe(0);
  });
  it('excludes non-food categories (liquor) from revenue and cost', () => {
    const r = computeFoodCost([sel(), sel({ selectionGuid: 'x2', salesCategoryGuid: 'cat-liquor', itemName: 'Margarita', itemGuid: null, gross: 15 })], [chk()], REF, COSTS);
    expect(r.total.eligibleNetFoodRevenue).toBe(20);
  });
  it('excludes gift cards', () => {
    const r = computeFoodCost([sel({ itemGuid: null, itemName: 'E-Gift Card', gross: 100 })], [chk()], REF, COSTS);
    expect(r.total.eligibleNetFoodRevenue).toBe(0);
  });
  it('applies selection-level discounts to net revenue', () => {
    const r = computeFoodCost([sel({ gross: 20, discount: 5 })], [chk()], REF, COSTS);
    expect(r.total.eligibleNetFoodRevenue).toBe(15);
  });
  it('prorates check-level discounts across food selections by gross', () => {
    const s1 = sel({ selectionGuid: 's1', gross: 30 });
    const s2 = sel({ selectionGuid: 's2', gross: 10, itemGuid: null, itemName: 'Lamb Chops' });
    const r = computeFoodCost([s1, s2], [chk({ checkLevelDiscount: 8 })], REF, COSTS);
    // 8 spread 30:10 → 6 and 2
    expect(r.total.eligibleNetFoodRevenue).toBeCloseTo(30 - 6 + 10 - 2);
  });
  it('unmatched items are excluded from cost, tracked in the review queue, and never $0-costed', () => {
    const r = computeFoodCost([sel(), sel({ selectionGuid: 'u1', itemGuid: null, itemName: 'Mystery Roll', gross: 12, quantity: 3 })], [chk()], REF, COSTS);
    expect(r.total.foodCostDollars).toBe(7.5); // mystery contributes nothing
    expect(r.total.unmatchedItemCount).toBe(1);
    expect(r.total.unmatchedQty).toBe(3);
    expect(r.total.unmatchedNet).toBe(12);
    expect(r.total.checksAffectedByUnmatched).toBe(1);
    expect(r.unmatchedQueue[0].name).toBe('Mystery Roll');
    // coverage reflects the gap
    expect(r.total.coverage.qtyPct).toBeCloseTo((1 / 4) * 100);
    expect(r.total.coverage.netPct).toBeCloseTo((20 / 32) * 100);
  });
});

describe('weighted baseline', () => {
  it('is Σcost/Σrevenue, not an average of server percentages', () => {
    // Server A: $10 cost / $100 rev = 10%. Server B: $90 cost / $150 rev = 60%.
    // Naive average = 35%. Weighted = 100/250 = 40%.
    const baselineTotal = { foodCostDollars: 100, eligibleNetFoodRevenue: 250 };
    expect(weightedBaselinePct(baselineTotal)).toBeCloseTo(40);
  });
  it('returns null with no baseline revenue', () => {
    expect(weightedBaselinePct({ foodCostDollars: 0, eligibleNetFoodRevenue: 0 })).toBeNull();
  });
});

describe('variance classification', () => {
  const bucket = (pct, revenue = 1000, checks = 10, coverage = 1) => ({
    foodCostDollars: (pct / 100) * revenue,
    eligibleNetFoodRevenue: revenue,
    matchedNet: revenue * coverage,
    checks: new Set(Array.from({ length: checks }, (_, i) => `k${i}`)),
  });
  it('normal within 10 pts of baseline', () => {
    expect(classifyVariance(bucket(38), 30).status).toBe('normal');
  });
  it('watch at 10–14.99 pts over baseline', () => {
    expect(classifyVariance(bucket(41), 30).status).toBe('watch');
    expect(classifyVariance(bucket(44.9), 30).status).toBe('watch');
  });
  it('critical at 15+ pts over baseline', () => {
    expect(classifyVariance(bucket(45), 30).status).toBe('critical');
  });
  it('insufficient sample suppresses flags (check count)', () => {
    expect(classifyVariance(bucket(60, 1000, 3), 30).status).toBe('insufficient_sample');
  });
  it('insufficient sample suppresses flags (net food sales)', () => {
    expect(classifyVariance(bucket(60, 300, 10), 30).status).toBe('insufficient_sample');
  });
  it('insufficient cost coverage suppresses flags', () => {
    expect(classifyVariance(bucket(60, 1000, 10, 0.4), 30).status).toBe('insufficient_coverage');
  });
  it('thresholds are configurable', () => {
    const t = { ...DEFAULT_THRESHOLDS, watchPts: 5, criticalPts: 8 };
    expect(classifyVariance(bucket(36), 30, t).status).toBe('watch');
    expect(classifyVariance(bucket(39), 30, t).status).toBe('critical');
  });
});

describe('binding conversion rules', () => {
  it('normalizes blank/missing/ambiguous intent to UNKNOWN', () => {
    for (const v of ['', null, undefined, 'maybe', '???']) expect(normalizeIntent(v)).toBe('UNKNOWN');
  });
  it('only UNDECIDED and ALC are conversion-eligible', () => {
    expect(isConversionEligible('UNDECIDED')).toBe(true);
    expect(isConversionEligible('ALC')).toBe(true);
    expect(isConversionEligible('PREDECIDED_AYCE')).toBe(false);
    expect(isConversionEligible('UNKNOWN')).toBe(false);
  });
  const tables = [
    { intent: 'UNDECIDED', hasAyceSales: true },   // eligible, converted
    { intent: 'UNDECIDED', hasAyceSales: false },  // eligible
    { intent: 'ALC', hasAyceSales: true },         // eligible, converted
    { intent: 'ALC', hasAyceSales: false },        // eligible
    { intent: 'PREDECIDED_AYCE', hasAyceSales: true }, // excluded both sides
    { intent: 'UNKNOWN', hasAyceSales: true },     // excluded both sides
    { intent: '', hasAyceSales: true },            // → UNKNOWN, excluded
  ];
  const stats = conversionStats(tables);
  it('unknown intent excluded from numerator AND denominator', () => {
    expect(stats.eligibleTables).toBe(4);
    expect(stats.convertedTables).toBe(2);
    expect(stats.unknownIntentTables).toBe(2);
  });
  it('pre-decided AYCE excluded from numerator AND denominator', () => {
    expect(stats.predecidedTables).toBe(1);
  });
  it('conversion rate = converted eligible / all eligible', () => {
    expect(stats.conversionRate).toBeCloseTo(50);
  });
  it('no commission on unknown or pre-decided tables', () => {
    expect(commissionEligible({ intent: 'UNKNOWN', hasAyceSales: true })).toBe(false);
    expect(commissionEligible({ intent: 'PREDECIDED_AYCE', hasAyceSales: true })).toBe(false);
    expect(commissionEligible({ intent: 'UNDECIDED', hasAyceSales: true })).toBe(true);
  });
  it('ambiguous OpenTable matches never earn commission until resolved', () => {
    expect(commissionEligible({ intent: 'UNDECIDED', hasAyceSales: true, ambiguousMatch: true })).toBe(false);
  });
  it('unknown-intent tables still count toward AYCE mix and food cost (engine has no intent filter)', () => {
    // food-cost engine ignores intent entirely — unknown-intent selections flow through
    const r = computeFoodCost([sel()], [chk()], REF, COSTS);
    expect(r.total.eligibleNetFoodRevenue).toBe(20);
  });
});

describe('split checks / table visits', () => {
  it('two checks on one order aggregate once at order (table-visit) level but stay separate per check', () => {
    const s1 = sel({ checkGuid: 'k1' });
    const s2 = sel({ checkGuid: 'k2', selectionGuid: 'z2' });
    const r = computeFoodCost([s1, s2], [chk({ checkGuid: 'k1' }), chk({ checkGuid: 'k2' })], REF, COSTS);
    expect(r.perCheck.size).toBe(2); // check drilldown retains individual checks
    const visits = new Set([...r.perCheck.values()].map((c) => c.orderGuid));
    expect(visits.size).toBe(1);     // both belong to one table visit (same order)
    expect(r.total.foodCostDollars).toBe(15); // counted once each, no duplication
  });
});

describe('name normalization', () => {
  it('collapses case, punctuation and whitespace', () => {
    expect(normalizeName('  SNOW-CRAB   (1 Cluster)! ')).toBe(normalizeName('snow crab 1 cluster'));
  });
});
