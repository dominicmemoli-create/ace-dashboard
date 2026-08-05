// Food-cost classification rules — the strict precedence used by the engine.
// Pure data + pure functions; shared by the browser, the CLI and the tests.
//
// Precedence (see docs/METRICS.md):
//   A. Excluded modifiers / non-cost signals — never food-cost items. They add
//      no cost, never appear in missing-cost lists, never reduce coverage and
//      never receive the $2 fallback.
//   B. Drinks — trivial drink costs are ignored for this temporary model.
//   C. Explicit portion overrides (1/2-lb shrimp $2.50, one-piece crab cake $4)
//      — these beat generic aliases and every temporary cost below.
//   D. Explicit canonical temporary costs (WDT $10, Catfish $3, …).
//   E. $2 fallback for genuine supplied-menu items with no explicit cost.
//   Anything else that is a real food item stays in the MISSING list — it is
//   never silently costed at $0.
//   Chef-confirmed uploads (source 'chef_confirmed' / verification 'verified')
//   outrank every temporary rule, so uploading the chef's sheet replaces the
//   temporary model item by item.

export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------ A. modifiers -- */
// Structural rule: a Toast selection with a parentSelectionGuid is a modifier
// of its parent item — that is Toast's own metadata and is always decisive.
// The name lists below are the fallback for rows whose structure is missing
// (older imports, CSV paths) and for the few kitchen notes Toast rings as
// top-level $0 rows ("Melted Butter", "Extra Side Sauce Hosp"). Exact
// normalized names + a few tight patterns only — no broad fuzzy matching.
const MODIFIER_NAMES = new Set([
  // cooking temperatures
  'rare', 'med rare', 'medium rare', 'medium', 'med', 'med well', 'medium well',
  'well done', 'well', 'wd', 'mw', 'mr',
  // spice levels
  'mild', 'hot', 'extra hot', 'non spicy', 'no spice', 'spicy',
  // butter / sauce preparation notes
  'only butter inside', 'butter ots', 'melted butter', 'butter on the side',
  'extra butter', 'light butter', 'no butter',
  'extra side sauce', 'extra side sauce hosp', 'side sauce',
  'no sauce', 'no sauce no heat', 'sauce on the side', 'sauce ots',
  // boil flavor choices (normally children; safety net)
  'classic oh dang', 'classic garlic butter', 'classic cajun',
  'maryland style old bay butter', 'lemon garlic', 'thai coconut dairy free',
  'bayou mambo', 'garlic butter', 'old bay',
  // omissions / substitutions
  'no corn no potato', 'no potato extra corn', 'no corn extra potato',
  'no corn', 'no potato', 'no potatoes', 'no sides', 'no fries', 'no bread',
  'no rim', 'no onion', 'no onions',
  // birthday / occasion notes
  'bday', 'birthday', 'happy birthday', 'bday note', 'birthday note',
  // plating / batching notes
  'same plate', 'all same tray', 'yes sausage', 'no sausage',
  '2 pieces', '3 pieces', 'glass', 'split', 'to go', 'garlic noodles default',
  // AYCE kitchen batching markers — $0 by design, not food-cost items
  'tray a', 'tray b', 'tray c', 'tray d', 'tray e', 'tray f',
]);

// Tight patterns for known modifier FAMILIES. Each is anchored and narrow so a
// real menu item cannot drift in.
const MODIFIER_PATTERNS = [
  /^tray [a-f]$/,                                   // Tray A~ … Tray F~
  /^no [a-z0-9 ]{2,30}$/,                           // omission instructions ("No Corn", "No Potato Extra Corn")
  /^(extra )?(rare|med rare|medium rare|med well|medium well|medium|well done|well)$/,
  /^(sub|substitute) [a-z0-9 ]{2,30}$/,             // substitution notes
  /^(only |melted |extra |light |no )?butter( ots| otc| inside| on the side)?$/,
  /^(happy )?(bday|birthday)( note| dessert| candle)?$/,
];

/** Name-level modifier check on a raw item name (fallback path). */
export function isModifierName(itemName) {
  const n = normalizeName(itemName);
  if (!n) return false;
  if (MODIFIER_NAMES.has(n)) return true;
  return MODIFIER_PATTERNS.some((re) => re.test(n));
}

