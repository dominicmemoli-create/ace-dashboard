# Moving to the dedicated `ace-dashboard` Supabase project

The dashboard previously shared a Supabase project with an unrelated application.
This runbook takes it to its own project, with the production authorization
posture applied from the first migration.

Nothing here prints or requires a secret value in chat, a commit or a log.
Placeholders used below:

- `<SUPABASE_DB_URL>` — Postgres connection string of the **new** project
  (Supabase → Project Settings → Database → Connection string → URI)
- `<SUPABASE_SECRET_KEY>` — the new project's secret key. **Not required by any
  script in this repo.** Every admin script authenticates with `<SUPABASE_DB_URL>`.
  Keep it in your password manager only.
- `<TOAST_CLIENT_SECRET>` — unchanged from the current setup
- `<GITHUB_ACTIONS_PAT>` — fine-grained token, this repository, Actions: write

The publishable key and project URL are **not** secrets: they are committed in
`data/supabase_config.json` by design, and the database grants them read access
to PII-free dashboard data only.

---

## 1. Where every value belongs

| Value | GitHub Actions secret | Local `.env` | Supabase Vault | `data/supabase_config.json` |
|---|---|---|---|---|
| Project URL | — | `SUPABASE_URL` | — | ✅ `url` |
| Publishable key | — | `SUPABASE_PUBLISHABLE_KEY` | — | ✅ `publishableKey` |
| `<SUPABASE_DB_URL>` | ✅ `SUPABASE_DB_URL` | ✅ `SUPABASE_DB_URL` | — | ❌ never |
| `<SUPABASE_SECRET_KEY>` | ❌ not needed | ❌ not needed | — | ❌ never |
| `<TOAST_CLIENT_SECRET>` | ✅ `TOAST_CLIENT_SECRET` | ✅ (local runs) | — | ❌ never |
| `TOAST_CLIENT_ID` | ✅ | ✅ | — | ❌ |
| `<GITHUB_ACTIONS_PAT>` | ❌ | ❌ | ✅ `ace_github_pat` | ❌ never |

`.env` is gitignored. CI fails the build if a `.env` file is ever committed.

---

## 2. Bootstrap the empty project

Enable nothing by hand — `bootstrap.mjs` enables `pg_net` and `supabase_vault`
and applies the migrations in dependency order.

```bash
node scripts/admin/bootstrap.mjs --dry-run
```
```bash
node scripts/admin/bootstrap.mjs
```

Order applied (each file is idempotent, each runs in its own transaction):

1. `0000_ace_core_tables.sql` — every flat `ace_*` table, indexes, RLS enabled
2. `0003_manager_tools.sql` — `user_profiles`, `ace_approved_emails`, audit, import runs
3. `0004_operator_role.sql` — one operator capability
4. `0005_upload_rematch.sql` — OpenTable re-match behaviour
5. `0006_manager_writes.sql` — policies, grants, and the manager-only write RPCs

`0001_schema.sql` / `0002_rls.sql` define an older fully-normalized schema the
running dashboard never reads. Add `--with-legacy-schema` only if you want them.

Then seed the reference and pilot data:

```bash
node scripts/deploy-supabase.mjs
```

---

## 3. Supabase Auth configuration (dashboard UI, one time)

**Authentication → URL Configuration**

- Site URL: `https://dominicmemoli-create.github.io/ace-dashboard/`
- Redirect URLs (add all three):
  - `https://dominicmemoli-create.github.io/ace-dashboard/`
  - `https://dominicmemoli-create.github.io/ace-dashboard/index.html`
  - `http://localhost:5173/` (local development only)

**Authentication → Providers → Email**

- Email provider: enabled
- Confirm email: on
- Magic link: enabled
- **Allow new users to sign up: OFF.** This is the control that makes
  `create_user: false` meaningful — an address that is not already a user cannot
  request a link.

**Authentication → Sessions** — defaults are fine (1 hour access token, refresh
rotation on). The dashboard refreshes single-flight and re-prompts on expiry.

---

## 4. First manager bootstrap

Approval is two steps by design: an approved *email* decides the role a new auth
user receives, and the auth user must exist before a magic link can be sent.

```bash
node scripts/admin/add-manager.mjs dominicmemoli@gmail.com manager
```

Then create the auth user once, in the Supabase dashboard:
**Authentication → Users → Add user → Send invitation** to the same address.
The `ace_on_auth_user_created` trigger reads `ace_approved_emails` and writes the
`manager` role into `user_profiles` automatically.

Verify without leaving the browser: sign in on the live site, open Account — it
must read your address with no "no access" suffix.

