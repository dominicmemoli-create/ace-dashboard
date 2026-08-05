-- Production authorization posture.
--
-- Replaces the withdrawn 0006_public_access_rpc.sql, which granted anon EXECUTE
-- on the write RPCs. Under that migration any visitor holding the publishable
-- key could replace metrics, upload costs, rewrite review decisions and dispatch
-- Toast ingestion runs, with an audit trail keyed on a browser-supplied string.
-- None of that survives here.
--
-- The posture this file establishes:
--   * ACE2026 is a presentation gate in the browser and authorizes nothing.
--   * anon may SELECT exactly the PII-free data the public dashboard renders.
--   * every write requires a signed-in user whose user_profiles.role is an
--     approved operator role — enforced in the database, not in the UI.
--   * audit attribution comes from auth.uid() / auth.jwt(), never from input.
--   * Jul 31 - Aug 2 2026 pilot history is frozen against all writes.
--
-- Apply with: node scripts/admin/bootstrap.mjs
-- Idempotent: safe to re-run.

-- ===========================================================================
-- 1. Withdraw every artifact the open-access migration introduced.
-- ===========================================================================
-- These signatures carry the trailing browser-supplied actor argument. Dropping them
-- by exact signature matters: leaving them in place would leave anon-executable
-- overloads resolvable alongside the hardened functions below.
drop function if exists ace_upload_opentable(jsonb, text, text, text);
drop function if exists ace_upload_costs(jsonb, text, text, text, text, text);
drop function if exists ace_replace_metrics(jsonb, jsonb, jsonb, text);
drop function if exists ace_save_review_fix(text, text, text, text, text, text, text);
drop function if exists ace_retry_toast_update(text, text);
drop function if exists ace_retry_status(bigint, text);
drop function if exists ace_public_can_write();
drop function if exists ace_public_actor(text);

-- The client-supplied actor session is not an identity. Remove it entirely
-- rather than leaving a spoofable column that looks like attribution.
alter table if exists ace_correction_audit drop column if exists actor_session_id;
alter table if exists ace_import_runs      drop column if exists actor_session_id;

-- Restore audit integrity. On a clean project there is nothing to clean up; on a
-- project where the open-access migration ran, unattributable rows must be dealt
-- with deliberately by an administrator rather than silently deleted here.
do $$
declare v_orphans int;
begin
  if exists (select 1 from information_schema.columns
             where table_name = 'ace_correction_audit' and column_name = 'user_id') then
    select count(*) into v_orphans from ace_correction_audit where user_id is null;
    if v_orphans = 0 then
      alter table ace_correction_audit alter column user_id set not null;
    else
      raise notice 'ace_correction_audit has % unattributable row(s) from the open-access build. Review them, then re-run this migration to restore the NOT NULL constraint. See docs/SECURITY.md.', v_orphans;
    end if;
  end if;
end $$;

-- ===========================================================================
-- 2. Read posture — least privilege for anon.
-- ===========================================================================
-- Dashboard-visible, PII-free, already published on the static site.
do $$
declare t text;
begin
  foreach t in array array[
    'ace_manifest','ace_reference','ace_metrics','ace_item_metrics',
    'ace_intents','ace_ingestion_runs']
  loop
    execute format('drop policy if exists poc_read on %I;', t);
    execute format('drop policy if exists public_read on %I;', t);
    execute format('create policy public_read on %I for select using (true);', t);
  end loop;
end $$;

-- Operator-only. ace_checks / ace_selections are check-level restaurant sales
-- with server identifiers, read only by the manager match and recalculation
-- flows; the public dashboard renders the aggregated ace_metrics instead.
-- ace_import_runs carries operator emails and uploaded file names.
do $$
declare t text;
begin
  foreach t in array array['ace_checks','ace_selections','ace_item_costs','ace_import_runs']
  loop
    execute format('drop policy if exists poc_read on %I;', t);
    execute format('drop policy if exists public_read on %I;', t);
    execute format('drop policy if exists operator_read on %I;', t);
    execute format('create policy operator_read on %I for select using (ace_is_operator());', t);
  end loop;
end $$;

-- Sanitized projections so signed-out visitors keep a working dashboard without
-- seeing operator identity. Views run with definer rights, so they read past the
-- operator_read policies above by design; each one strips the sensitive fields.
create or replace view ace_item_costs_public as
  select id,
         canonical_name,
         effective_from,
         payload - 'updatedBy' - 'actorSessionId' as payload,
         updated_at
  from ace_item_costs;

create or replace view ace_import_runs_public as
  select kind,
         status,
         error,
         counts - 'actor' - 'actorSessionId' as counts,
         created_at
  from ace_import_runs;

