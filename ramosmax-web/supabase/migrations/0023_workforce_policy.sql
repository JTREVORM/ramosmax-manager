-- ===========================================================================
-- RamosMAX Web — Phase F — 0023: the payroll policy and the EAT day
-- ===========================================================================
-- Ports `functions/src/workforce.js`. DEFAULT_POLICY is the only place the
-- daily allowance, the reporting time and the grace period appear, exactly as
-- it is the only place in the reference.
--
-- Every date decision in this phase is an EAST AFRICA TIME business day.
-- Africa/Kampala is UTC+3 with no daylight saving, and the database decides
-- it — never the browser, and never the device clock.
-- ===========================================================================

/* The EAT day-start instant of a business day: 00:00 in Kampala. */
create or replace function app.eat_day_start(p_day date)
returns timestamptz
language sql
immutable
as $$
  select (p_day::timestamp) at time zone 'Africa/Kampala';
$$;

/* A wall-clock time on an EAT business day, as an instant. */
create or replace function app.eat_at(p_day date, p_time time)
returns timestamptz
language sql
immutable
as $$
  select ((p_day::timestamp) + p_time) at time zone 'Africa/Kampala';
$$;

/* ISO weekday of an EAT business day: Monday = 1 … Sunday = 7. */
create or replace function app.iso_weekday(p_day date)
returns integer
language sql
immutable
as $$
  select extract(isodow from p_day)::integer;
$$;

comment on function app.eat_day_start(date) is
  'Midnight in Kampala. Used wherever the reference implementation used dayStart().';

-- ---------------------------------------------------------------------------
-- The policy
-- ---------------------------------------------------------------------------

create or replace function app.policy_int(
  p_value jsonb, p_key text, p_default bigint, p_min bigint, p_max bigint)
returns bigint
language sql
immutable
as $$
  select case
    when jsonb_typeof(p_value -> p_key) = 'number'
     and (p_value ->> p_key) ~ '^-?\d+$'
     and (p_value ->> p_key)::bigint between p_min and p_max
    then (p_value ->> p_key)::bigint
    else p_default end;
$$;

create or replace function app.policy_bool(p_value jsonb, p_key text, p_default boolean)
returns boolean
language sql
immutable
as $$
  select case when jsonb_typeof(p_value -> p_key) = 'boolean'
              then (p_value ->> p_key)::boolean else p_default end;
$$;

/*
 * DEFAULT_POLICY, merged with `settings/payroll_policy` field by field, as
 * policyFrom() does: a stored value is used only when it is present and of
 * the right shape, so a damaged setting can never disable a rule.
 */
create or replace function app.payroll_policy()
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  with stored as (
    select coalesce((select value from public.settings where key = 'payroll_policy'), '{}'::jsonb) as v
  )
  select jsonb_build_object(
    'reportingTime', case when (select v ->> 'reportingTime' from stored) ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                          then (select v ->> 'reportingTime' from stored) else '08:00' end,
    'workingDays', case when jsonb_typeof((select v -> 'workingDays' from stored)) = 'array'
                          and jsonb_array_length((select v -> 'workingDays' from stored)) > 0
                        then (select v -> 'workingDays' from stored)
                        else '[1,2,3,4,5,6]'::jsonb end,
    'gracePeriodMinutes',    app.policy_int(stored.v, 'gracePeriodMinutes', 15, 0, 240),
    'lateThresholdMinutes',  app.policy_int(stored.v, 'lateThresholdMinutes', 120, 1, 720),
    'requireClockOut',           app.policy_bool(stored.v, 'requireClockOut', false),
    'allowanceOnNonWorkingDays', app.policy_bool(stored.v, 'allowanceOnNonWorkingDays', false),
    'defaultDailyAllowanceUgx',  app.policy_int(stored.v, 'defaultDailyAllowanceUgx', 5000, 0, 1000000),
    'allowanceEligibleRoles', case when jsonb_typeof((select v -> 'allowanceEligibleRoles' from stored)) = 'array'
                                   then (select v -> 'allowanceEligibleRoles' from stored)
                                   else '["cashier","manager","worker"]'::jsonb end,
    'lateAllowancePolicy', case when (select v ->> 'lateAllowancePolicy' from stored) in ('full', 'deduct', 'reject')
                                then (select v ->> 'lateAllowancePolicy' from stored) else 'deduct' end,
    'lateDeductionUgx',    app.policy_int(stored.v, 'lateDeductionUgx', 2500, 0, 1000000),
    'maxLateDeductionUgx', app.policy_int(stored.v, 'maxLateDeductionUgx', 5000, 0, 1000000),
    'allowanceApprovalRequired',   app.policy_bool(stored.v, 'allowanceApprovalRequired', true),
    'maxDeductionPercentOfGross',  app.policy_int(stored.v, 'maxDeductionPercentOfGross', 100, 0, 100),
    'payrollRequiresAdminApproval', app.policy_bool(stored.v, 'payrollRequiresAdminApproval', true)
  ) from stored;
$$;

