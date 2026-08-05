# Metric definitions (binding)

## AYCE program food cost — the tracked metric (default view)

Management tracks food cost for **AYCE tables and the items rung at $0 as AYCE
rounds** — nothing else. À-la-carte items, including Royal Feast trays sold at menu
price, are priced individually and sit **outside** the tracked program metric.

| Term | Definition |
|---|---|
| AYCE check | A check containing an AYCE entitlement selection (`CLASSIC/PREMIUM/ROYALTY PER PERSON`, kids tiers) |
| Entitlement revenue | Net revenue of the entitlement selections (the per-person AYCE price) |
| AYCE round | A **$0-rung**, Food-category selection on an AYCE check |
| AYCE food cost $ | Σ (round quantity × effective unit cost) |
| **AYCE food cost %** | AYCE food cost $ ÷ entitlement revenue |
| Cost per AYCE cover | AYCE food cost $ ÷ entitlement covers |
| Round coverage | % of round **quantity** with a costed item (rounds have no revenue, so coverage is judged on quantity) |

Priced add-ons on an AYCE check (a $30 à-la-carte lobster, a Royal Feast tray) are
excluded from both sides of the program metric.

### Classification precedence (binding — src/cost-rules.mjs)

Every selection is classified before costing, in this strict order:

| Level | Rule |
|---|---|
| **A. Excluded modifiers / non-cost signals** | Any Toast selection with a `parentSelectionGuid` (structural modifier metadata), plus a curated normalized-name fallback for known modifier names ("Med Well", "Melted Butter", "Bday", "No Potato Extra Corn", Tray A–F, …). Never cost items: they add no cost, never appear in missing-cost lists, never reduce coverage, never receive the $2 fallback. |
| **B. Drinks** | Trivial drinks (fountain drinks, sweet tea, lemonade, Coke/Coke Zero/Sprite, …) are ignored by this temporary model — even when Toast miscategorizes them as Food. Same non-effects as A. |
| **C. Explicit portion overrides** | Every recognized ½-lb shrimp portion = **$2.50** (half of the $5 pound; EZ-Peel / Head-On / Jumbo White spellings normalized). Every one-piece crab cake = **$4.00**. Overrides beat generic aliases and every temporary cost. |
| **D. Explicit canonical temporary costs** | WDT $10 · Catfish $3 · Shrimp $2 · Gator $3 · Blackened Wings $2 · Tenders $3 · Shrimp Tacos $3 · Catfish Tacos $3 · Honey Shrimp $4 · Calamari $4 · Blackened Salmon $6 · Shrimp Scampi $4 · Gumbo $6 · Small/Large Clam Chowder $2/$4 · Crab Dip $4 (aliases normalized). |
| **E. $2 supplied-menu fallback** | Genuine supplied-menu items with no explicit cost (Cajun Fries, Fresh Garlic Noodles, Brussels Sprouts, Mac & Cheese, Hush Puppies, Beignets, cheesecakes, Ice Cream, real sauce items). Each surfaces under its own canonical name — never buried in a "Sides/Desserts/Sauce" bucket. |
| **Missing** | A real food item outside the above stays in the missing-cost list — **never silently $0**. |

**Chef-confirmed costs outrank every temporary rule (C–E)** — uploading the
chef's sheet replaces the temporary model item by item, effective-dated.
Coverage is computed over genuine cost-bearing items only (A/B and the AYCE
entitlement rows are out of the denominator), so modifiers can never mask a
real gap.

### Distribution statistics (server drill-downs)

Two figures shown together, never substituted:
- **Weighted mean** = Σ cost ÷ Σ AYCE sales — the actual financial impact.
- **Median check %** — the typical table; robust to "whale" tables. Quartiles /
  IQR and a Tukey outlier line (Q3 + 1.5·IQR) identify unusually expensive checks.

An **All food (context)** scope remains available on the page for the blended view;
everything below applies to that mode.

## Food cost (all-food context mode)

| Term | Definition |
|---|---|
| Extended food cost | `nonvoided_quantity × effective_cost_per_portion` per item selection |
| Food cost dollars | Σ extended food cost over matched food selections in scope |
| Eligible net food revenue | Σ (gross − discounts) over non-voided **Food**-category selections. Excludes tax, tips, service charges, gift cards, non-food categories, voided items. Selection discounts are netted directly; check-level discounts are prorated across the check's food selections by gross value. |
| Food cost % | food cost dollars ÷ eligible net food revenue |
| Baseline food cost % | **Weighted**: Σ baseline cost ÷ Σ baseline eligible revenue over the baseline range. Never an average of per-server percentages. |
| Variance | server (or scope) food cost % − baseline %, in percentage points |

**Cost resolution hierarchy** per selection: ① Toast item GUID → ② configured alias
(`imports/alias_map.json`) → ③ normalized item-name equality → ④ **unmatched review
queue**. Unmatched items contribute revenue but no cost — the shortfall is reported as
cost-mapping coverage; **no item is ever silently costed at $0**.

**AYCE entitlement items** (`CLASSIC/PREMIUM/ROYALTY PER PERSON` and kids variants)
carry an explicit, documented **$0 direct cost**: the food a table actually orders
arrives as separate AYCE round selections which carry the real cost.

**Effective dating.** Every cost record has `effective_from`/`effective_to`. Historical
results are computed with the cost effective on the business date, so replacing a rough
cost with a chef-confirmed cost never rewrites history.

**Status flags** (configurable; defaults):
- Normal — within 10 points of baseline
- Watch — 10 to 14.99 points above baseline
- Critical — 15+ points above baseline
- Insufficient sample — fewer than 5 checks **or** under $500 net food sales
- Insufficient coverage — under 60% of the server's food revenue is cost-mapped

Estimated food cost measures what the POS recorded as served. **It is not inventory
variance and never attributes kitchen waste to an individual.**

## Conversion (unchanged from pilot — binding)

Intent values: `UNDECIDED` · `ALC` · `PREDECIDED_AYCE` · `UNKNOWN`.
Blank, missing, unmarked or ambiguous intent **is** `UNKNOWN`.

- Eligible = explicitly `UNDECIDED` or `ALC`.
- Converted = eligible **and** qualifying AYCE sales.
- Conversion rate = converted eligible ÷ all explicitly eligible.
- `UNKNOWN` and `PREDECIDED_AYCE` are excluded from **both** numerator and denominator.
- Both still count toward AYCE mix, AYCE revenue, overall sales and food cost.
- Neither ever generates commission. Missing host data must never help or hurt a server.
- Ambiguous Toast↔OpenTable matches sit in a review queue and never feed commission
  until resolved.

## Attribution

- Table visit = one Toast **order**; split checks are that order's multiple checks.
  Table-level analytics aggregate once per visit; check drilldown keeps each check.
- Server attribution uses the Toast order's server (check owner). Selection-level
  owners are preferred when the API exposes them reliably; transferred/mixed-owner
  checks are flagged, never double-counted.

## Commission program status

The $5/$7.50/$10 (classic/premium/royalty) conversion commission applied to the pilot
weekend **Jul 31 – Aug 2, 2026 only**. It is currently **inactive**
(`config/feature_flags.json → commission_program`). No commission accrues outside the
pilot window unless management re-enables the program with an explicit effective date.
