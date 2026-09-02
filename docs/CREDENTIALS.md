# Credential & approval checklist

| # | Dependency | Status | Exactly what's needed | Unblocks |
|---|---|---|---|---|
| 1 | Toast API client credentials | ✅ In hand (operator machine) | Already powering `scripts/ingest-toast.mjs`. For cloud ingestion, the same `TOAST_CLIENT_ID`/`SECRET` go into Supabase function env | Daily automated sync |
| 2 | Toast nightly export / SFTP | ❌ Not configured | Request "Nightly Data Export" from Toast support; host + SSH key → `TOAST_EXPORT_SFTP_*` | Backup ingestion path |
| 3 | Cloud Toast MCP for production | ⚠️ Do not assume | Only if Toast confirms unattended server-to-server auth for the MCP. Interactive use in Claude ≠ production-safe. Currently NOT planned | (alternative to #1, unnecessary) |
| 4 | OpenTable Reservation/Guest Sync | ❌ Not granted | Account manager approval; open questions already documented in the OpenTable MCP project (`docs/OPENTABLE_ACCESS_REQUIREMENTS.md` there). Yields `OPENTABLE_CLIENT_ID`/`SECRET` | Automated intent + table matching |
| 5 | OpenTable export format | ✅ Browser parser present | Standard GuestCenter reservations CSV; guest PII is stripped before upload | Manual intent upload |
| 6 | Toast item-selection export sample | ❌ Need one sample | One "Item Selection Details" CSV export to finalize CSV import mapping | Manual Toast upload without API |
| 7 | Supabase project | ✅ In use |  Dedicated `ace-dashboard` project. Public URL + publishable key are in `data/supabase_config.json`; DB URL and secret key stay in `.env` / password manager only | Dashboard reads (anon, read-only) and manager-authenticated writes |
| 8 | Chef-confirmed cost workbook | ⚠️ Superseded as the normal path | Still the fallback/override route (docs/CHEF_COSTS.md). The normal path is now #10 + #11 | Emergency cost corrections |
| 10 | **MarginEdge API key** | ✅ Set 2026-09-01 | Repo secrets `MARGINEDGE_API_KEY` and `MARGINEDGE_RESTAURANT_UNIT_ID=377809302` exist (`gh secret list`). The key is the same one the read-only MCP connector uses, so the two are not independently rotatable — issue a second key in MarginEdge (UI → API; shown once) when convenient and `gh secret set MARGINEDGE_API_KEY` | Daily automated cost sync (`marginedge-costs.yml`) |
| 11 | **Confirmed portion mappings** | ❌ Awaiting review | Portion quantity per Toast item, not prices. **26 staged** in `config/marginedge_mappings.seed.json` and loaded as `proposed`. 9 are already fully determined by MarginEdge vendor grades + the Toast name (a manager can flip them to `confirmed`), 4 need a count at receiving, 3 a manager yes/no, **6 need the chef**. Confirm/correct, set `reviewStatus: "confirmed"`, reload with `npm run load:marginedge-mappings -- --apply`. Lists in docs/MARGINEDGE_COST_AUDIT.md §8 | Verified MarginEdge cost coverage |
| 12 | MarginEdge recipe/plate-cost API | 🚫 Does not exist | The MarginEdge **public API has no recipe endpoints** (verified 2026-07-01). Plated costs cannot be read from MarginEdge at all — hence #11. Re-check only if MarginEdge publishes new endpoints | (would simplify #11) |
| 9 | Payroll source + definitions | ❌ Undecided | Which system, which fields, what "final" means | Payroll phase (flag stays off) |

Until each lands: the adapter interface, config path, env placeholder, docs and manual
fallback exist in-repo; nothing pretends to be connected.
