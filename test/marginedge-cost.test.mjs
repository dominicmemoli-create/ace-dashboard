// MarginEdge cost layer — derivation, safeguards, mapping discipline,
// idempotency and source independence.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  canonicalUnit, convertQuantity, validateMapping, deriveCostPerToastUnit,
  decideCostChange, DEFAULT_GUARDS, candidateProducts, reconcileItem, STATUS,
  nameSimilarity, contentTokens,
} from '../src/marginedge-cost.mjs';
import { costRank, costTierOf } from '../src/cost-rules.mjs';
import { resolveCost, buildCostIndex, computeFoodCost, filterAyceProgram } from '../src/food-cost-engine.mjs';
import { planSync, sourceHashFor, parseArgs, nyToday } from '../scripts/sync-marginedge-costs.mjs';
import { MarginEdgeClient, indexProducts, sanitizeError, missingMarginEdgeSecrets } from '../scripts/lib/marginedge-client.mjs';
import {
  sourceFreshness, marginedgeStatus, costsStatus, systemStatus,
} from '../src/page-update.mjs';

/* ------------------------------------------------------------- fixtures --- */
// Shapes and values taken from the live Falls Church unit (377809302), invoice
// 914942 / Samuels and Son Seafood, 2026-07-03.
const SNOW_CRAB = {
  productId: '828228826', productName: 'Snow Crab Clusters 8/Up',
  latestPrice: 11.5, reportByUnit: 'Pound', isFood: true, itemCount: 4,
  categoryNames: ['Seafood'],
};
const EZ_SHRIMP = {
  productId: '828222605', productName: 'Shrimp 21/25 Quick Peel',
  latestPrice: 5.45, reportByUnit: 'Pound', isFood: true, itemCount: 3,
  categoryNames: ['Seafood'],
};
const LOBSTER_TAIL = {
  productId: '837428186', productName: 'Lobster Tail 6/7 Cold Water',
  latestPrice: 25, reportByUnit: 'Each', isFood: true, itemCount: 1,
  categoryNames: ['Seafood'],
};
const BLUE_CRAB_CASE = {
  productId: '925793217', productName: 'Crabs, Blue #2',
  latestPrice: 190, reportByUnit: 'Case', isFood: true, itemCount: 17,
  categoryNames: ['Seafood'],
};
const PRODUCTS = [SNOW_CRAB, EZ_SHRIMP, LOBSTER_TAIL, BLUE_CRAB_CASE];
const INDEX = indexProducts(PRODUCTS);

const confirmedMapping = (over = {}) => ({
  id: 'memap-snow-crab-2-clusters',
  toastItemGuid: '4ae4697f-1166-4575-84c0-28b24d76ef89',
  canonicalName: 'SNOW CRAB (2 Clusters)',
  marginedgeRestaurantUnitId: 377809302,
  mappingType: 'single_product',
  reviewStatus: 'confirmed',
  portionBasis: '2 clusters × 0.65 lb',
  components: [{ productId: '828228826', quantityPerToastUnit: 1.3, unit: 'lb' }],
  ...over,
});

/* ------------------------------------------------------------------ units -- */
describe('MarginEdge unit handling', () => {
  it('canonicalizes the units MarginEdge actually returns', () => {
    expect(canonicalUnit('Pound')).toBe('lb');
    expect(canonicalUnit('Each')).toBe('each');
    expect(canonicalUnit('Kilogram')).toBe('kg');
    expect(canonicalUnit('Ounce')).toBe('oz');
  });

  it('treats pack and opaque units as unusable rather than guessing', () => {
    // "$190 per Case" says nothing about the cost of one crab.
    for (const u of ['Case', 'Box', 'Bushel', 'Pack', 'Other', '1000 Each', '240 Bottles', '']) {
      expect(canonicalUnit(u)).toBeNull();
    }
  });

  it('converts mass deterministically and refuses mass <-> count', () => {
    expect(convertQuantity(1, 'lb', 'oz')).toBeCloseTo(16, 6);
    expect(convertQuantity(1, 'kg', 'lb')).toBeCloseTo(2.2046226, 5);
    expect(convertQuantity(1, 'each', 'lb')).toBeNull();
    expect(convertQuantity(1, 'lb', 'each')).toBeNull();
  });
});

/* -------------------------------------------------------------- mappings --- */
describe('mapping validation', () => {
  it('accepts a well-formed confirmed mapping', () => {
    expect(validateMapping(confirmedMapping())).toEqual([]);
  });

  it('rejects mappings without an identity, a unit or a positive quantity', () => {
    expect(validateMapping({ marginedgeRestaurantUnitId: 1, components: [] }))
      .toContain('mapping needs a toastItemGuid or a canonicalName');
    expect(validateMapping(confirmedMapping({ marginedgeRestaurantUnitId: null })))
      .toContain('missing marginedgeRestaurantUnitId');
    const bad = confirmedMapping({ components: [{ productId: 'x', quantityPerToastUnit: 0, unit: 'lb' }] });
    expect(validateMapping(bad)).toContain('component 0: quantityPerToastUnit must be > 0');
    const noUnit = confirmedMapping({ components: [{ productId: 'x', quantityPerToastUnit: 1 }] });
    expect(validateMapping(noUnit)).toContain('component 0: missing unit');
  });
});

