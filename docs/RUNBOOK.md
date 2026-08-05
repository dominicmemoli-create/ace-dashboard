# Runbook

## Daily reality

Nothing to run for Toast. Sales arrive automatically every morning. Visitors
who pass the presentation gate keep OpenTable current with a browser upload and
resolve the occasional item under Fixes Needed. The complete no-terminal guide
is docs/UPLOAD_GUIDE.md.

## Who does what

| Task | Who | Where |
|---|---|---|
| Toast sales | nobody (automatic) | status on Update Dashboard |
| Toast retry after a failed morning | public dashboard visitor | Update Dashboard -> Retry Toast Update |
| OpenTable guest-status upload | public dashboard visitor | Update Dashboard -> Upload OpenTable File |
| Chef cost update | public dashboard visitor | Update Dashboard -> Update Food Costs |
| Resolve non-pilot exceptions | public dashboard visitor | Fixes Needed |
| Pilot Review history | nobody | frozen Jul 31-Aug 2, 2026 |

## Admin / emergency procedures

All CLI ingestion, migration, verification and recovery procedures live in
docs/TECHNICAL_RUNBOOK.md. They are backups; the dashboard is the routine path.

## Thresholds

Watch/critical points, minimum checks, minimum AYCE sales and minimum coverage
default in `src/food-cost-engine.mjs -> DEFAULT_THRESHOLDS` (per-browser
overrides persist locally).

## Gates that stay closed

- `config/feature_flags.json`: server portal and payroll remain off.
- Commission program inactive after Aug 2, 2026; the pilot ledger is frozen
  under Pilot Review.
