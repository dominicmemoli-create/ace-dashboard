# Administrator runbook

## Daily / after each business day

```bash
node scripts/ingest-toast.mjs <YYYYMMDD> --allow-desktop-config
```

Pulls the business date from the Toast API, refreshes `data/live/`, appends to the
ingestion run log. Re-running a date is safe (idempotent — full replace, keyed by GUID).
Then commit and push `data/live/` to publish (GitHub Pages redeploys automatically).

Credentials: `TOAST_CLIENT_ID` / `TOAST_CLIENT_SECRET` from the environment or `.env`
(gitignored). `--allow-desktop-config` reuses the local Toast MCP credentials on the
operator machine only. **Never commit credentials.**

## Importing the chef's final cost workbook (the important one)

1. Get costs as CSV with header `canonical_name,cost,portion,notes`
   (template: `imports/item_costs_template.csv`). Names should match the workbook's
   canonical names; new items are fine too.
2. Run:
   ```bash
   node scripts/import-costs.mjs --csv imports/chef_costs_YYYYMMDD.csv --effective YYYYMMDD --source chef_confirmed --by "Chef Name"
   ```
3. This **closes** each prior cost record (`effective_to` = day before) and appends the
   confirmed record. Historical results do not change — effective dating guarantees it.
4. Commit `data/live/item_costs.json` and push. The PROVISIONAL badge clears once no
   rough costs remain in the driver mix.

Alternative for a shift lead: the dashboard's **Data import** page accepts the same CSV
by drag-and-drop (browser-local until the database backend is live).

## Aliases / unmatched items

The Food Cost page's review queue lists items with sales but no cost. Fix either by
adding the cost (above) or mapping a name in `imports/alias_map.json`, then re-running
`npm run import:costs` (workbook) or the CSV import.

## Fixing a bad run

Normalized files are per-date; a failed run leaves the previous files untouched.
Worst case: `git checkout -- data/live/` restores the last committed good state.

## Thresholds

Watch/critical points, minimum checks, minimum net food sales, and minimum coverage are
editable on the Food Cost page (persisted per browser). Defaults live in
`src/food-cost-engine.mjs → DEFAULT_THRESHOLDS`.

## Deploy

GitHub Pages serves the repository root of `main`. To ship this branch:
review → merge `feature/live-food-cost-dashboard` into `main` → push. CI (vitest) runs
on every push. The legacy pilot dashboard stays available at `legacy/index.html`.

## Backend phase (when Supabase credentials exist)

1. `supabase db push` applies `supabase/migrations/`.
2. Deploy `supabase/functions/ingest-toast` and set env: TOAST_*, SUPABASE_*.
3. Schedule the cron (see the function header) for ~6:00 AM America/New_York.
4. Run the RLS test suite against the instance **before** flipping
   `config/feature_flags.json → server_portal`.
5. Payroll stays off until a verified payroll source and field definitions exist.
