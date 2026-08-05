// Food-cost classification precedence — one test block per precedence level
// (management brief items A–E), plus coverage recalculation and the
// weighted-mean / median distribution statistics.
import { describe, it, expect } from 'vitest';
import {
  computeFoodCost, classifySelection, resolveCost, buildCostIndex,
  perCheckCostStats, quantile, filterAyceProgram,
} from '../src/food-cost-engine.mjs';
import {
  isModifierName, isDrinkName, portionOverrideFor, ruleCostRecords, costRank,
} from '../src/cost-rules.mjs';

const REF = {
  salesCategories: [{ guid: 'cat-food', name: 'Food' }, { guid: 'cat-na', name: 'NA Beverage' }],
  employees: [{ guid: 'srv-a', name: 'Server A' }],
  tables: [{ guid: 'tbl-1', name: '21' }],
};
const DB_COSTS = [
  { id: 'ent', canonicalName: 'PREMIUM PER PERSON', aliases: [], toastItemGuid: null, costPerUnit: 0, effectiveFrom: '20260601', effectiveTo: null, source: 'manual', verification: 'verified' },
  { id: 'crab', canonicalName: 'Snow Crab (1)', aliases: ['SNOW CRAB (1 Cluster)'], toastItemGuid: null, costPerUnit: 7.5, effectiveFrom: '20260601', effectiveTo: null, source: 'rough_workbook', verification: 'unverified' },
  { id: 'umbrella', canonicalName: 'Sides/Desserts/Sauce', aliases: ['BEIGNETS', 'CAJUN FRIES'], toastItemGuid: null, costPerUnit: 2, effectiveFrom: '20260601', effectiveTo: null, source: 'rough_workbook', verification: 'unverified' },
];
let seq = 0;
const sel = (over = {}) => ({
  businessDate: '20260801', orderGuid: 'o1', checkGuid: 'k1', selectionGuid: `s${++seq}`,
  parentSelectionGuid: null, itemGuid: null, itemName: 'SNOW CRAB (1 Cluster)', quantity: 1,
  gross: 0, discount: 0, net: 0, voided: false, salesCategoryGuid: 'cat-food',
  serverGuid: 'srv-a', tableGuid: 'tbl-1', ...over,
});
const chk = (over = {}) => ({
  businessDate: '20260801', orderGuid: 'o1', checkGuid: 'k1', serverGuid: 'srv-a', tableGuid: 'tbl-1',
  voided: false, amount: 128, checkLevelDiscount: 0, ...over,
});
const ENT = () => sel({ itemName: 'PREMIUM PER PERSON', gross: 100, net: 100, quantity: 2 });

describe('A — modifiers and non-cost signals are never food-cost items', () => {
  it('structural: any selection with a parentSelectionGuid is a modifier', () => {
    expect(classifySelection(sel({ parentSelectionGuid: 'p1', itemName: 'Anything At All' }))).toBe('modifier');
  });
  it('name fallback catches the known modifier names from the brief', () => {
    for (const n of ['Med Well', 'Only Butter Inside', 'Butter Ots', 'Melted Butter',
      'Bday', 'Birthday', 'WD', 'No Potato Extra Corn', 'Medium', 'Well done',
      'No Corn, No Potato', 'Extra Side Sauce Hosp', 'Tray A~', 'All Same Tray~']) {
      expect(isModifierName(n), n).toBe(true);
    }
  });
  it('name fallback never swallows real menu items', () => {
    for (const n of ['SNOW CRAB (1 Cluster)', 'Blackened Salmon', '1 pc crab cake',
      'BEIGNETS', 'Melted Butter Cake', 'Banana Split', 'Lamb Chops']) {
      expect(isModifierName(n), n).toBe(false);
    }
  });
  it('modifiers add no cost, are not missing, and do not reduce coverage', () => {
    const r = computeFoodCost([
      ENT(), sel(),                                             // 1 costed round
      sel({ parentSelectionGuid: 'p', itemName: 'Classic Oh Dang!' }),
      sel({ itemName: 'Melted Butter' }),                        // top-level kitchen note
    ], [chk()], REF, DB_COSTS);
    expect(r.total.foodCostDollars).toBe(7.5);
    expect(r.unmatchedQueue).toHaveLength(0);                    // never in the missing list
    expect(r.total.coverage.qtyPct).toBe(100);                   // out of the denominator
    expect(r.total.excludedModifierQty).toBe(2);
    expect(r.excludedModifiers.map((x) => x.name)).toContain('Melted Butter');
  });
  it('modifiers never receive the $2 fallback', () => {
    const r = computeFoodCost([ENT(), sel({ itemName: 'Bday' })], [chk()], REF, []);
    expect(r.total.foodCostDollars).toBe(0);
  });
});

