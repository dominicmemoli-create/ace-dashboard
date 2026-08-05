-- One authenticated operator role — removes the manager / shift-lead
-- hierarchy. Every approved operator has equal capabilities. Writes still
-- require a real signed-in, approved user; anonymous users can execute
-- nothing. The legacy role values ('executive' | 'manager' | 'shift_lead')
-- remain valid in user_profiles / ace_approved_emails and are all treated as
-- the same operator capability, so no data changes and nothing is deleted.
--
-- Apply with: node scripts/admin/apply-sql.mjs supabase/migrations/0004_operator_role.sql
-- Idempotent: safe to re-run.

-- Convenience predicate used by the redefined functions.
create or replace function ace_is_operator() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role from user_profiles where id = auth.uid()), 'none')
         in ('executive','manager','shift_lead');
$$;

-- =============================== ace_upload_costs — now any operator ========
create or replace function ace_upload_costs(
  p_records jsonb,
  p_effective_from text,
  p_source text default 'chef_confirmed',
  p_file_name text default null,
  p_file_hash text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
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
  if not ace_is_operator() then
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

-- ============================== ace_replace_metrics — now any operator ======
create or replace function ace_replace_metrics(p_dates jsonb, p_rows jsonb, p_item_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_email text := coalesce(auth.jwt() ->> 'email', '');
  d text;
  v_rows int := 0; v_items int := 0;
begin
  if not ace_is_operator() then
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

-- =========================== ace_save_review_fix — no shift-lead limits =====
-- Any approved operator may decide any item, including pilot-window dates and
-- legacy mixed-menu records. Audit and reversal behavior unchanged.
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
  v_email text := coalesce(auth.jwt() ->> 'email', '');
  v_uid uuid := auth.uid();
  v_row record;
  v_payload jsonb;
  v_original jsonb;
  v_patch jsonb;
  v_has_ayce boolean;
  v_server text;
  v_corrected jsonb;
begin
  if not ace_is_operator() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_action not in ('UNDECIDED','ALC','PREDECIDED_AYCE','EXCLUDE','CONNECT','KEEP_FINAL','SET_SERVER','REVERT','REOPEN') then
    raise exception 'invalid_action';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required'; end if;

  select row_hash, business_date, payload into v_row from ace_intents where row_hash = p_row_hash;
  if v_row.row_hash is null then raise exception 'unknown_row'; end if;
  v_payload := v_row.payload;

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

-- =========================== ace_retry_toast_update — now any operator ======
create or replace function ace_retry_toast_update(p_business_date text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_email text := coalesce(auth.jwt() ->> 'email', '');
  v_token text;
  v_req bigint;
begin
  if not ace_is_operator() then
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

-- ------------------------------------------------------------------ grants --
-- Same posture as 0003: signed-in users only; anon can execute nothing.
do $$
declare f text;
begin
  foreach f in array array[
    'ace_upload_costs(jsonb, text, text, text, text)',
    'ace_replace_metrics(jsonb, jsonb, jsonb)',
    'ace_save_review_fix(text, text, text, text, text, text)',
    'ace_retry_toast_update(text)',
    'ace_is_operator()']
  loop
    execute format('revoke all on function %s from public, anon;', f);
    execute format('grant execute on function %s to authenticated, service_role;', f);
  end loop;
end $$;
