-- Manager tools: Supabase Auth roles + protected server-side functions (RPC).
--
-- Why RPC instead of Edge Functions: these security-definer functions ARE the
-- protected server-side endpoints. The browser calls them through PostgREST
-- with the signed-in user's JWT; the role check happens in the database, the
-- GitHub token lives in Supabase Vault and is only read inside the definer
-- function. No service-role key, Toast secret, GitHub token or database
-- password ever reaches browser code.
--
-- Apply with: node scripts/admin/apply-sql.mjs supabase/migrations/0003_manager_tools.sql
-- Idempotent: safe to re-run.

create extension if not exists pg_net;

-- ------------------------------------------------------------ roles / auth --
create table if not exists user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'server' check (role in ('executive','manager','shift_lead','server')),
  display_name text,
  created_at timestamptz not null default now()
);
alter table user_profiles enable row level security;

-- Approved manager/shift-lead emails. Populated by scripts/admin/add-manager.mjs
-- (or the documented SQL). New auth users get their role from this list; anyone
-- else lands as 'server' with no write powers.
create table if not exists ace_approved_emails (
  email text primary key,
  role text not null check (role in ('executive','manager','shift_lead')),
  added_by text,
  added_at timestamptz not null default now()
);
alter table ace_approved_emails enable row level security;
-- no policies: readable only by definer functions / service role.

create or replace function ace_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from user_profiles where id = auth.uid()), 'none');
$$;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'user_profiles' and policyname = 'profile_own') then
    create policy profile_own on user_profiles for select using (id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'user_profiles' and policyname = 'profile_mgmt') then
    create policy profile_mgmt on user_profiles for select using (ace_role() in ('executive','manager'));
  end if;
end $$;

-- Auto-provision a profile when an auth user is created (magic-link sign-in).
create or replace function ace_handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into user_profiles (id, role, display_name)
  values (
    new.id,
    coalesce((select role from ace_approved_emails where lower(email) = lower(new.email)), 'server'),
    split_part(coalesce(new.email, ''), '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists ace_on_auth_user_created on auth.users;
create trigger ace_on_auth_user_created after insert on auth.users
  for each row execute function ace_handle_new_user();

-- ------------------------------------------------------------- import runs --
create table if not exists ace_import_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('opentable','costs','toast_retry','metrics_rebuild')),
  file_name text,
  file_hash text,
  counts jsonb not null default '{}',
  status text not null default 'success' check (status in ('success','failed')),
  error text,
  created_by uuid,
  created_by_email text,
  created_at timestamptz not null default now()
);
create index if not exists ace_import_runs_kind_idx on ace_import_runs (kind, created_at desc);
alter table ace_import_runs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'ace_import_runs' and policyname = 'poc_read') then
    -- same POC read posture as the other ace_* tables (no PII in here);
    -- writes only through the definer functions below.
    create policy poc_read on ace_import_runs for select using (true);
  end if;
end $$;

-- -------------------------------------------------------- correction audit --
create table if not exists ace_correction_audit (
  id uuid primary key default gen_random_uuid(),
  row_hash text not null,
  action text not null,
  original jsonb,
  corrected jsonb,
  reason text not null,
  note text,
  user_id uuid not null,
  user_email text not null,
  created_at timestamptz not null default now()
);
create index if not exists ace_correction_audit_row_idx on ace_correction_audit (row_hash, created_at desc);
alter table ace_correction_audit enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'ace_correction_audit' and policyname = 'audit_mgmt_read') then
    create policy audit_mgmt_read on ace_correction_audit for select
      using (ace_role() in ('executive','manager','shift_lead'));
  end if;
end $$;

-- SQL twin of normalizeName() in src/food-cost-engine.mjs / import-costs.mjs.
create or replace function ace_norm_name(t text) returns text
language sql immutable as $$
  select trim(regexp_replace(regexp_replace(lower(coalesce(t, '')), '[^a-z0-9 ]+', ' ', 'g'), '\s+', ' ', 'g'));
$$;

