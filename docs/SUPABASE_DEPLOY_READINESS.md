# Supabase deploy readiness — everything outstanding

**Verified against the live `ace-dashboard` project on 2026-09-01** by querying
`pg_tables`, `pg_proc`, `pg_policies`, `pg_views`, `pg_extension`, `pg_trigger`, row counts,
and by testing the `anon` read posture inside a real transaction. Nothing below is inferred.

Companions: [`API_KEYS.md`](API_KEYS.md) (credentials) ·
[`SUPABASE_MIGRATION.md`](SUPABASE_MIGRATION.md) (full project setup) ·
[`DEPLOY.md`](DEPLOY.md) (frontend) · [`MARGINEDGE_COST_AUDIT.md`](MARGINEDGE_COST_AUDIT.md)

---

## 0. The one-paragraph answer

**The database is already deployed and healthy.** Migration `0007` is applied, all three new
tables exist, the freshness trigger is live, and the read posture is correct. What is left is
**not database work** — it is four external configuration steps and one human input. The single
hard blocker for the new cost pipeline is that **`MARGINEDGE_API_KEY` is not a GitHub Actions
secret**, so the daily workflow cannot run. The second, larger blocker is that **no portion
mapping has been chef-confirmed**, so even a working sync would publish nothing.

---

## 1. What is already live (do not redo)

### Schema — 16 tables, all present

```
ace_approved_emails      ace_intents            ace_marginedge_sync_runs
ace_checks               ace_item_costs         ace_metrics
ace_correction_audit     ace_item_metrics       ace_reference
ace_import_runs          ace_manifest           ace_selections
ace_ingestion_runs       ace_marginedge_mappings ace_source_status
user_profiles
```

The three from `0007` — `ace_marginedge_mappings`, `ace_source_status`,
`ace_marginedge_sync_runs` — are confirmed present. **`0007` is applied.**

### Functions — 14 `ace_*`, including the new one

`ace_handle_new_user`, `ace_is_operator`, `ace_norm_name`, `ace_pilot_window`,
`ace_replace_metrics`, `ace_require_operator`, `ace_retry_status`, `ace_retry_toast_update`,
`ace_role`, `ace_save_review_fix`, **`ace_touch_source_status`**, `ace_upload_costs`,
`ace_upload_opentable`, `ace_whoami`.

### Trigger

`ace_import_runs_source_status` on `ace_import_runs` — live. OpenTable freshness now updates
itself whenever a manager uploads, with no change to the reviewed `ace_upload_opentable` write
path.

### Views

`ace_item_costs_public`, `ace_import_runs_public`, **`ace_cost_coverage_public`**.

### Extensions

`pg_net`, `supabase_vault`, `pgcrypto`, `uuid-ossp`, `pg_stat_statements`, `plpgsql`.
Exactly what the RPC layer needs; nothing extra.

### Data actually in the project

| Table | Rows |
|---|---|
| `ace_selections` | 128,942 |
| `ace_checks` | 10,888 |
| `ace_item_metrics` | 4,438 |
| `ace_metrics` | 793 |
| `ace_intents` | 710 |
| `ace_item_costs` | 86 |
| **`ace_marginedge_mappings`** | **13 (all `proposed`)** |
| `ace_marginedge_sync_runs` | 4 (all dry runs, no errors) |
| `ace_source_status` | 3 |
| `user_profiles` | 9 |
| `ace_approved_emails` | 6 |

`ace_manifest`: 57 business dates, `last_toast_sync` = 2026-08-31. Vault holds
`ace_github_pat`.

### Source freshness is populated and correct

| Source | Status | Last success |
|---|---|---|
| `toast` | `ok` | 2026-08-31 |
| `opentable` | `ok` | 2026-08-16 |
| `marginedge` | `never` | — (attempted, nothing published) |

`marginedge` reading `never` rather than `failed` is deliberate: the source is reachable and
dry runs succeed, but nothing has been published, so the dashboard must not claim the cost feed
is broken.

### Read posture — verified correct

Tested with `begin; set local role anon; …; rollback` (so the role genuinely binds and owner
RLS-bypass does not mask the result):

| Table / view | `anon` |
|---|---|
| `ace_selections`, `ace_checks`, `ace_item_costs`, `ace_import_runs`, `ace_marginedge_mappings` | **DENIED** |
| `ace_metrics`, `ace_source_status`, `ace_marginedge_sync_runs` | ALLOWED |
| `ace_item_costs_public`, `ace_cost_coverage_public` | ALLOWED |

Signed-out visitors get the PII-free dashboard and the new freshness rows, and cannot reach
check-level sales, raw costs, operator emails, or purchase prices.

---

