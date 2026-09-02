// MarginEdge → ACE cost derivation. Pure functions, no I/O — shared by the sync
// script (scripts/sync-marginedge-costs.mjs), the audit
// (scripts/audit-marginedge-costs.mjs) and the vitest suite.
//
// WHY THIS SHAPE (see docs/MARGINEDGE_COST_AUDIT.md):
// The MarginEdge PUBLIC API exposes no recipe endpoints — no recipes, recipe
// ingredients, yields, conversions, plated recipe costs or recipe cost history.
// It exposes purchased PRODUCTS with a `latestPrice` quoted per `reportByUnit`,
// plus vendors/vendor items and invoice line items. MarginEdge therefore cannot
// tell ACE what a plated AYCE portion costs; it can only tell ACE what an
// INGREDIENT costs per purchase unit.
//
// So the division of labour is:
//   MarginEdge  → ingredient price per purchase unit (changes constantly)
//   ACE mapping → how much of that ingredient is in one Toast sellable unit
//                 (changes rarely; confirmed once by the chef)
//   ACE cost    = Σ (quantityPerToastUnit × pricePerQuantityUnit)
//
// That is the durable split the brief asks for: a price change must never
// require re-mapping the Toast item.
//
// A mapping is only ever used for costing when reviewStatus === 'confirmed'.
// Fuzzy name similarity produces CANDIDATES for review and nothing else.

export const MARGINEDGE_SOURCE = 'marginedge';

/** MarginEdge categoryType values that represent food spend. */
export const FOOD_CATEGORY_TYPES = new Set(['FOOD']);

export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ units -- */
// MarginEdge `reportByUnit` is free-ish text ("Pound", "Each", "Case",
// "Bushel", "Kilogram", "Bottle (750 Milliliters)"). Only units we can reason
// about deterministically are given a canonical form; everything else stays
// OPAQUE and requires an explicit unitsPerReportByUnit factor on the mapping
// component before it can produce a cost.
const UNIT_ALIASES = new Map([
  ['pound', 'lb'], ['pounds', 'lb'], ['lb', 'lb'], ['lbs', 'lb'],
  ['ounce', 'oz'], ['ounces', 'oz'], ['oz', 'oz'],
  ['kilogram', 'kg'], ['kilograms', 'kg'], ['kg', 'kg'],
  ['gram', 'g'], ['grams', 'g'], ['g', 'g'],
  ['each', 'each'], ['ea', 'each'], ['piece', 'each'], ['pieces', 'each'],
  ['gallon', 'gal'], ['gallons', 'gal'],
  ['quart', 'qt'], ['quarts', 'qt'],
]);

// Mass conversions to pounds. Deterministic and safe.
const TO_LB = { lb: 1, oz: 1 / 16, kg: 2.2046226218, g: 0.0022046226218 };

/** Canonical unit token for a MarginEdge reportByUnit string, or null when the
 * unit is opaque (Case / Box / Bushel / Pack / "240 Bottles" / Other …). */
