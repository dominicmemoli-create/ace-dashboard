# Manual upload guide (shift lead / MOD)

You cannot break anything with an upload. Duplicates are detected and skipped
automatically, and every import shows you a preview before anything happens.

1. Open the dashboard → **Data import** in the left menu.
2. Drag the file onto the dotted box (or click it and choose the file).
   Accepted today:
   - **Chef cost sheet** (CSV with columns `canonical_name,cost` — portion/notes optional)
   - Toast item-selection export (CSV) — validated and held for the database backend
   - OpenTable / host intent log (CSV) — validated and held for the database backend
3. The page shows: what the file was recognized as → how many rows are valid → how many
   are duplicates → a preview of the first rows.
4. Problem rows are listed with line numbers; you can download an error file to fix and
   re-upload. Only the bad rows fail — good rows import.
5. Click **Import** to confirm. Nothing imports until you click it.
6. The "Recent data loads" table at the bottom confirms what landed.

Notes
- Uploading the same file twice never duplicates data.
- Cost uploads take effect from today forward; historical numbers never change.
- If intent is blank or unclear on a host log, it counts as **Unknown** — it will not
  help or hurt anyone's conversion rate, and it never pays commission.
