# Known limitations (current branch)

1. **Static hosting = public data.** GitHub Pages cannot enforce authentication. The
   passcode is presentational; published normalized data is readable by anyone with
   the URL. Real access control arrives with the Supabase phase (scaffolded, unfunded
   by credentials today).
2. **Food cost is estimated and partially covered.** ~83% of pilot food revenue is
   cost-mapped. Combo trays (Tray A/B, Full House, Three-of-a-Kind, Pocket Pair,
   One-Outter, Go All-In) and some à-la-carte items await chef costs; true food-cost %
   is understated until the queue clears. Costs marked "rough" are unverified workbook
   values.
3. **Alcohol/beverage cost is out of scope** — the page measures FOOD cost only
   (Food sales category).
4. **Selection-level owner attribution** is not exposed by the Toast orders API;
   attribution uses the order's server (documented rule). Transferred checks are not
   yet detectable from the ordersBulk payload alone.
5. **OpenTable is not integrated.** Production API access has not been granted
   (see docs/CREDENTIALS.md). Intent for the pilot window comes from the host log in
   the frozen pilot extract; live dates have no intent data, so conversion analytics
   remain pilot-scoped.
6. **Manual CSV import of Toast/OpenTable exports validates but does not merge** —
   final column mapping needs a real export sample; chef cost CSV import is fully
   functional (browser-local until the backend lands).
7. **Browser-local imports** (Data Import page) persist per device via localStorage;
   they are honest about this in the UI. The authoritative path is the import scripts
   + git, or the future backend.
8. **RLS tests (brief items 20–22) and scheduled cloud ingestion** require a live
   Supabase project; scaffolds and static policy tests exist, behavior tests are
   pending credentials.
9. **Legacy pilot pages** (Overview/Servers/Commission) still read the frozen pilot
   extract — by design, to preserve the reviewed pilot numbers byte-for-byte.
10. **Pilot-extract vs live-API deltas.** The pilot extract reports $89,932 floor
    revenue; the live API normalization measures $92,051 across floor checks before
    the pilot's bar-table and edge-case exclusions. The reconciliation is documented
    in the methodology page; the two bases are never mixed in one metric.