describe('B — trivial drinks are ignored by the temporary model', () => {
  it('recognizes the soft-drink family', () => {
    for (const n of ['Coke', 'Coke Zero', 'Sprite', 'Sweet Tea', 'Lemonade', 'Fountain Drink', 'Gingerale ', 'Fanta Orange']) {
      expect(isDrinkName(n), n).toBe(true);
    }
    expect(isDrinkName('Lobster Garlic Noodles')).toBe(false);
  });
  it('drinks add no cost, no missing entry, no coverage reduction — even when miscategorized as Food', () => {
    const r = computeFoodCost([
      ENT(), sel(),
      sel({ itemName: 'Lemonade', salesCategoryGuid: 'cat-food' }),  // Toast miscategorization
      sel({ itemName: 'Coke Zero', salesCategoryGuid: 'cat-food' }),
    ], [chk()], REF, DB_COSTS);
    expect(r.total.foodCostDollars).toBe(7.5);
    expect(r.unmatchedQueue).toHaveLength(0);
    expect(r.total.coverage.qtyPct).toBe(100);
    expect(r.total.excludedDrinkQty).toBe(2);
  });
});

describe('C — explicit portion overrides', () => {
  it('every recognized 1/2-lb shrimp portion costs $2.50 (half of the $5 pound)', () => {
    for (const n of ['EZ__PEEL SHRIMP 1/2LB', 'JUMBO WHITE SHRIMP 1/2LB', 'HEAD ON SHRIMP 1/2LB', 'shrimp 1/2 lb']) {
      const po = portionOverrideFor(n);
      expect(po, n).not.toBeNull();
      expect(po.cost).toBe(2.5);
    }
  });
  it('prawns and full pounds are NOT half-pound shrimp', () => {
    expect(portionOverrideFor('AUSSIE KING PRAWNS (1/2 lb)')).toBeNull();
    expect(portionOverrideFor('EZ__PEEL SHRIMP 1LB')).toBeNull();
  });
  it('every one-piece crab cake costs $4.00', () => {
    for (const n of ['1 pc crab cake', 'Add Crab Cake 1 pc', 'Crab Cake 1pc']) {
      const po = portionOverrideFor(n);
      expect(po, n).not.toBeNull();
      expect(po.cost).toBe(4);
    }
    expect(portionOverrideFor('Crab Cakes (2) w/Corn Relish')).toBeNull();
  });
  it('overrides beat generic aliases and rough records end-to-end', () => {
    const roughShrimp = [{
      id: 'lbs', canonicalName: 'Shrimp lbs', aliases: ['EZ__PEEL SHRIMP 1/2LB'],
      toastItemGuid: null, costPerUnit: 4.85, effectiveFrom: '20260601', effectiveTo: null,
      source: 'rough_workbook', verification: 'unverified',
    }];
    const r = computeFoodCost([ENT(), sel({ itemName: 'EZ__PEEL SHRIMP 1/2LB', quantity: 2 })], [chk()], REF, roughShrimp);
    expect(r.total.foodCostDollars).toBe(5); // 2 × $2.50, not 2 × $4.85
    expect(r.itemDrivers[0].canonicalName).toBe('Shrimp (1/2 lb)');
    expect(r.itemDrivers[0].tier).toBe('override');
  });
  it('a chef-confirmed cost replaces the override (temporary costs are replaceable)', () => {
    const chef = [{
      id: 'chef', canonicalName: 'EZ__PEEL SHRIMP 1/2LB', aliases: [],
      toastItemGuid: null, costPerUnit: 2.8, effectiveFrom: '20260601', effectiveTo: null,
      source: 'chef_confirmed', verification: 'verified',
    }];
    const r = computeFoodCost([ENT(), sel({ itemName: 'EZ__PEEL SHRIMP 1/2LB' })], [chk()], REF, chef);
    expect(r.total.foodCostDollars).toBe(2.8);
    expect(r.itemDrivers[0].tier).toBe('confirmed');
  });
});

