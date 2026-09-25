-- ===========================================================================
-- RamosMAX Web — Phase F — 0029: loss incidents and salary deductions
-- ===========================================================================
-- Ports `functions/src/losses.js`.
--
--   reported ──review──► under_review ──decide──► approved ──schedule──► recovery_scheduled
--       │                    └──► rejected                                    │ (payroll paid)
--       └──────────────────────────────────────────► partially_recovered ──► recovered
--
-- AN INCIDENT NEVER DEDUCTS ANYTHING BY ITSELF. A staff member repays only an
-- amount an approver decided they are liable for, through a schedule someone
-- set up, and only when a payroll is actually paid. The subject sees an
-- incident about them once it has been DECIDED, never while it is being
-- investigated.
-- ===========================================================================

create or replace function app.create_loss_incident(
  p_type        text,
  p_amount      bigint,
  p_description text,
  p_request_id  text,
  p_staff       uuid default null,
  p_date        date default null,
  p_notes       text default null
)
returns table (incident_id uuid, loss_number text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier  jsonb;
  v_employee public.users%rowtype;
  v_number   text;
  v_id       uuid;
  v_date     date;
begin
  perform app.require_permission('losses.create');
  perform app.require_request_id(p_request_id);
  perform app.require_amount(p_amount, 'loss amount', 1, 100000000);
  if p_type not in ('damaged_equipment', 'damaged_customer_property', 'stock_loss',
                    'worker_related_loss', 'other') then
    raise exception 'Choose the type of loss.'
      using errcode = 'invalid_parameter_value', detail = 'incident_type';
  end if;
  v_date := app.require_business_date(p_date, 'incident date');

  v_earlier := app.claim_request(p_request_id, 'loss_incident',
    jsonb_build_object('staff', p_staff, 'amount', p_amount, 'description', p_description));
  if v_earlier is not null then
    return query select (v_earlier ->> 'incident_id')::uuid, v_earlier ->> 'loss_number';
    return;
  end if;

  if p_staff is not null then
    v_employee := app.read_employee(p_staff, false);
  end if;

  v_number := app.next_reference('loss_number_seq', 'RMX-LOSS-');
  insert into public.loss_incidents
    (loss_number, staff_uid, staff_id, staff_name, staff_role, incident_type, incident_date,
     amount_ugx, description, notes, request_id, reported_by, reported_by_name, updated_by)
  values
    (v_number, p_staff, v_employee.staff_id, v_employee.full_name, v_employee.role, p_type, v_date,
     p_amount, app.require_text(p_description, 'Description', 1000),
     app.optional_text(p_notes, 'Notes', 500), p_request_id,
     auth.uid(), (select full_name from public.users where id = auth.uid()), auth.uid())
  returning id into v_id;

  -- The reviewers hear about it. The subject does not: they see it once it
  -- has been decided.
  insert into public.workforce_events (type, reference_type, reference_id, audience, payload)
  values ('loss_incident_created', 'loss_incident', v_id, 'losses.review',
          jsonb_build_object('lossNumber', v_number));

  perform app.audit('loss.created', 'losses', v_id::text, p_staff, v_number, null, null,
    jsonb_build_object('lossNumber', v_number, 'incidentType', p_type, 'amountUgx', p_amount,
                       'staffUid', p_staff));

  perform app.complete_request(p_request_id,
    jsonb_build_object('incident_id', v_id, 'loss_number', v_number));

  return query select v_id, v_number;
end;
$$;

create or replace function app.review_loss_incident(p_incident uuid, p_notes text default null)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_inc public.loss_incidents%rowtype;
begin
  perform app.require_permission('losses.review');
  select * into v_inc from public.loss_incidents where id = p_incident for update;
  if v_inc.id is null then
    raise exception 'That loss incident could not be found.'
      using errcode = 'no_data_found', detail = 'incident';
  end if;
  perform app.require_not_own(v_inc.staff_uid, 'You cannot review an incident about yourself.');
  if v_inc.status <> 'reported' then
    raise exception 'Only a newly reported incident can be put under review.'
      using errcode = 'raise_exception', detail = 'invalid_status';
  end if;

  update public.loss_incidents
     set status = 'under_review', reviewed_by = auth.uid(),
         reviewed_by_name = (select full_name from public.users where id = auth.uid()),
         reviewed_at = now(), review_notes = app.optional_text(p_notes, 'Review notes', 500),
         updated_by = auth.uid()
   where id = p_incident;

  perform app.audit('loss.reviewed', 'losses', p_incident::text, v_inc.staff_uid, v_inc.loss_number,
    p_notes, jsonb_build_object('status', v_inc.status),
    jsonb_build_object('status', 'under_review'));
  return 'under_review';
end;
$$;

/*
 * The decision: approve with the amount the staff member must repay (0 means
 * the business absorbs it, never more than the loss) or reject. Always with a
 * reason. THIS is what makes the incident visible to its subject.
 */
create or replace function app.decide_loss_incident(
  p_incident uuid, p_decision text, p_reason text, p_recovery_ugx bigint default 0)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_inc      public.loss_incidents%rowtype;
  v_reason   text;
  v_recovery bigint;
  v_status   text;
begin
  perform app.require_permission('losses.approve');
  if p_decision not in ('approve', 'reject') then
    raise exception 'Choose approve or reject.'
      using errcode = 'invalid_parameter_value', detail = 'decision';
  end if;
  v_reason := app.require_reason(p_reason);
  v_recovery := case when p_decision = 'approve' then coalesce(p_recovery_ugx, 0) else 0 end;

  select * into v_inc from public.loss_incidents where id = p_incident for update;
  if v_inc.id is null then
    raise exception 'That loss incident could not be found.'
      using errcode = 'no_data_found', detail = 'incident';
  end if;
  perform app.require_not_own(v_inc.staff_uid, 'You cannot decide an incident about yourself.');
  if v_inc.status not in ('reported', 'under_review') then
    raise exception 'This incident is already %.', replace(v_inc.status, '_', ' ')
      using errcode = 'raise_exception', detail = 'invalid_status';
  end if;
  if v_recovery > v_inc.amount_ugx then
    raise exception 'The recovery cannot be more than the loss.'
      using errcode = 'invalid_parameter_value', detail = 'over_recovery';
  end if;
  if v_recovery > 0 and v_inc.staff_uid is null then
    raise exception 'No staff member is linked to this incident, so nothing can be recovered.'
      using errcode = 'invalid_parameter_value', detail = 'no_staff';
  end if;

  v_status := case when p_decision = 'approve' then 'approved' else 'rejected' end;
  update public.loss_incidents
     set status = v_status,
         approved_by = auth.uid(),
         approved_by_name = (select full_name from public.users where id = auth.uid()),
         approved_at = now(),
         approved_recovery_ugx = v_recovery,
         outstanding_ugx = case when p_decision = 'approve' then v_recovery else 0 end,
         recovery_reason = case when p_decision = 'approve' then v_reason end,
         rejection_reason = case when p_decision = 'reject' then v_reason end,
         -- Decided: the staff member may now see it.
         visible_to_staff = v_inc.staff_uid is not null,
         updated_by = auth.uid()
   where id = p_incident;

  perform app.audit(case when p_decision = 'approve' then 'loss.approved' else 'loss.rejected' end,
    'losses', p_incident::text, v_inc.staff_uid, v_inc.loss_number, v_reason,
    jsonb_build_object('status', v_inc.status),
    jsonb_build_object('status', v_status, 'amountUgx', v_inc.amount_ugx,
                       'approvedRecoveryUgx', v_recovery));
  return v_status;
end;
$$;

/* One loss_recovery deduction for what is still outstanding. */
create or replace function app.schedule_loss_recovery(
  p_incident uuid, p_instalment_ugx bigint, p_start_date date default null, p_reason text default null)
returns table (incident_id uuid, deduction_id uuid, deduction_number text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_inc    public.loss_incidents%rowtype;
  v_ded    public.salary_deductions%rowtype;
  v_number text;
  v_id     uuid;
  v_start  date;
begin
  perform app.require_permission('losses.schedule');
  perform app.require_amount(p_instalment_ugx, 'amount per payroll', 1, 100000000);
  v_start := app.require_business_date(p_start_date, 'first payroll date', 400);

  select * into v_inc from public.loss_incidents where id = p_incident for update;
  if v_inc.id is null then
    raise exception 'That loss incident could not be found.'
      using errcode = 'no_data_found', detail = 'incident';
  end if;
  perform app.require_not_own(v_inc.staff_uid, 'You cannot schedule a recovery from yourself.');
  if v_inc.status not in ('approved', 'partially_recovered') then
    raise exception '%', case when v_inc.status = 'recovery_scheduled'
      then 'A recovery is already scheduled.'
      else format('A %s incident cannot be scheduled.', replace(v_inc.status, '_', ' ')) end
      using errcode = 'raise_exception', detail = 'invalid_status';
  end if;
  if v_inc.deduction_id is not null then
    select * into v_ded from public.salary_deductions where id = v_inc.deduction_id;
    if v_ded.status in ('active', 'pending_approval') then
      raise exception 'A recovery is already scheduled.'
        using errcode = 'raise_exception', detail = 'already_scheduled';
    end if;
  end if;
  if v_inc.outstanding_ugx <= 0 then
    raise exception 'Nothing is outstanding on this incident.'
      using errcode = 'raise_exception', detail = 'nothing_outstanding';
  end if;
  if p_instalment_ugx > v_inc.outstanding_ugx then
    raise exception 'The amount per payroll cannot be more than what is outstanding.'
      using errcode = 'invalid_parameter_value', detail = 'instalment';
  end if;

  v_number := app.next_reference('deduction_number_seq', 'RMX-DED-');
  insert into public.salary_deductions
    (deduction_number, staff_uid, staff_id, staff_name, type, reason, source_kind, source_id,
     source_number, loss_incident_id, loss_number, total_amount_ugx, instalment_ugx,
     remaining_ugx, starts_from, status, approved_by, approved_by_name, approved_at,
     schedule_reason, created_by, created_by_name, updated_by)
  values
    (v_number, v_inc.staff_uid, v_inc.staff_id, v_inc.staff_name, 'loss_recovery',
     coalesce(v_inc.recovery_reason, 'Approved loss recovery'), 'loss_incident', p_incident,
     v_inc.loss_number, p_incident, v_inc.loss_number, v_inc.outstanding_ugx, p_instalment_ugx,
     v_inc.outstanding_ugx, v_start, 'active', v_inc.approved_by, v_inc.approved_by_name,
     v_inc.approved_at, app.optional_text(p_reason, 'Reason', 300),
     auth.uid(), (select full_name from public.users where id = auth.uid()), auth.uid())
  returning id into v_id;

  update public.loss_incidents
     set status = case when v_inc.recovered_ugx > 0 then 'partially_recovered'
                       else 'recovery_scheduled' end,
         deduction_id = v_id, deduction_number = v_number, updated_by = auth.uid()
   where id = p_incident;

  insert into public.workforce_events (type, reference_type, reference_id, audience, recipient_uid, payload)
  values ('loss_recovery_scheduled', 'deduction', v_id, 'staff', v_inc.staff_uid,
          jsonb_build_object('deductionNumber', v_number));

  perform app.audit('loss.recovery_scheduled', 'losses', p_incident::text, v_inc.staff_uid,
    v_inc.loss_number, p_reason, jsonb_build_object('status', v_inc.status),
    jsonb_build_object('deductionNumber', v_number, 'totalAmountUgx', v_inc.outstanding_ugx,
                       'instalmentUgx', p_instalment_ugx));
  perform app.audit('deduction.created', 'payroll', v_id::text, v_inc.staff_uid, v_number, null, null,
    jsonb_build_object('deductionNumber', v_number, 'type', 'loss_recovery',
                       'staffUid', v_inc.staff_uid, 'lossNumber', v_inc.loss_number));

  return query select p_incident, v_id, v_number;
end;
$$;

/* A deduction must not be cancelled while an unpaid payroll plans to take it. */
create or replace function app.require_deduction_not_planned(p_deduction uuid)
returns void
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_number text;
begin
  select i.payroll_number into v_number
    from public.payroll_items i, jsonb_array_elements(i.deduction_lines) l
   where i.current and i.payment_status = 'unpaid'
     and (l ->> 'deductionId')::uuid = p_deduction and (l ->> 'amountUgx')::bigint > 0
   limit 1;
  if v_number is not null then
    raise exception 'Payroll % includes this deduction. Correct or cancel that payroll first.', v_number
      using errcode = 'raise_exception', detail = 'deduction_in_payroll';
  end if;
end;
$$;

create or replace function app.cancel_loss_incident(p_incident uuid, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_inc    public.loss_incidents%rowtype;
  v_ded    public.salary_deductions%rowtype;
  v_reason text;
begin
  perform app.require_permission('losses.adjust');
  v_reason := app.require_reason(p_reason);
  select * into v_inc from public.loss_incidents where id = p_incident for update;
  if v_inc.id is null then
    raise exception 'That loss incident could not be found.'
      using errcode = 'no_data_found', detail = 'incident';
  end if;
  if v_inc.status in ('rejected', 'recovered', 'cancelled') then
    raise exception 'This incident is already %.', v_inc.status
      using errcode = 'raise_exception', detail = 'invalid_status';
  end if;

  if v_inc.deduction_id is not null then
    select * into v_ded from public.salary_deductions where id = v_inc.deduction_id for update;
    if v_ded.status in ('active', 'pending_approval') then
      perform app.require_deduction_not_planned(v_ded.id);
      update public.salary_deductions
         set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(),
             cancel_reason = v_reason, updated_by = auth.uid()
       where id = v_ded.id;
    end if;
  end if;

  -- What was recovered stays recorded; the rest is written off.
  update public.loss_incidents
     set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(),
         cancel_reason = v_reason, cancelled_outstanding_ugx = v_inc.outstanding_ugx,
         outstanding_ugx = 0, updated_by = auth.uid()
   where id = p_incident;

  perform app.audit('loss.cancelled', 'losses', p_incident::text, v_inc.staff_uid, v_inc.loss_number,
    v_reason,
    jsonb_build_object('status', v_inc.status, 'outstandingUgx', v_inc.outstanding_ugx),
    jsonb_build_object('status', 'cancelled', 'recoveredUgx', v_inc.recovered_ugx));
  return 'cancelled';
end;
$$;

-- ---------------------------------------------------------------------------
-- Other salary deductions
-- ---------------------------------------------------------------------------

create or replace function app.create_salary_deduction(
  p_staff      uuid,
  p_type       text,
  p_total_ugx  bigint,
  p_reason     text,
  p_reference  text,
  p_request_id text,
  p_instalment_ugx bigint default null,
  p_start_date date default null
)
returns table (deduction_id uuid, deduction_number text, status text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_earlier   jsonb;
  v_employee  public.users%rowtype;
  v_reason    text;
  v_reference text;
  v_instalment bigint;
  v_number    text;
  v_id        uuid;
  v_start     date;
begin
  perform app.require_permission('deductions.manage');
  perform app.require_request_id(p_request_id);
  if p_type not in ('authorized_deduction', 'other') then
    raise exception 'Choose an authorised salary deduction or another approved deduction.'
      using errcode = 'invalid_parameter_value', detail = 'deduction_type';
  end if;
  perform app.require_amount(p_total_ugx, 'total amount', 1, 100000000);
  v_instalment := coalesce(p_instalment_ugx, p_total_ugx);
  perform app.require_amount(v_instalment, 'amount per payroll', 1, 100000000);
  if v_instalment > p_total_ugx then
    raise exception 'The amount per payroll cannot be more than the total.'
      using errcode = 'invalid_parameter_value', detail = 'instalment';
  end if;
  v_reason := app.require_reason(p_reason);
  -- Every deduction names its source: a signed agreement, for instance.
  v_reference := app.optional_text(p_reference, 'Reference / source document', 80);
  if v_reference is null then
    raise exception 'Enter the source of this deduction (e.g. the signed agreement).'
      using errcode = 'invalid_parameter_value', detail = 'source';
  end if;
  v_start := app.require_business_date(p_start_date, 'first payroll date', 400);

  v_earlier := app.claim_request(p_request_id, 'salary_deduction',
    jsonb_build_object('staff', p_staff, 'type', p_type, 'total', p_total_ugx));
  if v_earlier is not null then
    return query select (v_earlier ->> 'deduction_id')::uuid, v_earlier ->> 'deduction_number',
                        v_earlier ->> 'status';
    return;
  end if;

  v_employee := app.read_employee(p_staff, false);
  perform app.require_not_own(p_staff, 'You cannot create a deduction from your own pay.');

  v_number := app.next_reference('deduction_number_seq', 'RMX-DED-');
  insert into public.salary_deductions
    (deduction_number, staff_uid, staff_id, staff_name, type, reason, reference, source_kind,
     source_number, total_amount_ugx, instalment_ugx, remaining_ugx, starts_from, status,
     request_id, created_by, created_by_name, updated_by)
  values
    (v_number, p_staff, v_employee.staff_id, v_employee.full_name, p_type, v_reason, v_reference,
     'manual', v_reference, p_total_ugx, v_instalment, p_total_ugx, v_start, 'pending_approval',
     p_request_id, auth.uid(), (select full_name from public.users where id = auth.uid()), auth.uid())
  returning id into v_id;

  insert into public.workforce_events (type, reference_type, reference_id, audience, payload)
  values ('deduction_awaiting_approval', 'deduction', v_id, 'payroll.approve',
          jsonb_build_object('deductionNumber', v_number));

  perform app.audit('deduction.created', 'payroll', v_id::text, p_staff, v_number, v_reason, null,
    jsonb_build_object('deductionNumber', v_number, 'type', p_type, 'staffUid', p_staff,
                       'totalAmountUgx', p_total_ugx, 'instalmentUgx', v_instalment));

  perform app.complete_request(p_request_id, jsonb_build_object(
    'deduction_id', v_id, 'deduction_number', v_number, 'status', 'pending_approval'));

  return query select v_id, v_number, 'pending_approval'::text;
end;
$$;

/* A deduction applies only once someone with payroll.approve has approved it. */
create or replace function app.decide_salary_deduction(
  p_deduction uuid, p_decision text, p_reason text default null)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_ded    public.salary_deductions%rowtype;
  v_reason text;
  v_status text;
begin
  perform app.require_permission('payroll.approve');
  if p_decision not in ('approve', 'reject') then
    raise exception 'Choose approve or reject.'
      using errcode = 'invalid_parameter_value', detail = 'decision';
  end if;
  v_reason := case when p_decision = 'reject' then app.require_reason(p_reason)
                   else app.optional_text(p_reason, 'Reason', 300) end;

  select * into v_ded from public.salary_deductions where id = p_deduction for update;
  if v_ded.id is null then
    raise exception 'That deduction could not be found.'
      using errcode = 'no_data_found', detail = 'deduction';
  end if;
  perform app.require_not_own(v_ded.staff_uid, 'You cannot approve a deduction from your own pay.');
  if v_ded.status <> 'pending_approval' then
    raise exception 'This deduction is %.', replace(v_ded.status, '_', ' ')
      using errcode = 'raise_exception', detail = 'invalid_status';
  end if;

  v_status := case when p_decision = 'approve' then 'active' else 'rejected' end;
  update public.salary_deductions
     set status = v_status,
         approved_by = case when p_decision = 'approve' then auth.uid() end,
         approved_by_name = case when p_decision = 'approve'
                                 then (select full_name from public.users where id = auth.uid()) end,
         approved_at = case when p_decision = 'approve' then now() end,
         rejection_reason = case when p_decision = 'reject' then v_reason end,
         updated_by = auth.uid()
   where id = p_deduction;

  perform app.audit(case when p_decision = 'approve' then 'deduction.approved' else 'deduction.rejected' end,
    'payroll', p_deduction::text, v_ded.staff_uid, v_ded.deduction_number, v_reason,
    jsonb_build_object('status', v_ded.status),
    jsonb_build_object('status', v_status, 'totalAmountUgx', v_ded.total_amount_ugx));
  return v_status;
end;
$$;

create or replace function app.cancel_salary_deduction(p_deduction uuid, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_ded    public.salary_deductions%rowtype;
  v_inc    public.loss_incidents%rowtype;
  v_reason text;
begin
  perform app.require_permission('deductions.manage', 'losses.adjust');
  v_reason := app.require_reason(p_reason);

  select * into v_ded from public.salary_deductions where id = p_deduction for update;
  if v_ded.id is null then
    raise exception 'That deduction could not be found.'
      using errcode = 'no_data_found', detail = 'deduction';
  end if;
  -- A loss recovery is cancelled by whoever may adjust losses; anything else
  -- by whoever manages deductions.
  perform app.require_permission(
    case when v_ded.type = 'loss_recovery' then 'losses.adjust' else 'deductions.manage' end);
  if v_ded.status not in ('active', 'pending_approval') then
    raise exception 'This deduction is %.', replace(v_ded.status, '_', ' ')
      using errcode = 'raise_exception', detail = 'invalid_status';
  end if;

  perform app.require_deduction_not_planned(p_deduction);

  update public.salary_deductions
     set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(),
         cancel_reason = v_reason, updated_by = auth.uid()
   where id = p_deduction;

  if v_ded.loss_incident_id is not null then
    select * into v_inc from public.loss_incidents where id = v_ded.loss_incident_id for update;
    if v_inc.status <> 'cancelled' then
      -- The incident can be rescheduled.
      update public.loss_incidents
         set status = case when v_inc.recovered_ugx > 0 then 'partially_recovered' else 'approved' end,
             deduction_id = null, deduction_number = null, updated_by = auth.uid()
       where id = v_inc.id;
    end if;
  end if;

  perform app.audit('deduction.cancelled', 'payroll', p_deduction::text, v_ded.staff_uid,
    v_ded.deduction_number, v_reason,
    jsonb_build_object('status', v_ded.status, 'remainingUgx', v_ded.remaining_ugx),
    jsonb_build_object('status', 'cancelled', 'recoveredUgx', v_ded.recovered_ugx));
  return 'cancelled';
end;
$$;
