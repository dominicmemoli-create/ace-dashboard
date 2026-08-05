# Dashboard guide - keeping data current

Everything happens in the dashboard itself. You never need a terminal, GitHub,
or any technical tool. Uploading the same file twice is safe.

## The whole job

1. Toast updates by itself every morning around 6 AM. Normally do nothing.
2. After service, export the reservations CSV from OpenTable GuestCenter.
3. Open the dashboard and enter the presentation passcode.
4. Go to Update Dashboard.
5. Click Upload OpenTable File and drop the file in.
6. Read the plain-language summary.
7. Click Update Dashboard to save. Everyone sees it.
8. If anything needs a call, it appears under Fixes Needed. Pick an answer,
   pick a reason, press Save.

## Access

This temporary presentation build does not ask for sign-in after the passcode.
Every visitor who reaches the dashboard can upload files, update food costs,
resolve non-pilot fixes, and retry Toast updates. The database limits those
writes to specific public RPC functions and records a public session id.

Pilot Review history is frozen. Jul 31-Aug 2, 2026 records are informational
only and cannot be edited from Fixes Needed.

## Food costs

When the chef confirms costs: Update Dashboard -> Upload Food Costs, drop in
the cost sheet (CSV or Excel), review what changes, confirm. Chef-confirmed
values replace the rough costs item by item, and numbers stay marked
**Rough costs — waiting for chef confirmation** until they do. Past days never
change; new costs apply from their effective date forward.

## If Toast is behind

Update Dashboard shows **Toast update needs attention** with one button:
Retry Toast Update. Press it; the update runs by itself and the status refreshes
when it finishes. A cooldown prevents repeated retry clicks from stacking.

## Good to know

- Visits with no recorded starting choice still count in every sales, cover
  and food-cost figure. Only conversion leaves them out.
- Half/Half means about half the party are returning guests and half are
  first-timers. It is information only, never a decision.
- Every fix you save keeps the original value and can be undone from Recently
  decided on the Fixes Needed page.
