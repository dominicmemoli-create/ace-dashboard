# ACE Dashboard — Chasin' Tails AYCE operational platform

Management dashboard for the AYCE pilot at Chasin' Tails (Founders Row, Falls Church):
pilot analytics, guest-intent conversion, and a live **food-cost** system driven by
item-selection data from the Toast API.

**Production:** https://dominicmemoli-create.github.io/ace-dashboard/ (passcode-gated
presentation; see docs/SECURITY.md for what that does and doesn't mean).

## Layout

| Path | What |
|---|---|
| `index.html` | The app shell (pilot pages + extension hook) |
| `src/food-cost-engine.mjs` | Pure calculation engine (shared browser/tests) |
| `src/pages-live.mjs` | Food Cost, Data Import, methodology augmentation |
| `src/adapters/` | Toast/OpenTable source adapter contracts |
| `data/ace_payload.js` | Frozen pilot extract (regression-pinned) |
| `data/live/` | Normalized Toast data, cost master, run log, manifest |
| `scripts/` | `ingest-toast.mjs` (ToastApiAdapter) · `import-costs.mjs` |
| `supabase/` | Migrations (schema + RLS), scheduled-ingestion function scaffold |
| `imports/` | Cost workbook, alias map, chef CSV template |
| `legacy/index.html` | Byte-identical pilot dashboard snapshot |
| `docs/` | Runbook, guides, metrics, data dictionary, security, demo script |
| `test/` | Vitest suite (engine rules + security posture + reconciliation) |

## Quick start

```bash
npm ci
npm test                 # 43 tests
npx serve -l 5173 .      # local preview (module pages need http, not file://)
```

Daily data: `node scripts/ingest-toast.mjs YYYYMMDD --allow-desktop-config` →
commit `data/live/` → push. Chef costs: see docs/CHEF_COSTS.md and docs/RUNBOOK.md.

## Honesty invariants

- Unmatched items are never $0-costed; coverage is always displayed.
- Rough workbook costs are flagged until chef-confirmed; replacements are data
  imports with effective dating — history never rewrites.
- Unknown / pre-decided intent never enters the conversion rate and never pays
  commission.
- Nothing claims to be connected that isn't (see docs/CREDENTIALS.md).
