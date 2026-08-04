# Deployment

## Frontend (current: GitHub Pages)

GitHub Pages serves the repo root of `main` (`.nojekyll` present). Deploy = merge to
`main`, push. CI runs vitest on every push; merge only on green.

```bash
git checkout main
git merge feature/live-food-cost-dashboard
git push origin main
```

Rollback: revert the merge commit, or point visitors at `legacy/index.html` (always
the shipped pilot report).

## Verify after deploy

1. Load the site, passcode in, confirm the freshness badge shows the expected dates.
2. Food Cost page renders numbers (fetches `data/live/*.json` — check the browser
   network tab for 404s if blank).
3. `npm test` locally must be green at the deployed commit.

## Backend (Supabase — when provisioned)

See docs/RUNBOOK.md "Backend phase". Frontend stays on Pages; it will read from
Supabase with the anon key once RLS is live, replacing the static JSON fetches in
`src/pages-live.mjs → loadLive()` (single function to swap).
