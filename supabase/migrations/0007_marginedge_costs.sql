-- MarginEdge as ACE's cost input layer.
--
-- WHAT THIS DOES NOT CHANGE: Toast ingestion, the OpenTable manager upload, the
-- food-cost engine, the existing effective-dated ace_item_costs contract, the
-- pilot-window freeze, or any authorization posture from 0006. This migration is
-- purely additive — it introduces the mapping layer MarginEdge cannot provide,
-- independent per-source freshness, and an audit trail for the cost sync.
--
-- WHY A MAPPING LAYER EXISTS AT ALL
-- The MarginEdge PUBLIC API exposes no recipe endpoints: no recipes, recipe
-- ingredients, yields, conversions, plated recipe costs, or recipe cost history
-- (verified against the developer-portal Swagger export, 2026-07-01; see
-- docs/MARGINEDGE_COST_AUDIT.md). It exposes purchased PRODUCTS with a
-- latestPrice quoted per reportByUnit, plus invoice line items.
--
-- So MarginEdge answers "what does this INGREDIENT cost per purchase unit", and
-- ACE must own "how much of that ingredient is in one Toast sellable unit".
-- That portion quantity is confirmed once by the chef and then survives every
-- future price change — which is exactly the required separation of mapping
-- identity from current cost.
--
-- Apply with: node scripts/admin/bootstrap.mjs
--   or:       node scripts/admin/apply-sql.mjs supabase/migrations/0007_marginedge_costs.sql
-- Idempotent: safe to re-run.

-- ===========================================================================
-- 1. Toast <-> MarginEdge mapping layer.
-- ===========================================================================
-- Identity is keyed on the Toast item GUID wherever Toast supplies one, because
-- names drift and GUIDs do not. canonical_name is kept as the fallback key for
-- the handful of legacy rows Toast rang without an item GUID.
create table if not exists ace_marginedge_mappings (
  id text primary key,
  payload jsonb not null,
  toast_item_guid uuid generated always as
    (nullif(payload ->> 'toastItemGuid', '')::uuid) stored,
  canonical_name text generated always as (payload ->> 'canonicalName') stored,
  review_status text generated always as
    (coalesce(payload ->> 'reviewStatus', 'proposed')) stored,
  marginedge_unit_id bigint generated always as
    (nullif(payload ->> 'marginedgeRestaurantUnitId', '')::bigint) stored,
  updated_at timestamptz not null default now()
);
create index if not exists ace_me_map_guid_idx on ace_marginedge_mappings (toast_item_guid);
create index if not exists ace_me_map_name_idx on ace_marginedge_mappings (canonical_name);
create index if not exists ace_me_map_status_idx on ace_marginedge_mappings (review_status);

-- Only ONE mapping may be active per Toast item, so a cost can never be derived
-- from two conflicting portion definitions at once.
create unique index if not exists ace_me_map_one_confirmed_per_guid
  on ace_marginedge_mappings (toast_item_guid)
  where review_status = 'confirmed' and toast_item_guid is not null;
create unique index if not exists ace_me_map_one_confirmed_per_name
  on ace_marginedge_mappings (canonical_name)
  where review_status = 'confirmed' and toast_item_guid is null;

comment on table ace_marginedge_mappings is
  'Toast item -> MarginEdge product(s) + portion quantity per Toast sellable unit. '
  'payload: { id, locationId, toastItemGuid, toastItemName, canonicalName, '
  'marginedgeRestaurantUnitId, mappingType (single_product|multi_product|excluded), '
  'components [{ productId, productName, quantityPerToastUnit, unit, unitsPerReportByUnit, note }], '
  'portionBasis, confidence, reviewStatus (proposed|confirmed|rejected), reviewedBy, '
  'notes, createdAt, updatedAt }. Only reviewStatus=confirmed rows ever produce a cost.';