/* ------------------------------------------------- exact + portion costing -- */
describe('cost derivation', () => {
  it('prices a 1:1 mapping straight off the MarginEdge unit price', () => {
    const m = confirmedMapping({
      canonicalName: 'LOBSTER TAIL (6-7oz)',
      components: [{ productId: '837428186', quantityPerToastUnit: 1, unit: 'each' }],
    });
    const d = deriveCostPerToastUnit(m, INDEX);
    expect(d.problems).toEqual([]);
    expect(d.cost).toBeCloseTo(25, 6);
  });

  it('applies a portion multiplier for multi-portion Toast items', () => {
    // 2 clusters at 0.65 lb each against $11.50/lb.
    expect(deriveCostPerToastUnit(confirmedMapping(), INDEX).cost).toBeCloseTo(14.95, 6);
    // The 1-cluster sibling shares the product, not the multiplier.
    const one = confirmedMapping({
      canonicalName: 'SNOW CRAB (1 Cluster)',
      components: [{ productId: '828228826', quantityPerToastUnit: 0.65, unit: 'lb' }],
    });
    expect(deriveCostPerToastUnit(one, INDEX).cost).toBeCloseTo(7.475, 6);
  });

  it('converts units deterministically when they differ', () => {
    const m = confirmedMapping({
      canonicalName: 'EZ__PEEL SHRIMP 1/2LB',
      components: [{ productId: '828222605', quantityPerToastUnit: 8, unit: 'oz' }],
    });
    expect(deriveCostPerToastUnit(m, INDEX).cost).toBeCloseTo(2.725, 6);
  });

  it('sums multi-ingredient mappings', () => {
    const m = confirmedMapping({
      canonicalName: 'Combo',
      mappingType: 'multi_product',
      components: [
        { productId: '828228826', quantityPerToastUnit: 0.5, unit: 'lb' },
        { productId: '828222605', quantityPerToastUnit: 0.25, unit: 'lb' },
      ],
    });
    expect(deriveCostPerToastUnit(m, INDEX).cost).toBeCloseTo(5.75 + 1.3625, 6);
  });

  it('requires an explicit pack factor for opaque units and never invents one', () => {
    const noFactor = confirmedMapping({
      canonicalName: 'Blue Crabs (AYCE 2)',
      components: [{ productId: '925793217', quantityPerToastUnit: 2, unit: 'each' }],
    });
    const d = deriveCostPerToastUnit(noFactor, INDEX);
    expect(d.cost).toBeNull();
    expect(d.problems.join(' ')).toMatch(/cannot convert MarginEdge unit "Case"/);

    // With the chef-supplied "a #2 case holds 36 crabs", it prices.
    const withFactor = confirmedMapping({
      canonicalName: 'Blue Crabs (AYCE 2)',
      components: [{ productId: '925793217', quantityPerToastUnit: 2, unit: 'each', unitsPerReportByUnit: 36 }],
    });
    expect(deriveCostPerToastUnit(withFactor, INDEX).cost).toBeCloseTo((190 / 36) * 2, 6);
  });

  it('returns no cost at all when any component is unpriceable', () => {
    const m = confirmedMapping({
      mappingType: 'multi_product',
      components: [
        { productId: '828228826', quantityPerToastUnit: 1, unit: 'lb' },
        { productId: 'does-not-exist', quantityPerToastUnit: 1, unit: 'lb' },
      ],
    });
    const d = deriveCostPerToastUnit(m, INDEX);
    // A partial sum would silently understate the plate — refuse instead.
    expect(d.cost).toBeNull();
    expect(d.problems.join(' ')).toMatch(/not found in MarginEdge/);
  });

  it('refuses to treat a $0 or negative MarginEdge price as free food', () => {
    const idx = indexProducts([{ ...SNOW_CRAB, latestPrice: 0 }]);
    const d = deriveCostPerToastUnit(confirmedMapping(), idx);
    expect(d.cost).toBeNull();
    expect(d.problems.join(' ')).toMatch(/refusing to treat as free/);
  });
});

