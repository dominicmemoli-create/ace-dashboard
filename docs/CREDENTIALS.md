# Credential & approval checklist

| # | Dependency | Status | Exactly what's needed | Unblocks |
|---|---|---|---|---|
| 1 | Toast API client credentials | ✅ In hand (operator machine) | Already powering `scripts/ingest-toast.mjs`. For cloud ingestion, the same `TOAST_CLIENT_ID`/`SECRET` go into Supabase function env | Daily automated sync |
| 2 | Toast nightly export / SFTP | ❌ Not configured | Request "Nightly Data Export" from Toast support; host + SSH key → `TOAST_EXPORT_SFTP_*` | Backup ingestion path |
| 3 | Cloud Toast MCP for production | ⚠️ Do not assume | Only if Toast confirms unattended server-to-server auth for the MCP. Interactive use in Claude ≠ production-safe. Currently NOT planned | (alternative to #1, unnecessary) |
| 4 | OpenTable Reservation/Guest Sync | ❌ Not granted | Account manager approval; open questions already documented in the OpenTable MCP project (`docs/OPENTABLE_ACCESS_REQUIREMENTS.md` there). Yields `OPENTABLE_CLIENT_ID`/`SECRET` | Automated intent + table matching |
| 5 | OpenTable export format | ✅ Browser parser present | Standard GuestCenter reservations CSV; guest PII is stripped before upload | Manual intent upload |
| 6 | Toast item-selection export sample | ❌ Need one sample | One "Item Selection Details" CSV export to finalize CSV import mapping | Manual Toast upload without API |
| 7 | Supabase project | ✅ In use | Public URL + anon key are in `data/supabase_config.json`; service credentials stay server/admin only | Shared dashboard reads and temporary public RPC writes |
| 8 | Chef-confirmed cost workbook | ❌ Awaiting chef | CSV per docs/CHEF_COSTS.md — esp. combo trays | Full cost coverage; rough-cost label clears |
| 9 | Payroll source + definitions | ❌ Undecided | Which system, which fields, what "final" means | Payroll phase (flag stays off) |

Until each lands: the adapter interface, config path, env placeholder, docs and manual
fallback exist in-repo; nothing pretends to be connected.
