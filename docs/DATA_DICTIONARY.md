# Data dictionary

## data/live/selections_<YYYYMMDD>.json — normalized item selections (PII-free)

| Field | Type | Notes |
|---|---|---|
| businessDate | string YYYYMMDD | Toast business date, not UTC calendar date |
| orderGuid / checkGuid / selectionGuid | uuid | stable Toast source IDs (idempotency keys) |
| parentSelectionGuid | uuid\|null | set on modifier rows (nested selections flattened) |
| itemGuid / itemGroupGuid | uuid\|null | Toast menu references |
| itemName | string | display name as rung |
| quantity | number | per recorded Toast quantity (weight items are in native units, e.g. lbs) |
| gross / preDiscountPrice | number | pre-discount extended price |
| discount | number | selection-level applied discounts |
| net | number | Toast post-modifier price; engine nets discounts on top |
| voided | bool | voided selections are excluded from every metric |
| salesCategoryGuid | uuid | Food/Liquor/… (modifiers inherit their parent's category) |
| serverGuid | uuid | order server (attribution rule: docs/METRICS.md) |
| tableGuid | uuid\|null | resolve display name via reference.tables |
| revenueCenterGuid / serviceAreaGuid / diningOptionGuid | uuid | context |

## data/live/checks_<YYYYMMDD>.json

Per check: GUIDs, serverGuid, tableGuid, openedDate/closedDate, numberOfGuests,
voided, amount (net of tax), taxAmount, totalAmount, checkLevelDiscount, tips,
serviceCharges. Split checks share an orderGuid → one table visit.

## data/live/reference.json

GUID→name maps: employees, revenueCenters, serviceAreas, diningOptions, tables,
salesCategories. Regenerated on every ingestion.

## data/live/item_costs.json — the cost master

id · toastItemGuid · toastSelectionGuid · canonicalName · aliases[] · portion ·
costPerUnit · effectiveFrom/effectiveTo (YYYYMMDD; null = open) · source
(`rough_workbook` | `chef_confirmed` | `vendor_derived` | `manual`) · verification ·
notes · createdAt/updatedAt/updatedBy.

## data/live/ingestion_runs.json

Append-only run log: runId, source, adapter, businessDate, timestamps, status,
row counts, warnings, error.

## data/live/manifest.json

Available dates + lastToastSync — the freshness source of truth for the UI.

## data/ace_payload.js

The frozen pilot extract that drives the legacy analytics pages (overview, servers,
commission). Numbers locked to the shipped pilot report; regression-guarded by
`test/security-scaffold.test.mjs` (reconciliation test).

## data/raw/ (gitignored)

Immutable gzipped Toast payloads per date. May contain guest PII (takeout names/
phones) — they stay on the operator machine and are never published.

## Supabase schema

See `supabase/migrations/0001_schema.sql` — same concepts, database-normalized, with
`table_visits`, `guest_intents`, `table_intent_matches` (confidence + review status),
`commission_rules/entries`, `payroll_summaries`, `ingestion_runs/errors`.
