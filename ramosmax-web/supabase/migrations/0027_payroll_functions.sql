-- ===========================================================================
-- RamosMAX Web — Phase F — 0027: salaries and payroll
-- ===========================================================================
-- Ports `functions/src/payroll.js`.
--
--   draft ──prepare──► prepared ──submit──► pending_review ──review──►
--        ──approve──► approved ──pay──► paid ──lock──► locked
--
-- Salary is effective-dated HISTORY. A payroll uses the version in force on
-- the LAST DAY OF ITS PERIOD and copies it onto every item, so a salary added
-- later — even one effective earlier — cannot rewrite a payroll that is done.
--
--   gross = basic + approved allowances in the period + other earnings
--   net   = gross − (authorised deductions + loss recoveries + other),
--           each taking min(instalment, remaining), all capped at
--           maxDeductionPercentOfGross of gross, NEVER below zero
--
-- Balances move only when the payroll is PAID, in one transaction with ONE
-- `payroll_payment` ledger entry for the whole payroll.
-- ===========================================================================

create or replace function app.max_salary_ugx()
returns bigint language sql immutable as $$ select 100000000::bigint; $$;

-- ---------------------------------------------------------------------------
-- Salary profiles
-- ---------------------------------------------------------------------------

/* A new salary VERSION. Nothing is ever edited; nobody sets their own. */
create or replace function app.set_salary_profile(
  p_staff     uuid,
  p_basic_ugx bigint,
  p_effective_from date default null,
  p_frequency text default 'monthly',
  p_allowance_eligible boolean default null,
  p_allowance_amount_ugx bigint default null,
  p_active    boolean default true,
  p_reason    text default null,
  p_notes     text default null
)
returns table (staff_uid uuid, history_id uuid, version integer)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_employee public.users%rowtype;
  v_policy   jsonb := app.payroll_policy();
  v_latest   public.salary_history%rowtype;
  v_eligible boolean;
  v_reason   text;
  v_effective date;
  v_version  integer;
  v_id       uuid;
  v_action   text;
