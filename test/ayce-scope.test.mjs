import { describe, it, expect } from 'vitest';
import { filterAyceProgram, computeFoodCost, isAyceEntitlement } from '../src/food-cost-engine.mjs';

const REF = {
  salesCategories: [
    { guid: 'cat-food', name: 'Food' },
    { guid: 'cat-liquor', name: 'Liquor' },
  ],
  employees: [], tables: [],
};
const COSTS = [
  { id: 'ent', canonicalName: 'PREMIUM PER PERSON', aliases: [], toastItemGuid: null, costPerUnit: 0, effectiveFrom: '20260601', effectiveTo: null, source: 'manual', verification: 'verified' },
  { id: 'crab', canonicalName: 'Snow Crab (1)', aliases: ['SNOW CRAB (1 Cluster)'], toastItemGuid: null, costPerUnit: 7.5, effectiveFrom: '20260601', effectiveTo: null, source: 'rough_workbook', verification: 'unverified' },
];
const sel = (over = {}) => ({
  businessDate: '20260801', orderGuid: 'o1', checkGuid: 'k1', selectionGuid: Math.random().toString(36).slice(2),
  itemGuid: null, itemName: 'SNOW CRAB (1 Cluster)', quantity: 1, gross: 0, discount: 0, net: 0,
  voided: false, salesCategoryGuid: 'cat-food', serverGuid: 'srv-a', tableGuid: 'tbl-1', ...over,
});
const chk = (over = {}) => ({
  businessDate: '20260801', orderGuid: 'o1', checkGuid: 'k1', serverGuid: 'srv-a', tableGuid: 'tbl-1',
  voided: false, amount: 128, checkLevelDiscount: 0, ...over,
});

const ENT = sel({ itemName: 'PREMIUM PER PERSON', gross: 256, net: 256, quantity: 2, selectionGuid: 'ent1' });

describe('AYCE program scope (the tracked metric)', () => {
  it('recognizes entitlement items incl. kids tiers', () => {
    expect(isAyceEntitlement({ itemName: 'ROYALTY PER PERSON' })).toBe(true);
    expect(isAyceEntitlement({ itemName: 'PREMIUM (kids)' })).toBe(true);
    expect(isAyceEntitlement({ itemName: 'SNOW CRAB (1 Cluster)' })).toBe(false);
  });

  it('keeps only checks that contain an entitlement selection', () => {
    const alcOnly = sel({ checkGuid: 'k2', gross: 30, net: 30, selectionGuid: 'alc1' });
    const r = filterAyceProgram([ENT, sel(), alcOnly], [chk(), chk({ checkGuid: 'k2' })], REF);
    expect(r.checks.map((c) => c.checkGuid)).toEqual(['k1']);
    expect(r.selections.some((s) => s.checkGuid === 'k2')).toBe(false);
  });

  it('includes $0-rung food rounds; excludes priced à-la-carte add-ons on AYCE checks (Royal Feast pricing is out of scope)', () => {
    const pricedAddon = sel({ itemName: 'FULL HOUSE', gross: 200, net: 200, selectionGuid: 'feast' });
    const r = filterAyceProgram([ENT, sel(), pricedAddon], [chk()], REF);
    const names = r.selections.map((s) => s.itemName);
    expect(names).toContain('SNOW CRAB (1 Cluster)');
    expect(names).not.toContain('FULL HOUSE');
  });

  it('excludes $0 non-food (liquor comps) from the round universe', () => {
    const compDrink = sel({ itemName: 'Comp Margarita', salesCategoryGuid: 'cat-liquor', selectionGuid: 'd1' });
    const r = filterAyceProgram([ENT, compDrink], [chk()], REF);
    expect(r.selections.map((s) => s.itemName)).not.toContain('Comp Margarita');
  });

  it('AYCE food-cost % = round cost ÷ entitlement revenue', () => {
    const r = filterAyceProgram([ENT, sel({ quantity: 4 })], [chk()], REF);
    expect(r.entitlementNet).toBe(256);
    expect(r.entitlementCovers).toBe(2);
    const fc = computeFoodCost(r.selections, r.checks, REF, COSTS);
    expect(fc.total.foodCostDollars).toBe(30);            // 4 × 7.50
    expect(fc.total.eligibleNetFoodRevenue).toBe(256);    // rounds contribute $0 revenue
    expect(fc.total.foodCostPct).toBeCloseTo((30 / 256) * 100);
  });

  it('voided entitlement does not qualify a check; voided rounds are excluded', () => {
    const voidedEnt = sel({ itemName: 'PREMIUM PER PERSON', gross: 128, net: 128, voided: true, checkGuid: 'k3', selectionGuid: 'v1' });
    const r = filterAyceProgram([voidedEnt, sel({ checkGuid: 'k3' })], [chk({ checkGuid: 'k3' })], REF);
    expect(r.checks.length).toBe(0);
    const r2 = filterAyceProgram([ENT, sel({ voided: true })], [chk()], REF);
    expect(r2.selections.filter((s) => !isAyceEntitlement(s)).length).toBe(0);
  });
});