/* ------------------------------------------------------------ safeguards --- */
describe('data-quality safeguards', () => {
  it('inserts when there is no existing cost', () => {
    const d = decideCostChange({ derived: 11.5, current: null, mapping: confirmedMapping() });
    expect(d.action).toBe('insert');
  });

  it('is idempotent for an unchanged source cost', () => {
    const d = decideCostChange({ derived: 11.5, current: 11.5, mapping: confirmedMapping() });
    expect(d.action).toBe('unchanged');
  });

  it('accepts ordinary market movement', () => {
    const d = decideCostChange({ derived: 12.65, current: 11.5, mapping: confirmedMapping() });
    expect(d.action).toBe('insert');
  });

  it('holds an implausible spike and keeps the last trustworthy cost', () => {
    const d = decideCostChange({ derived: 40, current: 11.5, mapping: confirmedMapping() });
    expect(d.action).toBe('hold');
    expect(d.reason).toMatch(/limit \+60%/);
  });

  it('holds an implausible collapse', () => {
    const d = decideCostChange({ derived: 1, current: 11.5, mapping: confirmedMapping() });
    expect(d.action).toBe('hold');
    expect(d.reason).toMatch(/limit −40%/);
  });

  it('never publishes an unexpected $0 over a working cost', () => {
    const d = decideCostChange({ derived: 0, current: 11.5, mapping: confirmedMapping() });
    expect(d.action).toBe('hold');
    expect(d.reason).toMatch(/effectively \$0/);
  });

  it('holds a value above the per-portion sanity ceiling', () => {
    const d = decideCostChange({ derived: 500, current: 11.5, mapping: confirmedMapping() });
    expect(d.action).toBe('hold');
    expect(d.reason).toMatch(/sanity ceiling/);
  });

  it('never replaces a valid cost with null', () => {
    const d = decideCostChange({ derived: null, current: 11.5, mapping: confirmedMapping() });
    expect(d.action).toBe('skip');
    expect(d.cost).toBeNull();
  });

  it('refuses to cost from an unconfirmed mapping however good the number looks', () => {
    for (const status of ['proposed', 'rejected', undefined]) {
      const d = decideCostChange({ derived: 11.5, current: null, mapping: confirmedMapping({ reviewStatus: status }) });
      expect(d.action).toBe('skip');
      expect(d.reason).toMatch(/only confirmed mappings are costed/);
    }
  });
});

/* --------------------------------------------------- candidates, not truth -- */
describe('candidate generation', () => {
  it('suggests plausible ingredients for a Toast item name', () => {
    const c = candidateProducts('SNOW CRAB (2 Clusters)', PRODUCTS);
    expect(c.length).toBeGreaterThan(0);
    expect(c[0].productId).toBe('828228826');
  });

  it('strips portion and program noise before matching', () => {
    expect(contentTokens('AYCE KING CRAB LEG (1 leg)')).not.toContain('ayce');
    expect(contentTokens('EZ__PEEL SHRIMP 1/2LB')).toContain('shrimp');
  });

  it('ignores non-food products entirely', () => {
    const scissors = { productId: '927193343', productName: 'Crab Scissors Seafood Shears', latestPrice: 11.99, reportByUnit: '8 Each', isFood: false };
    const c = candidateProducts('SNOW CRAB (1 Cluster)', [scissors]);
    expect(c).toEqual([]);
  });

  it('reports similar names as needing a portion spec, never as a mapping', () => {
    const rec = reconcileItem({
      item: { toastItemName: 'SNOW CRAB (2 Clusters)' },
      mapping: undefined, productIndex: INDEX, products: PRODUCTS,
    });
    expect(rec.status).toBe(STATUS.NEEDS_PORTION_SPEC);
    expect(rec.derived).toBeNull();     // a name match alone is never a cost
    expect(rec.candidates.length).toBeGreaterThan(0);
  });

  it('classifies a confirmed 1:1 mapping and a portion conversion differently', () => {
    const exact = reconcileItem({
      item: { toastItemName: 'LOBSTER TAIL (6-7oz)' },
      mapping: confirmedMapping({ components: [{ productId: '837428186', quantityPerToastUnit: 1, unit: 'each' }] }),
      productIndex: INDEX, products: PRODUCTS,
    });
    expect(exact.status).toBe(STATUS.EXACT_CONFIRMED_MAPPING);
    const portion = reconcileItem({
      item: { toastItemName: 'SNOW CRAB (2 Clusters)' },
      mapping: confirmedMapping(), productIndex: INDEX, products: PRODUCTS,
    });
    expect(portion.status).toBe(STATUS.VALID_PORTION_CONVERSION);
  });

  it('surfaces an incomplete recipe as INVALID_MARGINEDGE_COST, not as $0', () => {
    const rec = reconcileItem({
      item: { toastItemName: 'Blue Crabs (AYCE 2)' },
      mapping: confirmedMapping({ components: [{ productId: '925793217', quantityPerToastUnit: 2, unit: 'each' }] }),
      productIndex: INDEX, products: PRODUCTS,
    });
    expect(rec.status).toBe(STATUS.INVALID_MARGINEDGE_COST);
    expect(rec.derived).toBeNull();
  });

  it('honours an explicit exclusion', () => {
    const rec = reconcileItem({
      item: { toastItemName: 'Tray A' },
      mapping: { mappingType: 'excluded', notes: 'kitchen batching marker' },
      productIndex: INDEX, products: PRODUCTS,
    });
    expect(rec.status).toBe(STATUS.EXCLUDED_NON_COST_ITEM);
  });

  it('similarity is symmetric and bounded', () => {
    expect(nameSimilarity('snow crab', 'snow crab')).toBe(1);
    expect(nameSimilarity('snow crab', 'lobster tail')).toBe(0);
    expect(nameSimilarity('', 'x')).toBe(0);
  });
});

