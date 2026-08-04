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

Preparation modifiers (spice level, sauce choice, steak temperature, omissions like
"No Corn, No Potato") carry an explicit $0 — their cost is inside the item costs.
Priced add-ons on an AYCE check (a $30 à-la-carte lobster, a Royal Feast tray) are
excluded from both sides of the program metric.

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