## 2. Blockers — ordered by what actually stops you

### B1. `MARGINEDGE_API_KEY` GitHub Actions secret — **RESOLVED 2026-09-01**

`gh secret list` now shows all five: `MARGINEDGE_API_KEY`, `MARGINEDGE_RESTAURANT_UNIT_ID`,
`SUPABASE_DB_URL`, `TOAST_CLIENT_ID`, `TOAST_CLIENT_SECRET`. The key was piped from the local
`.env` straight into `gh secret set` (never echoed, never written to a tracked file); the unit
id was set with `--body 377809302`.

Without these the workflow fails at the first step, cleanly (`missingMarginEdgeSecrets()` runs
before any network call). The unit id is not secret; it is a secret here only so the workflow
can reference it uniformly. To rotate:

```bash
gh secret set MARGINEDGE_API_KEY            # paste the new key when prompted
```

### B2. Zero confirmed portion mappings — **blocks all value, not the deploy**

26 mappings are loaded (13 original + 13 added 2026-09-01), all `reviewStatus: "proposed"`. The
sync reads them, skips all 26, and writes nothing. That is correct and intended — a proposed
mapping must never produce a cost — but it means **verified MarginEdge coverage is 0%** and food
costs still come from the rough workbook.

The 2026-09-01 vendor-item audit ([`MARGINEDGE_COST_AUDIT.md`](MARGINEDGE_COST_AUDIT.md) §8 and
§11) changed the shape of the bottleneck: **9 mappings are already fully determined by
MarginEdge plus the Toast item name** (lobster tail, the six named-weight shrimp items, both
Fanny Bay oyster counts, crawfish via the published menu) and only need a manager to flip them
to `confirmed`. Of the rest, 4 need a count at receiving (snow crab clusters per case, king crab
legs per case, blue crabs per case, Skinny Dipper box count), 3 need a manager yes/no (prawn
count, which shrimp case feeds which bag, ribeye yield policy), and **6 genuinely need the chef**
(lamb chops per unit, crab cake weight, zabuton portion, hamachi orders per fillet, gator oz, and
the low-dollar mussels / catfish / ice-cream scoop).

| Question | Units affected | Why it matters |
|---|---|---|
| Lamb chops — how many chops per unit (weight per chop now derived) | 952 | 2 chops = $5.50, 3 = $8.25 vs ACE $4.00 |
| Snow crab — clusters per 30 lb case at receiving | 1,572 | 10.6% of all AYCE quantity; grade is 8/Up so ≥ 8 oz each |
| King crab — legs vs claws in a 16/20 case | 650 | legs-only $29.97 (= ACE) vs ~$25 |
| Crab cake — raw weight of one cake | 696 | 3 oz $4.69 / 4 oz $6.25 vs ACE $4.00 |
| Blue crabs — which case and how many crabs | 450 | $2.08–$6.25 per two crabs vs ACE $12.00 |

Workflow once answers arrive:

```bash
# edit config/marginedge_mappings.seed.json: fix quantityPerToastUnit,
# set "reviewStatus": "confirmed"
node scripts/admin/load-marginedge-mappings.mjs             # dry run
node scripts/admin/load-marginedge-mappings.mjs --apply
node scripts/sync-marginedge-costs.mjs --dry-run --verbose  # inspect the plan
node scripts/sync-marginedge-costs.mjs --apply
```

The loader refuses to downgrade an already-`confirmed` mapping, so reloading the seed can never
silently undo a chef decision.

### B3. The work is uncommitted on `main` — blocks the frontend and the workflows

`git status` shows the entire MarginEdge feature as uncommitted, on branch `main`.
GitHub Actions reads workflow files **from the repository**, so `marginedge-costs.yml` does not
exist to GitHub yet regardless of secrets.

[`DEPLOY.md`](DEPLOY.md) is explicit: *"Use a branch and PR; do not push directly to `main`."*
The current working tree violates that. Recommended:

```bash
git checkout -b feature/marginedge-cost-layer
git add -A && git commit
git push -u origin feature/marginedge-cost-layer
# open a PR, review, then merge to main
```

Files to expect in the diff: 11 new (`src/marginedge-cost.mjs`,
`scripts/lib/marginedge-client.mjs`, `scripts/sync-marginedge-costs.mjs`,
`scripts/audit-marginedge-costs.mjs`, `scripts/admin/load-marginedge-mappings.mjs`,
`supabase/migrations/0007_marginedge_costs.sql`, `.github/workflows/marginedge-costs.yml`,
`config/marginedge_mappings.seed.json`, `docs/MARGINEDGE_COST_AUDIT.md`, `docs/API_KEYS.md`,
this file, `audit/marginedge_reconciliation.json`, `test/marginedge-cost.test.mjs`) and 12
modified.

