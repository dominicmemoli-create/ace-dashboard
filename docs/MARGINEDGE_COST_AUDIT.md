# MarginEdge cost audit — Chasin' Tails, Founders Row (Falls Church)

Audit date: **2026-09-01**
Toast location: **Chasin' Tails — CT: Founders Row, Falls Church (CTFC)**, `e574444c-c511-4468-ab89-93d0abbec72b`
MarginEdge unit: **377809302 — "Nue/Chasin' Tails - Falls Church"**
Toast data window audited: **20260701 – 20260803** (34 business dates)
Machine-readable artifact: [`audit/marginedge_reconciliation.json`](../audit/marginedge_reconciliation.json)
Regenerate with: `node scripts/audit-marginedge-costs.mjs`

No credentials and no guest PII appear in this document or the artifact.

---

## 1. The finding that shaped the design

**The MarginEdge public API exposes no recipe data of any kind.**

Verified against the developer-portal Swagger export (`info.version 2024-03-19`, extracted
2026-07-01, held at `marginedge-mcp-read-only/docs/api-reference/original/`). The public API is
exactly ten GET endpoints: restaurant units, unit groups, unit-group categories, categories,
orders (invoices/credits), order detail, products, vendors, vendor items, vendor-item packaging.

There is **no** endpoint for:

| The brief assumed | Reality |
| --- | --- |
| recipes | absent from the public API |
| recipe ingredients | absent |
| recipe yields / conversions / subdivisions | absent |
| current plated recipe costs | absent |
| recipe cost history | absent |
| product price history | absent as an endpoint — only `latestPrice` |

MarginEdge's own help centre states the public API is a one-way MarginEdge → external flow;
recipes and plate costing live only in the MarginEdge UI. So the original plan —
"MarginEdge calculates recipe costs, ACE retrieves them" — **cannot be built against this API.**

### What MarginEdge *can* authoritatively supply

- **`GET /products`** — every purchased product with `latestPrice` quoted per `reportByUnit`
  (`Pound`, `Each`, `Case`, `Kilogram`, …), plus category allocation.
- **`GET /orders` + `GET /orders/{id}`** — invoice line items carrying
  `companyConceptProductId`, `quantity`, `unitPrice`, `packagingId` and an `invoiceDate`.
  This is the **only** trustworthy source of "what did this ingredient cost on that date",
  and it is what ACE uses for effective-dated history rather than pretending today's
  `latestPrice` always applied.

### The design that follows

| Layer | Owner | Change frequency |
| --- | --- | --- |
| Ingredient price per purchase unit | **MarginEdge** (invoices) | constantly |
| Quantity of that ingredient per one Toast sellable unit | **ACE mapping**, chef-confirmed | rarely |
| `cost = Σ (quantityPerToastUnit × pricePerUnit)` | ACE | derived |

This still satisfies the core requirement — *a price change must never require re-mapping the
Toast item* — and it changes the operator's job in the intended direction: the chef confirms
**portions once** instead of re-pricing a spreadsheet every month.

It is also a good fit for this menu. AYCE items at Chasin' Tails are overwhelmingly
single-ingredient portions (a cluster of snow crab, a half pound of shrimp, one lobster tail),
so most mappings need one product and one weight.

### A correction worth recording

An interim reading of this audit concluded that snow crab and shrimp were **absent** from the
MarginEdge catalogue. That was wrong. It was an artifact of the interactive MCP connector's
50-page ceiling: `/products` returns records alphabetically, and the scan stopped at ~4,119
records around "R", before `Shrimp…` / `Snow…`. Invoice line items confirm both products exist.
The production client (`scripts/lib/marginedge-client.mjs`) therefore follows the `nextPage`
cursor to exhaustion with a 500-page runaway guard, and never relies on a page cap.

---

## 2. Toast side — the universe being costed

Unchanged from the existing model: Toast remains authoritative for what was consumed. This
audit does not redefine scope. Modifiers (structural `parentSelectionGuid` plus the curated
name list), trivial drinks, AYCE entitlement rows and Tray A–F batching markers are excluded by
`src/cost-rules.mjs` exactly as before.

| Measure | Value |
| --- | --- |
| Business dates audited | 34 |
| AYCE selection rows | 37,108 |
| **Distinct genuine cost-bearing AYCE items** | **63** |
| **Total cost-bearing quantity** | **14,858** |
| Items with no ACE cost at all | 6 (91 units, 0.6%) |
| Items on chef-confirmed costs | **0** |

### Current cost quality, quantity-weighted

