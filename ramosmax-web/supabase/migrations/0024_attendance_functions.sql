-- ===========================================================================
-- RamosMAX Web — Phase F — 0024: attendance
-- ===========================================================================
-- Ports `functions/src/attendance.js`.
--
--   recorded (pending_verification) ──approve──► present | late | absent | excused
--                  │
--                  └──reject (reason)──► rejected
--   any ──correct (attendance.correct, reason)──► pending_verification
--
-- The server's clock is the only clock. A staff member clocking in sends no
-- time at all; a manager entering someone else's day sends times that must lie
-- on that EAT day and cannot be in the future. Lateness is computed here from
-- the policy, and the policy is copied onto the record.
-- ===========================================================================

create or replace function app.max_backdate_days()
returns integer language sql immutable as $$ select 62; $$;

/*
 * Records attendance. With no p_staff it is the caller's own clock-in, which
 * uses the SERVER's time; with one it is a manager's entry for someone else.
 */
create or replace function app.record_attendance(
  p_staff    uuid default null,
  p_arrival  text default 'present',
  p_day      date default null,
  p_clock_in timestamptz default null,
  p_clock_out timestamptz default null,
  p_notes    text default null
)
returns table (attendance_id uuid, attendance_number text, arrival_status text,
               minutes_late integer, late boolean)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_self     boolean := p_staff is null or p_staff = auth.uid();
  v_staff    uuid    := coalesce(p_staff, auth.uid());
  v_employee public.users%rowtype;
  v_policy   jsonb   := app.payroll_policy();
  v_today    date    := app.eat_day();
  v_day      date;
  v_in       timestamptz;
  v_out      timestamptz;
  v_notes    text;
  v_facts    record;
  v_arrival  text;
  v_number   text;
  v_id       uuid;
  v_reporting time := (v_policy ->> 'reportingTime')::time;
  v_grace     integer := (v_policy ->> 'gracePeriodMinutes')::integer;
  v_threshold integer := (v_policy ->> 'lateThresholdMinutes')::integer;
