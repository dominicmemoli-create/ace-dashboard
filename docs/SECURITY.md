# Security notes

## Access model

Two layers are intentionally separate:

1. **Presentation gate** (passcode `ACE2026`): hides the dashboard UI from
   casual visitors. It is embedded in the page, authorizes nothing, and is not
   authentication.
2. **Database authorization** (`supabase/migrations/0006_manager_writes.sql`):
   anonymous visitors may SELECT only the PII-free data the public dashboard
   renders. Every write RPC is granted to `authenticated` and `service_role`
   only, and each one calls `ace_require_operator()` before touching a row.

Hiding a button in the browser is a courtesy, not a control. The same request
posted straight to PostgREST with the publishable key is refused identically.

Authorization matrix:

| Action | anonymous visitor | signed in, not approved | approved manager |
|---|---|---|---|
| Read dashboard (metrics, costs, intents) | allowed | allowed | allowed |
| Read check-level sales, selections, import runs | blocked | blocked | allowed |
| Upload OpenTable file | blocked | blocked | allowed |
| Resolve / undo non-pilot Fixes Needed items | blocked | blocked | allowed |
| Upload chef costs | blocked | blocked | allowed |
| Retry Toast Update | blocked | blocked | allowed, rate-limited |
| Edit Jul 31–Aug 2 pilot history | blocked | blocked | blocked |

Approval lives in `user_profiles.role` and is seeded from `ace_approved_emails`
when the auth user is first created. Signing in proves identity; it does not
grant capability.

### What anonymous readers can and cannot see

Anonymous SELECT is limited to `ace_manifest`, `ace_reference`, `ace_metrics`,
`ace_item_metrics`, `ace_intents`, `ace_ingestion_runs`, and two sanitized
views. `ace_checks`, `ace_selections`, `ace_item_costs` and `ace_import_runs`
carry an operator-only policy and have their anon grants revoked, because they
expose check-level sales, server identifiers, operator emails and uploaded file
names.

The views `ace_item_costs_public` and `ace_import_runs_public` give the public
dashboard the numbers it renders with the operator identity stripped
(`payload - 'updatedBy'`, `counts - 'actor'`, no `created_by_email`, no
`file_name`).

### Rate limiting

`ace_retry_toast_update` holds a transaction-level advisory lock, a global
10-minute cooldown across all callers and business dates, and a 20-dispatch
rolling 24-hour cap. The cooldown is deliberately **not** keyed on the caller's
business date — that let a caller cycle dates to dispatch unlimited runs.

`ace_retry_status` only reads request ids this application recorded, so it
cannot be used to enumerate unrelated `pg_net` responses.

### Withdrawn posture

An earlier build (`0006_public_access_rpc.sql`, never released) granted anon
execute on the write RPCs and accepted a browser-supplied actor session as
audit identity. That file is deleted, and `0006_manager_writes.sql` drops each
of its overloads by exact signature — so no anon-executable version survives in
a database where it was applied — and drops the `actor_session_id` columns.

## Credential handling

- Browser code carries only the project URL and the publishable key. Tests guard
  against service-role keys, secret keys, database URLs, Toast secrets or GitHub
  tokens appearing in browser-loaded files.
- Toast credentials live in GitHub Actions secrets and local administrator env.
- The GitHub token for Retry Toast Update lives in Supabase Vault
  (`ace_github_pat`) and is read only inside the `ace_retry_toast_update`
  definer function. It must be a fine-grained PAT scoped to this repository with
  Actions: write and nothing else.
- `.env` is gitignored; CI greps for leaked secrets on every push.
- See docs/SUPABASE_MIGRATION.md for which value belongs in which store.

## Data protection

- Guest PII (names, phones, requests, notes) is stripped in the browser before
  upload and rejected server-side if it appears in an upload payload.
- Raw Toast payloads stay in gitignored local storage / CI artifacts.
- Corrections are append-only audited (`ace_correction_audit`) with `user_id`
  from `auth.uid()` and `user_email` from the verified JWT. Identity is never
  taken from the request body, and there are no typed-name prompts.

## Known gaps

- Published dashboard data remains readable by anyone with the URL and passcode,
  and static assets are public on GitHub Pages. That includes named server
  performance in the aggregated metrics.
- GitHub Pages cannot set response headers, so `_headers` (Netlify/Cloudflare
  syntax) has no effect: the live site ships without `X-Frame-Options`,
  `nosniff`, `Referrer-Policy` or a `noindex` header. `robots.txt` is the only
  crawler control in force.
- Audit rows created under the withdrawn open-access build have a null
  `user_id`. `0006_manager_writes.sql` reports them and leaves the `NOT NULL`
  constraint off until an administrator resolves them, rather than deleting
  history.
- Server portal and payroll stay feature-flagged off (see docs/LIMITATIONS.md).