comment on function app.payroll_policy() is
  'DEFAULT_POLICY from workforce.js, with valid stored overrides. The daily allowance (UGX 5,000), reporting time (08:00) and grace period (15 minutes) appear here and nowhere else.';

/* Changing the policy: Admin only, with a reason, and every change audited. */
create or replace function app.update_payroll_policy(p_changes jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before jsonb := app.payroll_policy();
  v_after  jsonb;
  v_reason text;
  v_key    text;
  v_changed text[] := '{}';
begin
  perform app.require_permission('settings.manage');
  v_reason := app.require_reason(p_reason);

  if jsonb_typeof(p_changes) <> 'object' then
    raise exception 'One of the settings is not recognised.'
      using errcode = 'invalid_parameter_value', detail = 'policy';
  end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if not (v_before ? v_key) then
      raise exception 'One of the settings is not recognised.'
        using errcode = 'invalid_parameter_value', detail = 'policy';
    end if;
  end loop;

  insert into public.settings (key, value) values ('payroll_policy', v_before || p_changes)
  on conflict (key) do update set value = excluded.value;

  -- Re-read through the validator: an unusable value falls back rather than
  -- being stored as law.
  v_after := app.payroll_policy();
  if v_after = v_before then
    raise exception 'Nothing has changed.' using errcode = 'raise_exception', detail = 'no_changes';
  end if;

  -- The late threshold must stay longer than the grace period.
  if (v_after ->> 'lateThresholdMinutes')::bigint <= (v_after ->> 'gracePeriodMinutes')::bigint then
    raise exception 'The late threshold must be longer than the grace period.'
      using errcode = 'invalid_parameter_value', detail = 'policy';
  end if;
  if (v_after ->> 'lateDeductionUgx')::bigint > (v_after ->> 'maxLateDeductionUgx')::bigint then
    raise exception 'The late deduction cannot exceed the maximum deduction.'
      using errcode = 'invalid_parameter_value', detail = 'policy';
  end if;

  select array_agg(k) into v_changed
    from jsonb_object_keys(v_after) k
   where v_after -> k is distinct from v_before -> k;

  perform app.audit('payroll_policy.updated', 'payroll', 'payroll_policy', null,
    'Payroll policy', v_reason, v_before, v_after);

  return jsonb_build_object('changed', to_jsonb(v_changed));
end;
$$;

-- ---------------------------------------------------------------------------
-- Lateness
-- ---------------------------------------------------------------------------

/*
 * Arrival facts for a clock-in, judged against a POLICY SNAPSHOT — the
 * reporting time and grace period as they were when the record was made, not
 * as they are now. Ports lateness() exactly:
 *
 *   minutesLate = whole minutes after the reporting time, never below zero
 *   late        = minutesLate > gracePeriodMinutes
 *   severe      = late and minutesLate > lateThresholdMinutes
 */
create or replace function app.lateness(
  p_day        date,
  p_clock_in   timestamptz,
  p_reporting  time,
  p_grace      integer,
  p_threshold  integer
)
returns table (minutes_late integer, late boolean, severely_late boolean, expected_at timestamptz)
language sql
immutable
as $$
  select m, m > p_grace, m > p_grace and m > p_threshold, e
    from (select greatest(0, floor(extract(epoch from
                   (p_clock_in - app.eat_at(p_day, p_reporting))) / 60)::integer) as m,
                 app.eat_at(p_day, p_reporting) as e) q;
$$;

comment on function app.lateness(date, timestamptz, time, integer, integer) is
  'Whole minutes after the reporting time. 08:15 with a 15-minute grace is the last on-time minute; 08:16 is late.';

-- ---------------------------------------------------------------------------
-- Salary versions
-- ---------------------------------------------------------------------------

/*
 * The salary version in force for a person on a day: the newest whose
 * effective date is on or before it, breaking ties by version number. A
 * version added later, effective later, cannot change what an earlier payroll
 * used.
 */
create or replace function app.salary_version_on(p_staff uuid, p_day date)
returns public.salary_history
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select h.* from public.salary_history h
   where h.staff_uid = p_staff and h.effective_from <= p_day
   order by h.effective_from desc, h.version desc
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Shared guards
-- ---------------------------------------------------------------------------

/* Nobody acts on their own attendance, allowance, salary, pay or incident. */
create or replace function app.require_not_own(p_staff uuid, p_message text)
returns void
language plpgsql
stable
as $$
begin
  if p_staff is not null and p_staff = auth.uid() then
    raise exception '%', p_message using errcode = 'insufficient_privilege', detail = 'self_action';
  end if;
end;
$$;

/* The employee behind a uid, as the workforce records name them. */
create or replace function app.read_employee(p_staff uuid, p_require_active boolean default true)
returns public.users
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v public.users%rowtype;
begin
  select * into v from public.users where id = p_staff;
  if v.id is null then
    raise exception 'That staff member could not be found.'
      using errcode = 'no_data_found', detail = 'staff_not_found';
  end if;
  if p_require_active and not v.active then
    raise exception '%''s account is not active.', coalesce(v.full_name, 'This staff member')
      using errcode = 'raise_exception', detail = 'staff_inactive';
  end if;
  return v;
end;
$$;
