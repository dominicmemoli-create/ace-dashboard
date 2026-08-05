# Demo script - AYCE Performance Dashboard (10 minutes)

Open the live site, passcode `ACE2026`.

## 1. The pilot result still stands (1 min)

Pilot Review -> Overview: 36.5% AYCE cover mix vs 29.5% baseline (+7 pts),
32.9% table conversion, commission ledger frozen. Regression tests pin the
payload and legacy snapshot.

## 2. This is now a daily operating tool (3 min)

Overview: shared Toast data, updated automatically around 6 AM.

- AYCE food cost vs the usual food cost for similar shifts.
- Conversion counts only tables with a recorded guest starting choice that
  connect to a Toast table.
- Server Performance suppresses alerts on thin samples and thin cost coverage.
- Small samples still show the estimate, clearly labeled Small sample — no alert.

## 3. Anyone with presentation access can run it (4 min)

Update Dashboard has the whole routine workload:

- Toast Sales: normally automatic. If a morning fails, Retry Toast Update is
  cooldown-protected.
- OpenTable Guest Status: drop in the GuestCenter file, review the preview,
  then update the dashboard. Re-uploading the same file is safe.
- Food Costs: chef CSV or Excel, exact diff preview, confirm. Rough costs stay
  labeled Rough costs — waiting for chef confirmation until replaced.

Fixes Needed shows one active card at a time. Only real questions appear:
conflicting starting choice, one likely table to confirm, a transfer, or an
intentional reopen. Unmarked visits and stale matches are summarized instead of
becoming a to-do list. Pilot-window rows are frozen history and do not appear.

## 4. Where this goes (1 min)

- Toast automation, food-cost engine, conversion rules, and pilot history are
  test-pinned.
- Next unlocks when wanted: authenticated operator access, automated OpenTable
  feed after API approval, full chef-confirmed cost coverage, server portal.

## Anticipated questions

- "Is this waste?" No. It is what Toast says the kitchen sent. Waste needs
  inventory data.
- "Can servers see this?" Not yet. The server portal is feature-flagged off.
- "Who can save right now?" In this temporary build, anyone with dashboard
  access can save the allowlisted updates; every write is audited with a public
  session id.
