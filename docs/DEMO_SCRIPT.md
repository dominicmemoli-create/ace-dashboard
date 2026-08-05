# Demo script — AYCE Performance Dashboard (10 minutes)

**Open the live site, passcode `ACE2026`.**

## 1 · The pilot result still stands (1 min)

Pilot Review → Overview: 36.5% AYCE cover mix vs 29.5% baseline (+7 pts),
32.9% table conversion, commission ledger frozen. Byte-identical to what was
reported in August — a regression test pins it.

## 2 · This is now a daily operating tool (3 min)

Overview: live Toast data through yesterday, updated automatically at 6 AM.
- AYCE food cost vs the "usual food cost for similar shifts" (same weekday +
  meal period, previous 4 weeks, dollar-weighted).
- Conversion counts only tables with a recorded guest starting choice that
  connect to a Toast table — missing host data never helps or hurts anyone.
- Server Performance: the same rules per server; flags refuse to fire on thin
  samples or thin cost coverage — fairness is built in.

## 3 · Anyone on the team can run it (4 min)

Update Dashboard — the whole management workload on one page:
- **Toast Sales**: "updated through yesterday — you normally do nothing."
  If a morning fails there is exactly one button: **Retry Toast Update**.
- **OpenTable Guest Status**: drop in the GuestCenter file → plain-language
  preview (dates, completed visits, anything needing a decision) → Update
  Dashboard. Re-uploading the same file is always safe.
- **Food Costs**: chef's CSV or Excel → see exactly which costs change →
  confirm. PROVISIONAL badge until chef-confirmed; history never rewrites.

Fixes Needed: only real questions, shown as cards with buttons — a conflicting
starting choice, a Half/Half table, one likely table to confirm. Sixty
unmarked visits? Excluded automatically with a one-line summary — not a to-do
list. Every decision saves under the signed-in manager and can be undone.

Manager Mode: work email → emailed sign-in link → done. Shift leads get
uploads + everyday fixes; cost updates and pilot-history decisions stay
manager-only. The passcode itself can't write anything.

## 4 · Where this goes (1 min)

- Toast automation, food-cost engine, conversion rules, pilot history:
  unchanged and test-pinned (127 tests).
- Next unlocks when wanted: automated OpenTable feed (needs their API
  approval), full chef-confirmed cost coverage, server portal (feature-flagged
  until authentication tests pass).

## Anticipated questions

- **"Is 36% good?"** It's rough workbook costs at ~90% item coverage — a solid
  first read that sharpens the day the chef's exact costs are uploaded. The
  per-cover framing ($46.60 cost vs $130.24 collected) is the margin story.
- **"Can servers see this?"** Not yet — the server portal ships only after the
  authentication test suite passes. Deliberately.
- **"Is this waste?"** No — it's what the POS says the kitchen sent. Waste
  needs inventory data (MarginEdge) — a future join.
