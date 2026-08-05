# Runbook

## Daily reality

Nothing to run. Toast data arrives automatically every morning; managers keep
OpenTable current with a browser upload and resolve the occasional item under
Fixes Needed. The complete manager procedure is **docs/UPLOAD_GUIDE.md** (one
page, no commands).

## Who does what

| Task | Who | Where |
|---|---|---|
| Toast sales | nobody (automatic) | status on Update Dashboard |
| Toast retry after a failed morning | manager | Update Dashboard → Retry Toast Update |
| OpenTable guest-status upload | manager or shift lead | Update Dashboard → Upload OpenTable File |
| Chef cost update | manager | Update Dashboard → Update Food Costs |
| Resolve exceptions | manager (shift lead for everyday items) | Fixes Needed |
| Approve a new manager email | administrator | `scripts/admin/add-manager.mjs` (docs/TECHNICAL_RUNBOOK.md) |

## Operator / emergency procedures

All CLI ingestion, migration, verification and recovery procedures moved to
**docs/TECHNICAL_RUNBOOK.md**. They are backups — the dashboard is the normal
path for every routine update.

## Thresholds

Watch/critical points, minimum checks, minimum AYCE sales and minimum coverage
default in `src/food-cost-engine.mjs → DEFAULT_THRESHOLDS` (per-browser
overrides persist locally).

## Gates that stay closed

- `config/feature_flags.json`: server portal and payroll remain **off**.
- Commission program inactive after Aug 2, 2026; the pilot ledger is frozen
  under Pilot Review.
