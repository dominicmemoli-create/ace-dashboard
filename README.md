# AYCE Performance Dashboard — Chasin' Tails

Restaurant-management dashboard for the AYCE program at Chasin' Tails
(Founders Row, Falls Church): live Toast sales, AYCE food cost, guest-choice
conversion, and the frozen pilot review — run entirely from the browser.

**Production:** https://dominicmemoli-create.github.io/ace-dashboard/
(presentation passcode for viewing; saving changes prompts for operator
sign-in at that moment — see docs/SECURITY.md).

Operators: the whole routine is **docs/UPLOAD_GUIDE.md** (one page, no
commands). Administrators: **docs/TECHNICAL_RUNBOOK.md**.

## How it runs

- Toast sales ingest automatically every morning (GitHub Actions → Supabase);
  operators see status on **Update Dashboard** and a Retry button if needed.
- OpenTable guest status arrives as a GuestCenter CSV uploaded in the browser;
  chef costs as an occasional CSV/XLSX upload. Every approved operator has the
  same capabilities — there is no manager-versus-shift-lead hierarchy.
- Corrections happen on **Fixes Needed** — actionable exceptions only
  (conflicting recorded choices, likely-match confirmations). Half/Half is a
  guest-mix note, never a fix; unmarked visits never create work.
- All writes go through operator-checked security-definer functions
  (`supabase/migrations/0004_operator_role.sql`, building on `0003`) under
  Supabase Auth magic links. Browser code holds only the public anon key.

## Layout

| Path | What |
|---|---|
| `index.html` | App shell (gate, nav, pilot pages, extension hook) |
| `src/pages-live.mjs` | Live pages: Overview, Server Performance, Food Cost, Help |
| `src/page-update.mjs` · `src/page-fixes.mjs` | Update Dashboard · Fixes Needed |
| `src/auth.mjs` · `src/manager-mode.mjs` | Magic-link auth · role gating UI |
| `src/triage.mjs` | Fixes Needed classifier (actionable vs auto-excluded) |
| `src/food-cost-engine.mjs` · `src/metrics-builder.mjs` | Metric math (shared browser/CLI) |
| `src/opentable.mjs` · `src/ot-matcher.mjs` | GuestCenter parsing · Toast matching |
| `scripts/` · `scripts/admin/` | CLI backups · admin tools (approve emails, tokens, live verification) |
| `supabase/migrations/` | Schema, RLS, manager-tool functions |
| `data/live/` · `data/ace_payload.js` | Static fallback data · frozen pilot extract |
| `legacy/index.html` | Byte-identical pilot dashboard snapshot |
| `test/` | Vitest suite (127 tests) + `scripts/admin/verify-live.mjs` (live) |

## Quick start (developers)

```bash
npm ci
npm test                 # 127 tests
npx serve -l 5173 .      # local preview (module pages need http, not file://)
```

## Honesty invariants

- Unmatched items are never $0-costed; coverage is always displayed and counts
  only genuine cost-bearing items (Toast modifiers, preparation notes and
  trivial drinks are excluded from the model — they never mask a gap).
- Temporary costs stay flagged provisional until chef-confirmed; cost changes
  are effective-dated — history never rewrites.
- Visits without a recorded guest choice count in every operational figure
  (tables, covers, sales, food cost). Only conversion leaves them out — shown
  as unavailable, never as zero — and they never pay commission or create work.
- Every correction is audited under the authenticated user and reversible.
- Nothing claims to be connected that isn't (see docs/CREDENTIALS.md).