begin
  perform app.require_permission('salary.manage');
  perform app.require_not_own(p_staff, 'You cannot set your own salary.');
  perform app.require_amount(p_basic_ugx, 'basic salary', 0, app.max_salary_ugx());
  if p_frequency not in ('monthly', 'weekly') then
    raise exception 'Choose monthly or weekly.'
      using errcode = 'invalid_parameter_value', detail = 'frequency';
  end if;
  if p_allowance_amount_ugx is not null then
    perform app.require_amount(p_allowance_amount_ugx, 'daily allowance', 0, 1000000);
  end if;
  -- A salary may be dated up to a year ahead.
  v_effective := app.require_business_date(p_effective_from, 'effective date', 366);

  v_employee := app.read_employee(p_staff, false);

  -- Aliased: `staff_uid` and `version` are also OUT parameters of this
  -- function, and an unqualified reference would be ambiguous.
  select * into v_latest from public.salary_history h
   where h.staff_uid = p_staff order by h.effective_from desc, h.version desc limit 1;

  v_reason := case when v_latest.id is null then app.optional_text(p_reason, 'Reason', 300)
                   else app.require_reason(p_reason) end;
  v_eligible := coalesce(p_allowance_eligible, v_latest.allowance_eligible,
    (v_policy -> 'allowanceEligibleRoles') @> to_jsonb(v_employee.role));

  -- A version cannot take effect before the latest one.
  if v_latest.id is not null and v_effective < v_latest.effective_from then
    raise exception 'A later salary version already takes effect on %. Changes cannot be backdated before it.',
      v_latest.effective_from
      using errcode = 'raise_exception', detail = 'backdated';
  end if;
  if v_latest.id is not null
     and v_latest.basic_salary_ugx = p_basic_ugx
     and v_latest.payment_frequency = p_frequency
     and v_latest.allowance_eligible = v_eligible
     and v_latest.allowance_amount_ugx is not distinct from p_allowance_amount_ugx
     and v_latest.active = p_active
     and v_latest.effective_from = v_effective then
    raise exception 'Nothing has changed.' using errcode = 'raise_exception', detail = 'no_changes';
  end if;

  v_version := coalesce(v_latest.version, 0) + 1;

  insert into public.salary_history
    (staff_uid, staff_id, staff_name, staff_role, version, basic_salary_ugx, payment_frequency,
     allowance_eligible, allowance_amount_ugx, active, effective_from, notes, reason,
     previous_value, previous_id, created_by, created_by_name)
  values
    (p_staff, v_employee.staff_id, v_employee.full_name, v_employee.role, v_version, p_basic_ugx,
     p_frequency, v_eligible, p_allowance_amount_ugx, p_active, v_effective,
     app.optional_text(p_notes, 'Notes', 500), v_reason,
     case when v_latest.id is null then null else jsonb_build_object(
       'basicSalaryUgx', v_latest.basic_salary_ugx, 'paymentFrequency', v_latest.payment_frequency,
       'allowanceEligible', v_latest.allowance_eligible,
       'allowanceAmountUgx', v_latest.allowance_amount_ugx, 'active', v_latest.active) end,
     v_latest.id, auth.uid(), (select full_name from public.users where id = auth.uid()))
  returning id into v_id;

  insert into public.salary_profiles
    (staff_uid, staff_id, staff_name, staff_role, basic_salary_ugx, payment_frequency,
     allowance_eligible, allowance_amount_ugx, active, effective_from, current_history_id,
     version, notes, updated_by, updated_by_name)
  values
    (p_staff, v_employee.staff_id, v_employee.full_name, v_employee.role, p_basic_ugx, p_frequency,
     v_eligible, p_allowance_amount_ugx, p_active, v_effective, v_id, v_version,
     app.optional_text(p_notes, 'Notes', 500), auth.uid(),
     (select full_name from public.users where id = auth.uid()))
  -- By constraint name: `staff_uid` is also an OUT parameter of this
  -- function, so a bare column name in the conflict target is ambiguous.
  on conflict on constraint salary_profiles_pkey do update set
    basic_salary_ugx = excluded.basic_salary_ugx,
    payment_frequency = excluded.payment_frequency,
    allowance_eligible = excluded.allowance_eligible,
    allowance_amount_ugx = excluded.allowance_amount_ugx,
    active = excluded.active,
    effective_from = excluded.effective_from,
    current_history_id = excluded.current_history_id,
    version = excluded.version,
    notes = excluded.notes,
    updated_by = excluded.updated_by,
    updated_by_name = excluded.updated_by_name,
    updated_at = now();

  v_action := case
    when v_latest.id is null then 'salary.created'
    when v_latest.active and not p_active then 'salary.deactivated'
    when not v_latest.active and p_active then 'salary.activated'
    else 'salary.changed' end;

  perform app.audit(v_action, 'payroll', p_staff::text, p_staff, v_employee.full_name, v_reason,
    case when v_latest.id is null then null
         else jsonb_build_object('basicSalaryUgx', v_latest.basic_salary_ugx,
                                 'active', v_latest.active) end,
    jsonb_build_object('basicSalaryUgx', p_basic_ugx, 'effectiveFrom', v_effective,
                       'version', v_version, 'active', p_active));

  return query select p_staff, v_id, v_version;
end;
$$;

-- ---------------------------------------------------------------------------
-- Periods
-- ---------------------------------------------------------------------------

/* The period a payroll covers. Ports periodFor(). */
create or replace function app.payroll_period(
  p_frequency text, p_year integer default null, p_month integer default null,
  p_week_start date default null)
returns table (frequency text, period_key text, period_label text,
               period_start date, period_end date, period_last_day date)
language plpgsql
stable
as $$
declare
  v_start date;
  v_end   date;
