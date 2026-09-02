# API keys & credentials — what ACE needs and where each one goes

Every variable the code actually reads, verified by grepping `process.env` across
`scripts/`, `src/` and `test/` on 2026-09-01. If a variable is not in this file, nothing
in the repo reads it.

**No real values appear here.** Placeholders live in [`.env.example`](../.env.example);
real values live in `.env` (gitignored), GitHub Actions repository secrets, or the
Supabase Vault. Status and how to obtain each one:
[`CREDENTIALS.md`](CREDENTIALS.md).

---

## 1. The short version

| Key | Needed for | Where it must live |
|---|---|---|
| `SUPABASE_DB_URL` | **everything server-side** | `.env` + GitHub secret |
| `TOAST_CLIENT_ID` / `TOAST_CLIENT_SECRET` | nightly Toast ingestion | `.env` + GitHub secret |
| `MARGINEDGE_API_KEY` | daily cost sync | `.env` + GitHub secret |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | one-off admin scripts only | `.env` only |
| `GITHUB_TOKEN` | one-off: seed the retry token | shell env, once |

Nothing above ever reaches the browser. The dashboard's only client-side credential is
the **publishable** key in [`data/supabase_config.json`](../data/supabase_config.json),
which is committed on purpose — it grants read access to PII-free tables only, and every
write RPC requires a signed-in approved manager.

---

## 2. Required for the automated pipelines

These three sets must exist as **GitHub Actions repository secrets** or the scheduled
workflows fail. Set them at *Settings → Secrets and variables → Actions*.

### `SUPABASE_DB_URL` — the one nothing works without

Postgres connection string for the dedicated `ace-dashboard` Supabase project. Read by
16 call sites: `scripts/nightly.mjs`, `scripts/sync-marginedge-costs.mjs`,
`scripts/audit-marginedge-costs.mjs`, `scripts/admin/*`, `scripts/build-metrics.mjs`.

- Supabase dashboard → *Project Settings → Database → Connection string → URI*.
- Contains the database password. Treat as a secret; never log it.
- Required by **both** workflows (Toast ingestion and MarginEdge cost sync).

> Free-tier projects auto-pause after ~1 week idle. The first connection after a pause
> can fail with `Connection terminated unexpectedly`; retrying wakes it. That is not a
> credential problem — check the Supabase dashboard before debugging keys.

### `TOAST_CLIENT_ID` + `TOAST_CLIENT_SECRET`

Toast partner API credentials for the nightly ~6:00 AM ingestion
(`.github/workflows/nightly-ingest.yml` → `scripts/nightly.mjs`).