To revoke someone: delete their row from `ace_approved_emails` **and** set
`user_profiles.role = 'server'` (or delete the auth user). Removing the approved
email alone does not downgrade an existing profile.

---

## 5. GitHub configuration

Repository → Settings → Secrets and variables → Actions:

| Secret | Action | Source |
|---|---|---|
| `SUPABASE_DB_URL` | **Replace** | New project connection string |
| `TOAST_CLIENT_ID` | Keep | Unchanged |
| `TOAST_CLIENT_SECRET` | Keep | Unchanged |

Fine-grained PAT for the Toast retry button:

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained
2. Resource owner: `dominicmemoli-create`; Repository access: **only**
   `dominicmemoli-create/ace-dashboard`
3. Repository permissions: **Actions: Read and write**. Nothing else.
4. Expiry: 90 days, calendar reminder to rotate.
5. Store it in Vault (never in a file):

```bash
node scripts/admin/set-github-token.mjs
```

---

## 6. Data migration

Export from the old project first; it is left running and unmodified.

### Must migrate — not reproducible from any source

```sql
-- run against the OLD project, save each result as JSON
select id, payload, updated_at from ace_item_costs order by id;
select row_hash, business_date, payload, imported_at from ace_intents order by row_hash;
select * from ace_correction_audit order by created_at;
select email, role, added_by, added_at from ace_approved_emails order by email;
```

- **`ace_item_costs`** — chef-entered costs. Import into the new project, or
  re-upload the chef's CSV through the dashboard (preferred: it re-derives Toast
  item GUIDs against the new project's selections).
- **`ace_intents`** — OpenTable records *and* the human match/review state.
- **`ace_correction_audit`** — human decision history. Rows written under the
  open-access build have a null `user_id`; import them with a marker rather than
  pretending they were attributed. `0006` will report them and leave the
  `NOT NULL` constraint off until they are resolved.
- **`ace_approved_emails`** — copy only the ACE managers.

### Must be rebuilt, never copied

- **`user_profiles`** — auth user ids differ between projects. Recreate by
  inviting each manager (section 4). Copying old UUIDs produces orphan rows.
- **`ace_checks` / `ace_selections`** — regenerate from Toast; Toast is the
  source of truth and re-ingestion is idempotent.
- **`ace_metrics` / `ace_item_metrics`** — derived. Never treat as a backup.

### Must not change

- **Pilot history, Jul 31 – Aug 2 2026.** Frozen in `data/ace_payload.js` and
  `legacy/index.html` (both hash-pinned in the test suite) and refused by every
  write RPC and by nightly ingestion.

### Re-ingest Toast

```bash
node scripts/nightly.mjs 20260803
```

Repeat per date, or let the schedule fill forward. Pilot dates are refused.

### Validation

```sql
-- row-count reconciliation: run on BOTH projects and compare
select 'item_costs' t, count(*) from ace_item_costs
union all select 'intents', count(*) from ace_intents
union all select 'corrections', count(*) from ace_correction_audit
union all select 'checks', count(*) from ace_checks
union all select 'selections', count(*) from ace_selections
union all select 'metrics', count(*) from ace_metrics;
```

```sql
-- duplicate detection: both must return zero rows
select canonical_name, effective_from, count(*)
from ace_item_costs group by 1,2 having count(*) > 1;

select business_date, period, count(*)
from ace_metrics where server_guid is null group by 1,2 having count(*) > 1;
```

```sql
-- the new project must contain ONLY ace_* tables plus Supabase internals
select table_name from information_schema.tables
where table_schema = 'public' and table_name not like 'ace\_%'
  and table_name <> 'user_profiles';
-- expected: zero rows
```

```sql
-- pilot history untouched
select count(*) from ace_metrics where business_date between '20260731' and '20260802';
select max(created_at) from ace_correction_audit
where row_hash in (select row_hash from ace_intents
                   where business_date between '20260731' and '20260802');
-- expected: no corrections dated after the cutover
```

### Rollback

Nothing in this process is destructive to the old project. To roll back:

1. Revert `data/supabase_config.json` to the previous URL and key (one commit).
2. Push; GitHub Pages redeploys within a minute and reads the old project again.
3. The new project can be left in place or deleted; no other repo file is
   project-specific.

If you have already applied `0006_manager_writes.sql` to the **old** project
(recommended, to close the anon write grants there too), that change is
independent of which project the frontend points at.

---

## 7. Remediating the old project

The old project may still carry the withdrawn open-access grants. Applying the
production migration there closes them without touching data:

```bash
SUPABASE_DB_URL=<old project URL> node scripts/admin/apply-sql.mjs supabase/migrations/0006_manager_writes.sql
```

Do this only after the new project is live, and expect the migration to report
any unattributable audit rows rather than deleting them.
