# Chef cost-update guide

The dashboard currently uses **rough** costs from the management workbook — every
number badge shows "rough" until your confirmed costs replace it.

## What we need

One row per item, cost **per portion as it is rung in Toast**:

```csv
canonical_name,cost,portion,notes
Snow Crab (1),7.82,per cluster,
Snow Crab (2 cl),15.15,per 2 clusters,
Lamb Chops,4.10,per AYCE round (2 chops),
WDT,10.40,per Whole Dang Thang,
```

- `canonical_name`: the name from the food-cost workbook (left column). New items are
  welcome — use the menu name.
- `cost`: dollars to the cent, your plate cost for that portion.
- The tracked metric is the **AYCE program**: everything rung at $0 as an AYCE round.
  Tray A–F markers are kitchen batching terms (same-pot instruction) and carry $0 by
  design. The remaining punch list of uncosted rounds, by volume:
  **1 pc crab cake (97), EZ-Peel Shrimp ½ lb (61), Fresh Garlic Noodles (49),
  ¼ lb / ½ lb Andouille Sausage (44), Jumbo White Shrimp ½ lb (23),
  drinks included with AYCE (lemonade, sweet tea, sodas)**.
- Royal Feast trays sold **at menu price** (Full House, Three-of-a-Kind, Pocket Pair,
  One-Outter, Go All-In) are à-la-carte and outside the tracked program — cost them
  only if you also want the all-food context view to be exact.
- Do **not** cost `CLASSIC/PREMIUM/ROYALTY PER PERSON` — those are the AYCE price
  buttons; their food cost flows through the individual rounds you already cost.

## What happens on import

Your numbers replace the rough ones **from the import date forward**. Past reports
keep the costs that were in effect at the time (full audit history is preserved).
When an ingredient price changes later, send an updated row — same process, history
stays intact. No code changes, ever.