begin
  if p_frequency not in ('monthly', 'weekly') then
    raise exception 'Choose monthly or weekly.'
      using errcode = 'invalid_parameter_value', detail = 'frequency';
  end if;

  if p_frequency = 'monthly' then
    if p_year is null or p_month is null or p_year not between 2020 and 2100
       or p_month not between 1 and 12 then
      raise exception 'Choose a valid month.'
        using errcode = 'invalid_parameter_value', detail = 'period';
    end if;
    v_start := make_date(p_year, p_month, 1);
    v_end   := (v_start + interval '1 month')::date;
    return query select 'monthly', to_char(v_start, 'YYYY-MM'),
      to_char(v_start, 'FMMonth YYYY'), v_start, v_end, v_end - 1;
  else
    if p_week_start is null then
      raise exception 'Choose the week.'
        using errcode = 'invalid_parameter_value', detail = 'period';
    end if;
    if app.iso_weekday(p_week_start) <> 1 then
      raise exception 'A weekly payroll starts on a Monday.'
        using errcode = 'invalid_parameter_value', detail = 'period';
    end if;
    v_start := p_week_start;
    v_end   := p_week_start + 7;
    return query select 'weekly', 'W' || v_start::text, 'Week of ' || v_start::text,
      v_start, v_end, v_end - 1;
  end if;
end;
$$;

