# What Dominic needs to provide — one pager

_Everything below unblocks a piece of the platform. Nothing else is needed from you;
the code, fallbacks, and docs for each item already exist._

## 🔴 Before Thursday (demo-critical)

**1. Nothing is strictly required — the demo works today.**
Optional polish: run a fresh sync so the freshness badge says Aug 5:
```bash
node scripts/ingest-toast.mjs 20260804 --allow-desktop-config
```
then commit/push `data/live/`, and merge the branch to `main` to deploy
(see docs/DEPLOY.md).

## 🟠 This week (biggest value per effort)

**2. Chef's exact costs.** CSV, one row per item:
`canonical_name,cost,portion,notes` (template: `imports/item_costs_template.csv`).
(Tray A–F are kitchen batching markers — already $0 by design, nothing needed.)
Priority order by impact on the numbers:
- 1 pc crab cake (97 rounds) · ½-lb shrimp portions (84) · Fresh Garlic Noodles (49)
  · Andouille ¼/½ lb (44) · included drinks (lemonade/tea/soda)
- Then corrections to any rough workbook value — every current cost is "rough"
Hand the chef `docs/CHEF_COSTS.md` — it's written for them. Import per
`docs/RUNBOOK.md` (one command, or drag-drop on the Data Import page).

**3. One sample Toast "Item Selection Details" CSV export** (any single day).
Unlocks: finalizing the manual-upload column mapping so a shift lead can import
without the API.

**4. Decision: does the commission program continue?**
It's currently recorded as pilot-weekend-only and OFF (`config/feature_flags.json`).
If it returns, tell me the effective date and any rate changes — it's a config flip,
not code.

## 🟡 When you can get them (unlocks the living platform)

**5. Supabase project** (free tier is fine): create at supabase.com →
send me `SUPABASE_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY` (service key via a private
channel, never chat/email you wouldn't want forwarded — see docs/SECURITY.md).
Unlocks: real login, roles, row-level security, the 6 AM automated sync, and
eventually the server portal.

**6. OpenTable production API approval** — keep pushing the account manager;
the open questions are already written up in the OpenTable MCP project's
`docs/OPENTABLE_ACCESS_REQUIREMENTS.md`. Until then: **one sample GuestCenter
export CSV** lets me finish the manual intent-upload path.

**7. Toast nightly export (optional backup path):** ask Toast support to enable
"Nightly Data Export" (SFTP) → host + key.

## ⚪ Later (payroll phase — currently OFF by design)

**8. Payroll decisions:** which system is the source of truth, which fields exist
(hours, base wage, reported tips), and what counts as "final." Payroll stays behind
a disabled flag until this is answered and RLS tests pass — servers will never see
estimates presented as paychecks.

---
### Current state for reference
Branch `feature/live-food-cost-dashboard` (pushed, CI green, 49 tests).
Tracked metric live: **AYCE food cost ≈ 36% of entitlement revenue**
($14.7k est. round cost / $41.0k AYCE revenue · $46.60/cover vs $130.24 collected ·
90% round coverage). Royal Feasts: à-la-carte, out of scope. Tray A–F: batching
markers, $0 by design.