-- ==================================================== RPC: upload-opentable ==
-- Managers and shift leads. Rows arrive already sanitized (parsed + matched in
-- the browser from the GuestCenter CSV using src/opentable.mjs / src/ot-matcher.mjs);
-- this function is the write gate: role check, PII guard, idempotent upsert,
-- import-run record. Re-uploading the same file changes nothing, and existing
-- manager corrections are never overwritten (insert ... do nothing by row hash).
create or replace function ace_upload_opentable(p_rows jsonb, p_file_name text default null, p_file_hash text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := ace_role();
  v_email text := coalesce(auth.jwt() ->> 'email', '');
  v_total int;
  v_inserted int := 0;
  v_dupfile boolean := false;
  v_dates jsonb;
  r jsonb;
  k text;
begin
  if v_role not in ('executive','manager','shift_lead') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid_payload';
  end if;
  v_total := jsonb_array_length(p_rows);
  if v_total = 0 then raise exception 'empty_upload'; end if;
  if v_total > 5000 then raise exception 'too_many_rows'; end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    -- PII guard: the sanitized shape must not carry guest fields or raw rows.
    foreach k in array array['guestName','phone','guestRequests','visitNotes','raw'] loop
      if r ? k then raise exception 'pii_field_rejected'; end if;
    end loop;
    if coalesce(r ->> 'rowHash', '') = '' or (r ->> 'businessDate') !~ '^[0-9]{8}$' then
      raise exception 'row_missing_keys';
    end if;
  end loop;

  if p_file_hash is not null and exists (
    select 1 from ace_import_runs
    where kind = 'opentable' and file_hash = p_file_hash and status = 'success'
  ) then
    v_dupfile := true;
  end if;

  insert into ace_intents (row_hash, business_date, payload)
  select x ->> 'rowHash', x ->> 'businessDate', x
  from jsonb_array_elements(p_rows) x
  on conflict (row_hash) do nothing;
  get diagnostics v_inserted = row_count;

  select coalesce(jsonb_agg(distinct d order by d), '[]'::jsonb) into v_dates
  from (select x ->> 'businessDate' d from jsonb_array_elements(p_rows) x) s;

  insert into ace_import_runs (kind, file_name, file_hash, counts, created_by, created_by_email)
  values ('opentable', p_file_name, p_file_hash,
          jsonb_build_object('total', v_total, 'inserted', v_inserted,
                             'duplicates', v_total - v_inserted, 'dates', v_dates,
                             'duplicateFile', v_dupfile),
          auth.uid(), v_email);

  return jsonb_build_object('inserted', v_inserted, 'duplicates', v_total - v_inserted,
                            'total', v_total, 'dates', v_dates, 'duplicateFile', v_dupfile);
end $$;

-- ======================================================= RPC: upload-costs ==
-- Manager-only. Effective-dated cost import: closes each open record the day
-- before the new effective date and appends the new record — history never
-- rewrites (mirrors scripts/import-costs.mjs). Re-uploading the same file for
-- the same effective date updates in place (idempotent).
create or replace function ace_upload_costs(
  p_records jsonb,
  p_effective_from text,
  p_source text default 'chef_confirmed',
  p_file_name text default null,
  p_file_hash text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := ace_role();
  v_email text := coalesce(auth.jwt() ->> 'email', '');
  v_day_before text;
  v_now timestamptz := now();
  rec jsonb;
  v_name text; v_cost numeric; v_norm text; v_guid text;
  v_open record;
  v_recognized int := 0; v_changed int := 0; v_unchanged int := 0;
  v_added int := 0; v_closed int := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_changed_items jsonb := '[]'::jsonb;
  v_id text;
  v_verification text;
  v_aliases jsonb;
begin
  if v_role not in ('executive','manager') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_records is null or jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) = 0 then
    raise exception 'invalid_payload';
  end if;
  if jsonb_array_length(p_records) > 2000 then raise exception 'too_many_rows'; end if;
  if p_effective_from !~ '^[0-9]{8}$' then raise exception 'invalid_effective_date'; end if;
  if p_source not in ('chef_confirmed','manual','rough_workbook') then raise exception 'invalid_source'; end if;
  v_day_before := to_char(to_date(p_effective_from, 'YYYYMMDD') - 1, 'YYYYMMDD');
  v_verification := case when p_source = 'chef_confirmed' then 'verified' else 'unverified' end;

  -- name -> most-frequent Toast item GUID, from the live selection data
  drop table if exists ace_tmp_guids;
  create temp table ace_tmp_guids on commit drop as
  select distinct on (nname) nname, guid from (
    select ace_norm_name(payload ->> 'itemName') nname, payload ->> 'itemGuid' guid,
           sum(coalesce((payload ->> 'quantity')::numeric, 1)) qty
    from ace_selections
    where payload ->> 'itemGuid' is not null and coalesce(payload ->> 'itemName', '') <> ''
    group by 1, 2) s
  order by nname, qty desc;

  for rec in select * from jsonb_array_elements(p_records) loop
    v_name := trim(coalesce(rec ->> 'name', ''));
    v_cost := (rec ->> 'cost')::numeric;
    if v_name = '' or v_cost is null or v_cost <= 0 or v_cost >= 500 then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('name', v_name, 'why', 'invalid name or cost'));
      continue;
    end if;
    v_recognized := v_recognized + 1;
    v_norm := ace_norm_name(v_name);
    v_aliases := coalesce(rec -> 'aliases', '[]'::jsonb);

    -- GUID: canonical name first, then aliases
    select guid into v_guid from ace_tmp_guids where nname = v_norm;
    if v_guid is null then
      select g.guid into v_guid
      from jsonb_array_elements_text(v_aliases) a
      join ace_tmp_guids g on g.nname = ace_norm_name(a)
      limit 1;
    end if;

    -- currently-open record for the same canonical item
    select id, payload into v_open from ace_item_costs
    where canonical_name = v_name and payload ->> 'effectiveTo' is null
    order by effective_from desc limit 1;

    if v_open.id is not null and (v_open.payload ->> 'effectiveFrom') > p_effective_from then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('name', v_name,
        'why', 'a newer cost is already effective ' || (v_open.payload ->> 'effectiveFrom')));
      continue;
    end if;

    if v_open.id is null then
      v_changed := v_changed + 1;  -- brand-new item counts as a change
      v_changed_items := v_changed_items || jsonb_build_array(jsonb_build_object(
        'name', v_name, 'oldCost', null, 'newCost', v_cost));
    elsif abs(coalesce((v_open.payload ->> 'costPerUnit')::numeric, 0) - v_cost) > 0.005
          or coalesce(v_open.payload ->> 'source', '') <> p_source then
      v_changed := v_changed + 1;
      v_changed_items := v_changed_items || jsonb_build_array(jsonb_build_object(
        'name', v_name, 'oldCost', (v_open.payload ->> 'costPerUnit')::numeric, 'newCost', v_cost));
    else
      v_unchanged := v_unchanged + 1;
    end if;

    -- close the prior open record (only when it is genuinely older)
    if v_open.id is not null and (v_open.payload ->> 'effectiveFrom') < p_effective_from then
      update ace_item_costs
      set payload = payload || jsonb_build_object('effectiveTo', v_day_before, 'updatedAt', v_now),
          updated_at = v_now
      where id = v_open.id;
      v_closed := v_closed + 1;
    end if;

    v_id := 'cost-' || replace(v_norm, ' ', '-') || '-' || p_effective_from;
    insert into ace_item_costs (id, payload, updated_at)
    values (v_id, jsonb_build_object(
      'id', v_id,
      'toastItemGuid', v_guid,
      'toastSelectionGuid', null,
      'canonicalName', v_name,
      'aliases', v_aliases,
      'portion', coalesce(nullif(rec ->> 'portion', ''), 'per recorded Toast selection quantity'),
      'costPerUnit', v_cost,
      'effectiveFrom', p_effective_from,
      'effectiveTo', null,
      'source', p_source,
      'verification', v_verification,
      'notes', coalesce(rec ->> 'notes', ''),
      'createdAt', v_now,
      'updatedAt', v_now,
      'updatedBy', v_email), v_now)
    on conflict (id) do update set payload = excluded.payload, updated_at = v_now;
    v_added := v_added + 1;
  end loop;

  insert into ace_import_runs (kind, file_name, file_hash, counts, created_by, created_by_email)
  values ('costs', p_file_name, p_file_hash,
          jsonb_build_object('recognized', v_recognized, 'changed', v_changed,
                             'unchanged', v_unchanged, 'added', v_added, 'closed', v_closed,
                             'skipped', v_skipped, 'effectiveFrom', p_effective_from,
                             'source', p_source),
          auth.uid(), v_email);

  return jsonb_build_object('recognized', v_recognized, 'changed', v_changed,
                            'unchanged', v_unchanged, 'added', v_added, 'closed', v_closed,
                            'skipped', v_skipped, 'changedItems', v_changed_items);