/* --------------------------------------------------------------- B. drinks -- */
// Trivial drinks that must not enter the temporary food-cost model even when
// Toast miscategorizes them as Food (Lemonade, Coke etc. appear with a Food
// sales category in the live data). Exact normalized names only.
const DRINK_NAMES = new Set([
  'fountain drink', 'fountain drinks', 'fountain soda', 'soft drink', 'soda',
  'coke', 'coke zero', 'diet coke', 'cherry coke', 'mexican coke',
  'sprite', 'sprite zero', 'fanta', 'dr pepper', 'diet dr pepper',
  'pepsi', 'diet pepsi', 'mountain dew', 'root beer', 'ginger ale', 'gingerale',
  'fanta orange', 'fanta grape', 'orange fanta',
  'sweet tea', 'unsweet tea', 'unsweetened tea', 'iced tea', 'hot tea', 'tea',
  'lemonade', 'arnold palmer', 'coffee', 'decaf coffee',
  'water', 'bottled water', 'sparkling water', 'topo chico',
  'juice', 'orange juice', 'apple juice', 'cranberry juice', 'pineapple juice',
  'refill', 'drink refill', 'splash of soda',
]);

/** Name-level drink check on a raw item name. */
export function isDrinkName(itemName) {
  const n = normalizeName(itemName);
  if (!n) return false;
  return DRINK_NAMES.has(n) || /^(sweet|unsweet|iced) tea refill$/.test(n);
}

/* ---------------------------------------------- C. explicit portion overrides */
/**
 * Portion overrides beat generic aliases and every temporary cost.
 * Returns { canonicalName, cost } or null. Operates on the normalized name.
 */
export function portionOverrideFor(itemName) {
  const n = normalizeName(itemName);
  if (!n) return null;
  // Every recognized 1/2-lb SHRIMP portion = $2.50 (half of the $5 full pound).
  // 'EZ__PEEL SHRIMP 1/2LB' → 'ez peel shrimp 1 2lb'; 'SHRIMP 1/2 LB' → 'shrimp 1 2 lb'.
  if (/shrimp/.test(n) && !/prawn/.test(n) && /(^|\s)1 2\s?lbs?(\s|$)/.test(n)) {
    return { canonicalName: 'Shrimp (1/2 lb)', cost: 2.5 };
  }
  // Every one-piece crab cake = $4.00.
  if (/crab ?cakes?/.test(n) && /(^|\s)1\s?(pc|pcs|piece|pieces)(\s|$)|^1\s?(pc|piece) crab ?cakes?$/.test(n)) {
    return { canonicalName: 'Crab Cake (1 pc)', cost: 4 };
  }
  return null;
}

/* --------------------------------------- D. explicit canonical temporary map */
export const EXPLICIT_COSTS = [
  { canonicalName: 'WDT', cost: 10, aliases: ['Whole Dang Thang', 'Whole Gang Thang'] },
  { canonicalName: 'Catfish', cost: 3, aliases: ['Crisp Catfish', 'Blue Catfish', 'Fried Catfish'] },
  { canonicalName: 'Shrimp', cost: 2, aliases: ['Crisp Shrimp', 'Crispy Shrimp', 'Fried Shrimp'] },
  { canonicalName: 'Gator', cost: 3, aliases: ['Gator Bites'] },
  { canonicalName: 'Blackened Wings', cost: 2, aliases: ['Vietnamese Cajun Wings', 'Blackend Wings'] },
  { canonicalName: 'Tenders', cost: 3, aliases: ['Chicken Tenders', 'Crisp Tenders'] },
  { canonicalName: 'Shrimp Tacos', cost: 3, aliases: ['Fried Shrimp Tacos'] },
  { canonicalName: 'Catfish Tacos', cost: 3, aliases: ['Blue Catfish Tacos', 'Fish Tacos'] },
  { canonicalName: 'Honey Shrimp', cost: 4, aliases: ['Sriracha Honey Shrimp', 'Honey Sriracha Shrimp', 'Honey SHrimp'] },
  { canonicalName: 'Calamari', cost: 4, aliases: ['Crisp Calamari', 'Calimari'] },
  { canonicalName: 'Blackened Salmon', cost: 6, aliases: ['BlackenedSalmon'] },
  { canonicalName: 'Shrimp Scampi', cost: 4, aliases: [] },
  { canonicalName: 'Gumbo', cost: 6, aliases: ['Seafood Gumbo'] },
  { canonicalName: 'Small Clam Chowder', cost: 2, aliases: ['Clam Chowder (Cup)', 'Clam Chowder (s)', 'Clam Chowder CUP (SMALL)', 'Clam Chowder Cup'] },
  { canonicalName: 'Large Clam Chowder', cost: 4, aliases: ['Clam Chowder (Bowl)', 'Clam Chowder (l)', 'Clam Chowder Bowl', 'Clam Chowder BOWL (LARGE)'] },
  { canonicalName: 'Crab Dip', cost: 4, aliases: ['Crab & Spinach Dip', 'Crab and Spinach Dip'] },
];