> Confirm `.env` is absent from the diff before pushing: `git status --porcelain | grep -c '\.env$'`
> must print `0`. It is gitignored (`.gitignore` line 4) and a scan confirmed the MarginEdge key
> appears in no tracked file.

### B4. Supabase Auth URL configuration — **VERIFIED CORRECT 2026-09-01**

Site URL and Redirect URLs are project configuration, not database state, so no SQL query can
read them. They were verified indirectly but deterministically: the admin `generate_link`
endpoint (service role, local `.env`) was asked for a magic link for the `example.com` test
operator with `redirect_to` in the query string — the same validation path GoTrue applies to the
browser's `/auth/v1/otp?redirect_to=…` request — and **no email is sent** by that endpoint.

| Request | `redirect_to` GoTrue put in the link |
|---|---|
| `redirect_to=https://dominicmemoli-create.github.io/ace-dashboard/` | the GitHub Pages URL (accepted) |
| no `redirect_to` (reveals the Site URL) | `https://dominicmemoli-create.github.io/ace-dashboard/` |
| control: `redirect_to=https://evil.example.invalid/` | fell back to the Site URL (allowlist enforced) |

So the Site URL is the production dashboard, the production URL passes the redirect allowlist,
and unlisted URLs are rejected. The public `/auth/v1/settings` endpoint confirms the email
provider is on, signup is disabled (`disable_signup: true`, which is what makes
`create_user: false` meaningful) and autoconfirm is off. Real sign-ins exist: one `hehfood.com`
manager on 2026-08-07 and Dominic on 2026-08-16.

The frontend requests exactly `location.origin + location.pathname`, i.e. the trailing-slash
URL above. Nothing to change in the Supabase dashboard.

### B5. Vault GitHub token should be a fine-grained PAT — security debt, not a blocker

`vault.secrets` holds `ace_github_pat` (present, count = 1), currently a `gh` OAuth token with
far broader scope than needed. `ace_retry_toast_update()` uses it via `pg_net` to dispatch the
nightly workflow when a manager clicks *Retry*.

Replace with a PAT scoped to this repository, *Actions: write* only:

```bash
GITHUB_TOKEN=<fine-grained-pat> node scripts/admin/set-github-token.mjs
```

---

## 3. Defects found and fixed while preparing this document

Both were real and would have bitten on a clean deploy.

1. **`bootstrap.mjs` omitted `0007`.** `LIVE_MIGRATIONS` listed only `0000`–`0006`, so
   `node scripts/admin/bootstrap.mjs` on a fresh project produced a database with no mapping
   table and a cost sync that could never run. Added, with a dependency-order assertion
   (`0007` must follow `0006`: it calls `ace_is_operator()` in a policy and reads
   `ace_import_runs` to backfill OpenTable freshness) and a named regression test.
2. **`.env.example` omitted `SUPABASE_DB_URL`** — the most-used variable in the codebase (16
   call sites) — while listing `SUPABASE_ANON_KEY`, which nothing reads. Anyone setting up from
   the template would have hit an opaque Postgres connection error. Fixed; a completeness check
   now confirms every variable the code reads is present.

---

## 4. Known issues that are NOT blockers

### Stale `poc_read` policies — cosmetic today, a trap later

Eight tables still carry a `poc_read` policy with `using (true)` alongside their intended
`operator_read` / `public_read`: `ace_checks`, `ace_selections`, `ace_item_costs`,
`ace_ingestion_runs`, `ace_item_metrics`, `ace_manifest`, `ace_metrics`, `ace_reference`.

Permissive RLS policies OR together, so on paper this looks alarming. **It is not exploitable
today** — verified above, `anon` is denied on every sensitive table, because the table-level
`GRANT` is the effective gate and `0006` revoked `SELECT` from `anon` on those tables.

The risk is latent: if anyone ever re-granted `SELECT` on `ace_selections` to `anon`, `poc_read`
would silently open full check-level sales data with no policy change to review. Worth a
one-line cleanup migration; not urgent, and deliberately **not** done here because touching
authorization policies deserves its own reviewed change rather than being smuggled into a
cost-layer deploy.

### Free-tier auto-pause

The project pauses after ~1 week idle. The first connection after a pause fails with
`Connection terminated unexpectedly`; retrying wakes it. This bit me twice while writing this
document. It is not a credential problem — check the Supabase dashboard before debugging keys.
The scheduled workflows will wake it daily, so this mostly affects manual runs after a quiet
period.

### `0001`/`0002` legacy schema is not applied — correct

