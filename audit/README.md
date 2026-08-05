# Visual redesign — before / after screenshot record

Captured locally with Chromium (`npm run shots`, `npm run shots:fixtures`) against
`npx serve .` on `http://localhost:4173/`, passing through the ACE2026 presentation gate.
Reduced-motion is forced, so nothing here depends on animation timing.

Every "before" image is the functional branch (`fix/functional-stability-and-open-access`,
commit `04a3a37`) rendered unchanged. Every "after" image is the same view on this design
branch. No application logic differs between the two sets.

## Viewports

| Name               | Size        | Purpose                                  |
| ------------------ | ----------- | ---------------------------------------- |
| `desktop`          | 1440 × 1000 | primary manager workstation              |
| `tablet`           | 834 × 1112  | iPad portrait — icon-rail navigation     |
| `tablet-landscape` | 1112 × 834  | iPad landscape                           |
| `mobile`           | 390 × 844   | phone — off-canvas navigation            |

`tablet-landscape` exists only in the "after" set; the "before" set was captured before that
viewport was added to the harness. The 1440 / 834 / 390 pairs cover the same views in both sets.

## Files

`<viewport>-<page>.png` for each of: `ops` (Operations overview), `servers`
(Server Performance), `foodcost` (AYCE Food Cost), `update` (Update Dashboard),
`fixes` (Fixes Needed), `pilot` (Pilot Review), `help` (How This Works), plus `gate.png`
for the presentation gate.

`console-errors.txt` records browser console errors observed during the run.

### After-only, fixture-backed states

Supabase is not reachable from a local browser in this environment, so the pages fall back
to the checked-in backup data — which contains no OpenTable records, leaving the Fixes
Needed queue and the conversion figures empty. `scripts/shots-fixtures.mjs` stubs the
PostgREST reads **at the network layer only** (no application code is stubbed or modified)
with fixtures derived from `data/live/*`, so these states can be reviewed:

- `*-fixes-queue.png` — populated queue, grouped "Handled automatically" panel
- `*-fixes-card-active.png` — one-card decision flow with a decision and reason chosen
- `*-update-live.png` — Update Dashboard against loaded shared data
- `*-server-drawer.png` — server check-level drill-down drawer

### Additional after-only captures

- `desktop-help-advanced.png` — Advanced Details accordion expanded
- `desktop-pilot*.png` — each Pilot Review tab
- `desktop-ops-dark.png` — dark theme
