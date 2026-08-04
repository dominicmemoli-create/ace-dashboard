-- ACE Dashboard operational schema (Supabase Postgres)
-- Apply with: supabase db push  (or psql -f)
-- Idempotency is enforced by stable Toast/OpenTable source GUIDs + unique constraints.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- locations
create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  toast_restaurant_guid uuid not null unique,
  name text not null,
  timezone text not null default 'America/New_York',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- employees
create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id),
  toast_employee_guid uuid unique,
  display_name text not null,
  employment_status text not null default 'active' check (employment_status in ('active','inactive','terminated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auth mapping: NEVER key authorization on names.
create table if not exists user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'server' check (role in ('executive','manager','shift_lead','server')),
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists employee_user_links (
  employee_id uuid not null references employees(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  primary key (employee_id, user_id)
);

-- ------------------------------------------------------------------- orders
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id),
  toast_order_guid uuid not null unique,
  business_date date not null,
  revenue_center text,
  service_area text,
  dining_option text,
  table_guid uuid,
  table_name text,
  server_employee_id uuid references employees(id),
  number_of_guests int,
  opened_at timestamptz,
  closed_at timestamptz,
  voided boolean not null default false,
  raw_ref text,                     -- pointer to immutable raw snapshot
  created_at timestamptz not null default now()
);
create index if not exists orders_business_date_idx on orders (location_id, business_date);

create table if not exists checks (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  toast_check_guid uuid not null unique,
  amount numeric(12,2) not null default 0,          -- net of tax
  tax_amount numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null default 0,
  check_level_discount numeric(12,2) not null default 0,
  tips numeric(12,2) not null default 0,
  service_charges numeric(12,2) not null default 0,
  voided boolean not null default false,
  owner_employee_id uuid references employees(id), -- final check owner
  transferred boolean not null default false,      -- flagged mixed/transferred ownership
  created_at timestamptz not null default now()
);

-- Table visit = the dine-in unit; split checks share one visit.
create table if not exists table_visits (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id),
  business_date date not null,
  table_name text,
  order_id uuid references orders(id),
  seated_at timestamptz,
  closed_at timestamptz,
  party_size int,
  attributed_employee_id uuid references employees(id),
  mixed_owner boolean not null default false,
  created_at timestamptz not null default now(),
  unique (order_id)
);

create table if not exists menu_items (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id),
  toast_item_guid uuid unique,
  name text not null,
  sales_category text,
  created_at timestamptz not null default now()
);

create table if not exists item_selections (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references checks(id) on delete cascade,
  toast_selection_guid uuid not null unique,
  parent_selection_guid uuid,
  menu_item_id uuid references menu_items(id),
  item_name text,
  quantity numeric(12,3) not null default 0,
  gross numeric(12,2) not null default 0,
  discount numeric(12,2) not null default 0,
  net numeric(12,2) not null default 0,
  voided boolean not null default false,
  sales_category text,
  owner_employee_id uuid references employees(id), -- selection-level attribution when reliable
  created_at timestamptz not null default now()
);
create index if not exists item_selections_check_idx on item_selections (check_id);

-- ---------------------------------------------------------------- item costs
create table if not exists item_aliases (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  alias text not null,
  unique (canonical_name, alias)
);

create table if not exists item_costs (
  id uuid primary key default gen_random_uuid(),
  toast_item_guid uuid,
  toast_selection_guid uuid,
  canonical_name text not null,
  portion text,
  cost_per_unit numeric(12,4) not null check (cost_per_unit >= 0),
  effective_from date not null,
  effective_to date,
  source text not null check (source in ('rough_workbook','chef_confirmed','vendor_derived','manual')),
  verification text not null default 'unverified' check (verification in ('unverified','verified')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  check (effective_to is null or effective_to >= effective_from)
);
create index if not exists item_costs_guid_idx on item_costs (toast_item_guid, effective_from);
create index if not exists item_costs_name_idx on item_costs (canonical_name, effective_from);

create table if not exists unmatched_items (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id),
  item_name text not null,
  first_seen date not null,
  last_seen date not null,
  total_quantity numeric(14,3) not null default 0,
  total_net numeric(14,2) not null default 0,
  resolved boolean not null default false,
  unique (location_id, item_name)
);

create table if not exists manual_match_overrides (
  id uuid primary key default gen_random_uuid(),
  item_name text not null,
  item_cost_id uuid not null references item_costs(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (item_name)
);

-- ------------------------------------------------------- OpenTable / intent
create table if not exists reservations (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id),
  opentable_reservation_id text unique,
  business_date date not null,
  reserved_at timestamptz,
  party_size int,
  created_at timestamptz not null default now()
);

create table if not exists guest_intents (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id),
  business_date date not null,
  reservation_id uuid references reservations(id),
  table_name text,
  intent text not null default 'UNKNOWN' check (intent in ('UNDECIDED','ALC','PREDECIDED_AYCE','UNKNOWN')),
  recorded_by text,
  created_at timestamptz not null default now()
);

create table if not exists table_intent_matches (
  id uuid primary key default gen_random_uuid(),
  table_visit_id uuid not null references table_visits(id),
  guest_intent_id uuid not null references guest_intents(id),
  match_method text not null check (match_method in ('reservation_id','table_time','table_only','manual')),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  matched_at timestamptz not null default now(),
  review_status text not null default 'auto' check (review_status in ('auto','pending_review','confirmed','rejected')),
  unique (table_visit_id, guest_intent_id)
);
-- BINDING RULE: matches with review_status='pending_review' must never feed commission.

-- --------------------------------------------------------------- commission
create table if not exists commission_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default false,   -- pilot-weekend program currently INACTIVE
  effective_from date not null,
  effective_to date,
  rate_classic numeric(8,2) not null,
  rate_premium numeric(8,2) not null,
  rate_royalty numeric(8,2) not null,
  notes text
);

create table if not exists commission_entries (
  id uuid primary key default gen_random_uuid(),
  table_visit_id uuid not null references table_visits(id),
  employee_id uuid not null references employees(id),
  rule_id uuid not null references commission_rules(id),
  amount numeric(10,2) not null,
  basis text not null,             -- e.g. '4 adult AYCE × $7.50 premium'
  created_at timestamptz not null default now(),
  unique (table_visit_id, employee_id, rule_id)
);

-- ------------------------------------------------------------------ payroll
-- Feature-flagged OFF until a verified source and field definitions exist.
create table if not exists payroll_summaries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  period_start date not null,
  period_end date not null,
  source text not null,
  status text not null default 'estimated' check (status in ('estimated','operational','reviewed','payroll_final')),
  hours numeric(8,2),
  base_wage numeric(8,2),
  reported_tips numeric(10,2),
  commission numeric(10,2),
  gross_estimate numeric(12,2),
  imported_at timestamptz not null default now(),
  unique (employee_id, period_start, period_end, source)
);

-- ---------------------------------------------------------------- ingestion
create table if not exists ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null,            -- toast_api | toast_csv | opentable_csv | cost_csv | ...
  adapter text not null,
  business_date date,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','success','failed','partial')),
  orders int, checks int, selections int,
  duplicates_prevented int not null default 0,
  warnings jsonb not null default '[]',
  error text
);

create table if not exists ingestion_errors (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references ingestion_runs(id) on delete cascade,
  line int,
  payload text,
  reason text not null
);
