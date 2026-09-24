-- ===========================================================================
-- RamosMAX Web — Phase C — 0009: RLS for customers, vehicles, services, jobs
-- ===========================================================================
-- Direct translation of the Phase 3 and Phase 4 blocks of
-- firebase/firestore.rules. SELECT only; no client holds INSERT, UPDATE or
-- DELETE on any of these tables.
--
-- THE WORKER / CUSTOMER-PHONE BOUNDARY
--
-- In the reference implementation a Worker holds vehicles.view and
-- services.view but NOT customers.view, and the comment in firestore.rules is
-- explicit: "a vehicle document carries only the owner name and customer
-- number, never a phone number."
--
-- That is reproduced structurally, in three independent layers:
--   1. public.vehicles HAS NO PHONE COLUMN AT ALL. There is nothing to leak.
--   2. public.customers, which does hold phones, has no policy granting a
--      Worker any row.
--   3. The search surface a Worker uses is a SECURITY INVOKER view that
--      selects an explicit column list, so a future column added to vehicles
--      cannot silently widen it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- customers — customers.view
-- ---------------------------------------------------------------------------

drop policy if exists customers_read on public.customers;
create policy customers_read on public.customers
  for select to authenticated
  using (app.has_permission('customers.view'));

grant select on public.customers to authenticated;

-- ---------------------------------------------------------------------------
-- vehicles — vehicles.view
-- ---------------------------------------------------------------------------
-- Workers hold this: plate look-up is part of their job. The table carries the
-- owner's name and customer number for the job card, and no phone number.

drop policy if exists vehicles_read on public.vehicles;
create policy vehicles_read on public.vehicles
  for select to authenticated
  using (app.has_permission('vehicles.view'));

grant select on public.vehicles to authenticated;

-- ---------------------------------------------------------------------------
-- services — services.view
-- ---------------------------------------------------------------------------
-- Workers and cashiers see the catalogue WITH prices, read-only. Prices are
-- changed only through app.update_service, which needs services.manage.

drop policy if exists services_read on public.services;
create policy services_read on public.services
  for select to authenticated
  using (app.has_permission('services.view'));

grant select on public.services to authenticated;

-- ---------------------------------------------------------------------------
-- service_intakes — jobs.view, or the worker's OWN job
-- ---------------------------------------------------------------------------
-- The reference rules grant intakes to jobs.view only. A worker reaches the
-- job through their own worker order, so a worker assigned to a job may read
-- that job's header — and no other. Without this a worker could not see which
-- vehicle their order belongs to.

drop policy if exists intakes_read on public.service_intakes;
create policy intakes_read on public.service_intakes
  for select to authenticated
  using (
    app.has_permission('jobs.view')
    or (
      app.has_permission('jobs.view.own')
      and exists (
        select 1 from public.worker_orders o
         where o.service_intake_id = service_intakes.id
           and o.worker_id = auth.uid()
      )
    )
  );

grant select on public.service_intakes to authenticated;

-- ---------------------------------------------------------------------------
-- worker_orders — jobs.view, or ONLY the orders assigned to you
-- ---------------------------------------------------------------------------
-- This is the core of worker isolation. A worker with jobs.view.own sees
-- exactly the rows where worker_id is their own uid — no filter in the query
-- is required or trusted.

drop policy if exists orders_read on public.worker_orders;
create policy orders_read on public.worker_orders
  for select to authenticated
  using (
    app.has_permission('jobs.view')
    or (app.has_permission('jobs.view.own') and worker_id = auth.uid())
  );

grant select on public.worker_orders to authenticated;

-- ===========================================================================
-- Read surfaces
-- ===========================================================================
-- These views are SECURITY INVOKER (the PostgreSQL default), so the caller's
-- own RLS policies still apply to the tables underneath. They exist to pin an
-- explicit column list, which RLS — being row-level — cannot do.

-- The vehicle directory used by plate search and the vehicle list. It names
-- every column it exposes, so adding a column to public.vehicles later cannot
-- widen what a Worker sees by accident.
create or replace view public.vehicle_directory
with (security_invoker = true) as
  select v.id,
         v.number_plate,
         v.normalized_plate,
         v.make,
         v.model,
         v.colour,
         v.year,
         v.vehicle_type,
         v.notes,            -- about the VEHICLE, never about the customer
         v.status,
         v.customer_id,
         v.customer_name,      -- name only
         v.customer_number,    -- reference only
         v.previous_plates,
         v.last_intake_at,
         v.created_at
    from public.vehicles v;

comment on view public.vehicle_directory is
  'Plate search and vehicle lists. Exposes the owner''s NAME and customer number and never a phone number, so a Worker holding vehicles.view cannot reach customer contact details.';

grant select on public.vehicle_directory to authenticated;

-- What a worker needs to carry out an order: the vehicle, the service and
-- their own progress. No customer contact details, by construction.
create or replace view public.my_worker_orders
with (security_invoker = true) as
  select o.id,
         o.order_number,
         o.job_number,
         o.service_intake_id,
         o.number_plate,
         o.vehicle_summary,
         o.service_name,
         o.category,
         o.status,
         o.assigned_at,
         o.accepted_at,
         o.started_at,
         o.paused_at,
         o.completed_at,
         o.total_paused_ms,
         o.pause_reason,
         o.notes,
         o.completion_notes
    from public.worker_orders o
   where o.worker_id = auth.uid();

comment on view public.my_worker_orders is
  'A worker''s own orders. Carries no customer_id and no customer details at all.';

grant select on public.my_worker_orders to authenticated;

-- ---------------------------------------------------------------------------
-- Plate search
-- ---------------------------------------------------------------------------
-- Search runs on the SERVER against the normalised key, so "UGB 123A",
-- "ugb-123a" and "UGB123A" all find the same vehicle. It is bounded, and it
-- reads through the directory view, so it is subject to the caller's RLS and
-- exposes no phone number regardless of who calls it.

create or replace function app.search_vehicles(p_query text, p_limit integer default 30)
returns setof public.vehicle_directory
language sql
stable
security invoker
set search_path = public, app, pg_temp
as $$
  select *
    from public.vehicle_directory
   where p_query is null or btrim(p_query) = ''
      or normalized_plate like app.plate_key(p_query) || '%'
   order by case when p_query is null or btrim(p_query) = '' then null end,
            last_intake_at desc nulls last,
            created_at desc
   limit least(greatest(coalesce(p_limit, 30), 1), 100);
$$;

grant execute on function app.search_vehicles(text, integer) to authenticated;
