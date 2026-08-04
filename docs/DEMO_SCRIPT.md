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
- Headline: **~16.9% estimated food cost** on the AYCE program weekend, on **83%
  cost-mapping coverage**. Point at the PROVISIONAL badge: "these are the rough
  workbook costs — when the chef hands us exact costs, they import as data, take
  effect from that day forward, and history stays intact."
- Server table: everyone within a few points of the weighted baseline this weekend —
  no Watch/Critical flags. "The system flags 10 points over baseline as Watch, 15 as
  Critical, and it refuses to flag anyone on a thin sample or thin cost coverage —
  fairness is built in."
- Scatter: up-and-right is the goal — high AYCE mix with controlled cost.
- Unmatched queue: "full transparency on what we can't cost yet — mostly combo trays.
  That's the chef's punch list, worth ~$11.5k of revenue."

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
- **"Is 16.9% good?"** It's the AYCE-weekend floor number on rough costs and 83%
  coverage — treat it as a baseline to beat, not a final verdict. Chef costs + tray
  costs will move it.
- **"Can servers see this?"** Not yet — the server portal ships only after real
  authentication and row-level security tests pass. Deliberately.
- **"Is this waste?"** No — it's what the POS says the kitchen sent. Waste needs
  inventory data (MarginEdge) — a future join, and the schema is ready for it.
