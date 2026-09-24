-- ===========================================================================
-- RamosMAX Web — Phase C — 0006: customers, vehicles, services, jobs
-- ===========================================================================
-- Ports the Phase 3 and Phase 4 data model (docs/CUSTOMERS_AND_VEHICLES.md,
-- SERVICES.md, OPERATIONS.md).
--
-- Posture is unchanged: SELECT only for `authenticated`, every mutation through
-- a SECURITY DEFINER function. Invariants the reference implementation had to
-- enforce in code — unique plates, unique customer phones, unique service
-- names, one open job per vehicle — become database constraints here, so they
-- hold even against a bug in the functions above them.
--
-- Nothing is ever deleted. Records become inactive or cancelled.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Reference-number sequences (replacing counters/{name})
-- ---------------------------------------------------------------------------

create sequence if not exists app.customer_number_seq;
create sequence if not exists app.job_number_seq;

create or replace function app.next_reference(p_sequence text, p_prefix text, p_width integer default 6)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_next bigint;
begin
  execute format('select nextval(%L)', 'app.' || p_sequence) into v_next;
  return p_prefix || lpad(v_next::text, p_width, '0');
end;
$$;

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------
-- The PRIMARY phone is unique across customers. It is optional: a walk-in may
-- have no phone at all, and several such customers must be allowed, so the
-- uniqueness is a partial index rather than a plain UNIQUE.

