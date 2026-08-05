-- Re-uploading an OpenTable file can now REPAIR rows that were stored before
-- the Toast data for their date existed (frozen 'unmatched' forever under the
-- old insert-only behavior). An existing row is updated ONLY when:
--   - it has never been corrected by a person (no correction, not confirmed,
--     not excluded), AND
--   - it is currently unmatched, AND
--   - the incoming row brings a real connection (matched or a candidate).
-- Everything else keeps the strict insert-only idempotency: identical
-- re-uploads still change nothing, and human decisions are never overwritten.
--
-- Apply with: node scripts/admin/apply-sql.mjs supabase/migrations/0005_upload_rematch.sql
-- Idempotent: safe to re-run.

create or replace function ace_upload_opentable(p_rows jsonb, p_file_name text default null, p_file_hash text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_email text := coalesce(auth.jwt() ->> 'email', '');
  v_total int;
  v_inserted int := 0;
  v_updated int := 0;
  v_dupfile boolean := false;
  v_dates jsonb;
  r jsonb;
  k text;
begin
  if not ace_is_operator() then
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

  -- repair pass: rows still unmatched, untouched by any person, where the
  -- fresh upload (parsed against now-available Toast data) found a connection
  update ace_intents i
  set payload = x
  from jsonb_array_elements(p_rows) x
  where i.row_hash = x ->> 'rowHash'
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
          auth.uid(), v_email);

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated,
                            'duplicates', v_total - v_inserted - v_updated,
                            'total', v_total, 'dates', v_dates, 'duplicateFile', v_dupfile);
end $$;

do $$ begin
  execute 'revoke all on function ace_upload_opentable(jsonb, text, text) from public, anon';
  execute 'grant execute on function ace_upload_opentable(jsonb, text, text) to authenticated, service_role';
end $$;
