# AYCE Performance Dashboard — Chasin' Tails

Restaurant-management dashboard for the AYCE program at Chasin' Tails
(Founders Row, Falls Church): live Toast sales, AYCE food cost, guest-choice
conversion, and the frozen pilot review — run entirely from the browser.

**Production:** https://dominicmemoli-create.github.io/ace-dashboard/
(presentation passcode; writes require Manager Mode — see docs/SECURITY.md).

Managers: the whole routine is **docs/UPLOAD_GUIDE.md** (one page, no
commands). Operators: **docs/TECHNICAL_RUNBOOK.md**.

## How it runs

- Toast sales ingest automatically every morning (GitHub Actions → Supabase);
  managers see status on **Update Dashboard** and a Retry button if needed.
- OpenTable guest status arrives as a GuestCenter CSV uploaded in the browser;
  chef costs as an occasional CSV/XLSX upload (manager-only).
- Corrections happen on **Fixes Needed** — actionable exceptions only; unknown
  or unreliable records are excluded automatically and never create work.
- All writes go through role-checked security-definer functions
  (`supabase/migrations/0003_manager_tools.sql`) under Supabase Auth magic
  links. Browser code holds only the public anon key.

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

- Unmatched items are never $0-costed; coverage is always displayed.
- Rough costs stay flagged provisional until chef-confirmed; cost changes are
  effective-dated — history never rewrites.
- Unknown / unmarked guest choices never enter conversion and never pay
  commission; they are excluded automatically, not turned into busywork.
- Every correction is audited under the authenticated user and reversible.
- Nothing claims to be connected that isn't (see docs/CREDENTIALS.md).