-- ===========================================================================
-- 3. Authorization helpers.
-- ===========================================================================
create or replace function ace_is_operator() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role from user_profiles where id = auth.uid()), 'none')
         in ('executive','manager','shift_lead');
$$;

-- Identity for audit rows. Always derived from the verified JWT.
create or replace function ace_require_operator() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = '42501';
  end if;
  if not ace_is_operator() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return jsonb_build_object('userId', v_uid, 'email', coalesce(auth.jwt() ->> 'email', ''));
end $$;

create or replace function ace_whoami()
returns jsonb
language sql stable security definer set search_path = public as $$
  select case
    when auth.uid() is null then jsonb_build_object('role', 'public', 'email', '')
    when ace_is_operator()  then jsonb_build_object('role', ace_role(), 'email', coalesce(auth.jwt() ->> 'email', ''))
    else jsonb_build_object('role', 'unauthorized', 'email', coalesce(auth.jwt() ->> 'email', ''))
  end;
$$;

-- Single source of truth for the frozen pilot window.
create or replace function ace_pilot_window() returns text[]
language sql immutable as $$ select array['20260731','20260802']; $$;

-- ===========================================================================
-- 4. Write RPCs — signed-in approved operators only.
-- ===========================================================================

-- ------------------------------------------------------ ace_upload_opentable --
create or replace function ace_upload_opentable(
  p_rows jsonb,
  p_file_name text default null,
  p_file_hash text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor jsonb;
  v_email text;
  v_uid uuid;
  v_total int;
  v_inserted int := 0;
  v_updated int := 0;
  v_dupfile boolean := false;
  v_dates jsonb;
  v_pilot text[] := ace_pilot_window();
  r jsonb;
  k text;
begin
  v_actor := ace_require_operator();
  v_email := v_actor ->> 'email';
  v_uid := (v_actor ->> 'userId')::uuid;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid_payload';
  end if;
  v_total := jsonb_array_length(p_rows);
  if v_total = 0 then raise exception 'empty_upload'; end if;
  if v_total > 5000 then raise exception 'too_many_rows'; end if;

  for r in select * from jsonb_array_elements(p_rows) loop
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

  -- Frozen pilot rows are never inserted or updated, whoever is signed in.
  insert into ace_intents (row_hash, business_date, payload)
  select x ->> 'rowHash', x ->> 'businessDate', x
  from jsonb_array_elements(p_rows) x
  where (x ->> 'businessDate') not between v_pilot[1] and v_pilot[2]
  on conflict (row_hash) do nothing;
  get diagnostics v_inserted = row_count;

  update ace_intents i
  set payload = x
  from jsonb_array_elements(p_rows) x
  where i.row_hash = x ->> 'rowHash'
    and i.business_date not between v_pilot[1] and v_pilot[2]
    and i.payload -> 'correction' is null
    and coalesce(i.payload ->> 'reviewStatus', 'auto') <> 'confirmed'
    and coalesce((i.payload ->> 'excluded')::boolean, false) = false
    and coalesce(i.payload ->> 'matchStatus', 'unmatched') = 'unmatched'
    and coalesce(x ->> 'matchStatus', 'unmatched') <> 'unmatched'
    and x ->> 'matchedOrderGuid' is not null;
  get diagnostics v_updated = row_count;

  select coalesce(jsonb_agg(distinct d order by d), '[]'::jsonb) into v_dates
  from (select x ->> 'businessDate' d from jsonb_array_elements(p_rows) x) s;

  insert into ace_import_runs (kind, file_name, file_hash, counts, created_by, created_by_email)
  values ('opentable', p_file_name, p_file_hash,
          jsonb_build_object('total', v_total, 'inserted', v_inserted, 'updated', v_updated,
                             'duplicates', v_total - v_inserted - v_updated, 'dates', v_dates,
                             'duplicateFile', v_dupfile),
          v_uid, v_email);

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated,
                            'duplicates', v_total - v_inserted - v_updated,
                            'total', v_total, 'dates', v_dates, 'duplicateFile', v_dupfile);
end $$;