-- ===========================================================================
-- 2. Independent per-source freshness.
-- ===========================================================================
-- ace_manifest.last_toast_sync stays exactly where it is — Toast ingestion is
-- untouched. This table is the one place the UI can ask "how current is each
-- INDEPENDENT source", so a stale OpenTable upload never makes Toast or
-- MarginEdge look broken (and vice versa).
create table if not exists ace_source_status (
  source text primary key check (source in ('toast','marginedge','opentable')),
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  status text not null default 'never' check (status in ('never','ok','failed','stale')),
  detail jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

insert into ace_source_status (source, status) values
  ('toast','never'), ('marginedge','never'), ('opentable','never')
on conflict (source) do nothing;

comment on table ace_source_status is
  'One row per independent upstream source. A failure in one source must never '
  'be presented as the whole dashboard being down; see docs/METRICS.md.';

-- Backfill Toast from the existing manifest so the new UI is correct on day one
-- without waiting for the next nightly run.
update ace_source_status s
set last_success_at = m.last_toast_sync,
    last_attempt_at = coalesce(s.last_attempt_at, m.last_toast_sync),
    status = case when m.last_toast_sync is null then 'never' else 'ok' end,
    updated_at = now()
from ace_manifest m
where s.source = 'toast' and m.id = 1 and s.last_success_at is null;

-- Backfill OpenTable from the most recent successful manager upload.
update ace_source_status s
set last_success_at = r.created_at,
    last_attempt_at = coalesce(s.last_attempt_at, r.created_at),
    status = 'ok',
    updated_at = now()
from (select max(created_at) created_at from ace_import_runs
      where kind = 'opentable' and status = 'success') r
where s.source = 'opentable' and r.created_at is not null and s.last_success_at is null;

-- OpenTable freshness follows the manager upload automatically. Implemented as
-- a trigger on ace_import_runs rather than by editing ace_upload_opentable, so
-- the reviewed 0006 write path is untouched and the nightly upload workflow
-- keeps working exactly as it does today.
create or replace function ace_touch_source_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_source text;
begin
  v_source := case when new.kind = 'opentable' then 'opentable' else null end;
  if v_source is null then return new; end if;
  insert into ace_source_status (source, last_success_at, last_attempt_at, status, detail, updated_at)
  values (v_source,
          case when new.status = 'success' then new.created_at else null end,
          new.created_at,
          case when new.status = 'success' then 'ok' else 'failed' end,
          jsonb_build_object('fileName', new.file_name, 'counts', new.counts - 'actor'),
          now())
  on conflict (source) do update set
    last_success_at = case when new.status = 'success' then new.created_at
                           else ace_source_status.last_success_at end,
    last_attempt_at = new.created_at,
    status = case when new.status = 'success' then 'ok' else 'failed' end,
    detail = jsonb_build_object('fileName', new.file_name, 'counts', new.counts - 'actor'),
    updated_at = now();
  return new;
end $$;

drop trigger if exists ace_import_runs_source_status on ace_import_runs;
create trigger ace_import_runs_source_status
  after insert on ace_import_runs
  for each row execute function ace_touch_source_status();

-- ===========================================================================
-- 3. MarginEdge sync audit trail.
-- ===========================================================================
create table if not exists ace_marginedge_sync_runs (
  run_id text primary key,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists ace_me_sync_created_idx on ace_marginedge_sync_runs (created_at desc);

comment on table ace_marginedge_sync_runs is
  'One row per sync-marginedge-costs run: mode (dry-run|apply), counts, and every '
  'exception (held anomaly, unresolved mapping, unpriceable component) with its reason.';

-- ===========================================================================
-- 4. Cost provenance.
-- ===========================================================================
-- ace_item_costs stores a JSONB payload, so MarginEdge provenance needs no
-- column change. The additional payload fields written by the sync are:
--   source            'marginedge'
--   verification      'verified' only when the mapping was chef-confirmed
--   marginEdge { restaurantUnitId, mappingId, components [{productId, productName,
--                latestPrice, reportByUnit, quantityPerToastUnit, unit}],
--                sourceEffectiveDate, syncedAt, sourceHash }
-- sourceHash is the idempotency marker: identical MarginEdge inputs produce an
-- identical hash, so a re-run inserts nothing.
comment on table ace_item_costs is
  'Effective-dated item cost master. payload.source in '
  '(chef_confirmed|manual|rough_workbook|marginedge|vendor_derived); '
  'payload.marginEdge carries MarginEdge provenance incl. sourceHash for idempotency. '
  'A MarginEdge cost is only verification=verified when its mapping is chef-confirmed — '
  'never merely because the API returned a number.';

-- The relational mirror in 0001_schema.sql constrains source values; keep it in
-- step so a future relational writer is not rejected.
do $$
begin
  if exists (select 1 from information_schema.tables where table_name = 'item_costs') then
    alter table item_costs drop constraint if exists item_costs_source_check;
    alter table item_costs add constraint item_costs_source_check
      check (source in ('rough_workbook','chef_confirmed','vendor_derived','manual','marginedge'));
  end if;
end $$;

-- ===========================================================================
-- 5. Read posture — matches 0006 exactly.
-- ===========================================================================
alter table ace_marginedge_mappings  enable row level security;
alter table ace_source_status        enable row level security;
alter table ace_marginedge_sync_runs enable row level security;

-- Freshness and sync outcomes are what the dashboard renders for everyone, and
-- carry no operator identity or PII.
do $$
declare t text;
begin
  foreach t in array array['ace_source_status','ace_marginedge_sync_runs']
  loop
    execute format('drop policy if exists public_read on %I;', t);
    execute format('create policy public_read on %I for select using (true);', t);
  end loop;
end $$;

-- Mappings expose purchase prices and portion sizes — operator only, same as
-- ace_item_costs.
drop policy if exists operator_read on ace_marginedge_mappings;
create policy operator_read on ace_marginedge_mappings
  for select using (ace_is_operator());

-- Signed-out visitors still need coverage headlines, without prices or portions.
create or replace view ace_cost_coverage_public as
  select review_status,
         count(*)::int as items,
         count(*) filter (where payload -> 'components' is not null)::int as items_with_components
  from ace_marginedge_mappings
  group by review_status;

grant select on ace_source_status, ace_marginedge_sync_runs to anon, authenticated;
grant select on ace_cost_coverage_public to anon, authenticated;
revoke all on ace_marginedge_mappings from anon;
grant select on ace_marginedge_mappings to authenticated;

-- No client role writes directly; the sync runs as the service role from GitHub
-- Actions, exactly like nightly Toast ingestion.
revoke insert, update, delete on
  ace_marginedge_mappings, ace_source_status, ace_marginedge_sync_runs
from anon, authenticated;