/* -------------------------------------------------- E. $2 supplied-menu list */
// Genuine menu items from the supplied appetizer/entrée/side/sauce/dessert
// list that have NO explicit cost above → temporary $2. Items that DO have an
// explicit cost resolve there instead (and under their own canonical name,
// never buried in a "Sides/Desserts/Sauce" bucket).
export const FALLBACK_MENU = [
  { canonicalName: 'Cajun Fries', aliases: ['CAJUN FRIES'] },
  { canonicalName: 'Fresh Garlic Noodles', aliases: ['FRESH GARLIC NOODLES', 'Garlic Noodles'] },
  { canonicalName: 'Brussels Sprouts', aliases: ['BRUSSELS SPROUTS', 'Brussel Sprouts'] },
  { canonicalName: 'Mac & Cheese', aliases: ['MAC & CHEESE', 'Mac and Cheese'] },
  { canonicalName: 'Hush Puppies', aliases: ['SOUTHERN HUSH PUPPIES', 'Southern Hush Puppies'] },
  { canonicalName: 'Beignets', aliases: ['BEIGNETS'] },
  { canonicalName: 'Fried Cheesecake', aliases: ['FRIED CHEESECAKE'] },
  { canonicalName: 'Berry Cheesecake', aliases: ['SEASONAL BERRY CHEESECAKE', 'Seasonal Berry Cheesecake'] },
  { canonicalName: 'Ice Cream', aliases: ['Vanilla Ice Cream'] },
  // real ordered sauces sold as menu items (NOT boil-flavor modifiers)
  { canonicalName: 'Voodoo Sauce', aliases: [] },
];
export const FALLBACK_COST = 2;

/* ------------------------------------------------------------ rule records -- */
/** The temporary rules expressed as cost records the engine can index.
 *  Sources: 'explicit_temp' (D) and 'menu_fallback' (E). Portion overrides (C)
 *  are name patterns, applied inside resolveCost, not records. */
export function ruleCostRecords() {
  const recs = [];
  for (const e of EXPLICIT_COSTS) {
    recs.push({
      id: `rule-explicit-${normalizeName(e.canonicalName).replace(/ /g, '-')}`,
      toastItemGuid: null, canonicalName: e.canonicalName, aliases: e.aliases,
      costPerUnit: e.cost, effectiveFrom: '20260101', effectiveTo: null,
      source: 'explicit_temp', verification: 'unverified',
      notes: 'Temporary explicit cost from management — replace via chef upload',
    });
  }
  for (const f of FALLBACK_MENU) {
    recs.push({
      id: `rule-fallback-${normalizeName(f.canonicalName).replace(/ /g, '-')}`,
      toastItemGuid: null, canonicalName: f.canonicalName, aliases: f.aliases,
      costPerUnit: FALLBACK_COST, effectiveFrom: '20260101', effectiveTo: null,
      source: 'menu_fallback', verification: 'unverified',
      notes: 'Temporary $2 supplied-menu fallback — replace via chef upload',
    });
  }
  return recs;
}

/* -------------------------------------------------------------- precedence -- */
/** Rank of a cost record — lower wins. Chef-confirmed (and explicitly verified
 * $0 records like the AYCE entitlements) beat every temporary rule; portion
 * overrides beat the explicit map; the explicit map beats other provisional
 * records; the $2 supplied-menu fallback beats only the legacy umbrella
 * "Sides/Desserts/Sauce" bucket so items surface under their own names. */
export function costRank(rec) {
  if (rec.source === 'chef_confirmed' || rec.verification === 'verified') return 1;
  if (rec.source === 'portion_override') return 2;
  if (rec.source === 'explicit_temp') return 3;
  if (normalizeName(rec.canonicalName) === 'sides desserts sauce') return 6;
  if (rec.source === 'menu_fallback') return 5;
  return 4; // rough workbook / other provisional records
}

/** Human label for how a cost was assigned — used in coverage breakdowns. */
export function costTierOf(rec) {
  if (rec.source === 'chef_confirmed') return 'confirmed';
  if (rec.verification === 'verified') return 'confirmed';
  if (rec.source === 'portion_override') return 'override';
  if (rec.source === 'explicit_temp') return 'explicit_temp';
  if (rec.source === 'menu_fallback') return 'fallback_2';
  return 'rough_estimate';
}