- `TOAST_RESTAURANT_GUID` is **not** a secret: `e574444c-c511-4468-ab89-93d0abbec72b`
  (Chasin' Tails — CT: Founders Row, Falls Church). It has a default in code, so it only
  needs setting to point ACE at a different location.
- `scripts/lib/ingest-rules.mjs → missingSecrets()` checks all three before any network
  call, so a missing secret fails with a clear message rather than a driver stack trace.

### `MARGINEDGE_API_KEY` + `MARGINEDGE_RESTAURANT_UNIT_ID`

MarginEdge public API, for the daily ~6:20 AM cost sync
(`.github/workflows/marginedge-costs.yml` → `scripts/sync-marginedge-costs.mjs`).

- **Create in MarginEdge:** MarginEdge UI → API. **The key is shown exactly once** —
  capture it immediately into a password manager.
- **Scope:** whatever units the key can reach defines its scope; there is no separate
  permission model. Verify with `GET /restaurantUnits`, which is also the cheapest
  credential check. The sync calls it first and fails loudly if the configured unit is
  not reachable.
- `MARGINEDGE_RESTAURANT_UNIT_ID` is **not** a secret: `377809302`
  ("Nue/Chasin' Tails - Falls Church" — the unit is shared with Nue).
- **Read-only by construction.** Every documented endpoint is `GET`; the client in
  `scripts/lib/marginedge-client.mjs` sends nothing else, so an ACE bug cannot write to
  MarginEdge.
- **Server-side only.** The dashboard is static GitHub Pages; MarginEdge is reached
  exclusively from GitHub Actions. This key must never appear in browser code, a
  committed file, or a log. `sanitizeError()` redacts it from every error message, and
  `test/marginedge-cost.test.mjs` asserts it never leaks.

A key already exists for the local read-only MCP connector
(`marginedge-mcp-read-only/.env`). ACE needs the value present in its own environment;
reusing that key is fine, or issue a second one so they can be rotated independently.

---

## 3. Admin-only — never put these in CI

Used by interactive maintenance scripts run from a trusted machine. They belong in local
`.env` and nowhere else.

| Variable | Read by | Purpose |
|---|---|---|
| `SUPABASE_URL` | `scripts/admin/add-manager.mjs`, `scripts/admin/verify-live.mjs`, `scripts/deploy-supabase.mjs` | Supabase REST/Auth base URL (not secret on its own) |
| `SUPABASE_SERVICE_ROLE_KEY` | same three | Full bypass of RLS. **The most dangerous value in the project.** |

`SUPABASE_SERVICE_ROLE_KEY` grants unrestricted database access and defeats every
authorization control in `supabase/migrations/0006_manager_writes.sql`. It is required
only to create manager accounts, generate magic links for the live verification suite,
and deploy SQL. It is **not** needed by either scheduled workflow — those use
`SUPABASE_DB_URL`.

### `GITHUB_TOKEN` — one-off

Read once by `scripts/admin/set-github-token.mjs`, which stores it in the Supabase Vault
as `ace_github_pat`. That vaulted token is what `ace_retry_toast_update()` uses via
`pg_net` to dispatch the nightly workflow when a manager clicks *Retry* in the browser.

Currently the vault holds Dominic's `gh` OAuth token. **It should be replaced with a
fine-grained PAT** scoped to this repository with only *Actions: write*:

```bash
GITHUB_TOKEN=<fine-grained-pat> node scripts/admin/set-github-token.mjs
```

---

## 4. Not credentials

`CHROMIUM_PATH`, `BROWSER_CHANNEL` and `THEME` are read by `scripts/shots.mjs` and
`scripts/shots-fixtures.mjs` for screenshot generation. Local convenience only.

---

## 5. Not required (and deliberately absent)

| Variable | Why it is unset |
|---|---|
| `OPENTABLE_CLIENT_ID` / `SECRET` | Production API access **not granted**. The permanent plan is the nightly GuestCenter CSV upload by a manager. Do not build against invented endpoints. |
| `TOAST_EXPORT_SFTP_HOST` / `KEY` | Toast "Nightly Data Export" not configured; the API path is in use instead. |
| `PAYROLL_SOURCE` | Payroll feature flag is off; no approved source. |
| *(MarginEdge recipe API)* | **Does not exist.** The MarginEdge public API has no recipe, yield, conversion or plate-cost endpoints, so no credential can unlock them. See [`MARGINEDGE_COST_AUDIT.md`](MARGINEDGE_COST_AUDIT.md) §1. |

---

## 6. Setting up from scratch

```bash
cp .env.example .env      # then fill in real values; .env is gitignored
```

Minimum to run the two pipelines locally:

```bash
SUPABASE_DB_URL=...
TOAST_CLIENT_ID=...
TOAST_CLIENT_SECRET=...
MARGINEDGE_API_KEY=...
MARGINEDGE_RESTAURANT_UNIT_ID=377809302
```

Verify without writing anything:

```bash
node scripts/sync-marginedge-costs.mjs --dry-run --verbose
```

A healthy dry run prints the unit name, the product count, the mapping counts and a plan
of zero changes. It writes no costs and — by design — does **not** mark the MarginEdge
source as successfully synced, because it published nothing.

---

## 7. Hygiene rules

1. **`.env` is gitignored** (`.gitignore` line 4). Confirm with `git check-ignore -v .env`
   before adding anything to it.
2. **`.env.example` holds placeholders only** — `__REQUIRED__`, never a real value.
3. **Rotate anything that has been pasted into a chat, ticket, or screenshot.**
4. **Secrets never enter the browser bundle.** `test/security-scaffold.test.mjs` and
   `scripts/audit-keys.mjs` assert this; run `npm test` after touching credential
   handling.
5. **Non-secret identifiers stay in the clear** — the Toast restaurant GUID, the
   MarginEdge unit id and the Supabase publishable key are committed on purpose. Marking
   them secret would obscure which values genuinely matter.