-- ---------------------------------------------------------- ace_upload_costs --
create or replace function ace_upload_costs(
  p_records jsonb,
  p_effective_from text,
  p_source text default 'chef_confirmed',
  p_file_name text default null,
  p_file_hash text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor jsonb;
  v_email text;
  v_uid uuid;
  v_day_before text;
  v_now timestamptz := now();
  v_pilot text[] := ace_pilot_window();
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
  v_actor := ace_require_operator();
  v_email := v_actor ->> 'email';
  v_uid := (v_actor ->> 'userId')::uuid;

  if p_records is null or jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) = 0 then
    raise exception 'invalid_payload';
  end if;
  if jsonb_array_length(p_records) > 2000 then raise exception 'too_many_rows'; end if;
  if p_effective_from !~ '^[0-9]{8}$' then raise exception 'invalid_effective_date'; end if;
  if p_source not in ('chef_confirmed','manual','rough_workbook') then raise exception 'invalid_source'; end if;
  -- A cost effective inside or before the pilot window would retroactively
  -- recalculate frozen pilot results.
  if p_effective_from <= v_pilot[2] then
    raise exception 'pilot_history_frozen' using errcode = '42501';
  end if;
  v_day_before := to_char(to_date(p_effective_from, 'YYYYMMDD') - 1, 'YYYYMMDD');
  v_verification := case when p_source = 'chef_confirmed' then 'verified' else 'unverified' end;

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
    begin
      v_cost := (rec ->> 'cost')::numeric;
    exception when others then
      v_cost := null;
    end;
    if v_name = '' or v_cost is null or v_cost <= 0 or v_cost >= 500 then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('name', v_name, 'why', 'invalid name or cost'));
      continue;
    end if;
    v_recognized := v_recognized + 1;
    v_norm := ace_norm_name(v_name);
    v_aliases := coalesce(rec -> 'aliases', '[]'::jsonb);

    select guid into v_guid from ace_tmp_guids where nname = v_norm;
    if v_guid is null then
      select g.guid into v_guid
      from jsonb_array_elements_text(v_aliases) a
      join ace_tmp_guids g on g.nname = ace_norm_name(a)
      limit 1;
    end if;

    select id, payload into v_open from ace_item_costs
    where canonical_name = v_name and payload ->> 'effectiveTo' is null
    order by effective_from desc limit 1;

    if v_open.id is not null and (v_open.payload ->> 'effectiveFrom') > p_effective_from then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('name', v_name,
        'why', 'a newer cost is already effective ' || (v_open.payload ->> 'effectiveFrom')));
      continue;
    end if;

    if v_open.id is null then
      v_changed := v_changed + 1;
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
          v_uid, v_email);

  return jsonb_build_object('recognized', v_recognized, 'changed', v_changed,
                            'unchanged', v_unchanged, 'added', v_added, 'closed', v_closed,
                            'skipped', v_skipped, 'changedItems', v_changed_items);
end $$;

-- ------------------------------------------------------- ace_replace_metrics --
create or replace function ace_replace_metrics(p_dates jsonb, p_rows jsonb, p_item_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor jsonb;
  v_email text;
  v_uid uuid;
  v_pilot text[] := ace_pilot_window();
  d text;
  v_rows int := 0; v_items int := 0;
begin
  v_actor := ace_require_operator();
  v_email := v_actor ->> 'email';
  v_uid := (v_actor ->> 'userId')::uuid;

  if p_dates is null or jsonb_typeof(p_dates) <> 'array' or jsonb_array_length(p_dates) = 0
     or jsonb_array_length(p_dates) > 120 then
    raise exception 'invalid_dates';
  end if;
  for d in select jsonb_array_elements_text(p_dates) loop
    if d !~ '^[0-9]{8}$' then raise exception 'invalid_dates'; end if;
    if d between v_pilot[1] and v_pilot[2] then
      raise exception 'pilot_history_frozen' using errcode = '42501';
    end if;
  end loop;
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
          v_uid, v_email);

  return jsonb_build_object('dates', p_dates, 'rows', v_rows, 'itemRows', v_items);
end $$;

-- ------------------------------------------------------- ace_save_review_fix --
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
  v_pilot text[] := ace_pilot_window();
  v_actor jsonb;
  v_email text;
  v_uid uuid;
  v_row record;
  v_payload jsonb;
  v_original jsonb;
  v_patch jsonb;
  v_has_ayce boolean;
  v_server text;
  v_corrected jsonb;
begin
  v_actor := ace_require_operator();
  v_email := v_actor ->> 'email';
  v_uid := (v_actor ->> 'userId')::uuid;

  if p_action not in ('UNDECIDED','ALC','PREDECIDED_AYCE','EXCLUDE','CONNECT','KEEP_FINAL','SET_SERVER','REVERT','REOPEN') then
    raise exception 'invalid_action';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required'; end if;

  select row_hash, business_date, payload into v_row from ace_intents where row_hash = p_row_hash;
  if v_row.row_hash is null then raise exception 'unknown_row'; end if;
  if v_row.business_date between v_pilot[1] and v_pilot[2] then
    raise exception 'pilot_history_frozen' using errcode = '42501';
  end if;
  v_payload := v_row.payload;

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

