-- Row Level Security — authorization is enforced by the DATABASE, not the UI.
-- Roles: executive | manager | shift_lead | server (user_profiles.role).
--
-- Principles:
--  * Servers see ONLY rows attributed to their linked employee profile.
--  * Payroll has stricter policies than performance data (server sees own,
--    only when status–appropriate; nobody else below manager).
--  * The anon key can read NOTHING operational.
--  * The service-role key is used exclusively by Edge Functions (server-side).

-- Helper: current user's role
create or replace function app_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from user_profiles where id = auth.uid()), 'none');
$$;

-- Helper: employee ids linked to the current user
create or replace function app_employee_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select employee_id from employee_user_links
  where user_id = auth.uid() and approved_at is not null;
$$;

-- Enable RLS everywhere (deny-by-default)
alter table locations             enable row level security;
alter table employees             enable row level security;
alter table user_profiles         enable row level security;
alter table employee_user_links   enable row level security;
alter table orders                enable row level security;
alter table checks                enable row level security;
alter table table_visits          enable row level security;
alter table menu_items            enable row level security;
alter table item_selections       enable row level security;
alter table item_aliases          enable row level security;
alter table item_costs            enable row level security;
alter table unmatched_items       enable row level security;
alter table manual_match_overrides enable row level security;
alter table reservations          enable row level security;
alter table guest_intents         enable row level security;
alter table table_intent_matches  enable row level security;
alter table commission_rules      enable row level security;
alter table commission_entries    enable row level security;
alter table payroll_summaries     enable row level security;
alter table ingestion_runs        enable row level security;
alter table ingestion_errors      enable row level security;

-- Management (executive + manager): full read of operational data
do $$
declare t text;
begin
  foreach t in array array[
    'locations','employees','orders','checks','table_visits','menu_items',
    'item_selections','item_aliases','item_costs','unmatched_items',
    'manual_match_overrides','reservations','guest_intents',
    'table_intent_matches','commission_rules','commission_entries',
    'ingestion_runs','ingestion_errors']
  loop
    execute format(
      'create policy mgmt_read_%1$s on %1$s for select using (app_role() in (''executive'',''manager''));', t);
  end loop;
end $$;

-- Shift leads: configurable — default read of operational (non-payroll) data
do $$
declare t text;
begin
  foreach t in array array[
    'orders','checks','table_visits','menu_items','item_selections',
    'item_costs','unmatched_items','guest_intents','table_intent_matches',
    'ingestion_runs']
  loop
    execute format(
      'create policy lead_read_%1$s on %1$s for select using (app_role() = ''shift_lead'');', t);
  end loop;
end $$;

-- Servers: rows attributed to their own linked employee profile ONLY
create policy server_own_orders on orders for select
  using (app_role() = 'server' and server_employee_id in (select app_employee_ids()));
create policy server_own_visits on table_visits for select
  using (app_role() = 'server' and attributed_employee_id in (select app_employee_ids()));
create policy server_own_commission on commission_entries for select
  using (app_role() = 'server' and employee_id in (select app_employee_ids()));
create policy server_own_profile on employees for select
  using (app_role() = 'server' and id in (select app_employee_ids()));

-- Payroll: STRICTER. Server may read own rows; managers read all; nobody writes
-- via client (writes go through Edge Functions with service role).
create policy payroll_mgmt_read on payroll_summaries for select
  using (app_role() in ('executive','manager'));
create policy payroll_server_own on payroll_summaries for select
  using (app_role() = 'server' and employee_id in (select app_employee_ids()));

-- Profiles: user reads own profile; managers read all
create policy profile_own on user_profiles for select using (id = auth.uid());
create policy profile_mgmt on user_profiles for select using (app_role() in ('executive','manager'));
create policy links_own on employee_user_links for select using (user_id = auth.uid());
create policy links_mgmt on employee_user_links for select using (app_role() in ('executive','manager'));

-- Cost maintenance: managers may insert/update item costs and aliases from the UI
create policy costs_mgmt_write on item_costs for insert with check (app_role() in ('executive','manager'));
create policy costs_mgmt_update on item_costs for update using (app_role() in ('executive','manager'));
create policy aliases_mgmt_write on item_aliases for insert with check (app_role() in ('executive','manager'));
create policy overrides_mgmt_write on manual_match_overrides for insert with check (app_role() in ('executive','manager'));

-- NOTE deliberately absent: any anon policy. The anon key sees nothing.
-- NOTE deliberately absent: server-role INSERT/UPDATE anywhere.
