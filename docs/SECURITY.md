# Security notes

## Access model (temporary)

Two layers are intentionally separate:

1. **Presentation gate** (passcode `ACE2026`): hides the dashboard UI from
   casual visitors. It is embedded in the page and is not real authentication.
2. **Public RPC allowlist** (`supabase/migrations/0006_public_access_rpc.sql`):
   the browser uses only the Supabase anon key. The database grants anon
   execute only on the narrow dashboard RPCs for OpenTable upload, cost upload,
   metric rebuild, Fixes Needed save/undo, Toast retry/status, and `whoami`.

Security implication: anyone who has the URL and public site config can attempt
the allowlisted RPCs during this temporary presentation build. The server still
validates payload shape, rejects guest PII, keeps RLS/table writes behind
security-definer functions, applies Toast retry cooldown/locking, and records a
public session id with every write.

Authorization matrix:

| Action | visitor with public site access |
|---|---|
| Read dashboard | allowed |
| Upload OpenTable file | allowed via anon RPC |
| Resolve / undo non-pilot Fixes Needed items | allowed via anon RPC |
| Upload chef costs | allowed via anon RPC |
| Retry Toast Update | allowed via anon RPC, cooldown-protected |
| Edit Jul 31-Aug 2 pilot history | blocked; Pilot Review is frozen |

The prior approved-operator/magic-link posture remains in older migrations for
history, but current browser code does not request sign-in. Re-tightening access
later should be done with a forward migration that revokes anon execute from the
write RPCs and restores an authenticated operator check.

## Credential handling

- Browser code carries only the public anon key. Tests guard against service-role
  keys, database URLs, Toast secrets, or GitHub tokens in browser-loaded files.
- Toast credentials live in GitHub Actions secrets and local administrator env.
- The GitHub token for Retry Toast Update lives in Supabase Vault
  (`ace_github_pat`) and is read only inside the `ace_retry_toast_update`
  definer function.
- `.env` is gitignored; CI greps for leaked secrets on every push.

## Data protection

- Guest PII (names, phones, requests, notes) is stripped in the browser before
  upload and rejected server-side if it appears in an upload payload.
- Raw Toast payloads stay in gitignored local storage / CI artifacts.
- Corrections are append-only audited (`ace_correction_audit`) with
  `user_email = public-site visitor` and `actor_session_id`; no typed names.

## Known gaps

- The temporary public write model is intentionally less restrictive than an
  authenticated operator model. Treat it as presentation access, not permanent
  production authorization.
- Published dashboard data remains readable by anyone with the URL and passcode,
  and static assets are public on GitHub Pages.
- Server portal and payroll stay feature-flagged off (see docs/LIMITATIONS.md).