The normalized schema (`locations`, `employees`, `orders`, `checks`, `item_costs`, …) is absent;
only the flat `ace_*` layer exists. That matches `bootstrap.mjs`, which treats those as opt-in
(`--with-legacy-schema`). Consequence: the `item_costs` source-constraint update in `0007` was a
no-op, guarded by `if exists`. Nothing to do.

### MarginEdge product-price caveat

The same product is bought from different vendors at different prices (Prawns U/6 at $17.75 vs
$17.45 on consecutive days), and `latestPrice` is simply whichever invoice processed last. A
trailing weighted average would be more stable but changes what the number *means* — a
management decision, left open deliberately.

---

## 5. Deployment runbook

Nothing here re-applies to the live project except step 2, which is idempotent.

```bash
# 1. Confirm green at the commit you intend to ship
npm test                                   # expect 321 passing, 13 files

# 2. Database (already applied; safe to re-run — every statement is guarded)
node scripts/admin/bootstrap.mjs --dry-run  # shows 0000,0003,0004,0005,0006,0007
node scripts/admin/bootstrap.mjs

# 3. Secrets (B1) — done 2026-09-01; re-run only to rotate
gh secret list                             # expect 5 entries

# 4. Ship the code (B3)
git checkout -b feature/marginedge-cost-layer
git add -A && git commit && git push -u origin feature/marginedge-cost-layer
# PR -> review -> merge to main

# 5. Prove the workflow runs before trusting the schedule
gh workflow run "Daily MarginEdge cost sync" -f mode=dry-run
gh run watch

# 6. Supabase Auth URL configuration (B4) — verified correct 2026-09-01, nothing to do

# 7. Rotate the Vault token (B5)
GITHUB_TOKEN=<fine-grained-pat> node scripts/admin/set-github-token.mjs
```

### Verification after deploy

```bash
node scripts/sync-marginedge-costs.mjs --dry-run --verbose
```

A healthy run prints the unit name, `5091 products (1163 in FOOD categories)`, the mapping
counts, and `Plan — insert 0, unchanged 0, hold 0, skip 26`. Zero inserts is **success** until
a mapping is confirmed.

Then confirm the dashboard shows three independent freshness lines (Toast, MarginEdge,
OpenTable) rather than one combined "updated" badge, and that a stale OpenTable upload does not
make food cost appear broken.

---

## 6. Rollback

The cost layer is additive, which makes rollback cheap:

- **Frontend / workflows:** revert the merge commit. The MarginEdge workflow stops firing.
- **Sync:** it only ever *appends* effective-dated rows to `ace_item_costs` and never deletes or
  mutates a previous record. To undo published costs, close or delete rows where
  `payload->>'source' = 'marginedge'`; the previously open record's `effectiveTo` was set to the
  day before, so restoring it is a single update.
- **Mappings:** set `reviewStatus` back to `proposed` and the sync immediately stops costing
  those items, leaving existing cost records untouched.
- **Schema:** `0007` adds only new tables, one view, one function and one trigger. Dropping them
  returns the project to its `0006` posture. No existing table was altered.

Because nothing has been published yet (`ace_item_costs` has **0** rows with
`source = 'marginedge'`), rollback today is simply "revert the commit".

---

## 7. Summary checklist

| # | Item | Blocking? | Owner | Verified state |
|---|---|---|---|---|
| 1 | Migration `0007` applied | — | done | ✅ live |
| 2 | 26 proposed mappings loaded (13 + 13 on 2026-09-01) | — | done | ✅ live |
| 3 | Freshness rows + trigger | — | done | ✅ live |
| 4 | Read posture correct | — | done | ✅ tested as `anon` |
| 5 | `bootstrap.mjs` includes `0007` | — | done | ✅ + regression test |
| 6 | `MARGINEDGE_API_KEY` GitHub secret | — | done | ✅ set 2026-09-01 |
| 7 | `MARGINEDGE_RESTAURANT_UNIT_ID` secret | — | done | ✅ set 2026-09-01 |
| 8 | Commit + PR + merge to `main` | **yes** | Dominic | see PR `feature/marginedge-cost-layer` |
| 9 | Chef portion confirmations | **yes, for value** | Chef | ❌ 0 confirmed — see `MARGINEDGE_COST_AUDIT.md` §8 for the reduced list |
| 10 | Supabase Auth URL configuration | — | done | ✅ verified 2026-09-01 (B4) |
| 11 | Fine-grained PAT in Vault | no | Dominic | ⚠️ OAuth token in place |
| 12 | `poc_read` cleanup migration | no | later | ⚠️ latent, not exploitable |

**Items 6, 7 and 8 are the entire technical distance to a running pipeline.** Item 9 is the
distance to it being *useful*.
