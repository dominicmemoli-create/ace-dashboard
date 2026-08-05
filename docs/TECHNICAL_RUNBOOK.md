# Technical runbook (administrators only)

Managers never need this file — every routine workflow runs in the browser
(see docs/UPLOAD_GUIDE.md). These are the operator/backup procedures.

## Architecture

- **Toast** → GitHub Actions (`.github/workflows/nightly-ingest.yml`, ~6:00 AM
  America/New_York, DST-safe) → `scripts/nightly.mjs` → Supabase `ace_*` tables
  (idempotent per-date replace) → metric rows rebuilt for affected dates.
- **Frontend** → GitHub Pages (repo root of `main`). Reads Supabase with the
  anon key (RLS read-only); falls back to `data/live/*.json` when unreachable.
- **Operator tools** → Supabase Auth (email magic links) + security-definer
  RPCs (`supabase/migrations/0003_manager_tools.sql` +
  `0004_operator_role.sql`): `ace_upload_opentable`, `ace_upload_costs`,
  `ace_replace_metrics`, `ace_save_review_fix`, `ace_retry_toast_update`
  (+ `ace_retry_status`, `ace_whoami`, `ace_is_operator`). ONE operator
  capability — all approved roles are equal; checks happen inside the
  functions; anon has no execute.
- **Retry Toast Update** → RPC reads a GitHub token from Supabase Vault
  (`ace_github_pat`) and dispatches the nightly workflow via `pg_net`.
  No secret ever reaches the browser.

## Admin tools (`scripts/admin/`, need `.env`)

| Command | Purpose |
|---|---|
| `node scripts/admin/add-manager.mjs <email> <manager\|shift_lead\|executive>` | approve a sign-in email (all role values grant the same operator capability) |
| `node scripts/admin/add-manager.mjs <email> --remove` | revoke operator access |
| `node scripts/admin/set-github-token.mjs` | store/rotate the GitHub token in Vault (prefer a fine-grained PAT: this repo only, Actions read/write) |
| `node scripts/admin/apply-sql.mjs <file.sql>` | apply a migration |
| `node scripts/admin/verify-live.mjs [--with-retry]` | live acceptance suite: real sessions per role, authorization matrix, idempotency, audit, reversal, optional real workflow dispatch (cleans up after itself; needs the `*.test@example.com` users provisioned via add-manager) |

Equivalent SQL for approvals is documented in `scripts/admin/add-manager.mjs`.

## CLI fallbacks (kept as backup, not the normal path)

```bash
node scripts/ingest-toast.mjs YYYYMMDD --allow-desktop-config   # manual Toast pull
node scripts/nightly.mjs YYYYMMDD                               # full nightly run vs Supabase
node scripts/import-opentable.mjs file.csv                      # OpenTable import (browser upload is the normal path)
node scripts/import-costs.mjs --csv chef.csv --effective YYYYMMDD --source chef_confirmed
node scripts/build-metrics.mjs                                  # full metric rebuild
node scripts/apply-corrections.mjs corrections.json             # legacy corrections format
node scripts/deploy-supabase.mjs                                # re-seed ace_* from data/live
```

The metric math lives once in `src/metrics-builder.mjs` — the browser recalc
and the CLI use the same module.

## Auth configuration (Supabase dashboard, one-time)

Authentication → URL Configuration:
- **Site URL**: `https://dominicmemoli-create.github.io/ace-dashboard/`
- Add the same URL to **Redirect URLs** (plus `http://localhost:5173` for dev).

Without this, magic-link emails redirect to the default localhost URL.
Free-tier built-in email is rate-limited (~2 emails/hour per address burst);
fine for a small management team, add custom SMTP if it ever isn't.

## Failure triage

- **Nightly failed**: Actions tab → run log; or `ace_ingestion_runs` payload
  `error`. A failed run never partially publishes (per-date transaction).
  Managers can self-serve via Retry Toast Update.
- **Retry says "update service not connected"**: Vault secret missing/expired →
  `node scripts/admin/set-github-token.mjs`.
- **Uploads failing with a reference ID**: browser console carries the full
  error next to the same reference.
- **Supabase paused (free tier)**: resume from the Supabase dashboard; the
  frontend shows "Backup data" until it's back.

## Deploy

Merge to `main`, push — GitHub Pages redeploys. CI (vitest, 127 tests) runs on
every push. Frozen pilot snapshot: `legacy/index.html` (hash-pinned in tests).