export function canonicalUnit(reportByUnit) {
  const raw = String(reportByUnit ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (UNIT_ALIASES.has(raw)) return UNIT_ALIASES.get(raw);
  // A leading count makes the unit a pack ("1000 Each", "240 Bottles") — the
  // price is per PACK, not per member, so it is opaque without a factor.
  if (/^\d/.test(raw)) return null;
  return UNIT_ALIASES.get(raw) ?? null;
}

/** Convert a quantity between canonical mass units. Returns null when the
 * conversion is not deterministic (mixing mass with counts, opaque units). */
export function convertQuantity(qty, fromUnit, toUnit) {
  if (fromUnit === toUnit) return qty;
  const a = TO_LB[fromUnit], b = TO_LB[toUnit];
  if (a == null || b == null) return null;   // never guess Each ↔ lb
  return (qty * a) / b;
}

/* --------------------------------------------------------------- mappings -- */
/**
 * One mapping component: a MarginEdge product plus how much of it one Toast
 * sellable unit consumes.
 *   productId               MarginEdge companyConceptProductId (identity — survives price changes)
 *   quantityPerToastUnit    numeric quantity consumed per ONE Toast selection unit
 *   unit                    the unit that quantity is expressed in ('lb','oz','each',…)
 *   unitsPerReportByUnit    REQUIRED when the product's reportByUnit is opaque
 *                           (e.g. Blue Crabs priced per Case → crabs per case).
 *                           Explicit, persisted, auditable — never inferred.
 */

/** Shape/consistency validation for one mapping. Returns a list of problems. */
export function validateMapping(mapping) {
  const problems = [];
  if (!mapping || typeof mapping !== 'object') return ['mapping is not an object'];
  if (!mapping.toastItemGuid && !mapping.canonicalName) {
    problems.push('mapping needs a toastItemGuid or a canonicalName');
  }
  if (!mapping.marginedgeRestaurantUnitId) problems.push('missing marginedgeRestaurantUnitId');
  const type = mapping.mappingType;
  if (type === 'excluded') return problems;              // no components required
  const comps = mapping.components;
  if (!Array.isArray(comps) || comps.length === 0) {
    problems.push('mapping has no components');
    return problems;
  }
  comps.forEach((c, i) => {
    if (!c.productId) problems.push(`component ${i}: missing productId`);
    const q = Number(c.quantityPerToastUnit);
    if (!Number.isFinite(q) || q <= 0) problems.push(`component ${i}: quantityPerToastUnit must be > 0`);
    if (!c.unit) problems.push(`component ${i}: missing unit`);
  });
  return problems;
}

/* ------------------------------------------------------- cost derivation -- */
/**
 * Cost of ONE Toast sellable unit for a mapping, given a MarginEdge product
 * index (Map productId → { productName, latestPrice, reportByUnit, categoryTypes }).
 *
 * Returns { cost, components, problems } where `cost` is null whenever any
 * component cannot be priced deterministically. A partial answer is never
 * returned as a cost — an unpriceable component makes the whole item
 * unpriceable, so ACE keeps its previous trustworthy value instead of
 * publishing a silently-too-low number.
 */
export function deriveCostPerToastUnit(mapping, productIndex) {
  const problems = validateMapping(mapping);
  if (mapping?.mappingType === 'excluded') {
    return { cost: null, components: [], problems: ['mapping is marked excluded'] };
  }
  if (problems.length) return { cost: null, components: [], problems };

  const out = [];
  let total = 0;
  for (const [i, c] of mapping.components.entries()) {
    const p = productIndex.get(String(c.productId));
    if (!p) { problems.push(`component ${i}: product ${c.productId} not found in MarginEdge`); continue; }
    const price = Number(p.latestPrice);
    if (!Number.isFinite(price)) { problems.push(`component ${i}: product ${c.productId} has no numeric latestPrice`); continue; }
    if (price <= 0) { problems.push(`component ${i}: product ${c.productId} priced at $${price} — refusing to treat as free`); continue; }

    const qty = Number(c.quantityPerToastUnit);
    const compUnit = String(c.unit).toLowerCase();
    const priceUnit = canonicalUnit(p.reportByUnit);

    let pricePerCompUnit = null;
    if (Number.isFinite(Number(c.unitsPerReportByUnit)) && Number(c.unitsPerReportByUnit) > 0) {
      // Explicit pack factor: price is per reportByUnit which holds N component units.
      pricePerCompUnit = price / Number(c.unitsPerReportByUnit);
    } else if (priceUnit && priceUnit === compUnit) {
      pricePerCompUnit = price;
    } else if (priceUnit && compUnit) {
      // Deterministic mass conversion only.
      const oneCompUnitInPriceUnit = convertQuantity(1, compUnit, priceUnit);
      if (oneCompUnitInPriceUnit != null) pricePerCompUnit = price * oneCompUnitInPriceUnit;
    }

    if (pricePerCompUnit == null) {
      problems.push(
        `component ${i}: cannot convert MarginEdge unit "${p.reportByUnit}" to "${c.unit}" — `
        + 'set unitsPerReportByUnit on the mapping component');
      continue;
    }
    const ext = qty * pricePerCompUnit;
    total += ext;
    out.push({
      productId: String(c.productId), productName: p.productName,
      reportByUnit: p.reportByUnit, latestPrice: price,
      quantityPerToastUnit: qty, unit: c.unit,
      pricePerCompUnit, extended: ext,
    });
  }
  if (problems.length) return { cost: null, components: out, problems };
  return { cost: total, components: out, problems: [] };
}

/* ------------------------------------------------------------ safeguards -- */
/**
 * Thresholds for accepting a newly derived MarginEdge cost. Documented in
 * docs/MARGINEDGE_COST_AUDIT.md; deliberately conservative because a wrong
 * cost is worse than a slightly stale one.
 */
export const DEFAULT_GUARDS = {
  maxIncreasePct: 60,     // > +60% vs the current effective cost → review, don't publish
  maxDecreasePct: 40,     // > −40% vs the current effective cost → review, don't publish
  minAbsolute: 0.01,      // a genuine food portion is never $0.00
  maxAbsolute: 200,       // a single AYCE portion over $200 is a unit error
  minDeltaToWrite: 0.005, // below this the source cost is "the same" — stay idempotent
};

/**
 * Decide what to do with a derived cost for one item.
 * Returns { action, reason, cost } where action ∈
 *   'insert'   — write a new effective-dated record
 *   'unchanged'— source cost already represented; write nothing (idempotent)
 *   'hold'     — derived value is questionable; KEEP the existing cost, flag it
 *   'skip'     — no usable derived value at all; keep the existing cost
 */
export function decideCostChange({ derived, current, guards = DEFAULT_GUARDS, mapping }) {
  const g = { ...DEFAULT_GUARDS, ...guards };
  if (mapping && mapping.reviewStatus !== 'confirmed') {
    return { action: 'skip', reason: `mapping review status is "${mapping.reviewStatus ?? 'unset'}" — only confirmed mappings are costed`, cost: null };
  }
  if (derived == null || !Number.isFinite(derived)) {
    return { action: 'skip', reason: 'no deterministic MarginEdge cost could be derived', cost: null };
  }
  if (derived < g.minAbsolute) {
    return { action: 'hold', reason: `derived cost $${derived.toFixed(4)} is effectively $0 — refusing to publish; last trustworthy cost kept`, cost: derived };
  }
  if (derived > g.maxAbsolute) {
    return { action: 'hold', reason: `derived cost $${derived.toFixed(2)} exceeds the $${g.maxAbsolute} per-portion sanity ceiling — likely a unit error`, cost: derived };
  }
  const cur = current == null ? null : Number(current);
  if (cur == null || !Number.isFinite(cur)) {
    return { action: 'insert', reason: 'no existing effective cost for this item', cost: derived };
  }
  if (Math.abs(cur - derived) <= g.minDeltaToWrite) {
    return { action: 'unchanged', reason: 'derived cost matches the open record', cost: derived };
  }
  if (cur > 0) {
    const pct = ((derived - cur) / cur) * 100;
    if (pct > g.maxIncreasePct) {
      return { action: 'hold', reason: `derived cost is +${pct.toFixed(1)}% vs $${cur.toFixed(2)} (limit +${g.maxIncreasePct}%) — flagged for review`, cost: derived };
    }
    if (pct < -g.maxDecreasePct) {
      return { action: 'hold', reason: `derived cost is ${pct.toFixed(1)}% vs $${cur.toFixed(2)} (limit −${g.maxDecreasePct}%) — flagged for review`, cost: derived };
    }
  }
  return { action: 'insert', reason: 'source cost changed within accepted tolerances', cost: derived };
}

/* -------------------------------------------------- candidate suggestions -- */
/** Token overlap similarity in [0,1] — candidate generation ONLY. */
export function nameSimilarity(a, b) {
  const ta = new Set(normalizeName(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeName(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

// Toast AYCE names carry portion/program noise that must not drive matching.
const NOISE_TOKENS = new Set([
  'ayce', 'oz', 'lb', 'lbs', 'pc', 'pcs', 'piece', 'pieces', 'cl', 'cluster',
  'clusters', 'leg', 'legs', 'each', 'fresh', 'whole', 'jumbo', 'large', 'small',
  'crisp', 'crispy', 'fried', 'blackened', 'seasonal', 'royal', 'imperial', 'and',
  'dozen', 'half', 'the', 'of', 'with', 'a', 'n',
]);

export function contentTokens(name) {
  return normalizeName(name).split(' ').filter((t) => t && !NOISE_TOKENS.has(t) && !/^\d+$/.test(t));
}

/**
 * Rank MarginEdge FOOD products as candidates for a Toast item name.
 * Purely advisory: the caller must never persist these as confirmed mappings.
 */
export function candidateProducts(toastItemName, products, { limit = 5, minScore = 0.2 } = {}) {
  const toks = contentTokens(toastItemName);
  if (!toks.length) return [];
  const scored = [];
  for (const p of products) {
    if (!p.isFood) continue;
    const pt = contentTokens(p.productName);
    if (!pt.length) continue;
    let hit = 0;
    for (const t of toks) if (pt.includes(t)) hit++;
    if (!hit) continue;
    // Reward covering the Toast tokens; mildly penalise very long product names.
    const score = (hit / toks.length) * (1 - Math.min(0.4, (pt.length - hit) * 0.06));
    if (score >= minScore) {
      scored.push({
        productId: String(p.productId), productName: p.productName,
        latestPrice: p.latestPrice, reportByUnit: p.reportByUnit,
        categoryNames: p.categoryNames ?? [], score: Math.round(score * 1000) / 1000,
      });
    }
  }
  return scored.sort((a, b) => b.score - a.score || a.productName.localeCompare(b.productName)).slice(0, limit);
}

/* ---------------------------------------------------- reconciliation status */
export const STATUS = {
  EXACT_CONFIRMED_MAPPING: 'EXACT_CONFIRMED_MAPPING',
  VALID_PORTION_CONVERSION: 'VALID_PORTION_CONVERSION',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  NEEDS_PORTION_SPEC: 'NEEDS_PORTION_SPEC',
  NO_MARGINEDGE_PRODUCT: 'NO_MARGINEDGE_PRODUCT',
  INVALID_MARGINEDGE_COST: 'INVALID_MARGINEDGE_COST',
  EXCLUDED_NON_COST_ITEM: 'EXCLUDED_NON_COST_ITEM',
};

/**
 * Classify one Toast item against the mapping table + MarginEdge products.
 * `mapping` may be undefined (nothing persisted yet).
 */
export function reconcileItem({ item, mapping, productIndex, products }) {
  if (mapping?.mappingType === 'excluded') {
    return { status: STATUS.EXCLUDED_NON_COST_ITEM, candidates: [], derived: null,
      notes: mapping.notes || 'excluded from the MarginEdge cost model by mapping' };
  }
  if (mapping && mapping.reviewStatus === 'confirmed') {
    const d = deriveCostPerToastUnit(mapping, productIndex);
    if (d.cost != null) {
      const single = mapping.components.length === 1
        && Number(mapping.components[0].quantityPerToastUnit) === 1
        && !mapping.components[0].unitsPerReportByUnit;
      return {
        status: single ? STATUS.EXACT_CONFIRMED_MAPPING : STATUS.VALID_PORTION_CONVERSION,
        candidates: [], derived: d.cost, components: d.components,
        notes: mapping.portionBasis || '',
      };
    }
    return { status: STATUS.INVALID_MARGINEDGE_COST, candidates: [], derived: null,
      notes: d.problems.join('; ') };
  }
  const candidates = candidateProducts(item.toastItemName, products);
  if (!candidates.length) {
    return { status: STATUS.NO_MARGINEDGE_PRODUCT, candidates: [], derived: null,
      notes: 'no MarginEdge FOOD product shares a content word with this Toast item' };
  }
  if (mapping) {
    return { status: STATUS.NEEDS_REVIEW, candidates, derived: null,
      notes: `mapping exists with review status "${mapping.reviewStatus ?? 'unset'}"` };
  }
  return { status: STATUS.NEEDS_PORTION_SPEC, candidates, derived: null,
    notes: 'candidate ingredient(s) found; a chef-confirmed portion quantity is required before costing' };
}