| Tier | Quantity | Share |
| --- | --- | --- |
| `rough_estimate` (rough workbook) | 8,799 | 59.2% |
| `fallback_2` (flat $2 menu fallback) | 2,758 | 18.6% |
| `explicit_temp` (management's temporary map) | 1,966 | 13.2% |
| `override` (curated portion rules) | 1,244 | 8.4% |
| uncosted | 91 | 0.6% |
| `confirmed` (chef) | **0** | **0%** |

**77.8% of AYCE quantity is currently priced by rough estimate or a flat $2 fallback, and
nothing is chef-verified.** That is the case for this project. It also means there is no
chef-confirmed data for MarginEdge to overwrite — the migration carries no risk of clobbering
signed-off numbers.

The six uncosted items are `Jumbotron Oyster (AYCE)` (37), `French Bread` (23), `Corn (2)` (13),
`1/4 lb Andouille Sausage` (11), `1/2 lb Andouille Sausage` (5), `Potatoes (3)` (2). All remain
in the missing-cost queue and are **never** silently costed at $0.

---

## 3. MarginEdge side — live data

Read from unit 377809302 on 2026-09-01.

- **Catalogue size:** **5,091 products**, of which **1,163 are in FOOD categories**. The
  interactive MCP connector reached only 4,119 before its page cap — the production client reads
  all 5,091.
- **Food categories** (`categoryType = FOOD`): Seafood `68210`, Meat `68206`, Produce `68224`,
  Dairy `68228`, Grocery and Dry Goods `68208`, Bread `68226`. Everything else
  (Kitchen Utensils `68144`, Repairs and Maintenance `68184`, Paper and Packaging `68212`,
  Liquor `68190`, …) is out of the food-cost universe by construction.
- **Purchasing volume:** 165 invoices totalling $211,613.97 over 2026-07-01 → 2026-07-15.
- **Seafood vendors present and posting line-level detail:** Samuels and Son Seafood
  (account `CHA60`), J.J. McDonnell (`CHA266`), Capital Seaboard, Top Enterprise,
  McLean Meat Co., Fells Point Wholesale Meat, Baldor, Chefs Warehouse.

### Verified ingredient prices

From `GET /products` (authoritative for what `latestPrice` means), cross-checked against Samuels
and Son Seafood invoice `914942`, 2026-07-03 ($14,666.00, 22 line items).

| MarginEdge product | id | `latestPrice` / `reportByUnit` | ACE cost today | ACE tier |
| --- | --- | --- | --- | --- |
| Snow crab, Cluster | `828228826` | **$11.50 / Pound** | $7.50 per cluster | rough |
| Shrimp, 21/25 EZ Peel | `828222605` | **$5.45 / Pound** | $4.85 per lb | rough |
| Shrimp, 21/25 Shell On | `872435171` | **$4.50 / Pound** | $4.85 per lb | rough |
| Prawns, U/6 | `830103928` | **$17.89 / Pound** | $12.00 | rough |
| Lobster, Tails | `837428186` | **$25.00 / Pound** | $12.00 | rough |
| Hamachi, Fillet | `829878135` | **$20.95 / Pound** | $2.50 | rough |
| Catfish, Fillet | `828247232` | **$6.24 / Pound** | $3.00 | explicit |
| Crab Cake mix | `847922298` | **$25.00 / Pound** | $4.00 per piece | override |
| Crawfish, Live | `828247210` | **$4.95 / Pound** | $5.50 | rough |
| Crab, King Legs | `830926106` | **$53.95 / Pound** | $30.00 per leg | rough |
| Lamb, Rack | `835234523` | **$18.76 / Pound** (was $18.51 on 2026-07-03; see §11) | $4.00 | rough |
| Mussels | `830103652` | **$4.99 / Pound** | $5.95 | rough |
| Ice Cream, Vanilla | `828228798` | **$12.72 / Gallon** | $2.00 | fallback |
| Crabs, Blue #2 | `925793217` | $190.00 / **Case** | $12.00 per 2 crabs | rough |

> **Unit semantics matter more than any single price.** `reportByUnit` on the product record — not
> the invoice line — defines what `latestPrice` is per. An interim version of this audit read
> "Lobster Tail 6/7, qty 40 @ $25.00" off invoice `914942` and concluded the price was **$25.00
> per tail**, implying ACE was under-costing the item by ~52% (~$5,200 over the window). That was
> wrong: product `837428186` is priced **per pound**. A 6–7 oz tail is 0.40625 lb ≈ **$10.16**, so
> ACE's $12.00 is in fact slightly *high*. Always take the unit from `/products`.
>
> Product prices also drift from any one invoice (hamachi $17.99 → $20.95, catfish $5.99 → $6.24,
> prawns $17.75 → $17.89). `latestPrice` is the current value; invoice line items are the history.

The genuinely large open questions are now **Lamb Chops** (952 units at ACE $4.00 against
$18.51/lb rack) and **AYCE KING CRAB LEG** (650 units at ACE $30.00 against $53.95/lb) — both
depend entirely on the portion weight the chef confirms.

### Invoice-derived price history (verified working)

`MarginEdgeClient.productPriceHistory()` was run live over 2026-07-01 → 2026-07-06: **68 invoices
scanned, 70 API requests**, credit memos excluded. Real effective dates, from real line items:

| Product | Observations in window | Price |
| --- | --- | --- |
| Snow crab, Cluster | Jul 2, 3, 3, 5 | $11.50 throughout |
| Shrimp, 21/25 EZ Peel | Jul 2, 3, 5, 6 | $5.45 throughout |
| Shrimp, 21/25 Shell On | Jul 3, 5 | $4.50 throughout |
| Lobster, Tails | Jul 3, 5 | $25.00 throughout |
| Prawns, U/6 | Jul 2, 3, 4, 5 | $17.75 (Samuels), **$17.45 (J.J. McDonnell, Jul 4)** |
| Crawfish, Live | Jul 2, 3, 4 | $4.95 throughout |

Two things this establishes:

1. **Prices are stable within a week**, so the daily sync will normally find nothing to write —
   the idempotency guard is doing real work, not defending against a theoretical case.
2. **The same product is bought from different vendors at different prices** (Prawns U/6 at
   $17.75 vs $17.45 on consecutive days), and `latestPrice` is now $17.89 — i.e. whichever
   invoice processed most recently. A single "current price" is therefore a simplification; a
   weighted average over a trailing window would be more stable. Not implemented — it would
   change what the number *means*, which is a management decision, not a code one.

This is the mechanism a historical backfill would use. **No backfill has been run.** ACE's
existing historical cost records are untouched, and the sync refuses any effective date on or
before the frozen pilot window.

---

## 4. MarginEdge data-quality problems found

1. **A mis-mapped invoice line.** On invoice `914942`, the line
   *"New Zealand Green Shell 100% Lump Ready To Make"* (mussels, $4.99) is coded to
   `companyConceptProductId 828264156` — which is the product **"Crabmeat, Lump"**, also on the
   same invoice at **$32.00/lb**. One product id therefore carries two unrelated prices
   differing by 6.4×, which makes `latestPrice` for `828264156` unreliable depending on
   processing order. **Requires a MarginEdge-side fix; ACE cannot repair it.** Until then, no
   mapping should point at `828264156`.
2. **Opaque purchase units — 114 food products.** `Crabs, Blue #2` is priced **per Case**
   ($190.00) and the API exposes no pack size on the product record; `Cheesecake, Plain` is
   $39.79 per **Box**. `Bushel`, `Pack` and counted units (`1000 Each`, `240 Bottles`) have the
   same problem. ACE refuses to guess: such a mapping stays unpriceable until an explicit
   `unitsPerReportByUnit` is supplied.
3. **49 food products priced at $0.00** and 1 with a null price. Any mapping pointing at one is
   held rather than published — a genuine portion is never free.
4. **434 food products with no vendor items attached** (`itemCount: 0`), i.e. no current
   purchasing behind the price. Treat their `latestPrice` as stale until a vendor item exists.
5. **Commingled concepts.** Unit 377809302 covers both Chasin' Tails Falls Church **and** Nue.
   Harmless for *unit prices* — the price of a pound of snow crab is the price — but it means
   this unit's totals must never be read as Chasin' Tails spend. ACE only reads prices.
6. **Non-food noise.** The catalogue is heavily polluted with Amazon/Home Depot purchases
   (plumbing fittings, spray paint, origami cranes, a GoPro, a laptop). The category filter
   handles it: only `categoryType = FOOD` products are candidates.
7. **No product price history endpoint.** Mitigated by deriving history from invoice line
   items, which carry real `invoiceDate` values.
8. **Interactive page caps are not a data gap.** See the correction in §1.

---

## 5. Reconciliation status

Against the full 5,091-product catalogue:

| Status | Items | Quantity | Share of quantity |
| --- | --- | --- | --- |
| `NEEDS_PORTION_SPEC` — candidate ingredient found, portion not yet confirmed | **56** | **13,846** | **93.2%** |
| `NO_MARGINEDGE_PRODUCT` | 7 | 1,012 | 6.8% |
| verified (`EXACT_CONFIRMED_MAPPING` + `VALID_PORTION_CONVERSION`) | 0 | 0 | **0%** |

**93.2% of AYCE quantity already resolves to a plausible MarginEdge ingredient.** What is missing
is not data from MarginEdge — it is the portion weight per Toast item. No mapping has been
chef-confirmed yet, so **verified coverage is 0%** and the sync writes nothing. That is the
correct starting state: name similarity generates candidates for review and never a trusted
mapping.

Candidate quality is good where it matters. Top-ranked candidate for `SNOW CRAB (2 Clusters)` and
`SNOW CRAB (1 Cluster)` is `Snow crab, Cluster` (score 1.00); for `AYCE KING CRAB LEG`,
`Crab, King Legs` (1.00); for `Blue Crabs (AYCE 2)`, `Crabs, Blue #2` (1.00); for `1 pc crab
cake`, `Crab Cake mix` (0.94); for `Vanilla Ice Cream`, `Ice Cream, Vanilla` (1.00).

The 7 items with **no** MarginEdge product are all composed/prepared dishes, which is exactly what
a missing recipe API costs you: `BEIGNETS` (457), `SOUTHERN HUSH PUPPIES` (197),
`Whole Dang Thang` (120, a combo tray), `Clam Chowder CUP (SMALL)` (115),
`ROYAL SURF N' TURF (AYCE - 20oz)` (93, a combo), `Crisp Calamari` (25),
`Clam Chowder BOWL (LARGE)` (5). These need either multi-component mappings built from their
sub-ingredients or they stay on the manual cost path.

| Status | Meaning |
| --- | --- |
| `EXACT_CONFIRMED_MAPPING` | confirmed 1:1 mapping, priced directly |
| `VALID_PORTION_CONVERSION` | confirmed mapping with an explicit portion/pack factor |
| `NEEDS_PORTION_SPEC` | candidate ingredient found; portion quantity not yet confirmed |
| `NEEDS_REVIEW` | a mapping exists but is not confirmed |
| `INVALID_MARGINEDGE_COST` | confirmed mapping that cannot be priced (missing product, opaque unit, $0) |
| `NO_MARGINEDGE_PRODUCT` | no FOOD product shares a content word with the Toast item |
| `EXCLUDED_NON_COST_ITEM` | excluded by mapping (batching markers etc.) |

**26 proposed mappings** (13 original + 13 added on 2026-09-01) covering the highest-volume and
highest-variance items are staged in
[`config/marginedge_mappings.seed.json`](../config/marginedge_mappings.seed.json). Each carries
the exact MarginEdge product id and price, the portion evidence MarginEdge itself supplies
(vendor-item size grades, packaging pack sizes — see §11), a `resolution` code saying whether the
portion is already determined or who still has to answer one question, and where a number is
still an assumption it is marked ASSUMED so the reviewer only has to correct it.

---

## 6. Safeguards and thresholds

Implemented in `src/marginedge-cost.mjs`, tested in `test/marginedge-cost.test.mjs`.

| Guard | Threshold | Behaviour |
| --- | --- | --- |
| Unconfirmed mapping | any | `skip` — no cost derived |
| Derived cost below | $0.01 | `hold` — a genuine portion is never free |
| Derived cost above | $200 / portion | `hold` — treated as a unit error |
| Increase vs current | > +60% | `hold` for review |
| Decrease vs current | > −40% | `hold` for review |
| Change below | $0.005 | `unchanged` — keeps the sync idempotent |
| Any unpriceable component | — | whole item unpriceable; no partial sum published |

`hold` means **the last trustworthy cost stays live** and the anomaly is recorded in
`ace_marginedge_sync_runs.payload.exceptions`. A slightly stale verified cost is always
preferred to a new corrupted one. Thresholds are deliberately conservative for a first
production run and are a single edit in `DEFAULT_GUARDS`.

---

## 7. Precedence

`src/cost-rules.mjs` ranks (lower wins):

| Rank | Source |
| --- | --- |
| 1 | `chef_confirmed` |
| **1.5** | **`marginedge` + verified mapping** |
| 2 | `portion_override` |
| 3 | `explicit_temp` |
| 4 | `rough_workbook`, **`marginedge` with an unconfirmed mapping** |
| 5 | `menu_fallback` ($2) |
| 6 | legacy "Sides/Desserts/Sauce" umbrella |

A verified MarginEdge cost replaces every temporary rule but **never** outranks a cost the chef
signed off directly. Verified MarginEdge quantity is reported in its own `marginedge` coverage
tier, separate from both `confirmed` and `rough_estimate`.

A MarginEdge cost is `verification: 'verified'` **only** because a human confirmed the portion
mapping behind it — never because the API returned a number.

---

## 8. What still needs a human — after the 2026-09-01 vendor-item audit (§11)

The original list below asked the chef roughly a dozen weights. Reading MarginEdge's vendor
items, packaging records and a month of invoice lines (§11) settles or narrows most of them.
Ordered by impact.

### 8a. Chef only — plated weight or count the kitchen alone knows (6)

1. **Lamb Chops — chops per unit** (952 units). Weight per chop is now derived from MarginEdge
   (18/20 NZ frenched rack ÷ 8 ribs = 2.375 oz = $2.75 at $18.51/lb); only the count is open.
   `docs/CHEF_COSTS.md` carries an unconfirmed "2 chops" example; purchases-vs-sales point to 3–4.
   2 chops = $5.50, 3 = $8.25 vs ACE $4.00.
2. **1 pc crab cake — raw mix weight** (696 units). Mix is bought by weight ($125 per 5 lb tub);
   nothing in MarginEdge states the cake size. 3 oz = $4.69, 4 oz = $6.25 vs ACE $4.00.
3. **Imperial Wagyu Zabuton — raw oz and trim yield** (569 units). Product firm (chuck flap,
   $22.20/lb); 4 oz = $5.55, 5 oz = $6.94 vs ACE $5.94.
4. **Hamachi Crudo — orders per ~4.3 lb fillet** (311 units). Fillets are catch-weight sides;
   state orders per fillet or trimmed oz + yield. 3 oz at 70% yield = $5.61 vs ACE $2.50.
5. **Gator Bites — oz of tail meat per order** (218 units). 6 oz = $4.68 vs ACE $3.00.
6. **GREEN-LIPPED MUSSELS — half-shells per order** (438 units) and **Crisp Catfish — one whole
   5–9 oz fillet or a fixed cut** (99 units); **Vanilla Ice Cream — scoop size** (448 units, $0.40
   per 4 oz scoop vs the flat $2.00 fallback). Low dollars each; batch them into the same visit.

### 8b. Purchasing / receiving — one count off a case or packing slip (4)

7. **Snow crab — clusters per 30 lb US Foods case** (1,572 units, 10.6% of AYCE quantity).
   Every purchase is the 8/Up grade, so a cluster is ≥ 8 oz; counting one case gives the average
   (480 oz ÷ count). 9 oz default: $6.31 / $12.63 vs ACE $7.50 / $14.50.
8. **King crab — legs and claws in one 20 lb J.J. McDonnell 16/20 Gold case** (650 units). 94%
   of August pounds are that SKU; 16/20 = 16–20 pieces per 10 lb. Legs-only: $29.97 (= ACE's
   $30); legs + claws: ~$25 per leg / ~$22.50 per piece.
9. **Blue Crabs — which case feeds AYCE and how many crabs were in the last one** (450 units).
   None of August's purchases is labelled #2 despite the product name; Samuels' own spec is 6–7
   dozen per #1 bushel box, 8–10 dozen per #2. Envelope $2.08–$6.25 per two crabs.
10. **Skinny Dippers — confirm "100 CT" on a J.J. McDonnell invoice** (401 units). Grower spec
    and every sibling East Coast packaging record say 100 per box; ACE's own $4.68 ÷ 6 = $78 per
    100. $4.38 / $8.75 vs ACE $4.68 / $9.36.

### 8c. Manager — a yes/no, no weighing (3)

11. **AUS KING PRAWNS — prawns per AYCE order (2, 3 or 4)**. The kitchen specs the SKU by count
    ("Must Be 6-8!" = 6–8 per lb); à-la-carte is named "(1/2 lb)" = 3–4 prawns; the AYCE item
    carries no portion. $2.56 per prawn at $17.89/lb; 3 = $7.67 vs ACE $12.00.
12. **Shrimp bags — which case feeds which item**: EZ PEEL from the Samuels 21/25 Quick Peel case
    ($5.45/lb) and JUMBO WHITE from the Tropic 21/25 shell-on case ($4.50/lb), not the reverse.
13. **AYCE RIBEYE (8oz) — cost at 100% yield ($9.27) or apply a cutting yield** (85% → $10.91)?
    Steaks are cut in-house from 112A rolls; bone-in is ruled out (24 oz steaks).

### 8d. Resolved without anyone — MarginEdge + the Toast name (9 mappings)

LOBSTER TAIL (6-7oz) $10.16 · EZ__PEEL SHRIMP 1LB $5.45 / 1/2LB $2.73 · JUMBO WHITE SHRIMP 1 LB
$4.50 / 1/2LB $2.25 · HEAD ON SHRIMP 1LB $3.95 / 1/2LB $1.98 · (6)/(12) FANNY BAY Oysters $8.10 /
$16.20 · LOUISIANA CRAWFISH $4.95 (portion "1 pound" is published on the restaurant's own menu).
These stay `proposed` because the architecture only publishes costs a human has confirmed — a
manager can flip them to `confirmed` from the evidence in the seed file without visiting the kitchen.

### 8e. MarginEdge-side fixes (in the MarginEdge UI — ACE cannot and must not change them)

- **Crab, King Legs `830926106`** mixes J.J. McDonnell Gold 16/20 at $53.95/lb with Restaurant
  Depot Red 20-Up at $31.4/lb. `latestPrice` flips with whichever invoice processed last (both
  vendors invoiced 2026-08-29). Split by grade/species.
- **Crabs, Blue #2 `925793217`** received no #2 in August — 10 units #1, 10 ungraded, $125–$299
  per case; the sister `Crabs, Blue #1` is an orphan. Rename/merge and record a count on the
  packaging.
- **Oysters, Shigoku `833486701`** is the de-facto West Coast half-shell product (64 vendor items,
  100% of August Fanny Bay volume); `Oyster, Fanny Bay` `942139937` is a near-orphan. Rename/merge.
- **Prawns, U/6 `830103928`**: nothing bought is U/6 (all 6/8); orphan `Shrimp, 6/8` `1266217520`
  holds the stale $13.99 with no vendor items — retire it once no ACE mapping points there.
- **Crawfish, Live `828247210`** holds the frozen cooked SKU while `Crawfish, Whole Cooked` sits
  empty; **Skinny Dipper packaging `76807`** has no count (set 100 EACH); **PFG ice-cream packaging
  `8978541`** records a 3 gal tub as 1 gallon; **Crabmeat, Lump `828264156`** still carries the
  mussels line from invoice `914942` (§4.1).
- Samuels vendor items have **no vendor codes and no packaging records**, and their names carry
  order notes and OCR bleed from adjacent lines ("4ea Frz Yellowtail Jap Oyster Fanny Bay"). Never
  read a pack count from a Samuels item name.

### 8f. Still out of reach

**Composed dishes** (beignets, hush puppies, clam chowder, Whole Dang Thang, Royal Surf N' Turf,
calamari) — no single MarginEdge product; decide multi-component mappings or keep manual costs.

---

## 9. Live end-to-end verification

> Historical (2026-09-01 morning run). The portion figures below were back-solved from ACE's rough
> costs; §11 replaces them with vendor-grade evidence and the 26-row seed. Kept for the method.

Run with the 13 staged mappings treated as chef-confirmed, against the live MarginEdge prices in
§3 and the real Toast quantities in the artifact. This exercises the whole chain:
Toast item → ACE mapping → MarginEdge product → portion logic → MarginEdge price →
effective-dated ACE cost → quantity × cost.

**VERIFIED AND AUTOMATED** — the sync would publish these:

| Toast item | qty | ACE now | MarginEdge | Δ/unit | 34-day Δ | portion |
| --- | --- | --- | --- | --- | --- | --- |
| `AUS KING PRAWNS` | 455 | $12.00 | **$12.09** | +$0.09 | +$43 | 0.676 lb @ $17.89/lb |
| `LOBSTER TAIL (6-7oz)` | 400 | $12.00 | **$10.16** | −$1.84 | **−$737** | 0.40625 lb @ $25.00/lb |
| `EZ__PEEL SHRIMP 1/2LB` | 371 | $2.50 | **$2.73** | +$0.23 | +$83 | 0.5 lb @ $5.45/lb |
| `Hamachi Crudo` | 311 | $2.50 | **$2.91** | +$0.41 | +$128 | 0.139 lb @ $20.95/lb |
| `EZ__PEEL SHRIMP 1LB` | 255 | $4.85 | **$5.45** | +$0.60 | +$153 | 1 lb @ $5.45/lb |
| `Crisp Catfish` | 99 | $3.00 | **$3.12** | +$0.12 | +$12 | 0.5 lb @ $6.24/lb |
| `JUMBO WHITE SHRIMP 1 LB` | 71 | $4.85 | **$4.50** | −$0.35 | −$25 | 1 lb @ $4.50/lb |

**1,962 units (13.2% of all AYCE quantity), $13,843 → $13,500 — a net −2.5%.** ACE is currently
*over*-costing this subset, driven almost entirely by lobster tail. That is the opposite of the
direction an earlier draft of this audit predicted, and it is why the unit semantics in §3 matter.

**VERIFIED BUT REQUIRES MANUAL MAPPING** — no change until the chef supplies the real portion.
Five items (2,939 units, 19.8% of AYCE quantity) resolve to the correct MarginEdge product and
price, but their portion was back-solved from ACE's existing rough cost, so the derived cost
reproduces the current cost *by construction*: `SNOW CRAB (2 Clusters)` (1,184), `1 pc crab cake`
(696), `LOUISIANA CRAWFISH` (453), `SNOW CRAB (1 Cluster)` (388), `Gator Bites` (218). Add the
un-staged high-volume items — `Lamb Chops` (952), `AYCE KING CRAB LEG` (650),
`Imperial Wagyu Zabuton` (569) — and **the value of this project is unlocked by roughly a dozen
portion answers, not by more code.**

**NEEDS HUMAN CONFIRMATION** — held by the safeguards, nothing published:

- `Blue Crabs (AYCE 2)` — `Crabs, Blue #2` is priced per **Case** ($190.00); needs a
  crabs-per-case figure before it can be costed. 450 units blocked.

**MISSING OR INCOMPLETE IN MARGINEDGE** — product `828264156` carries two unrelated prices (§4.1);
no mapping may use it until MarginEdge is corrected. The seven composed dishes in §5 have no
single MarginEdge product at all.

**EXCLUDED FROM THE FOOD-COST MODEL** — unchanged from the existing engine: Toast modifiers,
preparation notes, Tray A–F batching markers, trivial drinks, AYCE entitlement rows.

Verified coverage is **0% today** and will stay 0% until mappings are confirmed. No coverage
figure in this document is claimed as accuracy the reconciliation does not support.

## 10. Operating model

| Source | Cadence | Manager action |
| --- | --- | --- |
| **Toast** | nightly ~6:00 AM NY, `nightly-ingest.yml` | none |
| **MarginEdge** | daily ~6:20 AM NY, `marginedge-costs.yml` | none |
| **OpenTable** | nightly GuestCenter CSV | upload after service |

The three run independently. A MarginEdge failure cannot block Toast ingestion; a missing
OpenTable upload cannot stop food cost from calculating; a Toast failure does not corrupt cost
state. Freshness is tracked per source in `ace_source_status`.

The manual chef CSV/XLSX cost upload **remains available** as a fallback, emergency override and
correction tool. It is simply no longer the normal path.

---

## 11. Vendor-item, packaging and invoice audit — 2026-09-01

### 11.1 Why this section exists

The brief for this pass assumed MarginEdge recipes could supply portions. They cannot: the
read-only MCP's own capability report lists *recipes, menu engineering, theoretical usage* as
unsupported, and the public API has no recipe endpoint (§1). What MarginEdge **does** carry, and
the previous audit did not use, is one level below the product:

| MarginEdge object | What it told us |
| --- | --- |
| Vendor item names (`/vendors/{id}/vendorItems`) | **size grades** — "Lobster Tails cw 6-7oz", "King Crab Legs 16/20 Gold", "Snow Crab Clusters 8/Up", "Lamb N.Z Rack 18/20 Frenched", "King Prawn Head On 6/8" |
| Packaging records (`/packaging`) | **pack sizes** — Case/10LB, Case/30LB, Case/120EA, Case/36EA |
| Invoice lines (`/orders/{id}`, 2026-08-01 → 09-01) | **which SKU is actually bought**, at what price, how often |

Read GET-only through the production client (`scripts/lib/marginedge-client.mjs`): 5,091 products,
93 vendors, 4,345 vendor items (667 on the products of interest), 240 packaging records, 424
invoices / 618 relevant lines. Four packaging records were re-read through the read-only MCP
(`marginedge_get_vendor_item_packaging`) and matched byte-for-byte. Every conclusion was then
challenged by an independent skeptic with web access to the relevant trade conventions
(seafood count grades, rack rib counts, cut names); their corrections are folded in below.
Nothing was written to MarginEdge.

### 11.2 Result per mapping

| Toast item | MarginEdge product · price basis | Portion evidence | Derived cost | ACE now | Who still answers |
| --- | --- | --- | --- | --- | --- |
| LOBSTER TAIL (6-7oz) | Lobster, Tails `837428186` · $25.00/lb (Aug wtd $24.65) | all 18 Aug lines are the 6/7 oz grade (Samuels, Capital Seaboard, JJM) | **$10.16** (band $9.24–10.94) | $12.00 | nobody |
| EZ__PEEL SHRIMP 1LB / 1/2LB | Shrimp, 21/25 EZ Peel `828222605` · $5.45 (1,460 lb, flat) | portion in the name | **$5.45 / $2.73** | $4.85 / $2.50 | nobody |
| JUMBO WHITE SHRIMP 1 LB / 1/2LB | Shrimp, 21/25 Shell On `872435171` · $4.50 (880 lb, flat) | portion in the name; 21/25 is the "jumbo" grade | **$4.50 / $2.25** | $4.85 / $2.50 | manager: which case feeds which bag |
| HEAD ON SHRIMP 1LB / 1/2LB | Shrimp, 16/20 Head On `838546958` · $3.95 (30/40-per-kg head-on, 200 lb) | portion in the name | **$3.95 / $1.98** | $4.85 / $2.50 | nobody |
| (6)/(12) FANNY BAY Oysters | Oysters, Shigoku `833486701` (de-facto Fanny Bay product) · $1.35 each (Aug wtd $1.28) | count in the name, product per Each | **$8.10 / $16.20** | $10.80 / $21.60 | nobody |
| LOUISIANA CRAWFISH | Crawfish, Live `828247210` · $4.95 (1,440 lb, flat; frozen cooked SKU) | "1 pound" published on the restaurant's own menu | **$4.95** | $5.50 | chef, optional: weighed frozen or thawed |
| AUS KING PRAWNS | Prawns, U/6 `830103928` · $17.89 (was $13.99 until ~08-22) | 6/8 per lb; à-la-carte "(1/2 lb)"; AYCE count not stated | $2.56/prawn → 3 = **$7.67**, ½ lb = $8.95 | $12.00 | manager: prawns per AYCE order |
| AYCE RIBEYE (8oz) | Beef, Ribeye Boneless `872453321` · $18.54 (Aug wtd $18.30) | 8 oz in the name; 112A rolls cut in-house | **$9.27** at 100% yield, $10.91 at 85% | $10.00 | manager: yield policy |
| SNOW CRAB (1) / (2 Clusters) | Snow crab, Cluster `828228826` · $11.50 (Aug wtd $11.23; 82% US Foods) | 8/Up grade ⇒ ≥ 8 oz per cluster; average not recorded | 9 oz default **$6.31 / $12.63** | $7.50 / $14.50 | receiving: clusters per 30 lb case |
| AYCE KING CRAB LEG (1 leg) | Crab, King Legs `830926106` · $53.95 (JJM Gold 16/20, 94% of lb) | 16/20 = 16–20 pieces per 10 lb | legs-only **$29.97**; legs+claws ~$25 | $30.00 | receiving: legs vs claws per case |
| Blue Crabs (AYCE 2) | Crabs, Blue #2 `925793217` · $190/case (range $125–299, wtd $220) | no count on any purchased SKU; Samuels spec 6–7 dz (#1) / 8–10 dz (#2) | $2.08–$6.25 per 2 | $12.00 | purchasing: which case + count |
| (6)/(12) Skinny Dippers | Oysters, Skinny Dipper `828495545` · $72.95/box | 100 per box (grower spec, sibling packaging, ACE's own $78/100) | **$4.38 / $8.75** | $4.68 / $9.36 | receiving: confirm "100 CT" |
| Lamb Chops | Lamb, Rack `835234523` · $18.51 (99.6% of lb; latest $18.76) | 18/20 rack ÷ 8 ribs = 2.375 oz/chop ⇒ **$2.75/chop** | 2 chops $5.50 / 3 chops $8.25 | $4.00 | chef: chops per unit |
| 1 pc crab cake | Crab Cake mix `847922298` · $25.00/lb ($125 per 5 lb tub) | none — bought by weight | 3 oz $4.69 / 4 oz $6.25 | $4.00 | chef: raw weight |
| Imperial Wagyu Zabuton | Beef, Wagyu Chuck Flap `1025408720` · $22.20 (Aug $21.90–23.49) | zabuton = chuck flap; portion not recorded | 4 oz $5.55 / 5 oz $6.94 | $5.94 | chef: raw oz + yield |
| Hamachi Crudo | Hamachi, Fillet `829878135` · $20.95 (SKU change from $15.99; Aug wtd $18.12) | whole 4.1–4.6 lb sides | 3 oz @ 70% yield $5.61 | $2.50 | chef: orders per fillet |
| Gator Bites | Alligator, Meat `828264177` · $12.49 (12 × 1 lb packs, flat) | none | 6 oz $4.68 | $3.00 | chef: oz per order |
| Crisp Catfish | Catfish, Fillet `828247232` · $6.24 (Aug wtd $6.28) | sized SKUs bracket a fillet at 5–9 oz | 7 oz fillet $2.73 | $3.00 | chef: whole fillet or cut weight |
| GREEN-LIPPED MUSSELS | Mussels `830103652` · $4.99 (912 lb, flat) | plated by the piece; grade not recorded | $0.26–0.55 per half-shell | $5.95 | chef: count per order |
| Vanilla Ice Cream | Ice Cream, Vanilla `828228798` · $12.72/gal | none | 4 oz scoop $0.40 | $2.00 fallback | chef: scoop size |

**Tally of the 13 original mappings:** 4 fully resolved (lobster tail, EZ peel ×2, jumbo white
1 lb); 1 resolved from the restaurant's published menu (crawfish); 1 needs a manager yes/no
(prawns); 2 need a receiving count (snow crab ×2); 1 needs a purchasing count (blue crabs); 4 need
the chef (crab cake, hamachi, gator, catfish). **13 further mappings were added**, of which 5 are
fully resolved (jumbo white ½ lb, head-on ×2, Fanny Bay ×2).

### 11.3 Recomputed prices — where `latestPrice` and the month disagree

`latestPrice` is whichever invoice processed last. Recomputing from the actual August lines:

| Product | `latestPrice` | August, quantity-weighted | Why they differ |
| --- | --- | --- | --- |
| Snow crab, Cluster | $11.50 | **$11.23** | 82% of pounds came from US Foods at $11.17 ($335/30 lb); Samuels ($11.50) merely invoiced last |
| Lamb, Rack | $18.76 | **$18.51** | one 2 lb line on 08-31 set the latest; 530 of 532 lb were $18.51 |
| Lobster, Tails | $25.00 | **$24.65** | Capital Seaboard $23.90 and JJM $24.90 alongside Samuels $25.00 |
| Prawns, U/6 | $17.89 | ~$14–15 | a +28% step from $13.99 landed ~08-22; $17.89 is the correct forward price |
| Hamachi, Fillet | $20.95 | **$18.12** | SKU change (frozen "Mandarin Orange feed") overlapping the $15.99 regular fillet |
| Crab, King Legs | $53.95 | ~$52.60 | Restaurant Depot Red 20-Up at $31.4/lb (6% of lb) shares the product — a −42% flip is one invoice away |
| Crabs, Blue #2 | $190 | **$220** | $125–$299 per case inside one month, mixed grades and containers |
| Oysters (Fanny Bay) | $1.35 | **$1.28** | Stanley Pearlman 120-ct cases at $1.08 each are 26% of volume |
| Ice Cream, Vanilla | $12.72/gal | $13.7–14.0 (US Foods) | PFG packaging `8978541` records a 3 gal tub as 1 gallon |

None of these is an ACE defect — the sync deliberately uses `latestPrice` and the ±60/−40% guards
hold a flip — but they are the reason a trailing weighted average (noted in §3 as a management
decision) would be more stable than "last invoice wins".

### 11.4 Independent recomputations (step "validate the data")

Every line below was recomputed from raw invoice lines and agrees with the derivation the sync
would perform:

- Shrimp 21/25 EZ Peel: 26 lines, 1,460 lb, every `linePrice = qty × 5.45` → $5.45/lb ✓
- Shrimp 21/25 Shell On: 16 lines, 880 lb, `qty × 4.50` ✓
- Crawfish: 23 lines, 1,440 lb (all multiples of 20 lb = 4 × 5 lb bags), `qty × 4.95` ✓
- Lobster tails: 210 lb × $25.00 + 11 cases × $239 (10 lb) + 40 lb × $24.90 = $8,875 / 360 lb = $24.65 ✓
- Snow crab: 94 cases × 30 lb × $11.17 + 600 lb × $11.50 = $38,390 / 3,420 lb = $11.23 ✓
- King crab: 620 lb × $53.95 (JJM) vs 2 × 20 lb cases at $625.35 / $629.99 (RD) = $31.27–31.50/lb ✓
- Alligator: 13 lines, 204 lb, `qty × 12.49` ✓ · Mussels: 26 lines, 912 lb, all $4.99 ✓

No arithmetic discrepancy was found between MarginEdge's `latestPrice` and the most recent
invoice for any mapped product; the material discrepancies are the **within-product mixes**
(king crab, blue crab, hamachi, prawns) listed in §8e, which are MarginEdge coding issues.

### 11.5 Read-only and secret-handling hardening made in this pass

Two independent code audits (five lenses, two skeptics per finding, one completeness critic)
found **no path by which ACE or the MCP server can change anything in MarginEdge**: the only
network primitive is `MarginEdgeClient._get`, its method is the literal `GET`, the host is a
module constant, the browser never touches MarginEdge, and the only outbound call from the
database (`pg_net`) targets `api.github.com`. Hardening applied anyway:

- `redirect: 'error'` on the MarginEdge fetch — a cross-origin redirect would otherwise carry the
  `x-api-key` header to a third host (fetch strips only `Authorization`). Test added.
- API key held as a non-enumerable property so `console.log(client)` cannot print it.
- `workflow_dispatch` inputs are passed through `env:` instead of being interpolated into `run:`
  lines that hold secrets (both workflows). Tests added.
- `permissions: contents: read` on all three workflows.
- CI secret scan extended to `MARGINEDGE_API_KEY`; a static test forbids the key name, the
  `x-api-key` header and `api.marginedge.com` in any browser-shipped file.
- `audit-marginedge-costs.mjs` top-level error handler now runs `sanitizeError`.

Known, deliberately **not** changed here (security debt to schedule separately): every
`pg.Client` uses `ssl: { rejectUnauthorized: false }`; the GitHub Pages deploy has no CSP; the
browser trusts `data/supabase_config.json` without a host check; the MCP server and ACE share one
MarginEdge API key (not independently rotatable); the MCP repo has no CI running its own
`verify:read-only` scan.