-- ---------------------------------------------------- ace_retry_toast_update --
-- Cooldown is global, not per business date: keying it on the caller-supplied
-- date let a caller cycle dates to dispatch unlimited workflow runs.
create or replace function ace_retry_toast_update(p_business_date text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor jsonb;
  v_email text;
  v_uid uuid;
  v_token text;
  v_req bigint;
  v_today int;
begin
  v_actor := ace_require_operator();
  v_email := v_actor ->> 'email';
  v_uid := (v_actor ->> 'userId')::uuid;

  if p_business_date is not null and p_business_date !~ '^[0-9]{8}$' then
    raise exception 'invalid_business_date';
  end if;
  if not pg_try_advisory_xact_lock(hashtext('ace_retry_toast_update')) then
    raise exception 'retry_in_progress' using errcode = '55P03';
  end if;

  -- 10 minutes between dispatches of any kind, for anyone.
  if exists (
    select 1 from ace_import_runs
    where kind = 'toast_retry' and created_at > now() - interval '10 minutes'
  ) then
    raise exception 'retry_cooldown' using errcode = '42901';
  end if;

  -- Backstop against a compromised operator session burning Actions minutes.
  select count(*) into v_today from ace_import_runs
  where kind = 'toast_retry' and created_at > now() - interval '24 hours';
  if v_today >= 20 then
    raise exception 'retry_daily_limit' using errcode = '42901';
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
          jsonb_build_object('requestId', v_req, 'businessDate', p_business_date,
                             'cooldownMinutes', 10),
          v_uid, v_email);

  return jsonb_build_object('status', 'Update started', 'requestId', v_req);
end $$;

-- ---------------------------------------------------------- ace_retry_status --
-- Scoped: only request ids this application recorded are readable, so the
-- function cannot be used to enumerate unrelated pg_net responses.
create or replace function ace_retry_status(p_request_id bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_rec record;
begin
  perform ace_require_operator();

  if not exists (
    select 1 from ace_import_runs
    where kind = 'toast_retry' and (counts ->> 'requestId')::bigint = p_request_id
  ) then
    raise exception 'unknown_request';
  end if;

  select status_code, error_msg into v_rec from net._http_response where id = p_request_id;
  if not found then
    return jsonb_build_object('done', false);
  end if;
  return jsonb_build_object('done', true, 'statusCode', v_rec.status_code,
                            'accepted', coalesce(v_rec.status_code, 0) = 204,
                            'error', v_rec.error_msg);
end $$;

-- ===========================================================================
-- 5. Grants — anon executes nothing that writes.
-- ===========================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'ace_upload_opentable(jsonb, text, text)',
    'ace_upload_costs(jsonb, text, text, text, text)',
    'ace_replace_metrics(jsonb, jsonb, jsonb)',
    'ace_save_review_fix(text, text, text, text, text, text)',
    'ace_retry_toast_update(text)',
    'ace_retry_status(bigint)',
    'ace_is_operator()',
    'ace_require_operator()',
    'ace_role()']
  loop
    execute format('revoke all on function %s from public, anon;', f);
    execute format('grant execute on function %s to authenticated, service_role;', f);
  end loop;

  -- Identity is safe to expose: it only ever reports the caller's own state,
  -- and the signed-out UI needs it to render the correct sign-in affordance.
  revoke all on function ace_whoami() from public;
  grant execute on function ace_whoami() to anon, authenticated, service_role;
  revoke all on function ace_pilot_window() from public;
  grant execute on function ace_pilot_window() to anon, authenticated, service_role;
end $$;

-- Table-level grants. RLS still applies on top of these for the base tables.
revoke all on ace_checks, ace_selections, ace_item_costs, ace_import_runs from anon;
grant select on ace_checks, ace_selections, ace_item_costs, ace_import_runs to authenticated;
grant select on ace_manifest, ace_reference, ace_metrics, ace_item_metrics,
                ace_intents, ace_ingestion_runs to anon, authenticated;
grant select on ace_item_costs_public, ace_import_runs_public to anon, authenticated;

-- No client role may write to any table directly; every mutation goes through
-- the security-definer functions above or the service role used by ingestion.
revoke insert, update, delete on
  ace_manifest, ace_reference, ace_checks, ace_selections, ace_ingestion_runs,
  ace_item_costs, ace_metrics, ace_item_metrics, ace_intents,
  ace_import_runs, ace_correction_audit
from anon, authenticated;