create or replace function app.create_payroll(
  p_frequency text default 'monthly',
  p_year      integer default null,
  p_month     integer default null,
  p_week_start date default null,
  p_notes     text default null
)
returns table (payroll_id uuid, payroll_number text, period_key text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_p      record;
  v_number text;
  v_id     uuid;
begin
  perform app.require_permission('payroll.prepare', 'payroll.process');
  select * into v_p from app.payroll_period(p_frequency, p_year, p_month, p_week_start);

  if v_p.period_start > app.eat_day() then
    raise exception 'A payroll period cannot start in the future.'
      using errcode = 'invalid_parameter_value', detail = 'period';
  end if;

  v_number := app.next_reference('payroll_number_seq', 'RMX-PAY-');
  begin
    insert into public.payroll
      (payroll_number, frequency, period_key, period_label, period_start, period_end,
       period_last_day, notes, created_by, created_by_name, updated_by)
    values
      (v_number, v_p.frequency, v_p.period_key, v_p.period_label, v_p.period_start,
       v_p.period_end, v_p.period_last_day, app.optional_text(p_notes, 'Notes', 500),
       auth.uid(), (select full_name from public.users where id = auth.uid()), auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'There is already a % payroll for %.', v_p.frequency, v_p.period_label
      using errcode = 'unique_violation', detail = 'duplicate_payroll';
  end;

  perform app.audit('payroll.created', 'payroll', v_id::text, null, v_number, null, null,
    jsonb_build_object('payrollNumber', v_number, 'frequency', v_p.frequency,
                       'periodKey', v_p.period_key));

  return query select v_id, v_number, v_p.period_key;
end;
$$;

-- ---------------------------------------------------------------------------
-- Calculation
-- ---------------------------------------------------------------------------

/*
 * Recalculates a payroll: a NEW version of the items, the old ones kept and
 * superseded. Everything here is the server's arithmetic — the browser sends
 * no salary, no gross, no deduction and no net.
 */
create or replace function app.calculate_payroll(p_payroll uuid, p_status text default 'prepared')
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_pay     public.payroll%rowtype;
  v_policy  jsonb := app.payroll_policy();
  v_cap_pct integer;
  v_version integer;
  v_staff   record;
  v_v       public.salary_history%rowtype;
  v_basic   bigint;
  v_allow   bigint;
  v_days    integer;
  v_earn    bigint;
  v_gross   bigint;
  v_cap     bigint;
  v_left    bigint;
  v_capped  boolean;
  v_lines   jsonb;
  v_bucket_salary bigint;
  v_bucket_loss   bigint;
  v_bucket_other  bigint;
  v_d       record;
  v_planned bigint;
  v_take    bigint;
  v_total_deductions bigint;
  v_index   integer := 0;
  v_ids     uuid[];
  v_earnings jsonb;
begin
  select * into v_pay from public.payroll where id = p_payroll;
  v_cap_pct := (v_policy ->> 'maxDeductionPercentOfGross')::integer;
  v_version := v_pay.version + 1;

  -- The previous calculation is kept, marked superseded.
  update public.payroll_items
     set current = false, status = 'superseded'
   where payroll_id = p_payroll and current;

  for v_staff in
    -- Everyone with a salary version in force at period end on this
    -- frequency, plus anyone with an approved allowance in the period.
    select distinct s.staff_uid from (
      select h.staff_uid from public.salary_history h where h.effective_from <= v_pay.period_last_day
      union
      select a.staff_uid from public.worker_allowances a
       where a.status = 'approved' and a.business_day >= v_pay.period_start
         and a.business_day < v_pay.period_end
    ) s
  loop
    v_v := app.salary_version_on(v_staff.staff_uid, v_pay.period_last_day);
    if v_v.id is null or v_v.payment_frequency <> v_pay.frequency then
      continue;
    end if;

    -- An inactive version stops the basic salary; allowances still stand.
    v_basic := case when v_v.active then v_v.basic_salary_ugx else 0 end;

    select coalesce(sum(a.approved_amount_ugx), 0), count(*), coalesce(array_agg(a.id), '{}')
      into v_allow, v_days, v_ids
      from public.worker_allowances a
     where a.staff_uid = v_staff.staff_uid and a.status = 'approved'
       and coalesce(a.approved_amount_ugx, 0) > 0
       and a.business_day >= v_pay.period_start and a.business_day < v_pay.period_end;

    select coalesce(sum(e.amount_ugx), 0),
           coalesce(jsonb_agg(jsonb_build_object('entryId', e.id, 'description', e.description,
                                                 'amountUgx', e.amount_ugx, 'reason', e.reason)), '[]'::jsonb)
      into v_earn, v_earnings
      from public.payroll_earnings e
     where e.payroll_id = p_payroll and e.staff_uid = v_staff.staff_uid and e.removed_at is null;

    if v_basic = 0 and v_days = 0 and v_earn = 0 then
      continue;
    end if;

    v_gross := v_basic + v_allow + v_earn;
    v_cap   := (v_gross * v_cap_pct) / 100;
    v_left  := v_cap;
    v_capped := false;
    v_lines := '[]'::jsonb;
    v_bucket_salary := 0;
    v_bucket_loss := 0;
    v_bucket_other := 0;

    for v_d in
      select d.*, i.outstanding_ugx as incident_outstanding, i.status as incident_status,
             i.staff_uid as incident_staff
        from public.salary_deductions d
        left join public.loss_incidents i on i.id = d.loss_incident_id
       where d.staff_uid = v_staff.staff_uid and d.status = 'active' and d.remaining_ugx > 0
         and d.starts_from <= v_pay.period_last_day
         and not exists (select 1 from public.deduction_applications ap
                          where ap.deduction_id = d.id and ap.payroll_id = p_payroll and not ap.reversed)
       order by d.created_at, d.deduction_number
    loop
      -- A loss recovery only while its incident is live, belongs to this
      -- person and still has something outstanding.
      if v_d.loss_incident_id is not null and (
           v_d.incident_status is null or v_d.incident_status = 'cancelled'
           or v_d.incident_staff <> v_staff.staff_uid
           or coalesce(v_d.incident_outstanding, 0) <= 0) then
        continue;
      end if;

      -- Never more than the instalment, what remains, or what the incident
      -- still has outstanding.
      v_planned := least(v_d.instalment_ugx,
        case when v_d.loss_incident_id is null then v_d.remaining_ugx
             else least(v_d.remaining_ugx, v_d.incident_outstanding) end);
      v_take := greatest(0, least(v_planned, v_left));
      if v_take < v_planned then v_capped := true; end if;
      v_left := v_left - v_take;

      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'deductionId', v_d.id, 'deductionNumber', v_d.deduction_number, 'type', v_d.type,
        'reason', v_d.reason, 'lossIncidentId', v_d.loss_incident_id, 'lossNumber', v_d.loss_number,
        'plannedUgx', v_planned, 'amountUgx', v_take));

      if v_d.type = 'authorized_deduction' then v_bucket_salary := v_bucket_salary + v_take;
      elsif v_d.type = 'loss_recovery'     then v_bucket_loss   := v_bucket_loss + v_take;
      else                                      v_bucket_other  := v_bucket_other + v_take;
      end if;
    end loop;

    v_total_deductions := v_bucket_salary + v_bucket_loss + v_bucket_other;
    v_index := v_index + 1;

    insert into public.payroll_items
      (item_number, payroll_id, payroll_number, payroll_version, frequency, period_key,
       period_label, period_start, period_end, staff_uid, staff_id, staff_name, staff_role,
       salary_history_id, salary_version, salary_active,
       basic_salary_ugx, allowances_ugx, allowance_days, other_earnings_ugx, gross_ugx,
       salary_deductions_ugx, loss_recoveries_ugx, other_deductions_ugx, total_deductions_ugx,
       deduction_capped, net_ugx, deduction_lines, allowance_ids, other_earnings,
       status, current, created_by)
    values
      (format('%s-%s', v_pay.payroll_number, lpad(v_index::text, 3, '0')),
       p_payroll, v_pay.payroll_number, v_version, v_pay.frequency, v_pay.period_key,
       v_pay.period_label, v_pay.period_start, v_pay.period_end,
       v_staff.staff_uid, v_v.staff_id, v_v.staff_name, v_v.staff_role,
       v_v.id, v_v.version, v_v.active,
       v_basic, v_allow, v_days, v_earn, v_gross,
       v_bucket_salary, v_bucket_loss, v_bucket_other, v_total_deductions,
       v_capped, v_gross - v_total_deductions, v_lines, v_ids, v_earnings,
       coalesce(p_status, 'prepared'), true, auth.uid());
  end loop;

  -- The payroll's totals are the sum of its items, computed here.
  update public.payroll p
     set version = v_version,
         employee_count = t.n,
         total_basic_ugx = t.basic, total_allowances_ugx = t.allow,
         total_other_earnings_ugx = t.earn, total_gross_ugx = t.gross,
         total_salary_deductions_ugx = t.sal, total_loss_recoveries_ugx = t.loss,
         total_other_deductions_ugx = t.other, total_deductions_ugx = t.ded,
         total_net_ugx = t.net
    from (select count(*)::integer as n,
                 coalesce(sum(basic_salary_ugx), 0) as basic,
                 coalesce(sum(allowances_ugx), 0) as allow,
                 coalesce(sum(other_earnings_ugx), 0) as earn,
                 coalesce(sum(gross_ugx), 0) as gross,
                 coalesce(sum(salary_deductions_ugx), 0) as sal,
                 coalesce(sum(loss_recoveries_ugx), 0) as loss,
                 coalesce(sum(other_deductions_ugx), 0) as other,
                 coalesce(sum(total_deductions_ugx), 0) as ded,
                 coalesce(sum(net_ugx), 0) as net
            from public.payroll_items where payroll_id = p_payroll and current) t
   where p.id = p_payroll;
