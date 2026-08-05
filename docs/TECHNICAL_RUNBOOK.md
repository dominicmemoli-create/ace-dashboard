# Technical runbook (administrators only)

Routine workflows run in the browser (see docs/UPLOAD_GUIDE.md). This file is
for migrations, credentials, recovery, and verification.

## Architecture

- **Toast** -> GitHub Actions (`.github/workflows/nightly-ingest.yml`, ~6:00 AM
  America/New_York) -> `scripts/nightly.mjs` -> Supabase `ace_*` tables ->
  metric rows rebuilt for affected dates.
- **Frontend** -> GitHub Pages from repo root on `main`. Reads Supabase with
  the anon key and falls back to `data/live/*.json` when unreachable.
- **Browser writes** -> manager-only RPCs from
  `supabase/migrations/0006_manager_writes.sql`. Every write RPC is granted to
  `authenticated` only and calls `ace_require_operator()` first. The functions
  are security-definer, validate payloads, reject PII, write audit records with
  `auth.uid()` and the JWT email, and block Jul 31-Aug 2 pilot-history edits.
  Anonymous callers get read-only access to the PII-free dashboard tables and
  the two sanitized `*_public` views.
- **Sign-in** -> Supabase Auth magic links (`src/auth.mjs`), approval seeded from
  `ace_approved_emails` into `user_profiles` by the `ace_on_auth_user_created`
  trigger in `0003_manager_tools.sql`.
- **Retry Toast Update** -> RPC reads `ace_github_pat` from Supabase Vault and
  dispatches the nightly workflow via `pg_net`. No GitHub token reaches the
  browser.

## Migrations

On a clean project, apply everything in dependency order with one command:

```bash
node scripts/admin/bootstrap.mjs
```

That runs `0000_ace_core_tables.sql` (which owns every flat `ace_*` table, so
the ingestion scripts are no longer the de-facto schema), then `0003`, `0004`,
`0005`, `0006_manager_writes.sql`. `0001_schema.sql` / `0002_rls.sql` define an
older normalized schema the dashboard never reads and are opt-in via
`--with-legacy-schema`. Preview the order with `--dry-run`.

Individual files still apply with:

```bash
node scripts/admin/apply-sql.mjs supabase/migrations/0006_manager_writes.sql
```

## Admin tools (`scripts/admin/`, need `.env`)

| Command | Purpose |
|---|---|
| `node scripts/admin/set-github-token.mjs` | store/rotate the GitHub token in Vault |
| `node scripts/admin/apply-sql.mjs <file.sql>` | apply a migration |
| `node scripts/admin/verify-live.mjs [--with-retry]` | live acceptance suite; update before relying on a changed access model |
| `node scripts/admin/add-manager.mjs ...` | legacy approved-operator tooling; not used by the current public browser path |

## CLI fallbacks

```bash
node scripts/ingest-toast.mjs YYYYMMDD --allow-desktop-config
node scripts/nightly.mjs YYYYMMDD
node scripts/import-opentable.mjs file.csv
node scripts/import-costs.mjs --csv chef.csv --effective YYYYMMDD --source chef_confirmed
node scripts/build-metrics.mjs
node scripts/deploy-supabase.mjs
```

The metric math lives once in `src/metrics-builder.mjs`; browser recalculation
and CLI rebuilds use the same module.

## Failure triage

- **Nightly failed**: inspect the Actions run or `ace_ingestion_runs.payload`.
  A failed run should not partially publish a date.
- **Retry says update service not connected**: Vault secret missing or expired;
  rotate with `node scripts/admin/set-github-token.mjs`.
- **Uploads fail with a reference ID**: browser console carries the full error
  next to the same reference.
- **Pilot fix save fails**: expected for Jul 31-Aug 2, 2026; Pilot Review is
  frozen.
- **Supabase paused**: resume from the Supabase dashboard; the frontend shows
  Backup data until it is back.

## Deploy

Merge a reviewed branch to `main`, push, and let GitHub Pages redeploy. CI runs
vitest on every push. As of this update the local suite is 202 tests.