/* --------------------------------------------------------- cost precedence -- */
describe('cost precedence with MarginEdge in the model', () => {
  const rec = (over) => ({
    id: 'r', canonicalName: 'SNOW CRAB (2 Clusters)', aliases: [], costPerUnit: 1,
    effectiveFrom: '20260901', effectiveTo: null, source: 'rough_workbook',
    verification: 'unverified', ...over,
  });

  it('ranks a verified MarginEdge cost above every temporary rule', () => {
    const me = costRank(rec({ source: 'marginedge', verification: 'verified' }));
    expect(me).toBeLessThan(costRank(rec({ source: 'portion_override' })));
    expect(me).toBeLessThan(costRank(rec({ source: 'explicit_temp' })));
    expect(me).toBeLessThan(costRank(rec({ source: 'rough_workbook' })));
    expect(me).toBeLessThan(costRank(rec({ source: 'menu_fallback' })));
  });

  it('never lets MarginEdge outrank a chef-confirmed cost', () => {
    expect(costRank(rec({ source: 'chef_confirmed', verification: 'verified' })))
      .toBeLessThan(costRank(rec({ source: 'marginedge', verification: 'verified' })));
  });

  it('treats an unverified MarginEdge record as provisional', () => {
    const me = costRank(rec({ source: 'marginedge', verification: 'unverified' }));
    expect(me).toBeGreaterThan(costRank(rec({ source: 'portion_override' })));
    expect(costTierOf(rec({ source: 'marginedge', verification: 'unverified' }))).toBe('rough_estimate');
  });

  it('reports a verified MarginEdge cost as its own tier', () => {
    expect(costTierOf(rec({ source: 'marginedge', verification: 'verified' }))).toBe('marginedge');
  });

  it('a verified MarginEdge record wins resolveCost over the rough workbook', () => {
    const index = buildCostIndex([
      rec({ id: 'rough', costPerUnit: 14.5, source: 'rough_workbook' }),
      rec({ id: 'me', costPerUnit: 14.95, source: 'marginedge', verification: 'verified' }),
    ]);
    const r = resolveCost({ itemName: 'SNOW CRAB (2 Clusters)', itemGuid: null }, index, '20260905');
    expect(r.record.id).toBe('me');
    expect(r.tier).toBe('marginedge');
  });

  it('chef-confirmed still wins after a MarginEdge sync', () => {
    const index = buildCostIndex([
      rec({ id: 'me', costPerUnit: 14.95, source: 'marginedge', verification: 'verified' }),
      rec({ id: 'chef', costPerUnit: 13.25, source: 'chef_confirmed', verification: 'verified' }),
    ]);
    const r = resolveCost({ itemName: 'SNOW CRAB (2 Clusters)', itemGuid: null }, index, '20260905');
    expect(r.record.id).toBe('chef');
  });

  it('effective dating still governs — a future MarginEdge cost is not used early', () => {
    const index = buildCostIndex([
      rec({ id: 'me-future', costPerUnit: 20, source: 'marginedge', verification: 'verified', effectiveFrom: '20261001' }),
      rec({ id: 'me-now', costPerUnit: 14.95, source: 'marginedge', verification: 'verified', effectiveFrom: '20260901' }),
    ]);
    expect(resolveCost({ itemName: 'SNOW CRAB (2 Clusters)' }, index, '20260905').record.id).toBe('me-now');
  });
});