end;
$$;

create or replace function app.prepare_payroll(p_payroll uuid, p_reason text default null)
returns table (payroll_id uuid, version integer, employee_count integer, total_net_ugx bigint)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_pay public.payroll%rowtype;
begin
  perform app.require_permission('payroll.prepare', 'payroll.process');

  select * into v_pay from public.payroll where id = p_payroll for update;
  if v_pay.id is null then
    raise exception 'That payroll could not be found.'
      using errcode = 'no_data_found', detail = 'payroll';
  end if;
  if v_pay.status not in ('draft', 'prepared') then
    raise exception '%', case when v_pay.status = 'cancelled' then 'This payroll is cancelled.'
      else 'This payroll is past preparation. Use a correction instead.' end
      using errcode = 'raise_exception', detail = 'invalid_status';
  end if;

  perform app.calculate_payroll(p_payroll);

  update public.payroll
     set status = 'prepared', prepared_by = auth.uid(),
         prepared_by_name = (select full_name from public.users where id = auth.uid()),
         prepared_at = now(),
         submitted_by = null, submitted_at = null,
         reviewed_by = null, reviewed_by_name = null, reviewed_at = null, review_notes = null,
         approved_by = null, approved_by_name = null, approved_at = null,
         updated_by = auth.uid()
   where id = p_payroll;

  select * into v_pay from public.payroll where id = p_payroll;

  perform app.audit('payroll.prepared', 'payroll', p_payroll::text, null, v_pay.payroll_number,
    app.optional_text(p_reason, 'Reason', 300),
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'prepared', 'version', v_pay.version,
                       'employeeCount', v_pay.employee_count,
                       'totalGrossUgx', v_pay.total_gross_ugx,
                       'totalNetUgx', v_pay.total_net_ugx));

  return query select v_pay.id, v_pay.version, v_pay.employee_count, v_pay.total_net_ugx;
