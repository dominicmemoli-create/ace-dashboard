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

The frontend reads the dedicated `ace-dashboard` Supabase project with the
publishable key (committed in `data/supabase_config.json`; read-only by design).
Writes require a signed-in approved manager — see
`supabase/migrations/0006_manager_writes.sql`.

Bootstrap a project with `node scripts/admin/bootstrap.mjs`, which applies every
migration in dependency order; apply a single file with
`scripts/admin/apply-sql.mjs`; rotate the Vault GitHub token with
`scripts/admin/set-github-token.mjs`.

Full project setup, Auth configuration, data migration and rollback:
**docs/SUPABASE_MIGRATION.md**.

## Response headers

GitHub Pages cannot set custom response headers. `_headers` (Netlify/Cloudflare
syntax) and `netlify.toml` are inert here — do not rely on either for
`X-Frame-Options`, `nosniff`, `Referrer-Policy` or `noindex`. `robots.txt` is
the only crawler control that applies. Fixing this properly means fronting the
site with a CDN that supports headers.
