# Deployment

## Frontend: GitHub Pages

GitHub Pages serves the repo root of `main` (`.nojekyll` present). Use a branch
and PR; do not push directly to `main`.

```bash
git checkout main
git merge <reviewed-branch>
git push origin main
```

Rollback: revert the merge commit, or point visitors at `legacy/index.html`
(always the shipped pilot report).

## Verify after deploy

1. Load the site, passcode in, confirm the freshness badge shows sales and
   OpenTable dates separately.
2. Open Advanced Details and confirm the deployed commit matches the expected
   GitHub Pages deployment SHA.
3. Confirm Fixes Needed does not surface frozen Jul 31-Aug 2 pilot records.
4. `npm test` must be green at the deployed commit.

## Backend: Supabase

The frontend reads shared Supabase data with the anon key. Current temporary
writes use the anon RPC allowlist in `supabase/migrations/0006_public_access_rpc.sql`.
Apply migrations with `scripts/admin/apply-sql.mjs`; rotate Vault credentials
with `scripts/admin/set-github-token.mjs`.
