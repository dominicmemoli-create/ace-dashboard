# Security notes

## Access model (current)

Two independent layers, honestly labeled:

1. **Presentation gate** (passcode `ACE2026`): hides the read-only dashboard
   from casual visitors. It is embedded in the page, provides **no security**,
   and — by design — **authorizes no writes whatsoever**.
2. **Operator sign-in** (Supabase Auth, email magic links): every write goes
   through security-definer database functions that re-check the signed-in
   user on the server (`supabase/migrations/0004_operator_role.sql`). There is
   **one operator capability** — every approved operator can do everything;
   there is no manager-versus-shift-lead hierarchy and no persistent "mode":
   a signed-out visitor is prompted for the magic link at the moment they
   attempt a write. Anonymous users cannot execute any write function; anon
   key holders get read-only access to the same PII-free data the static site
   already published.

Authorization matrix:

| Action | approved operator | anyone else |
|---|---|---|
| Read dashboard | ✓ | ✓ (behind passcode) |
| Upload OpenTable file | ✓ | ✗ |
| Resolve / undo Fixes Needed items (incl. pilot-window dates) | ✓ | ✗ |
| Upload chef costs | ✓ | ✗ |
| Retry Toast Update | ✓ | ✗ |

Approved emails: `ace_approved_emails` (managed by
`scripts/admin/add-manager.mjs`; the stored role values executive / manager /
shift_lead are legacy labels that all map to the same operator capability).
Unknown emails cannot request a sign-in link, and any user created another way
lands as role `server` with no writes.

## Credential handling

- **Browser code carries only the public anon key.** Verified by tests: no
  service-role key, database URL, Toast secret, or GitHub token appears in any
  browser-loaded file.
- **Toast credentials**: GitHub Actions secrets (nightly ingestion) and the
  operator machine only.
- **GitHub token for Retry Toast Update**: Supabase Vault (`ace_github_pat`),
  read only inside the `ace_retry_toast_update` definer function. Rotate with
  `scripts/admin/set-github-token.mjs`; prefer a fine-grained PAT scoped to
  this repository with Actions read/write only.
- `.env` is gitignored; CI greps for leaked secrets on every push.

## Data protection

- Guest PII (names, phones, requests, notes) is stripped in the browser before
  upload and **rejected server-side** if it ever appears in an upload payload.
- Raw Toast payloads stay in gitignored local storage / CI artifacts.
- Corrections are append-only audited (`ace_correction_audit`) with the
  authenticated identity — never a typed name — and are reversible.

## Known gaps (deliberate, disclosed)

- Published dashboard data remains readable by anyone with the URL + passcode;
  acceptable because it is the same PII-free dataset the pilot already
  published. Tightening read access = replace the anon read policies with
  authenticated-only policies (one migration; UI already handles auth).
- Server portal and payroll stay feature-flagged off (see docs/LIMITATIONS.md).