end;
$$;

/* A correction BEFORE payment: recalculate, and go back through the workflow. */
create or replace function app.correct_payroll(p_payroll uuid, p_reason text)
returns table (payroll_id uuid, version integer, total_net_ugx bigint)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_pay    public.payroll%rowtype;
  v_reason text;
begin
  perform app.require_permission('payroll.adjust');
  v_reason := app.require_reason(p_reason);

  select * into v_pay from public.payroll where id = p_payroll for update;
  if v_pay.id is null then
    raise exception 'That payroll could not be found.'
      using errcode = 'no_data_found', detail = 'payroll';
  end if;
  if v_pay.status not in ('prepared', 'pending_review', 'approved') then
    raise exception '%', case when v_pay.status in ('paid', 'locked')
      then 'This payroll has been paid. Reverse the payment (or adjust the next payroll) instead.'
      else format('A %s payroll cannot be corrected.', v_pay.status) end
      using errcode = 'raise_exception', detail = 'invalid_status';
  end if;

  perform app.calculate_payroll(p_payroll);

  update public.payroll
     set status = 'prepared',
         submitted_by = null, submitted_at = null,
         reviewed_by = null, reviewed_by_name = null, reviewed_at = null, review_notes = null,
         approved_by = null, approved_by_name = null, approved_at = null,
         correction_count = correction_count + 1, last_correction_reason = v_reason,
         updated_by = auth.uid()
   where id = p_payroll;

  select * into v_pay from public.payroll where id = p_payroll;

  perform app.audit('payroll.corrected', 'payroll', p_payroll::text, null, v_pay.payroll_number,
    v_reason, jsonb_build_object('status', 'approved'),
    jsonb_build_object('status', 'prepared', 'version', v_pay.version,
                       'totalNetUgx', v_pay.total_net_ugx));

  return query select v_pay.id, v_pay.version, v_pay.total_net_ugx;
end;
$$;