begin
  -- Marking your own attendance is one permission; recording someone else's
  -- is another.
  if v_self then
    perform app.require_permission('attendance.mark', 'attendance.record');
  else
    perform app.require_permission('attendance.record');
  end if;

  if p_arrival not in ('present', 'absent', 'excused') then
    raise exception 'Choose present, absent or excused.'
      using errcode = 'invalid_parameter_value', detail = 'arrival';
  end if;
  if v_self and p_arrival <> 'present' then
    raise exception 'Ask a manager to record an absence.'
      using errcode = 'invalid_parameter_value', detail = 'arrival';
  end if;

  v_day := case when v_self then v_today else coalesce(p_day, v_today) end;
  if v_day > v_today then
    raise exception 'Attendance cannot be recorded for a future day.'
      using errcode = 'invalid_parameter_value', detail = 'date';
  end if;
  if v_day < v_today - app.max_backdate_days() then
    raise exception 'Attendance can be entered for the last % days only.', app.max_backdate_days()
      using errcode = 'invalid_parameter_value', detail = 'date';
  end if;

  if p_arrival = 'present' then
    -- Clocking in yourself uses the SERVER's clock, never the browser's.
    v_in := case when v_self then now() else p_clock_in end;
    if v_in is null then
      raise exception 'A present day needs a clock-in time.'
        using errcode = 'invalid_parameter_value', detail = 'time';
    end if;
    if v_in < app.eat_day_start(v_day) or v_in >= app.eat_day_start(v_day + 1) then
      raise exception 'The clock-in time must be on the attendance day.'
        using errcode = 'invalid_parameter_value', detail = 'time';
    end if;
    if v_in > now() then
      raise exception 'The clock-in time cannot be in the future.'
        using errcode = 'invalid_parameter_value', detail = 'time';
    end if;
    if not v_self and p_clock_out is not null then
      v_out := p_clock_out;
      if v_out <= v_in then
        raise exception 'The clock-out time must be after the clock-in time.'
          using errcode = 'invalid_parameter_value', detail = 'time';
      end if;
      if v_out > now() then
        raise exception 'The clock-out time cannot be in the future.'
          using errcode = 'invalid_parameter_value', detail = 'time';
      end if;
    end if;
  elsif p_clock_in is not null or p_clock_out is not null then
    raise exception 'An absence has no clock-in or clock-out time.'
      using errcode = 'invalid_parameter_value', detail = 'time';
  end if;

  v_notes := app.optional_text(p_notes, 'Notes', 500);
  if p_arrival = 'excused' and v_notes is null then
    raise exception 'Say why the absence is excused.'
      using errcode = 'invalid_parameter_value', detail = 'notes';
  end if;

  v_employee := app.read_employee(v_staff);

  select * into v_facts from app.lateness(v_day, v_in, v_reporting, v_grace, v_threshold)
   where v_in is not null;

  v_arrival := case when p_arrival <> 'present' then p_arrival
                    when coalesce(v_facts.late, false) then 'late' else 'on_time' end;
  v_number := app.next_reference('attendance_number_seq', 'RMX-ATT-');

  begin
    insert into public.attendance
      (attendance_number, staff_uid, staff_id, staff_name, staff_role, business_day, working_day,
       clock_in_at, clock_out_at, reporting_time, grace_period_minutes, late_threshold_minutes,
       expected_reporting_at, minutes_late, late, severely_late, arrival_status,
       source, recorded_via, notes, recorded_by, recorded_by_name, updated_by)
    values
      (v_number, v_staff, v_employee.staff_id, v_employee.full_name, v_employee.role, v_day,
       (v_policy -> 'workingDays') @> to_jsonb(app.iso_weekday(v_day)),
       v_in, v_out, v_reporting, v_grace, v_threshold,
       app.eat_at(v_day, v_reporting),
       coalesce(v_facts.minutes_late, 0), coalesce(v_facts.late, false),
       coalesce(v_facts.severely_late, false), v_arrival,
       'manual', case when v_self then 'self' else 'manager' end, v_notes,
       auth.uid(), (select full_name from public.users where id = auth.uid()), auth.uid())
    returning id into v_id;
  exception when unique_violation then
    -- The UNIQUE constraint, not a check: two phones cannot both win.
    raise exception '% already has attendance for %.', v_employee.full_name, v_day
      using errcode = 'unique_violation', detail = 'duplicate_attendance';
  end;

  -- A late self clock-in is put in front of a reviewer.
  if v_self and coalesce(v_facts.late, false) then
    insert into public.workforce_events (type, reference_type, reference_id, audience, payload)
    values ('attendance_review', 'attendance', v_id, 'attendance.approve',
            jsonb_build_object('attendanceNumber', v_number));
  end if;

  perform app.audit('attendance.recorded', 'attendance', v_id::text, v_staff, v_number, null, null,
    jsonb_build_object('attendanceNumber', v_number, 'staffUid', v_staff, 'day', v_day,
                       'arrivalStatus', v_arrival, 'minutesLate', coalesce(v_facts.minutes_late, 0),
                       'source', 'manual', 'via', case when v_self then 'self' else 'manager' end));

  return query select v_id, v_number, v_arrival, coalesce(v_facts.minutes_late, 0),
                      coalesce(v_facts.late, false);
end;
$$;