end $$;

-- ==================================================== RPC: replace-metrics ==
-- Manager-only. Transactional per-date replacement of the aggregate rows after
-- a cost change. The rows are recomputed in the browser by the SAME tested
-- engine the CLI uses (src/metrics-builder.mjs); this function only accepts
-- them for the declared dates and swaps them atomically.
create or replace function ace_replace_metrics(p_dates jsonb, p_rows jsonb, p_item_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := ace_role();
  v_email text := coalesce(auth.jwt() ->> 'email', '');
  d text;
  v_rows int := 0; v_items int := 0;
begin
  if v_role not in ('executive','manager') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_dates is null or jsonb_typeof(p_dates) <> 'array' or jsonb_array_length(p_dates) = 0
     or jsonb_array_length(p_dates) > 120 then
    raise exception 'invalid_dates';
  end if;
  for d in select jsonb_array_elements_text(p_dates) loop
    if d !~ '^[0-9]{8}$' then raise exception 'invalid_dates'; end if;
  end loop;
  -- every submitted row must belong to a declared date
  if exists (select 1 from jsonb_array_elements(p_rows) x
             where not (p_dates ? (x ->> 'businessDate'))) or
     exists (select 1 from jsonb_array_elements(p_item_rows) x
             where not (p_dates ? (x ->> 'businessDate'))) then
    raise exception 'row_outside_declared_dates';
  end if;

  delete from ace_metrics where business_date in (select jsonb_array_elements_text(p_dates));
  delete from ace_item_metrics where business_date in (select jsonb_array_elements_text(p_dates));

  insert into ace_metrics (unique_key, business_date, period, server_guid, payload)
  select (x ->> 'businessDate') || '|' || (x ->> 'period') || '|' || coalesce(x ->> 'serverGuid', '-'),
         x ->> 'businessDate', x ->> 'period', (x ->> 'serverGuid')::uuid, x
  from jsonb_array_elements(p_rows) x
  on conflict (unique_key) do update set payload = excluded.payload;
  get diagnostics v_rows = row_count;

  insert into ace_item_metrics (unique_key, business_date, period, payload)
  select (x ->> 'businessDate') || '|' || (x ->> 'period') || '|' || (x ->> 'name'),
         x ->> 'businessDate', x ->> 'period', x
  from jsonb_array_elements(p_item_rows) x
  on conflict (unique_key) do update set payload = excluded.payload;
  get diagnostics v_items = row_count;

  insert into ace_import_runs (kind, counts, created_by, created_by_email)
  values ('metrics_rebuild',
          jsonb_build_object('dates', p_dates, 'rows', v_rows, 'itemRows', v_items),
          auth.uid(), v_email);

  return jsonb_build_object('dates', p_dates, 'rows', v_rows, 'itemRows', v_items);
end $$;

-- =================================================== RPC: save-review-fix ==
-- Managers, shift leads. Saves a Fixes Needed decision directly to the shared
-- database: original values preserved inside the payload AND in the append-only
-- audit table; identity comes from the authenticated user (never typed in).
-- Reversible: REVERT restores the original source values from the stored
-- snapshot and reopens the item.
--
-- Shift-lead limits: mixed-menu policy exceptions and anything dated inside the
-- frozen pilot-commission window (Jul 31 – Aug 2, 2026) require a manager.
create or replace function ace_save_review_fix(
  p_row_hash text,
  p_action text,
  p_reason text,
  p_note text default null,
  p_order_guid text default null,
  p_server_guid text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := ace_role();
  v_email text := coalesce(auth.jwt() ->> 'email', '');
  v_uid uuid := auth.uid();
  v_row record;
  v_payload jsonb;
  v_original jsonb;
  v_patch jsonb;
  v_has_ayce boolean;
  v_server text;
  v_corrected jsonb;
  c_pilot_from constant text := '20260731';
  c_pilot_to constant text := '20260802';
begin
  if v_role not in ('executive','manager','shift_lead') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_action not in ('UNDECIDED','ALC','PREDECIDED_AYCE','EXCLUDE','CONNECT','KEEP_FINAL','SET_SERVER','REVERT','REOPEN') then
    raise exception 'invalid_action';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required'; end if;

  select row_hash, business_date, payload into v_row from ace_intents where row_hash = p_row_hash;
  if v_row.row_hash is null then raise exception 'unknown_row'; end if;
  v_payload := v_row.payload;

  if v_role = 'shift_lead' then
    if v_row.business_date between c_pilot_from and c_pilot_to then
      raise exception 'manager_required_pilot_window' using errcode = '42501';
    end if;
    if coalesce((v_payload ->> 'mixedMenuException')::boolean, false)
       and p_action in ('KEEP_FINAL','SET_SERVER','PREDECIDED_AYCE','ALC','UNDECIDED') then
      raise exception 'manager_required_mixed_menu' using errcode = '42501';
    end if;
  end if;

  -- first-correction snapshot survives later corrections
  v_original := coalesce(v_payload -> 'correction' -> 'original', jsonb_build_object(
    'intent', v_payload -> 'intent',
    'intentEffective', v_payload -> 'intentEffective',
    'matchStatus', v_payload -> 'matchStatus',
    'matchedOrderGuid', v_payload -> 'matchedOrderGuid',
    'matchConfidence', v_payload -> 'matchConfidence',
    'hasAyceSales', v_payload -> 'hasAyceSales',
    'matchedServerGuid', v_payload -> 'matchedServerGuid',
    'excluded', coalesce(v_payload -> 'excluded', 'false'::jsonb),
    'reviewStatus', v_payload -> 'reviewStatus'));

  if p_action in ('UNDECIDED','ALC','PREDECIDED_AYCE') then
    v_corrected := to_jsonb(p_action);
    v_patch := jsonb_build_object(
      'correction', jsonb_build_object('original', v_original, 'corrected', v_corrected,
        'reason', p_reason, 'note', p_note, 'user', v_email, 'userId', v_uid, 'at', now()),
      'intentEffective', p_action, 'reviewStatus', 'confirmed', 'excluded', false, 'reopened', false);

  elsif p_action = 'EXCLUDE' then
    v_corrected := to_jsonb('EXCLUDE'::text);
    v_patch := jsonb_build_object(
      'correction', jsonb_build_object('original', v_original, 'corrected', v_corrected,
        'reason', p_reason, 'note', p_note, 'user', v_email, 'userId', v_uid, 'at', now()),
      'intentEffective', null, 'reviewStatus', 'confirmed', 'excluded', true, 'reopened', false);

  elsif p_action = 'CONNECT' then
    if p_order_guid is null or p_order_guid !~* '^[0-9a-f-]{36}$' then
      raise exception 'order_guid_required';
    end if;
    -- conversion facts computed HERE from the shared Toast data, not trusted
    -- from the browser
    select exists (
      select 1 from ace_selections s
      where s.payload ->> 'orderGuid' = p_order_guid
        and coalesce((s.payload ->> 'voided')::boolean, false) = false
        and s.payload ->> 'itemName' ~* 'PER PERSON|\(kids\)'
    ) into v_has_ayce;
    select c.payload ->> 'serverGuid' into v_server
    from ace_checks c where c.payload ->> 'orderGuid' = p_order_guid limit 1;
    if v_server is null and not exists (
      select 1 from ace_checks c where c.payload ->> 'orderGuid' = p_order_guid) then
      raise exception 'unknown_order';
    end if;
    v_corrected := jsonb_build_object('matchedOrderGuid', p_order_guid, 'hasAyceSales', v_has_ayce);
    v_patch := jsonb_build_object(
      'correction', jsonb_build_object('original', v_original, 'corrected', v_corrected,
        'reason', p_reason, 'note', p_note, 'user', v_email, 'userId', v_uid, 'at', now()),
      'matchStatus', 'matched', 'matchedOrderGuid', p_order_guid, 'matchConfidence', 1,
      'matchMethod', 'manual', 'hasAyceSales', v_has_ayce, 'matchedServerGuid', v_server,
      'reviewStatus', 'confirmed', 'excluded', false, 'reopened', false);

  elsif p_action = 'KEEP_FINAL' then
    v_corrected := to_jsonb('KEEP_FINAL'::text);
    v_patch := jsonb_build_object(
      'correction', jsonb_build_object('original', v_original, 'corrected', v_corrected,
        'reason', p_reason, 'note', p_note, 'user', v_email, 'userId', v_uid, 'at', now()),
      'reviewStatus', 'confirmed', 'reopened', false);

  elsif p_action = 'SET_SERVER' then
    if p_server_guid is null or p_server_guid !~* '^[0-9a-f-]{36}$' then
      raise exception 'server_guid_required';
    end if;
    v_corrected := jsonb_build_object('attributedServerGuid', p_server_guid);
    v_patch := jsonb_build_object(
      'correction', jsonb_build_object('original', v_original, 'corrected', v_corrected,
        'reason', p_reason, 'note', p_note, 'user', v_email, 'userId', v_uid, 'at', now()),
      'matchedServerGuid', p_server_guid, 'reviewStatus', 'confirmed', 'reopened', false);

  elsif p_action = 'REVERT' or p_action = 'REOPEN' then
    v_corrected := to_jsonb(p_action);
    v_patch := jsonb_build_object(
      'correction', null,
      'intentEffective', v_original -> 'intentEffective',
      'matchStatus', v_original -> 'matchStatus',
      'matchedOrderGuid', v_original -> 'matchedOrderGuid',
      'matchConfidence', v_original -> 'matchConfidence',
      'hasAyceSales', v_original -> 'hasAyceSales',
      'matchedServerGuid', v_original -> 'matchedServerGuid',
      'excluded', coalesce(v_original -> 'excluded', 'false'::jsonb),
      'reviewStatus', 'pending_review',
      'reopened', to_jsonb(p_action = 'REOPEN'));
  end if;

  update ace_intents set payload = payload || v_patch where row_hash = p_row_hash;

  insert into ace_correction_audit (row_hash, action, original, corrected, reason, note, user_id, user_email)
  values (p_row_hash, p_action, v_original, v_corrected, p_reason, p_note, v_uid, v_email);

  return jsonb_build_object('saved', true, 'rowHash', p_row_hash, 'action', p_action);
end $$;

-- ================================================= RPC: retry-toast-update ==
-- Manager-only. Dispatches the existing protected GitHub Actions ingestion
-- workflow. The GitHub token lives in Supabase Vault (name 'ace_github_pat',
-- set by scripts/admin/set-github-token.mjs) and never leaves this function.
-- Default (no date): the workflow processes the missing prior business date.
create or replace function ace_retry_toast_update(p_business_date text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := ace_role();
  v_email text := coalesce(auth.jwt() ->> 'email', '');
  v_token text;
  v_req bigint;
begin
  if v_role not in ('executive','manager') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_business_date is not null and p_business_date !~ '^[0-9]{8}$' then
    raise exception 'invalid_business_date';
  end if;
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'ace_github_pat';
  if v_token is null then raise exception 'github_token_not_configured'; end if;

  select net.http_post(
    url := 'https://api.github.com/repos/dominicmemoli-create/ace-dashboard/actions/workflows/nightly-ingest.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Accept', 'application/vnd.github+json',
      'Content-Type', 'application/json',
      'User-Agent', 'ace-dashboard-supabase',
      'X-GitHub-Api-Version', '2022-11-28'),
    body := jsonb_build_object('ref', 'main',
      'inputs', case when p_business_date is null then '{}'::jsonb
                     else jsonb_build_object('businessDate', p_business_date) end)
  ) into v_req;

  insert into ace_import_runs (kind, counts, created_by, created_by_email)
  values ('toast_retry',
          jsonb_build_object('requestId', v_req, 'businessDate', p_business_date),
          auth.uid(), v_email);

  return jsonb_build_object('status', 'Update started', 'requestId', v_req);
end $$;

-- Delivery check for a retry request (pg_net responses are async).
create or replace function ace_retry_status(p_request_id bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := ace_role();
  v_rec record;
begin
  if v_role not in ('executive','manager','shift_lead') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select status_code, error_msg into v_rec from net._http_response where id = p_request_id;
  if not found then
    return jsonb_build_object('done', false);
  end if;
  return jsonb_build_object('done', true, 'statusCode', v_rec.status_code,
                            'accepted', coalesce(v_rec.status_code, 0) = 204,
                            'error', v_rec.error_msg);
end $$;

-- Who am I (role + email for the signed-in user; the UI shows this).
create or replace function ace_whoami()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('role', ace_role(), 'email', coalesce(auth.jwt() ->> 'email', ''));
$$;

-- ------------------------------------------------------------------ grants --
-- Definer functions: callable by signed-in users only (role re-checked inside).
do $$
declare f text;
begin
  foreach f in array array[
    'ace_upload_opentable(jsonb, text, text)',
    'ace_upload_costs(jsonb, text, text, text, text)',
    'ace_replace_metrics(jsonb, jsonb, jsonb)',
    'ace_save_review_fix(text, text, text, text, text, text)',
    'ace_retry_toast_update(text)',
    'ace_retry_status(bigint)']
  loop
    execute format('revoke all on function %s from public, anon;', f);
    execute format('grant execute on function %s to authenticated, service_role;', f);
  end loop;
  -- whoami is harmless for anon (returns role "none") but keep it authenticated-only
  revoke all on function ace_whoami() from public, anon;
  grant execute on function ace_whoami() to authenticated, service_role;
  revoke all on function ace_role() from public, anon;
  grant execute on function ace_role() to authenticated, service_role;
end $$;
