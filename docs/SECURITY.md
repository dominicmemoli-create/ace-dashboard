# Security notes

## Current state (static hosting, honest posture)

- The passcode gate (`ACE2026`) is **presentation-level only** and is labeled as such
  in the app. Anyone with the URL + file access can read the published data. This was
  true of the pilot and remains true until the Supabase backend ships.
- What we publish is therefore curated: normalized, PII-free operational data
  (server names + sales figures — the same data the pilot dashboard already showed).
- Guest PII never leaves the operator machine: raw Toast payloads are gitignored
  (`data/raw/`), and normalization strips customer objects entirely.
- No credentials exist anywhere in the repository or the deployed site. CI greps for
  secret patterns on every push; `.env` is gitignored; tests verify `.env.example`
  holds placeholders only.

## Credential handling

- Toast API credentials: environment / local `.env` / operator's desktop config —
  read at runtime by the ingestion script, never written anywhere.
- Supabase service-role key: Edge Functions only. Browser code gets the anon key
  only after RLS is applied and tested.
- Payroll: no source configured; feature flag off; schema exists but no data flows.

## Backend security design (scaffolded, not yet live)

- Authorization enforced by Postgres RLS (deny-by-default), not by hiding UI.
- Roles: executive / manager / shift_lead / server via `user_profiles`.
- Server access is keyed by `employee_user_links` (auth user ↔ employee GUID),
  **never by display name**.
- Payroll tables carry stricter, separate policies than performance data.
- Ambiguous intent matches carry `review_status` and are structurally excluded from
  commission until resolved.
- Server portal and payroll pages stay behind disabled feature flags until the RLS
  suite (brief tests 20–22) passes against a live instance.

## Known gaps (deliberate, disclosed)

See docs/LIMITATIONS.md — most importantly: published dashboard data is readable by
anyone with the URL until Supabase Auth replaces the static gate.