/* Other authorised earnings on one person's pay, while the payroll is prepared. */
create or replace function app.add_payroll_earning(
  p_payroll uuid, p_staff uuid, p_description text, p_amount bigint, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_pay    public.payroll%rowtype;
  v_reason text;
  v_id     uuid;
begin
  perform app.require_permission('payroll.adjust');
  v_reason := app.require_reason(p_reason);
  perform app.require_amount(p_amount, 'amount', 1, app.max_salary_ugx());
  perform app.require_not_own(p_staff, 'You cannot add earnings to your own pay.');

  select * into v_pay from public.payroll where id = p_payroll for update;
  if v_pay.status <> 'prepared' then
    raise exception 'Earnings can be added while the payroll is prepared (before review).'
      using errcode = 'raise_exception', detail = 'invalid_status';
  end if;
  if not exists (select 1 from public.payroll_items
                  where payroll_id = p_payroll and current and staff_uid = p_staff) then
    raise exception 'That staff member is not in this payroll.'
      using errcode = 'invalid_parameter_value', detail = 'not_in_payroll';
  end if;

  insert into public.payroll_earnings (payroll_id, staff_uid, description, amount_ugx, reason, added_by)
  values (p_payroll, p_staff, app.require_text(p_description, 'Description', 120), p_amount,
          v_reason, auth.uid())
  returning id into v_id;

  perform app.calculate_payroll(p_payroll);

  perform app.audit('payroll.earning_added', 'payroll', p_payroll::text, p_staff,
    v_pay.payroll_number, v_reason, null,
    jsonb_build_object('staffUid', p_staff, 'description', p_description, 'amountUgx', p_amount));
  return v_id;
end;
$$;

create or replace function app.remove_payroll_earning(p_earning uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_entry public.payroll_earnings%rowtype;
  v_pay   public.payroll%rowtype;
  v_reason text;
begin
  perform app.require_permission('payroll.adjust');
  v_reason := app.require_reason(p_reason);

  select * into v_entry from public.payroll_earnings where id = p_earning for update;
  if v_entry.id is null or v_entry.removed_at is not null then
    raise exception 'That earning could not be found.'
      using errcode = 'no_data_found', detail = 'earning';
  end if;
  select * into v_pay from public.payroll where id = v_entry.payroll_id for update;
  if v_pay.status <> 'prepared' then
    raise exception 'Earnings can be removed while the payroll is prepared (before review).'
      using errcode = 'raise_exception', detail = 'invalid_status';
  end if;

  update public.payroll_earnings
     set removed_at = now(), removed_by = auth.uid(), remove_reason = v_reason
   where id = p_earning;

  perform app.calculate_payroll(v_entry.payroll_id);

  perform app.audit('payroll.earning_removed', 'payroll', v_entry.payroll_id::text,
    v_entry.staff_uid, v_pay.payroll_number, v_reason,
    jsonb_build_object('description', v_entry.description, 'amountUgx', v_entry.amount_ugx), null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Review and approval
-- ---------------------------------------------------------------------------

/*
 * submit · review · return · approve.
 *
 * Review must happen before approval. Nobody reviews or approves a payroll
 * that includes their own pay unless they are an Administrator, and while the
 * policy requires it, ONLY an Administrator may approve.
 */
create or replace function app.update_payroll_status(
  p_payroll uuid, p_action text, p_reason text default null, p_notes text default null)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_pay    public.payroll%rowtype;
  v_reason text;
  v_notes  text;
  v_status text;
  v_policy jsonb;
  v_mine   boolean;
  v_role   text := app.current_role_id();
begin
  if p_action not in ('submit', 'review', 'return', 'approve') then
    raise exception 'Choose a valid action.'
      using errcode = 'invalid_parameter_value', detail = 'action';
  end if;
  case p_action
    when 'submit'  then perform app.require_permission('payroll.prepare', 'payroll.process');
    when 'review'  then perform app.require_permission('payroll.review');
    when 'return'  then perform app.require_permission('payroll.review', 'payroll.approve');
    when 'approve' then perform app.require_permission('payroll.approve');
  end case;
  v_reason := case when p_action = 'return' then app.require_reason(p_reason)
                   else app.optional_text(p_reason, 'Reason', 300) end;
  v_notes  := app.optional_text(p_notes, 'Notes', 500);

  select * into v_pay from public.payroll where id = p_payroll for update;
  if v_pay.id is null then
    raise exception 'That payroll could not be found.'
      using errcode = 'no_data_found', detail = 'payroll';
  end if;

  v_mine := exists (select 1 from public.payroll_items
                     where payroll_id = p_payroll and current and staff_uid = auth.uid());

  if p_action = 'submit' then
    if v_pay.status <> 'prepared' then
      raise exception 'Only a prepared payroll can be submitted for review.'
        using errcode = 'raise_exception', detail = 'invalid_status';
    end if;
    if v_pay.employee_count = 0 then
      raise exception 'This payroll has nobody to pay.'
        using errcode = 'raise_exception', detail = 'empty_payroll';
    end if;
    v_status := 'pending_review';
    update public.payroll set status = v_status, submitted_by = auth.uid(), submitted_at = now(),
           returned_reason = null, updated_by = auth.uid() where id = p_payroll;
    insert into public.workforce_events (type, reference_type, reference_id, audience, payload)
    values ('payroll_review', 'payroll', p_payroll, 'payroll.review',
            jsonb_build_object('payrollNumber', v_pay.payroll_number));

  elsif p_action = 'review' then
    if v_pay.status <> 'pending_review' then
      raise exception 'Only a payroll waiting for review can be reviewed.'
        using errcode = 'raise_exception', detail = 'invalid_status';
    end if;
    if v_pay.reviewed_at is not null then
      raise exception 'This payroll has already been reviewed.'
        using errcode = 'raise_exception', detail = 'already_reviewed';
    end if;
    if v_mine and v_role <> 'admin' then
      raise exception 'You cannot review a payroll that includes your own pay.'
        using errcode = 'insufficient_privilege', detail = 'self_action';
    end if;
    v_status := v_pay.status;
    update public.payroll set reviewed_by = auth.uid(),
           reviewed_by_name = (select full_name from public.users where id = auth.uid()),
           reviewed_at = now(), review_notes = v_notes, updated_by = auth.uid()
     where id = p_payroll;
    insert into public.workforce_events (type, reference_type, reference_id, audience, payload)
    values ('payroll_review', 'payroll', p_payroll, 'payroll.approve',
            jsonb_build_object('payrollNumber', v_pay.payroll_number));

  elsif p_action = 'return' then
    if v_pay.status <> 'pending_review' then
      raise exception 'Only a payroll waiting for review can be returned.'
        using errcode = 'raise_exception', detail = 'invalid_status';
    end if;
    v_status := 'prepared';
    update public.payroll set status = v_status, returned_reason = v_reason,
           reviewed_by = null, reviewed_by_name = null, reviewed_at = null, review_notes = null,
           updated_by = auth.uid() where id = p_payroll;

  else
    if v_pay.status = 'approved' then
      raise exception 'This payroll is already approved.'
        using errcode = 'raise_exception', detail = 'already_approved';
    end if;
    if v_pay.status <> 'pending_review' then
      raise exception 'Only a payroll waiting for approval can be approved.'
        using errcode = 'raise_exception', detail = 'invalid_status';
    end if;
    if v_pay.reviewed_at is null then
      raise exception 'Review the payroll before approving it.'
        using errcode = 'raise_exception', detail = 'not_reviewed';
    end if;
    v_policy := app.payroll_policy();
    if (v_policy ->> 'payrollRequiresAdminApproval')::boolean and v_role <> 'admin' then
      raise exception 'Payroll must be approved by an Administrator.'
        using errcode = 'insufficient_privilege', detail = 'admin_approval_required';
    end if;
    if v_mine and v_role <> 'admin' then
      raise exception 'You cannot approve a payroll that includes your own pay.'
        using errcode = 'insufficient_privilege', detail = 'self_action';
    end if;
    v_status := 'approved';
    update public.payroll set status = v_status, approved_by = auth.uid(),
           approved_by_name = (select full_name from public.users where id = auth.uid()),
           approved_at = now(), updated_by = auth.uid() where id = p_payroll;
    insert into public.workforce_events (type, reference_type, reference_id, audience, payload)
    values ('payroll_approved', 'payroll', p_payroll, 'payroll.pay',
            jsonb_build_object('payrollNumber', v_pay.payroll_number));
  end if;

  if v_status <> v_pay.status then
    update public.payroll_items set status = v_status where payroll_id = p_payroll and current;
  end if;

  perform app.audit('payroll.' || case p_action when 'submit' then 'submitted'
                                                when 'review' then 'reviewed'
                                                when 'return' then 'returned'
                                                else 'approved' end,
    'payroll', p_payroll::text, null, v_pay.payroll_number, coalesce(v_reason, v_notes),
    jsonb_build_object('status', v_pay.status),
    jsonb_build_object('status', v_status, 'totalNetUgx', v_pay.total_net_ugx));

  return v_status;
end;
$$;