/* ------------------------------------------------------------- sync plan --- */
describe('sync planning and idempotency', () => {
  const openCosts = (over = {}) => new Map([['SNOW CRAB (2 Clusters)', {
    id: 'cost-snow-crab-2-clusters-20260801', canonicalName: 'SNOW CRAB (2 Clusters)',
    costPerUnit: 14.5, effectiveFrom: '20260801', effectiveTo: null,
    source: 'rough_workbook', verification: 'unverified', ...over,
  }]]);

  it('plans one insert that closes the previous open record', () => {
    const plan = planSync({
      mappings: [confirmedMapping()], products: PRODUCTS,
      openCosts: openCosts(), effectiveFrom: '20260905',
    });
    expect(plan.insert).toHaveLength(1);
    expect(plan.insert[0].cost).toBeCloseTo(14.95, 4);
    expect(plan.insert[0].previousCost).toBe(14.5);
    expect(plan.insert[0].closesRecordId).toBe('cost-snow-crab-2-clusters-20260801');
    expect(plan.insert[0].verification).toBe('verified');
  });

  it('re-running against unchanged MarginEdge data writes nothing', () => {
    const first = planSync({
      mappings: [confirmedMapping()], products: PRODUCTS,
      openCosts: openCosts(), effectiveFrom: '20260905',
    });
    const applied = openCosts({
      id: 'cost-snow-crab-2-clusters-20260905', costPerUnit: first.insert[0].cost,
      effectiveFrom: '20260905', source: 'marginedge', verification: 'verified',
      marginEdge: { sourceHash: first.insert[0].sourceHash },
    });
    const second = planSync({
      mappings: [confirmedMapping()], products: PRODUCTS,
      openCosts: applied, effectiveFrom: '20260906',
    });
    expect(second.insert).toHaveLength(0);
    expect(second.unchanged).toHaveLength(1);
  });

  it('does not rewrite history when a newer cost is already effective', () => {
    const plan = planSync({
      mappings: [confirmedMapping()], products: PRODUCTS,
      openCosts: openCosts({ effectiveFrom: '20261001' }), effectiveFrom: '20260905',
    });
    expect(plan.insert).toHaveLength(0);
    expect(plan.skip[0].reason).toMatch(/newer cost is already effective 20261001/);
  });

  it('holds anomalies instead of publishing them', () => {
    const spiked = [{ ...SNOW_CRAB, latestPrice: 60 }, EZ_SHRIMP, LOBSTER_TAIL, BLUE_CRAB_CASE];
    const plan = planSync({
      mappings: [confirmedMapping()], products: spiked,
      openCosts: openCosts(), effectiveFrom: '20260905',
    });
    expect(plan.insert).toHaveLength(0);
    expect(plan.hold).toHaveLength(1);
    expect(plan.hold[0].currentCost).toBe(14.5);   // last trustworthy cost preserved
  });

  it('skips unconfirmed mappings and reports why', () => {
    const plan = planSync({
      mappings: [confirmedMapping({ reviewStatus: 'proposed' })], products: PRODUCTS,
      openCosts: openCosts(), effectiveFrom: '20260905',
    });
    expect(plan.insert).toHaveLength(0);
    expect(plan.skip[0].reason).toMatch(/only confirmed mappings are costed/);
  });

  it('holds when the mapping references a product MarginEdge no longer returns', () => {
    const plan = planSync({
      mappings: [confirmedMapping()], products: [EZ_SHRIMP], // snow crab disappeared
      openCosts: openCosts(), effectiveFrom: '20260905',
    });
    expect(plan.hold).toHaveLength(1);
    expect(plan.hold[0].reason).toMatch(/not found in MarginEdge/);
  });

  it('sourceHash is stable across runs and changes only with the inputs', () => {
    const comps = [{ productId: '828228826', latestPrice: 11.5, reportByUnit: 'Pound', quantityPerToastUnit: 1.3, unit: 'lb' }];
    const a = sourceHashFor({ mappingId: 'm', components: comps });
    expect(sourceHashFor({ mappingId: 'm', components: comps })).toBe(a);
    expect(sourceHashFor({ mappingId: 'm', components: [{ ...comps[0], latestPrice: 12 }] })).not.toBe(a);
    // Component order must not matter.
    const two = [comps[0], { productId: '828222605', latestPrice: 5.45, reportByUnit: 'Pound', quantityPerToastUnit: 1, unit: 'lb' }];
    expect(sourceHashFor({ mappingId: 'm', components: two }))
      .toBe(sourceHashFor({ mappingId: 'm', components: [...two].reverse() }));
  });

  it('defaults to dry run and only writes when --apply is passed', () => {
    expect(parseArgs([]).dryRun).toBe(true);
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(['--apply']).apply).toBe(true);
    expect(parseArgs(['--effective-from', '20260905']).effectiveFrom).toBe('20260905');
  });

  it('nyToday returns a YYYYMMDD business date', () => {
    expect(nyToday(new Date('2026-09-05T14:00:00Z'))).toBe('20260905');
    // 00:30 UTC is still the previous day in New York.
    expect(nyToday(new Date('2026-09-05T00:30:00Z'))).toBe('20260904');
  });
});