create table if not exists public.customers (
  id                 uuid primary key default gen_random_uuid(),
  customer_number    text not null unique,

  full_name          text not null,
  phone_number       text,
  alternative_phone  text,
  email              text,
  address            text,
  notes              text,

  status             text not null default 'active',
  vehicle_count      integer not null default 0,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references public.users (id),
  updated_by         uuid references public.users (id),
  status_reason      text,
  status_changed_at  timestamptz,
  status_changed_by  uuid references public.users (id),

  constraint customers_status       check (status in ('active', 'inactive')),
  constraint customers_name_length  check (char_length(full_name) between 2 and 80),
  constraint customers_phone_e164   check (phone_number is null or phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  constraint customers_alt_e164     check (alternative_phone is null or alternative_phone ~ '^\+[1-9][0-9]{7,14}$'),
  constraint customers_vehicle_count check (vehicle_count >= 0)
);

-- "A customer with this phone number already exists."
create unique index if not exists customers_phone_unique
  on public.customers (phone_number) where phone_number is not null;

create index if not exists customers_name_search_idx
  on public.customers using gin (to_tsvector('simple', full_name));
create index if not exists customers_status_created_idx
  on public.customers (status, created_at desc);

-- ---------------------------------------------------------------------------
-- vehicles
-- ---------------------------------------------------------------------------
-- The number plate is the primary OPERATIONAL identifier, but NOT the primary
-- key: a corrected plate must not orphan the vehicle's history, so the id is a
-- surrogate and the plate is a unique attribute.
--
-- WORKER PRIVACY: this table carries the owner's NAME and CUSTOMER NUMBER for
-- display on a job card, and deliberately NO phone number. Workers hold
-- vehicles.view but not customers.view, so plate look-up can never expose a
-- customer's phone number. That is a structural guarantee, not a policy one.

create table if not exists public.vehicles (
  id                 uuid primary key default gen_random_uuid(),

  number_plate       text not null,
  normalized_plate   text not null,
  previous_plates    text[] not null default '{}',

  model              text not null,
  colour             text not null,
  make               text,
  year               integer,
  vehicle_type       text,
  notes              text,

  customer_id        uuid references public.customers (id),
  customer_name      text,
  customer_number    text,

  status             text not null default 'active',
  last_intake_at     timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references public.users (id),
  updated_by         uuid references public.users (id),
  status_reason      text,
  status_changed_at  timestamptz,
  status_changed_by  uuid references public.users (id),

  constraint vehicles_status  check (status in ('active', 'inactive')),
  constraint vehicles_year    check (year is null or year between 1950 and 2100),
  constraint vehicles_type    check (vehicle_type is null or vehicle_type in
                                ('car','suv','pickup','van','bus','truck','motorcycle','other')),
  constraint vehicles_plate_key_shape check (normalized_plate ~ '^[A-Z0-9]+$')
);

-- "UGB 123A is already registered." — enforced by the database, so a race
-- between two receptionists cannot create two vehicles with one plate.
create unique index if not exists vehicles_plate_unique
  on public.vehicles (normalized_plate);
create index if not exists vehicles_customer_idx on public.vehicles (customer_id);
create index if not exists vehicles_recent_idx   on public.vehicles (created_at desc);

-- ---------------------------------------------------------------------------
-- services
-- ---------------------------------------------------------------------------
-- Prices are WHOLE Uganda shillings and live only in the database. Nothing is
-- hard-coded in the frontend.

create table if not exists public.services (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null,
  description                 text,
  category                    text not null,
  price_ugx                   bigint not null,
  estimated_duration_minutes  integer,
  qualifies_for_loyalty       boolean not null default false,
  is_active                   boolean not null default true,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  created_by                  uuid references public.users (id),
  updated_by                  uuid references public.users (id),

  constraint services_category check (category in
    ('washing','interior','exterior','detailing','polishing','waxing','other')),
  constraint services_price    check (price_ugx between 0 and 100000000),
  constraint services_duration check (estimated_duration_minutes is null
                                      or estimated_duration_minutes between 1 and 1440),
  constraint services_name_length check (char_length(name) between 2 and 80)
);

-- Case-insensitive uniqueness, as unique_keys/service_name_{lowercase} was.
create unique index if not exists services_name_unique on public.services (lower(name));

-- ---------------------------------------------------------------------------
-- service_intakes — the JOB
-- ---------------------------------------------------------------------------

create table if not exists public.service_intakes (
  id                  uuid primary key default gen_random_uuid(),
  job_number          text not null unique,

  vehicle_id          uuid not null references public.vehicles (id),
  number_plate        text not null,
  normalized_plate    text not null,
  vehicle_summary     text,

  customer_id         uuid references public.customers (id),
  customer_name       text,

  status              text not null default 'open',

  -- A SNAPSHOT of the services and their prices at intake time. A later
  -- catalogue price change must never rewrite a visit already started.
  selected_services   jsonb not null,
  service_ids         uuid[] not null,
  service_count       integer not null,

  orders              jsonb not null default '[]'::jsonb,
  worker_ids          uuid[] not null default '{}',

  notes               text,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        uuid references public.users (id),
  cancel_reason       text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references public.users (id),
  created_by_name     text,
  updated_by          uuid references public.users (id),

  constraint intakes_status check (status in ('draft', 'open', 'completed', 'cancelled')),
  constraint intakes_service_count check (service_count between 1 and 20)
);

-- ONE OPEN JOB PER VEHICLE. "… already has a service in progress."
-- A partial unique index makes this race-safe without a transaction-level read.
create unique index if not exists intakes_one_open_per_vehicle
  on public.service_intakes (vehicle_id) where status in ('open', 'draft');

create index if not exists intakes_status_created_idx on public.service_intakes (status, created_at desc);
create index if not exists intakes_plate_idx          on public.service_intakes (normalized_plate);
create index if not exists intakes_vehicle_idx        on public.service_intakes (vehicle_id);

-- ---------------------------------------------------------------------------
-- worker_orders — one per selected service
-- ---------------------------------------------------------------------------
-- Carries the vehicle and the service, and the customer id for linkage only.
-- It deliberately carries NO customer contact details: this is the record a
-- worker reads.

create table if not exists public.worker_orders (
  id                  uuid primary key default gen_random_uuid(),
  order_number        text not null unique,

  service_intake_id   uuid not null references public.service_intakes (id),
  job_number          text not null,

  vehicle_id          uuid not null references public.vehicles (id),
  number_plate        text not null,
  vehicle_summary     text,
  customer_id         uuid references public.customers (id),

  service_id          uuid not null references public.services (id),
  service_name        text not null,
  category            text not null,

  status              text not null default 'pending',
  worker_id           uuid references public.users (id),
  worker_name         text,
  assigned_by         uuid references public.users (id),
  assigned_at         timestamptz,
  accepted_at         timestamptz,
  started_at          timestamptz,
  paused_at           timestamptz,
  resumed_at          timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        uuid references public.users (id),

  total_paused_ms     bigint not null default 0,
  pause_reason        text,
  cancel_reason       text,
  completion_notes    text,
  notes               text,

  -- Every assignment, never removed: a reassignment closes the previous entry.
  assignment_history  jsonb not null default '[]'::jsonb,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references public.users (id),
  updated_by          uuid references public.users (id),

  constraint orders_status check (status in
    ('pending','assigned','accepted','in_progress','paused','completed','cancelled')),
  constraint orders_paused_ms check (total_paused_ms >= 0),
  -- An order in any state beyond `pending` must name the worker it belongs to.
  constraint orders_worker_required check (
    status in ('pending', 'cancelled') or worker_id is not null)
);

create index if not exists orders_intake_idx on public.worker_orders (service_intake_id);
create index if not exists orders_worker_idx on public.worker_orders (worker_id, status);
create index if not exists orders_status_idx on public.worker_orders (status, created_at desc);

-- ---------------------------------------------------------------------------
-- Nothing is deleted
-- ---------------------------------------------------------------------------
-- Customers, vehicles and services are deactivated; intakes and orders are
-- cancelled. A DELETE is always a mistake, so the database refuses it outright
-- rather than relying on the absence of a grant.

create or replace function app.forbid_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'RamosMAX never deletes %: deactivate or cancel it instead', tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['customers','vehicles','services','service_intakes','worker_orders'] loop
    execute format('drop trigger if exists %I_no_delete on public.%I', t, t);
    execute format(
      'create trigger %I_no_delete before delete on public.%I
       for each row execute function app.forbid_delete()', t, t);
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format(
      'create trigger %I_touch before update on public.%I
       for each row execute function app.touch_updated_at()', t, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Default deny
-- ---------------------------------------------------------------------------

alter table public.customers        enable row level security;
alter table public.customers        force  row level security;
alter table public.vehicles         enable row level security;
alter table public.vehicles         force  row level security;
alter table public.services         enable row level security;
alter table public.services         force  row level security;
alter table public.service_intakes  enable row level security;
alter table public.service_intakes  force  row level security;
alter table public.worker_orders    enable row level security;
alter table public.worker_orders    force  row level security;

revoke all on public.customers, public.vehicles, public.services,
              public.service_intakes, public.worker_orders
  from anon, authenticated;