describe('D — explicit canonical temporary costs', () => {
  const cases = [
    ['Whole Dang Thang', 10, 'WDT'], ['Crisp Catfish', 3, 'Catfish'],
    ['Crisp Shrimp', 2, 'Shrimp'], ['Gator Bites', 3, 'Gator'],
    ['Blackened Wings', 2, 'Blackened Wings'], ['Chicken Tenders', 3, 'Tenders'],
    ['Fried Shrimp Tacos', 3, 'Shrimp Tacos'], ['Blue Catfish Tacos', 3, 'Catfish Tacos'],
    ['Sriracha Honey Shrimp', 4, 'Honey Shrimp'], ['Crisp Calamari', 4, 'Calamari'],
    ['Blackened Salmon', 6, 'Blackened Salmon'], ['Shrimp Scampi', 4, 'Shrimp Scampi'],
    ['Seafood Gumbo', 6, 'Gumbo'], ['Clam Chowder (Cup)', 2, 'Small Clam Chowder'],
    ['Clam Chowder BOWL (LARGE)', 4, 'Large Clam Chowder'], ['Crab & Spinach Dip', 4, 'Crab Dip'],
  ];
  it.each(cases)('%s → $%d as %s', (name, cost, canonical) => {
    const r = computeFoodCost([ENT(), sel({ itemName: name })], [chk()], REF, []);
    expect(r.total.foodCostDollars).toBe(cost);
    expect(r.itemDrivers[0].canonicalName).toBe(canonical);
    expect(r.itemDrivers[0].tier).toBe('explicit_temp');
  });
  it('generic Shrimp is $2 while 1/2-lb shrimp keeps the $2.50 override', () => {
    const r = computeFoodCost([ENT(), sel({ itemName: 'Crisp Shrimp' }), sel({ itemName: 'JUMBO WHITE SHRIMP 1/2LB' })], [chk()], REF, []);
    expect(r.total.foodCostDollars).toBe(2 + 2.5);
  });
});

describe('E — $2 supplied-menu fallback', () => {
  it('genuine supplied-menu items without explicit costs get $2 under their OWN name', () => {
    const r = computeFoodCost([ENT(), sel({ itemName: 'BEIGNETS' }), sel({ itemName: 'CAJUN FRIES' })], [chk()], REF, DB_COSTS);
    expect(r.total.foodCostDollars).toBe(4);
    const names = r.itemDrivers.map((d) => d.canonicalName);
    expect(names).toContain('Beignets');
    expect(names).toContain('Cajun Fries');
    expect(names).not.toContain('Sides/Desserts/Sauce'); // never buried in the umbrella
    expect(r.itemDrivers.find((d) => d.canonicalName === 'Beignets').tier).toBe('fallback_2');
  });
  it('an explicit cost wins over the fallback for the same item', () => {
    // Blackened Salmon is on the supplied menu AND has an explicit $6 cost
    const r = computeFoodCost([ENT(), sel({ itemName: 'Blackened Salmon' })], [chk()], REF, []);
    expect(r.total.foodCostDollars).toBe(6);
  });
  it('real food outside the supplied menu stays MISSING — never silently $0 or $2', () => {
    const r = computeFoodCost([ENT(), sel({ itemName: 'French Bread' }), sel({ itemName: 'Jumbotron Oyster (AYCE)' })], [chk()], REF, []);
    expect(r.total.foodCostDollars).toBe(0);
    expect(r.unmatchedQueue.map((u) => u.name).sort()).toEqual(['French Bread', 'Jumbotron Oyster (AYCE)']);
    expect(r.total.coverage.qtyPct).toBe(0); // honest coverage
  });
});

