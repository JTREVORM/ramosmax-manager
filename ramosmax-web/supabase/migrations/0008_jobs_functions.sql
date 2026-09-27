-- ===========================================================================
-- RamosMAX Web — Phase C — 0008: service intake, jobs and worker orders
-- ===========================================================================
-- Ports functions/src/jobs.js. The browser is NEVER authoritative for a price,
-- a status transition, an assignment rule or a completion decision.
--
-- The worker-order status flow, reproduced exactly:
--
--   pending -assign-> assigned -accept-> accepted -start-> in_progress -complete-> completed
--                        ^                                    |   ^
--                        +------- reassign (reason) ----------+   |
--                                                             v   |
--                                                          paused +
--   any unfinished order -cancel (reason)-> cancelled
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The job status implied by its orders
-- ---------------------------------------------------------------------------
-- `completed` when every order that is not cancelled is completed AND at least
-- one was completed; otherwise `open`. A multi-service job therefore finishes
-- only when all its required services are done or cancelled.

create or replace function app.job_status_for(p_orders jsonb)
returns text
language sql
immutable
as $$
  with live as (
    select o->>'status' as status
      from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb)) o
     where o->>'status' <> 'cancelled'
  )
  select case
    when (select count(*) from live) > 0
     and not exists (select 1 from live where status <> 'completed')
    then 'completed' else 'open' end;
$$;

-- Rebuilds the job's order summary and status from the orders themselves, so
-- the summary can never drift from the rows it describes.
create or replace function app.refresh_intake(p_intake uuid)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_orders  jsonb;
  v_workers uuid[];
  v_status  text;
  v_intake  public.service_intakes%rowtype;
begin
  select * into v_intake from public.service_intakes where id = p_intake for update;

  select coalesce(jsonb_agg(jsonb_build_object(
           'workerOrderId', o.id,
           'orderNumber',   o.order_number,
           'serviceId',     o.service_id,
           'serviceName',   o.service_name,
           'workerId',      o.worker_id,
           'workerName',    o.worker_name,
           'status',        o.status) order by o.order_number), '[]'::jsonb),
         coalesce(array_agg(distinct o.worker_id) filter (where o.worker_id is not null), '{}')
    into v_orders, v_workers
    from public.worker_orders o
   where o.service_intake_id = p_intake;

  v_status := v_intake.status;
  if v_intake.status not in ('cancelled', 'draft') then
    v_status := app.job_status_for(v_orders);
  end if;

  update public.service_intakes
     set orders       = v_orders,
         worker_ids   = v_workers,
         status       = v_status,
         completed_at = case when v_status = 'completed'
                             then coalesce(completed_at, now()) else null end,
         updated_by   = auth.uid()
   where id = p_intake;

  return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_service_intake
-- ---------------------------------------------------------------------------