/* ----------------------------------------------------------- API client ---- */
describe('MarginEdge API client', () => {
  const okJson = (body) => ({ ok: true, status: 200, json: async () => body, headers: { get: () => null } });

  it('sends the API key as a header and only ever issues GET', async () => {
    const calls = [];
    const c = new MarginEdgeClient({
      apiKey: 'secret-key', restaurantUnitId: 377809302, rateLimitMs: 0,
      fetchImpl: async (url, init) => { calls.push({ url, init }); return okJson({ restaurants: [{ id: 377809302, name: 'Nue/Chasin\' Tails - Falls Church' }] }); },
    });
    const units = await c.restaurantUnits();
    expect(units[0].id).toBe(377809302);
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers['x-api-key']).toBe('secret-key');
    expect(calls[0].url).toMatch(/^https:\/\/api\.marginedge\.com\/public\//);
    // The key must never travel to another host on a redirect.
    expect(calls[0].init.redirect).toBe('error');
  });

  it('has no code path that can issue anything but GET', async () => {
    const methods = new Set();
    const c = new MarginEdgeClient({
      apiKey: 'k', restaurantUnitId: 377809302, rateLimitMs: 0,
      fetchImpl: async (url, init) => {
        methods.add(init.method);
        if (url.includes('/orders/')) return okJson({ orderId: 'o1', lineItems: [] });
        if (url.includes('/orders')) return okJson({ orders: [{ orderId: 'o1' }] });
        return okJson({ restaurants: [], categories: [], products: [] });
      },
    });
    await c.restaurantUnits(); await c.categories(); await c.products();
    await c.orders({ startDate: '2026-08-01', endDate: '2026-08-02' }); await c.orderDetail('o1');
    expect([...methods]).toEqual(['GET']);
    // No public method exists that could mutate MarginEdge.
    const names = Object.getOwnPropertyNames(MarginEdgeClient.prototype);
    expect(names.filter((n) => /^(post|put|patch|delete|create|update|remove|approve|submit|upload)/i.test(n))).toEqual([]);
  });

  it('follows the nextPage cursor to completion', async () => {
    let page = 0;
    const c = new MarginEdgeClient({
      apiKey: 'k', restaurantUnitId: 1, rateLimitMs: 0,
      fetchImpl: async () => {
        page++;
        return okJson(page < 3
          ? { nextPage: `cursor-${page}`, products: [{ companyConceptProductId: `p${page}`, productName: `P${page}`, latestPrice: 1, reportByUnit: 'Pound', categories: [] }] }
          : { products: [{ companyConceptProductId: 'p3', productName: 'P3', latestPrice: 1, reportByUnit: 'Pound', categories: [] }] });
      },
    });
    const products = await c.products();
    expect(products).toHaveLength(3);
    expect(page).toBe(3);
  });

  it('retries a 500 and succeeds', async () => {
    let n = 0;
    const c = new MarginEdgeClient({
      apiKey: 'k', restaurantUnitId: 1, rateLimitMs: 0,
      fetchImpl: async () => {
        n++;
        if (n === 1) return { ok: false, status: 500, headers: { get: () => null } };
        return okJson({ restaurants: [{ id: 1, name: 'x' }] });
      },
    });
    await expect(c.restaurantUnits()).resolves.toHaveLength(1);
    expect(n).toBe(2);
  });

  it('does not retry a 401 and gives an actionable message', async () => {
    let n = 0;
    const c = new MarginEdgeClient({
      apiKey: 'k', restaurantUnitId: 1, rateLimitMs: 0,
      fetchImpl: async () => { n++; return { ok: false, status: 401, headers: { get: () => null } }; },
    });
    await expect(c.restaurantUnits()).rejects.toThrow(/MARGINEDGE_API_KEY/);
    expect(n).toBe(1);
  });

  it('marks products as food from their FOOD categories', async () => {
    const c = new MarginEdgeClient({
      apiKey: 'k', restaurantUnitId: 1, rateLimitMs: 0,
      fetchImpl: async () => okJson({ products: [
        { companyConceptProductId: 'a', productName: 'Crawfish, Live', latestPrice: 4.95, reportByUnit: 'Pound', categories: [{ categoryId: '68210', percentAllocation: 100 }] },
        { companyConceptProductId: 'b', productName: 'Crab Scissors', latestPrice: 11.99, reportByUnit: '8 Each', categories: [{ categoryId: '68144', percentAllocation: 100 }] },
      ] }),
    });
    const cats = [
      { categoryId: '68210', categoryName: 'Seafood', isFood: true },
      { categoryId: '68144', categoryName: 'Kitchen Utensils and Supplies', isFood: false },
    ];
    const products = await c.products({ categories: cats });
    expect(products.find((p) => p.productId === 'a').isFood).toBe(true);
    expect(products.find((p) => p.productId === 'b').isFood).toBe(false);
  });

  it('builds invoice-derived price history with real effective dates', async () => {
    const c = new MarginEdgeClient({
      apiKey: 'k', restaurantUnitId: 1, rateLimitMs: 0,
      fetchImpl: async (url) => {
        if (url.includes('/orders/')) {
          const id = url.split('/orders/')[1].split('?')[0];
          if (id === 'o1') {
            return okJson({ orderId: 'o1', invoiceDate: '2026-07-03', isCredit: false, vendorName: 'Samuels',
              lineItems: [{ companyConceptProductId: '828228826', quantity: 540, unitPrice: 11.5, linePrice: 6210 }] });
          }
          // A credit memo must not be read as a price observation.
          return okJson({ orderId: 'o2', invoiceDate: '2026-07-10', isCredit: true, vendorName: 'Samuels',
            lineItems: [{ companyConceptProductId: '828228826', quantity: -10, unitPrice: 0.01, linePrice: -0.1 }] });
        }
        return okJson({ orders: [
          { orderId: 'o1', invoiceDate: '2026-07-03', vendorName: 'Samuels', orderTotal: 6210, status: 'CLOSED' },
          { orderId: 'o2', invoiceDate: '2026-07-10', vendorName: 'Samuels', orderTotal: -0.1, status: 'CLOSED' },
        ] });
      },
    });
    const h = await c.productPriceHistory({ startDate: '2026-07-01', endDate: '2026-07-31' });
    const obs = h.byProduct.get('828228826');
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ date: '2026-07-03', unitPrice: 11.5 });
  });

  it('rejects a bad date range before making a request', async () => {
    let called = false;
    const c = new MarginEdgeClient({ apiKey: 'k', restaurantUnitId: 1, rateLimitMs: 0, fetchImpl: async () => { called = true; return okJson({}); } });
    await expect(c.orders({ startDate: '20260701', endDate: '2026-07-31' })).rejects.toThrow(/YYYY-MM-DD/);
    expect(called).toBe(false);
  });

  it('never leaks the API key in an error message', () => {
    expect(sanitizeError('boom with key sk-abc123', 'sk-abc123')).toBe('boom with key [REDACTED]');
    expect(sanitizeError('headers: x-api-key: sk-abc123')).toMatch(/\[REDACTED\]/);
  });

  it('reports missing secrets rather than half-running', () => {
    expect(missingMarginEdgeSecrets({})).toEqual(['MARGINEDGE_API_KEY', 'MARGINEDGE_RESTAURANT_UNIT_ID']);
    expect(missingMarginEdgeSecrets({ MARGINEDGE_API_KEY: '__REQUIRED_FOR_COST_SYNC__', MARGINEDGE_RESTAURANT_UNIT_ID: '377809302' }))
      .toEqual(['MARGINEDGE_API_KEY']);
    expect(missingMarginEdgeSecrets({ MARGINEDGE_API_KEY: 'k', MARGINEDGE_RESTAURANT_UNIT_ID: '377809302' })).toEqual([]);
  });
});