describe('precedence ordering is total and stable', () => {
  it('costRank orders chef > override > explicit > rough > fallback > umbrella', () => {
    const rank = (r) => costRank(r);
    expect(rank({ source: 'chef_confirmed' })).toBeLessThan(rank({ source: 'portion_override' }));
    expect(rank({ source: 'portion_override' })).toBeLessThan(rank({ source: 'explicit_temp' }));
    expect(rank({ source: 'explicit_temp' })).toBeLessThan(rank({ source: 'rough_workbook' }));
    expect(rank({ source: 'rough_workbook' })).toBeLessThan(rank({ source: 'menu_fallback' }));
    expect(rank({ source: 'menu_fallback' })).toBeLessThan(rank({ source: 'rough_workbook', canonicalName: 'Sides/Desserts/Sauce' }));
  });
  it('resolveCost surfaces the tier used', () => {
    const index = buildCostIndex([...DB_COSTS, ...ruleCostRecords()]);
    expect(resolveCost(sel({ itemName: 'SNOW CRAB (1 Cluster)' }), index, '20260801').tier).toBe('rough_estimate');
    expect(resolveCost(sel({ itemName: 'BEIGNETS' }), index, '20260801').tier).toBe('fallback_2');
    expect(resolveCost(sel({ itemName: 'PREMIUM PER PERSON' }), index, '20260801').tier).toBe('confirmed');
  });
});

describe('coverage & AYCE scope after exclusions', () => {
  it('coverage denominator holds only genuine cost-bearing rounds', () => {
    const r = computeFoodCost([
      ENT(),                                             // entitlement — out of qty coverage
      sel(),                                             // costed round
      sel({ itemName: 'Medium', parentSelectionGuid: 'p' }), // modifier
      sel({ itemName: 'Sweet Tea' }),                    // drink
      sel({ itemName: 'French Bread' }),                 // genuine missing
    ], [chk()], REF, DB_COSTS);
    expect(r.total.totalQty).toBe(2);        // round + missing item only
    expect(r.total.matchedQty).toBe(1);
    expect(r.total.coverage.qtyPct).toBe(50); // honest: modifiers can no longer mask gaps
  });
  it('the full AYCE pipeline agrees: entitlement revenue ÷ round cost', () => {
    const selections = [ENT(), sel({ quantity: 4 }), sel({ itemName: 'Classic Oh Dang!', parentSelectionGuid: 'p' })];
    const scope = filterAyceProgram(selections, [chk()], REF);
    const fc = computeFoodCost(scope.selections, scope.checks, REF, DB_COSTS);
    expect(scope.entitlementNet).toBe(100);
    expect(fc.total.foodCostDollars).toBe(30);            // 4 × 7.50
    expect(fc.total.eligibleNetFoodRevenue).toBe(100);
    expect(fc.total.foodCostPct).toBeCloseTo(30);
  });
});

describe('weighted mean vs median (distribution statistics)', () => {
  it('weighted mean is Σcost/Σrevenue; median is the typical check', () => {
    const buckets = [
      { foodCostDollars: 10, eligibleNetFoodRevenue: 100 },   // 10%
      { foodCostDollars: 12, eligibleNetFoodRevenue: 100 },   // 12%
      { foodCostDollars: 14, eligibleNetFoodRevenue: 100 },   // 14%
      { foodCostDollars: 300, eligibleNetFoodRevenue: 300 },  // 100% whale
    ];
    const s = perCheckCostStats(buckets);
    expect(s.weightedPct).toBeCloseTo((336 / 600) * 100);     // 56% — financial impact
    expect(s.medianPct).toBeCloseTo(13);                      // typical table
    expect(s.samples).toBe(4);
    expect(s.outlierCount).toBe(1);                           // the whale is flagged
    expect(s.outlierAbovePct).toBeLessThan(100);
  });
  it('checks with no revenue are excluded from the distribution but not the weighted mean', () => {
    const s = perCheckCostStats([
      { foodCostDollars: 5, eligibleNetFoodRevenue: 0 },
      { foodCostDollars: 10, eligibleNetFoodRevenue: 100 },
    ]);
    expect(s.samples).toBe(1);
    expect(s.weightedPct).toBeCloseTo(15);
  });
  it('quantile interpolates linearly', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNull();
  });
});