create or replace function app.create_service_intake(
  p_vehicle     uuid,
  p_service_ids uuid[],
  p_notes       text default null,
  p_draft       boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_vehicle   public.vehicles%rowtype;
  v_intake    uuid;
  v_job       text;
  v_services  jsonb;
  v_ids       uuid[];
  v_count     integer;
  v_open      uuid;
  v_summary   text;
  v_actor     text;
begin
  perform app.require_permission('jobs.create');

  select * into v_vehicle from public.vehicles where id = p_vehicle;
  if v_vehicle.id is null then
    raise exception 'That vehicle could not be found.'
      using errcode = 'no_data_found', detail = 'vehicle_missing';
  end if;
  if v_vehicle.status <> 'active' then
    raise exception '% is inactive. Reactivate it before starting a service.', v_vehicle.number_plate
      using errcode = 'invalid_parameter_value', detail = 'vehicle_inactive';
  end if;

  -- Duplicates are collapsed, as the reference implementation does.
  select array_agg(distinct s) into v_ids from unnest(coalesce(p_service_ids, '{}')) s;
  v_count := coalesce(array_length(v_ids, 1), 0);
  if v_count < 1 or v_count > 20 then
    raise exception 'Choose between 1 and 20 services.'
      using errcode = 'invalid_parameter_value', detail = 'services';
  end if;

  -- Every service must exist AND be active. The PRICE IS READ HERE, from the
  -- catalogue, never from the request: the browser cannot set a price.
  select jsonb_agg(jsonb_build_object(
           'serviceId', s.id, 'name', s.name, 'category', s.category,
           'priceUgx', s.price_ugx, 'qualifiesForLoyalty', s.qualifies_for_loyalty)
         order by s.name)
    into v_services
    from public.services s
   where s.id = any (v_ids) and s.is_active;

  if v_services is null or jsonb_array_length(v_services) <> v_count then
    raise exception 'One of the selected services is unavailable.'
      using errcode = 'invalid_parameter_value', detail = 'services';
  end if;

  -- One open job per vehicle. Checked here for a clear message; the partial
  -- unique index is what makes it race-safe.
  select id into v_open from public.service_intakes
   where vehicle_id = p_vehicle and status in ('open', 'draft');
  if v_open is not null then
    raise exception '% already has a service in progress.', v_vehicle.number_plate
      using errcode = 'unique_violation', detail = 'open_intake_exists', hint = v_open::text;
  end if;

  v_job := app.next_reference('job_number_seq', 'RMX-JOB-');
  v_summary := btrim(concat_ws(' ', v_vehicle.make, v_vehicle.model, '·', v_vehicle.colour));
  select full_name into v_actor from public.users where id = auth.uid();

  insert into public.service_intakes
    (job_number, vehicle_id, number_plate, normalized_plate, vehicle_summary,
     customer_id, customer_name, status, selected_services, service_ids, service_count,
     notes, created_by, created_by_name, updated_by)
  values
    (v_job, p_vehicle, v_vehicle.number_plate, v_vehicle.normalized_plate, v_summary,
     v_vehicle.customer_id, v_vehicle.customer_name,
     case when p_draft then 'draft' else 'open' end,
     v_services, v_ids, v_count,
     app.optional_text(p_notes, 'Notes', 500), auth.uid(), v_actor, auth.uid())
  returning id into v_intake;

  -- One pending worker order per selected service.
  insert into public.worker_orders
    (order_number, service_intake_id, job_number, vehicle_id, number_plate, vehicle_summary,
     customer_id, service_id, service_name, category, created_by, updated_by)
  select
    v_job || '/' || row_number() over (order by s->>'name'),
    v_intake, v_job, p_vehicle, v_vehicle.number_plate, v_summary,
    v_vehicle.customer_id,
    (s->>'serviceId')::uuid, s->>'name', s->>'category', auth.uid(), auth.uid()
  from jsonb_array_elements(v_services) s;

  update public.vehicles set last_intake_at = now() where id = p_vehicle;
  perform app.refresh_intake(v_intake);

  perform app.audit('service_intake.created', 'jobs', v_job, null, null, null, null,
    jsonb_build_object('numberPlate', v_vehicle.number_plate, 'serviceCount', v_count));
  return v_intake;
end;
$$;

create or replace function app.cancel_service_intake(p_intake uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_intake public.service_intakes%rowtype;
  v_reason text := app.require_reason(p_reason);
begin
  perform app.require_permission('jobs.manage');
  select * into v_intake from public.service_intakes where id = p_intake for update;
  if v_intake.id is null then
    raise exception 'That job could not be found.' using errcode = 'no_data_found', detail = 'job';
  end if;
  if v_intake.status = 'cancelled' then
    raise exception 'This job was already cancelled.'
      using errcode = 'invalid_parameter_value', detail = 'cancelled';
  end if;

  -- Refused once any work has started or finished.
  if exists (select 1 from public.worker_orders
              where service_intake_id = p_intake
                and status in ('in_progress', 'paused', 'completed')) then
    raise exception 'Work on this job has already started.'
      using errcode = 'invalid_parameter_value', detail = 'work_started';
  end if;

  update public.worker_orders
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         cancel_reason = v_reason, updated_by = auth.uid()
   where service_intake_id = p_intake and status <> 'cancelled';

  update public.service_intakes
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         cancel_reason = v_reason, updated_by = auth.uid()
   where id = p_intake;

  perform app.audit('service_intake.cancelled', 'jobs', v_intake.job_number, null, null, v_reason,
    jsonb_build_object('status', v_intake.status), jsonb_build_object('status', 'cancelled'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker orders
-- ---------------------------------------------------------------------------

-- A worker may be assigned only when their account is LIVE and they hold
-- jobs.complete. Ports readAssignableWorker().
create or replace function app.require_assignable_worker(p_worker uuid)
returns text
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_name text;
begin
  select full_name into v_name from public.users where id = p_worker;
  if v_name is null
     or not app.is_account_live(p_worker)
     or not ('jobs.complete' = any (app.effective_permissions(p_worker))) then
    raise exception 'Choose an active worker who can carry out jobs.'
      using errcode = 'invalid_parameter_value', detail = 'worker';
  end if;
  return v_name;
end;
$$;

-- Loads an order and refuses to touch a cancelled job.
create or replace function app.require_open_order(p_order uuid)
returns public.worker_orders
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_order  public.worker_orders%rowtype;
  v_status text;
begin
  select * into v_order from public.worker_orders where id = p_order;
  if v_order.id is null then
    raise exception 'That work order could not be found.'
      using errcode = 'no_data_found', detail = 'order';
  end if;
  select status into v_status from public.service_intakes where id = v_order.service_intake_id;
  if v_status = 'cancelled' then
    raise exception 'This job was cancelled.'
      using errcode = 'invalid_parameter_value', detail = 'cancelled';
  end if;
  return v_order;
end;
$$;

create or replace function app.assign_worker_order(
  p_order  uuid,
  p_worker uuid,
  p_notes  text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_order  public.worker_orders%rowtype;
  v_name   text;
begin
  perform app.require_permission('jobs.assign');
  v_order := app.require_open_order(p_order);

  if v_order.status <> 'pending' then
    raise exception 'This work order is already assigned. Use Reassign instead.'
      using errcode = 'invalid_parameter_value', detail = 'invalid_transition';
  end if;

  v_name := app.require_assignable_worker(p_worker);

  update public.worker_orders
     set status      = 'assigned',
         worker_id   = p_worker,
         worker_name = v_name,
         assigned_by = auth.uid(),
         assigned_at = now(),
         notes       = coalesce(app.optional_text(p_notes, 'Notes', 500), notes),
         assignment_history = assignment_history || jsonb_build_object(
           'workerId', p_worker, 'workerName', v_name,
           'assignedBy', auth.uid(), 'assignedAt', now(),
           'endedAt', null, 'reason', null),
         updated_by  = auth.uid()
   where id = p_order;

  perform app.refresh_intake(v_order.service_intake_id);
  perform app.audit('work_order.assigned', 'jobs', v_order.order_number, p_worker, null, null,
    jsonb_build_object('status', v_order.status),
    jsonb_build_object('status', 'assigned', 'workerId', p_worker));
end;
$$;

-- Reassignment needs a REASON, must go to a DIFFERENT worker, and closes the
-- previous history entry rather than removing it. Progress timestamps reset.
create or replace function app.reassign_worker_order(
  p_order  uuid,
  p_worker uuid,
  p_reason text
)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_order   public.worker_orders%rowtype;
  v_name    text;
  v_reason  text := app.require_reason(p_reason);
  v_history jsonb;
begin
  perform app.require_permission('jobs.assign');
  v_order := app.require_open_order(p_order);

  if v_order.status not in ('assigned', 'accepted', 'in_progress', 'paused') then
    raise exception 'This work order cannot be reassigned.'
      using errcode = 'invalid_parameter_value', detail = 'invalid_transition';
  end if;
  if v_order.worker_id = p_worker then
    raise exception 'Choose a different worker.'
      using errcode = 'invalid_parameter_value', detail = 'same_worker';
  end if;

  v_name := app.require_assignable_worker(p_worker);

  -- Close the open history entry; never delete it.
  select coalesce(jsonb_agg(
           case when entry->>'endedAt' is null
                then entry || jsonb_build_object('endedAt', now(), 'reason', v_reason)
                else entry end), '[]'::jsonb)
    into v_history
    from jsonb_array_elements(v_order.assignment_history) entry;

  update public.worker_orders
     set status       = 'assigned',
         worker_id    = p_worker,
         worker_name  = v_name,
         assigned_by  = auth.uid(),
         assigned_at  = now(),
         accepted_at  = null,
         started_at   = null,
         paused_at    = null,
         resumed_at   = null,
         pause_reason = null,
         total_paused_ms = 0,
         assignment_history = v_history || jsonb_build_object(
           'workerId', p_worker, 'workerName', v_name,
           'assignedBy', auth.uid(), 'assignedAt', now(),
           'endedAt', null, 'reason', null),
         updated_by   = auth.uid()
   where id = p_order;

  perform app.refresh_intake(v_order.service_intake_id);
  perform app.audit('work_order.reassigned', 'jobs', v_order.order_number, p_worker, null, v_reason,
    jsonb_build_object('workerId', v_order.worker_id),
    jsonb_build_object('workerId', p_worker));
end;
$$;

create or replace function app.cancel_worker_order(p_order uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_order  public.worker_orders%rowtype;
  v_reason text := app.require_reason(p_reason);
begin
  perform app.require_permission('jobs.manage');
  v_order := app.require_open_order(p_order);

  if v_order.status = 'completed' then
    raise exception 'This work order is already finished.'
      using errcode = 'invalid_parameter_value', detail = 'invalid_transition';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'This work order was already cancelled.'
      using errcode = 'invalid_parameter_value', detail = 'invalid_transition';
  end if;

  update public.worker_orders
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         cancel_reason = v_reason, updated_by = auth.uid()
   where id = p_order;

  perform app.refresh_intake(v_order.service_intake_id);
  perform app.audit('work_order.cancelled', 'jobs', v_order.order_number, v_order.worker_id, null, v_reason,
    jsonb_build_object('status', v_order.status), jsonb_build_object('status', 'cancelled'));
end;
$$;

-- ---------------------------------------------------------------------------
-- update_worker_order_status — the worker's own actions
-- ---------------------------------------------------------------------------
-- ONLY the assigned worker may accept, start, pause, resume or complete their
-- order, and only along the permitted transitions. Any other move is refused
-- with `invalid_transition`.
--
-- Returns the resulting JOB status, so the caller learns when a job has become
-- ready to invoice without computing anything itself.

create or replace function app.update_worker_order_status(
  p_order  uuid,
  p_action text,
  p_reason text default null,
  p_notes  text default null
)
returns table (order_status text, job_status text, ready_to_invoice boolean)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_order      public.worker_orders%rowtype;
  v_intake     public.service_intakes%rowtype;
  v_to         text;
  v_from       text[];
  v_was_ready  boolean;
  v_job_status text;
begin
  perform app.require_permission('jobs.complete');
  v_order := app.require_open_order(p_order);

  -- The assigned worker, and nobody else.
  if v_order.worker_id is distinct from auth.uid() then
    raise exception 'This work order is not assigned to you.'
      using errcode = 'insufficient_privilege', detail = 'not_assigned';
  end if;

  case p_action
    when 'accept'   then v_from := array['assigned'];    v_to := 'accepted';
    when 'start'    then v_from := array['accepted'];    v_to := 'in_progress';
    when 'pause'    then v_from := array['in_progress']; v_to := 'paused';
    when 'resume'   then v_from := array['paused'];      v_to := 'in_progress';
    when 'complete' then v_from := array['in_progress']; v_to := 'completed';
    else
      raise exception 'Unknown action.' using errcode = 'invalid_parameter_value', detail = 'action';
  end case;

  if not (v_order.status = any (v_from)) then
    raise exception 'This work order cannot be % from its current state.', p_action
      using errcode = 'invalid_parameter_value', detail = 'invalid_transition';
  end if;

  -- Pausing needs a reason.
  if p_action = 'pause' then perform app.require_reason(p_reason); end if;

  select * into v_intake from public.service_intakes where id = v_order.service_intake_id;
  v_was_ready := app.job_status_for(v_intake.orders) = 'completed';

  update public.worker_orders
     set status       = v_to,
         accepted_at  = case when p_action = 'accept'   then now() else accepted_at end,
         started_at   = case when p_action = 'start'    then now() else started_at end,
         paused_at    = case when p_action = 'pause'    then now() else paused_at end,
         resumed_at   = case when p_action = 'resume'   then now() else resumed_at end,
         completed_at = case when p_action = 'complete' then now() else completed_at end,
         pause_reason = case when p_action = 'pause' then app.require_reason(p_reason)
                             when p_action = 'resume' then null else pause_reason end,
         -- Worked time is start to completion, minus pauses.
         total_paused_ms = case
           when p_action = 'resume' and paused_at is not null
           then total_paused_ms + greatest(0, (extract(epoch from (now() - paused_at)) * 1000)::bigint)
           else total_paused_ms end,
         completion_notes = case when p_action = 'complete'
                                 then app.optional_text(p_notes, 'Notes', 500)
                                 else completion_notes end,
         updated_by   = auth.uid()
   where id = p_order;

  v_job_status := app.refresh_intake(v_order.service_intake_id);

  -- Event names are spelt out rather than derived: deriving them gave
  -- "pauseed" and "resumeed", and these strings are the audit trail.
  perform app.audit(
    case p_action
      when 'accept'   then 'work_order.accepted'
      when 'start'    then 'work_order.started'
      when 'pause'    then 'work_order.paused'
      when 'resume'   then 'work_order.resumed'
      when 'complete' then 'work_order.completed'
    end,
    'jobs', v_order.order_number, auth.uid(), null, p_reason,
    jsonb_build_object('status', v_order.status), jsonb_build_object('status', v_to));

  return query select v_to, v_job_status,
    (v_job_status = 'completed' and not v_was_ready);
end;
$$;

grant execute on function
  app.create_service_intake(uuid, uuid[], text, boolean),
  app.cancel_service_intake(uuid, text),
  app.assign_worker_order(uuid, uuid, text),
  app.reassign_worker_order(uuid, uuid, text),
  app.cancel_worker_order(uuid, text),
  app.update_worker_order_status(uuid, text, text, text),
  app.job_status_for(jsonb)
to authenticated;