/* Clock-out: your own today (server time) or, with attendance.record, another's. */
create or replace function app.clock_out(
  p_attendance uuid default null,
  p_at         timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_self boolean := p_attendance is null;
  v_rec  public.attendance%rowtype;
  v_at   timestamptz;
begin
  if v_self then
    perform app.require_permission('attendance.mark', 'attendance.record');
    select * into v_rec from public.attendance
     where staff_uid = auth.uid() and business_day = app.eat_day() for update;
  else
    perform app.require_permission('attendance.record');
    select * into v_rec from public.attendance where id = p_attendance for update;
  end if;

  if v_rec.id is null then
    raise exception 'That attendance record could not be found.'
      using errcode = 'no_data_found', detail = 'attendance';
  end if;
  if v_self and v_rec.staff_uid <> auth.uid() then
    raise exception 'That attendance record is not yours.'
      using errcode = 'invalid_parameter_value', detail = 'not_own';
  end if;
  if v_rec.clock_in_at is null then
    raise exception 'There is no clock-in to clock out from.'
      using errcode = 'raise_exception', detail = 'no_clock_in';
  end if;
  if v_rec.clock_out_at is not null then
    raise exception 'Already clocked out.'
      using errcode = 'raise_exception', detail = 'already_clocked_out';
  end if;
  if v_rec.verification_status <> 'pending' then
    raise exception 'This record has been verified. Ask for a correction instead.'
      using errcode = 'raise_exception', detail = 'verified';
  end if;

  v_at := case when v_self then now() else p_at end;
  if v_at is null or v_at <= v_rec.clock_in_at then
    raise exception 'The clock-out time must be after the clock-in time.'
      using errcode = 'invalid_parameter_value', detail = 'time';
  end if;
  if v_at > now() then
    raise exception 'The clock-out time cannot be in the future.'
      using errcode = 'invalid_parameter_value', detail = 'time';
  end if;

  update public.attendance set clock_out_at = v_at, updated_by = auth.uid() where id = v_rec.id;

  perform app.audit('attendance.clocked_out', 'attendance', v_rec.id::text, v_rec.staff_uid,
    v_rec.attendance_number, null, null,
    jsonb_build_object('clockOutAt', v_at, 'via', case when v_self then 'self' else 'manager' end));

  return v_rec.id;
end;
$$;

/*
 * Verification. approve needs attendance.approve; reject needs
 * attendance.review or .approve and a reason. NOBODY VERIFIES THEIR OWN
 * ATTENDANCE.
 */
create or replace function app.verify_attendance(
  p_attendance uuid[],
  p_action     text,
  p_reason     text default null,
  p_notes      text default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_policy jsonb := app.payroll_policy();
  v_reason text;
  v_notes  text;
  v_rec    public.attendance%rowtype;
  v_status text;
  v_count  integer := 0;
begin
  if p_action not in ('approve', 'reject') then
    raise exception 'Choose approve or reject.'
      using errcode = 'invalid_parameter_value', detail = 'action';
  end if;
  if p_action = 'approve' then
    perform app.require_permission('attendance.approve');
  else
    perform app.require_permission('attendance.review', 'attendance.approve');
  end if;
  if p_attendance is null or array_length(p_attendance, 1) is null then
    raise exception 'Choose at least one attendance record.'
      using errcode = 'invalid_parameter_value', detail = 'ids';
  end if;
  if array_length(p_attendance, 1) > 50 then
    raise exception 'Choose at most 50 at a time.'
      using errcode = 'invalid_parameter_value', detail = 'ids';
  end if;
  v_reason := case when p_action = 'reject' then app.require_reason(p_reason)
                   else app.optional_text(p_reason, 'Reason', 300) end;
  v_notes  := app.optional_text(p_notes, 'Notes', 500);

  -- Check every record before changing any of them.
  for v_rec in select * from public.attendance where id = any (p_attendance) for update loop
    perform app.require_not_own(v_rec.staff_uid, 'You cannot verify your own attendance.');
    if v_rec.verification_status <> 'pending' then
      raise exception '% has already been %.', v_rec.attendance_number, v_rec.verification_status
        using errcode = 'raise_exception', detail = 'already_verified';
    end if;
    if p_action = 'approve' and (v_policy ->> 'requireClockOut')::boolean
       and v_rec.clock_in_at is not null and v_rec.clock_out_at is null then
      raise exception '% has no clock-out yet.', v_rec.attendance_number
        using errcode = 'raise_exception', detail = 'no_clock_out';
    end if;
    v_count := v_count + 1;
  end loop;

  if v_count <> array_length(p_attendance, 1) then
    raise exception 'That attendance record could not be found.'
      using errcode = 'no_data_found', detail = 'attendance';
  end if;

  for v_rec in select * from public.attendance where id = any (p_attendance) loop
    v_status := case when p_action = 'reject' then 'rejected'
                     when v_rec.arrival_status = 'on_time' then 'present'
                     else v_rec.arrival_status end;
    update public.attendance
       set status = v_status,
           verification_status = case when p_action = 'approve' then 'approved' else 'rejected' end,
           verified_by = auth.uid(),
           verified_by_name = (select full_name from public.users where id = auth.uid()),
           verified_at = now(), verification_notes = v_notes,
           rejection_reason = case when p_action = 'reject' then v_reason end,
           updated_by = auth.uid()
     where id = v_rec.id;

    if p_action = 'reject' then
      insert into public.workforce_events (type, reference_type, reference_id, audience, recipient_uid, payload)
      values ('attendance_rejected', 'attendance', v_rec.id, 'staff', v_rec.staff_uid,
              jsonb_build_object('attendanceNumber', v_rec.attendance_number));
    end if;

    perform app.audit(
      case when p_action = 'approve' then 'attendance.approved' else 'attendance.rejected' end,
      'attendance', v_rec.id::text, v_rec.staff_uid, v_rec.attendance_number,
      coalesce(v_reason, v_notes),
      jsonb_build_object('status', v_rec.status),
      jsonb_build_object('status', v_status, 'arrivalStatus', v_rec.arrival_status,
                         'minutesLate', v_rec.minutes_late));
  end loop;

  return v_count;
end;
$$;

/*
 * A correction. The original and corrected values, the reason and who made it
 * are kept; the record goes back for verification; lateness is recomputed
 * with THE RECORD'S OWN POLICY, not today's.
 */
create or replace function app.correct_attendance(
  p_attendance uuid,
  p_reason     text,
  p_arrival    text default null,
  p_clock_in   timestamptz default null,
  p_clock_out  timestamptz default null,
  p_notes      text default null,
  p_clear_clock_out boolean default false
)
returns table (attendance_id uuid, correction_id uuid, cancelled_allowance_id uuid)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_rec      public.attendance%rowtype;
  v_reason   text;
  v_arrival  text;
  v_in       timestamptz;
  v_out      timestamptz;
  v_notes    text;
  v_facts    record;
  v_status   text;
  v_changed  text[] := '{}';
  v_allowance public.worker_allowances%rowtype;
  v_cancelled uuid;
  v_correction uuid;
  v_previous jsonb;
  v_new      jsonb;
begin
  perform app.require_permission('attendance.correct');
  v_reason := app.require_reason(p_reason);

  select * into v_rec from public.attendance where id = p_attendance for update;
  if v_rec.id is null then
    raise exception 'That attendance record could not be found.'
      using errcode = 'no_data_found', detail = 'attendance';
  end if;
  perform app.require_not_own(v_rec.staff_uid, 'You cannot correct your own attendance.');

  v_arrival := coalesce(p_arrival,
    case when v_rec.arrival_status in ('on_time', 'late') then 'present' else v_rec.arrival_status end);
  if v_arrival not in ('present', 'absent', 'excused') then
    raise exception 'Choose present, absent or excused.'
      using errcode = 'invalid_parameter_value', detail = 'arrival';
  end if;

  v_in  := coalesce(p_clock_in, v_rec.clock_in_at);
  v_out := case when p_clear_clock_out then null else coalesce(p_clock_out, v_rec.clock_out_at) end;
  v_notes := case when p_notes is null then v_rec.notes else app.optional_text(p_notes, 'Notes', 500) end;

  if v_arrival <> 'present' then
    v_in := null;
    v_out := null;
  else
    if v_in is null then
      raise exception 'A present day needs a clock-in time.'
        using errcode = 'invalid_parameter_value', detail = 'time';
    end if;
    if v_in < app.eat_day_start(v_rec.business_day)
       or v_in >= app.eat_day_start(v_rec.business_day + 1) then
      raise exception 'The clock-in time must be on the attendance day.'
        using errcode = 'invalid_parameter_value', detail = 'time';
    end if;
    if v_in > now() or (v_out is not null and v_out > now()) then
      raise exception 'Times cannot be in the future.'
        using errcode = 'invalid_parameter_value', detail = 'time';
    end if;
    if v_out is not null and v_out <= v_in then
      raise exception 'The clock-out time must be after the clock-in time.'
        using errcode = 'invalid_parameter_value', detail = 'time';
    end if;
  end if;
  if v_arrival = 'excused' and v_notes is null then
    raise exception 'Say why the absence is excused.'
      using errcode = 'invalid_parameter_value', detail = 'notes';
  end if;

  -- What actually changed.
  if v_arrival is distinct from (case when v_rec.arrival_status in ('on_time', 'late')
                                      then 'present' else v_rec.arrival_status end)
    then v_changed := v_changed || 'arrival'::text; end if;
  if v_in  is distinct from v_rec.clock_in_at  then v_changed := v_changed || 'clockInAt'::text; end if;
  if v_out is distinct from v_rec.clock_out_at then v_changed := v_changed || 'clockOutAt'::text; end if;
  if v_notes is distinct from v_rec.notes      then v_changed := v_changed || 'notes'::text; end if;
  if array_length(v_changed, 1) is null then
    raise exception 'Nothing has changed.' using errcode = 'raise_exception', detail = 'no_changes';
  end if;

  -- The allowance that depended on the old facts.
  if v_rec.allowance_id is not null then
    select * into v_allowance from public.worker_allowances where id = v_rec.allowance_id for update;
    if v_allowance.status = 'paid' then
      raise exception 'Its allowance % has been paid. Reverse the payment before correcting attendance.',
        v_allowance.allowance_number
        using errcode = 'raise_exception', detail = 'allowance_paid';
    end if;
    if v_allowance.status in ('calculated', 'pending_approval', 'approved') then
      if exists (select 1 from public.payroll_items i
                  where i.current and v_allowance.id = any (i.allowance_ids)) then
        raise exception 'Its allowance % is in a payroll. Correct the payroll first.',
          v_allowance.allowance_number
          using errcode = 'raise_exception', detail = 'allowance_in_payroll';
      end if;
      v_cancelled := v_allowance.id;
    end if;
  end if;

  -- Recomputed with the POLICY THE RECORD CARRIES, so a later policy change
  -- cannot rewrite this day.
  select * into v_facts from app.lateness(v_rec.business_day, v_in,
    v_rec.reporting_time, v_rec.grace_period_minutes, v_rec.late_threshold_minutes)
   where v_in is not null;

  v_status := case when v_arrival <> 'present' then v_arrival
                   when coalesce(v_facts.late, false) then 'late' else 'on_time' end;

  v_previous := jsonb_build_object('arrivalStatus', v_rec.arrival_status, 'clockInAt', v_rec.clock_in_at,
    'clockOutAt', v_rec.clock_out_at, 'notes', v_rec.notes, 'status', v_rec.status);
  v_new := jsonb_build_object('arrivalStatus', v_status, 'clockInAt', v_in, 'clockOutAt', v_out,
    'notes', v_notes, 'status', 'pending_verification');

  insert into public.attendance_corrections
    (attendance_id, attendance_number, staff_uid, staff_name, business_day,
     previous_value, new_value, changed_fields, reason, cancelled_allowance_id,
     corrected_by, corrected_by_name)
  values
    (v_rec.id, v_rec.attendance_number, v_rec.staff_uid, v_rec.staff_name, v_rec.business_day,
     v_previous, v_new, v_changed, v_reason, v_cancelled,
     auth.uid(), (select full_name from public.users where id = auth.uid()))
  returning id into v_correction;

  update public.attendance
     set clock_in_at = v_in, clock_out_at = v_out,
         minutes_late = coalesce(v_facts.minutes_late, 0),
         late = coalesce(v_facts.late, false),
         severely_late = coalesce(v_facts.severely_late, false),
         arrival_status = v_status, notes = v_notes,
         status = 'pending_verification', verification_status = 'pending',
         verified_by = null, verified_by_name = null, verified_at = null,
         verification_notes = null, rejection_reason = null,
         allowance_id = case when v_cancelled is not null then null else allowance_id end,
         correction_count = correction_count + 1,
         updated_by = auth.uid()
   where id = v_rec.id;

  if v_cancelled is not null then
    update public.worker_allowances
       set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(),
           cancel_reason = format('Attendance %s corrected: %s', v_rec.attendance_number, v_reason),
           updated_by = auth.uid()
     where id = v_cancelled;
    perform app.audit('allowance.cancelled', 'payroll', v_cancelled::text, v_rec.staff_uid,
      v_allowance.allowance_number, v_reason,
      jsonb_build_object('status', v_allowance.status),
      jsonb_build_object('status', 'cancelled', 'attendanceId', v_rec.id));
  end if;

  insert into public.workforce_events (type, reference_type, reference_id, audience, recipient_uid, payload)
  values ('attendance_corrected', 'attendance', v_rec.id, 'staff', v_rec.staff_uid,
          jsonb_build_object('attendanceNumber', v_rec.attendance_number));

  perform app.audit('attendance.corrected', 'attendance', v_rec.id::text, v_rec.staff_uid,
    v_rec.attendance_number, v_reason, v_previous, v_new);

  return query select v_rec.id, v_correction, v_cancelled;
end;
$$;
