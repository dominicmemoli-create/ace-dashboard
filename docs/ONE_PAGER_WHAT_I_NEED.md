# What I need from you — one pager (updated Aug 4, post-deploy)

## ✅ Done — nothing needed, this is live right now

- **Supabase-backed dashboard deployed**: https://dominicmemoli-create.github.io/ace-dashboard/
  (passcode `ACE2026`). The Food Cost page reads live from your Supabase Postgres
  database (project "Wardrobe" — resumed from pause; consider renaming it in the
  Supabase dashboard). Static-file fallback if the DB ever pauses again.
- **The tracked metric**: AYCE food cost ≈ **36.0%** of entitlement revenue —
  $14.7k estimated round cost / $41.0k AYCE revenue · **$46.57 per cover vs
  $130.24 collected** · 90% round coverage — using your rough workbook figures.
- Toast: full item-level history flows through your API key (`npm run ingest:toast`).
  **Nightly-export/SFTP is unnecessary** — the API already gives us everything.
- Payroll: parked, per your call.

## 🎯 For the 6 PM chef meeting — bring back ONE thing

**The line-item cost sheet.** Show him the Food Cost page (drivers table +
unmatched queue is his punch list), then have him fill a CSV:

```csv
canonical_name,cost,portion,notes
Snow Crab (1),7.82,per cluster,
```

- One row per item, cost to the cent, **per portion as rung in Toast**.
- Highest-impact gaps first: 1-pc crab cake · ½-lb shrimp portions ·
  Fresh Garlic Noodles · andouille (¼/½ lb) · AYCE-included drinks.
- Corrections to any rough number — every current cost is provisional.
- Skip: Tray A–F (batching markers, $0 by design) · PER PERSON buttons
  (cost flows through rounds) · Royal Feasts at menu price (à-la-carte, out of scope).

When he hands it over, one command imports it (`docs/RUNBOOK.md`), history stays
intact via effective dating, and the PROVISIONAL badge clears. If his sheet has
per-ingredient sub-lines, send it anyway — I'll extend the cost model to roll
ingredient lines up per item (that's the "reconfigure the calculations" step, and
the schema is ready for it).

## 📋 Small asks, whenever convenient

1. **One OpenTable daily export file** (GuestCenter CSV, any day). API approval is
   off the table for now, so daily exports are the plan — one sample locks the
   column mapping, then the Data Import page (or a watched-folder script) ingests
   them routinely.
2. **One Toast "Item Selection Details" CSV export** (any day) — same reason:
   finalizes the no-API manual-upload path as a backup.
3. **Commission decision** (whenever): program is recorded as pilot-weekend-only
   and OFF. If it returns, give me the effective date — it's a config flip.
4. **Supabase housekeeping** (2 min, optional): in the dashboard rename the
   project from "Wardrobe" to something like "chasin-tails-ops". Free tier
   auto-pauses after ~1 week idle — the dashboard survives that (falls back to
   static data), but the DB wakes with one click at supabase.com.

## Deferred by your call
OpenTable API · Toast nightly export · payroll — all scaffolded, none blocking.