/* ------------------------------------------------------ workflow hardening -- */
describe('MarginEdge workflow hardening', () => {
  const yml = readFileSync(new URL('../.github/workflows/marginedge-costs.yml', import.meta.url), 'utf8');

  it('runs with a read-only GITHUB_TOKEN', () => {
    expect(yml).toMatch(/permissions:\s*\r?\n\s*contents: read/);
  });

  it('never interpolates a dispatch input into a shell line that holds the API key', () => {
    expect(yml).toMatch(/EFFECTIVE_FROM: \$\{\{ inputs\.effectiveFrom \}\}/);
    expect(yml).not.toMatch(/run:.*\$\{\{ inputs\./);
  });

  it('plans before it applies, and apply is the only Supabase write', () => {
    expect(yml).toMatch(/--dry-run --verbose/);
    expect(yml).toMatch(/inputs\.mode != 'dry-run'/);
    expect(yml).not.toMatch(/\b(curl|wget|POST|PUT|PATCH|DELETE)\b/);
  });
});

/* --------------------------------------------------- freshness / status UI -- */
describe('per-source freshness and status wording', () => {
  const NOW = Date.parse('2026-09-01T14:00:00Z');
  const base = (over = {}) => ({
    metrics: [], items: [], intents: [], costs: [], importRuns: [], ingestionRuns: [],
    sourceStatus: [], marginedgeRuns: [], ...over,
  });
  const status = (source, over = {}) => ({
    source, status: 'ok', last_success_at: '2026-09-01T10:18:00Z',
    last_attempt_at: '2026-09-01T10:18:00Z', detail: {}, ...over,
  });

  it('reads each source independently', () => {
    const DATA = base({ sourceStatus: [status('toast'), status('marginedge'), status('opentable')] });
    expect(sourceFreshness(DATA, 'toast').status).toBe('ok');
    expect(sourceFreshness(DATA, 'marginedge').status).toBe('ok');
    expect(sourceFreshness(DATA, 'nope')).toBeNull();
  });

  it('survives a project that has not applied migration 0007', () => {
    expect(sourceFreshness(base(), 'marginedge')).toBeNull();
    expect(marginedgeStatus(base(), { now: NOW }).state).toBe('never');
  });

  it('reports ok, stale, failed and never distinctly', () => {
    const at = (iso, over) => base({ sourceStatus: [status('marginedge', { last_success_at: iso, ...over })] });
    expect(marginedgeStatus(at('2026-09-01T10:18:00Z'), { now: NOW }).state).toBe('ok');
    expect(marginedgeStatus(at('2026-08-25T10:18:00Z'), { now: NOW }).state).toBe('stale');
    expect(marginedgeStatus(at('2026-09-01T10:18:00Z', { status: 'failed' }), { now: NOW }).state).toBe('failed');
    expect(marginedgeStatus(at(null), { now: NOW }).state).toBe('never');
  });

  it('a MarginEdge failure keeps the last successful snapshot in the message', () => {
    const DATA = base({ sourceStatus: [status('marginedge', { status: 'failed' })] });
    const me = marginedgeStatus(DATA, { now: NOW });
    expect(me.label).toMatch(/last successful MarginEdge costs/);
    expect(me.lastSuccess).toBe('2026-09-01T10:18:00Z');
  });

  it('a MarginEdge failure never claims sales are broken', () => {
    const DATA = base({
      sourceStatus: [status('marginedge', { status: 'failed' }), status('toast')],
      metrics: [{ businessDate: '20260831', serverGuid: null }],
      ingestionRuns: [{ status: 'success', startedAt: '2026-09-01T10:00:00Z' }],
    });
    const sys = systemStatus(DATA, 0);
    expect(sys.head).toMatch(/MarginEdge cost update failed/);
    expect(sys.action).toMatch(/Sales and guest numbers are current/);
  });

  it('a Toast failure says food-cost source data may still be current', () => {
    const DATA = base({
      ingestionRuns: [{ status: 'failed', startedAt: '2026-09-01T10:00:00Z' }],
      metrics: [{ businessDate: '20260820', serverGuid: null }],
    });
    const sys = systemStatus(DATA, 0);
    expect(sys.head).toMatch(/Toast sales update failed/);
    expect(sys.action).toMatch(/Food costs and guest status are unaffected/);
  });

  it('counts verified coverage from the confirmed and marginedge tiers only', () => {
    const DATA = base({
      metrics: [{
        serverGuid: null, matchedQty: 100, totalQty: 100, unmatchedItems: 2,
        qtyByTier: { confirmed: 10, marginedge: 60, override: 10, explicit_temp: 10, rough_estimate: 5, fallback_2: 5 },
      }],
    });
    const c = costsStatus(DATA);
    expect(c.verifiedCoverage).toBeCloseTo(70, 6);
    expect(c.uncostedItems).toBe(2);
  });

  it('does not count a verified MarginEdge cost as a rough cost', () => {
    const DATA = base({
      items: [
        { matched: true, cost: 80, source: 'marginedge', verification: 'verified', tier: 'marginedge' },
        { matched: true, cost: 20, source: 'rough_workbook', verification: 'unverified', tier: 'rough_estimate' },
      ],
    });
    expect(costsStatus(DATA).roughShare).toBeCloseTo(20, 6);
  });

  it('surfaces held anomalies as an attention item without changing the numbers', () => {
    const DATA = base({
      sourceStatus: [status('marginedge')],
      marginedgeRuns: [{ held: 3, skipped: 5, inserted: 1 }],
      metrics: [{ businessDate: '20260831', serverGuid: null }],
      ingestionRuns: [{ status: 'success', startedAt: '2026-09-01T10:00:00Z' }],
    });
    const me = marginedgeStatus(DATA, { now: NOW });
    expect(me.held).toBe(3);
    expect(me.unresolved).toBe(5);
    expect(systemStatus(DATA, 0).action).toMatch(/3 MarginEdge price changes held back for review/);
  });
});

/* ------------------------------------------------------ source independence */
describe('source independence', () => {
  const cats = { salesCategories: [{ guid: 'food', name: 'Food' }] };
  const ayceCheck = { checkGuid: 'c1', orderGuid: 'o1', businessDate: '20260905', voided: false, tableGuid: 't1', serviceAreaGuid: 'sa', amount: 100, numberOfGuests: 2, openedDate: '2026-09-05T23:00:00Z' };
  const selections = [
    { checkGuid: 'c1', businessDate: '20260905', itemName: 'AYCE DINNER PER PERSON', quantity: 2, gross: 100, net: 100, discount: 0, salesCategoryGuid: 'food', serverGuid: 's1' },
    { checkGuid: 'c1', businessDate: '20260905', itemName: 'SNOW CRAB (2 Clusters)', itemGuid: 'g-snow', quantity: 3, gross: 0, net: 0, discount: 0, salesCategoryGuid: 'food', serverGuid: 's1' },
  ];
  const meCost = {
    id: 'cost-me', canonicalName: 'SNOW CRAB (2 Clusters)', aliases: [], costPerUnit: 14.95,
    effectiveFrom: '20260901', effectiveTo: null, source: 'marginedge', verification: 'verified',
  };

  it('food cost calculates with no OpenTable data present at all', () => {
    const ayce = filterAyceProgram(selections, [ayceCheck], cats);
    const fc = computeFoodCost(ayce.selections, ayce.checks, cats, [meCost]);
    // No ace_intents, no guest tags, no conversion input — cost still lands.
    expect(fc.total.foodCostDollars).toBeCloseTo(44.85, 4);
    expect(fc.total.eligibleNetFoodRevenue).toBeCloseTo(100, 4);
    expect(fc.total.qtyByTier.marginedge).toBe(3);
    expect(fc.total.coverage.qtyPct).toBe(100);
  });

  it('a MarginEdge sync failure leaves the previous cost serving the engine', () => {
    // Nothing new was written; the open record from the last good sync is used.
    const ayce = filterAyceProgram(selections, [ayceCheck], cats);
    const fc = computeFoodCost(ayce.selections, ayce.checks, cats, [meCost]);
    expect(fc.total.foodCostDollars).toBeGreaterThan(0);
    expect(fc.total.unmatchedItemCount).toBe(0);
  });

  it('an unmapped genuine item stays in the missing queue and is never costed at $0', () => {
    const ayce = filterAyceProgram(selections, [ayceCheck], cats);
    const fc = computeFoodCost(ayce.selections, ayce.checks, cats, []);
    expect(fc.total.foodCostDollars).toBe(0);
    expect(fc.unmatchedQueue.map((u) => u.name)).toContain('SNOW CRAB (2 Clusters)');
    expect(fc.total.coverage.qtyPct).toBe(0);
  });
});
