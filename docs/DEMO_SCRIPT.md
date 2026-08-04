# Executive demo script — Thursday Aug 6, 8:00 AM (10 minutes)

**Open with the deployed dashboard, passcode `ACE2026`.**

## 1 · What you already trust still stands (1 min)
Overview page — the pilot result is unchanged: 36.5% AYCE cover mix vs 29.5% baseline,
+7 points, 32.9% table conversion. The pilot report is preserved untouched
(`legacy/index.html`) and a regression test pins its headline numbers.

## 2 · New: Food Cost (5 min)
Click **Food cost** in the left nav.
- "This is no longer a static report — this is **real item-level data from the Toast
  API**: 9,246 item selections across the pilot weekend, pulled by our own ingestion
  script."
- Headline — the tracked program metric: **~36% AYCE food cost** — the kitchen sent
  an estimated **$14.7k of food as $0-rung AYCE rounds** against **$41.0k of AYCE
  entitlement revenue** on 136 AYCE checks / 315 covers. Per cover: **~$46.60
  estimated cost vs $130.24 collected**. Royal Feast trays are à-la-carte priced and
  deliberately outside this metric.
- Point at the PROVISIONAL badge: "rough workbook costs — when the chef hands us
  exact costs, they import as data, take effect from that day forward, and history
  stays intact." And the round coverage: ~81% of round quantity is costed — **Tray A
  (321 rounds) is the single biggest uncosted item**, so expect the true % to rise.
- Server table: variance vs the weighted baseline, Watch at +10 pts, Critical at
  +15 pts, and the system refuses to flag anyone on a thin sample or thin cost
  coverage — fairness is built in.
- Scatter: up-and-right is the goal — high AYCE mix with controlled cost.
- Scope selector: flip to "All food (context)" for the blended view (~26%) — then
  flip back: "the program metric is what we manage to."

## 3 · Living system, not a one-off (2 min)
- Top bar freshness badge: "data through Aug 2, synced Aug 4."
- **Data import** page: drag a chef cost CSV in — detection, validation, duplicate
  protection, preview, confirm. A shift lead can do this.
- **Data & methodology**: sync status, coverage, provisional-vs-confirmed posture,
  and the binding conversion rule — unknown-intent tables never help or hurt anyone
  and never pay commission. Commission program itself: pilot-weekend only, off until
  management re-enables it.

## 4 · Where this goes (1 min)
Database backend is scaffolded (schema, role-based row-level security, scheduled
6 AM ingestion, server portal, payroll behind a flag). What it needs is listed on one
page: Supabase project, OpenTable approval, chef costs, payroll source decision. No
credential exists in the code; nothing claims to be connected that isn't.

## Anticipated questions
- **"Is 36% good?"** It's rough costs at 81% round coverage — treat it as a floor,
  not a verdict: Tray A/B/C/D costs will push it up, chef-exact costs will move it
  either way. The per-cover framing ($46.60 cost vs $130.24 collected) is the
  margin conversation.
- **"Can servers see this?"** Not yet — the server portal ships only after real
  authentication and row-level security tests pass. Deliberately.
- **"Is this waste?"** No — it's what the POS says the kitchen sent. Waste needs
  inventory data (MarginEdge) — a future join, and the schema is ready for it.
