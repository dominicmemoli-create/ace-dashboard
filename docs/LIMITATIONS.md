# Known limitations

1. **Temporary public writes.** GitHub Pages cannot enforce server-side
   authentication, and the current presentation build grants anon execute on a
   narrow RPC allowlist. Treat this as temporary, not permanent production
   authorization.
2. **Public static assets.** The passcode is presentational; static files and
   normalized PII-free dashboard data remain public to anyone with the URL.
3. **Food cost is estimated until confirmed.** Rough costs are labeled
   `Rough costs — waiting for chef confirmation`; true food-cost percentage may
   sharpen as chef-confirmed costs replace workbook estimates and fallbacks.
4. **Alcohol/beverage cost is out of scope.** The page measures food cost only.
5. **OpenTable automation is not integrated.** Manual GuestCenter CSV upload is
   the current path; API approval is still required for unattended sync.
6. **Selection-level owner attribution is not exposed by the Toast orders API.**
   Attribution uses the order server; transfer exceptions require review.
7. **Legacy pilot pages** (Overview/Servers/Commission) still read the frozen
   pilot extract by design, to preserve reviewed pilot numbers byte-for-byte.
8. **Pilot history is frozen.** Jul 31-Aug 2, 2026 rows are informational and
   cannot be edited from Fixes Needed.
9. **Server portal and payroll remain off.** Feature flags stay disabled until
   access control and payroll definitions are intentionally rebuilt.
