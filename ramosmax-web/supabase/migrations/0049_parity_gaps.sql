-- ===========================================================================
-- RamosMAX Web — Final phase — 0049: four callables the earlier phases missed
-- ===========================================================================
-- The Phase 1–9 parity review found four reference callables with no port:
--
--   updateUserProfile    edit a person's name, email, position, department
--                        and specialisation
--   changeUserPhone      change the sign-in phone number
--   linkStaff            link or unlink a person to their staff record
--   updateServiceIntake  change the services on a job before work starts
--
-- Nothing else was missing. `resetUserPassword` is here as
-- `app.prepare_password_reset`, and `ensureDefaultFinancialAccounts` is the
-- seed plus `app.create_financial_account`; both were found and matched.
--
-- ONE STRUCTURAL DIFFERENCE, recorded rather than hidden: the reference keeps
-- a separate `staff` collection that mirrors the profile. This port folded
-- those fields onto `public.users` in Phase B, so "linking staff" is setting
-- the staff reference on the person, and there is no second record to keep in
-- step — which removes the class of bug the reference's `syncStaff` exists to
-- prevent.
-- ===========================================================================

alter table public.users
  add column if not exists position   text,
  add column if not exists department text,
  -- Every session issued before this moment is over. `password_changed_at`
  -- already does this for a password change; a phone-number change needs its
  -- own, because it is not a password change and must not look like one.
  add column if not exists sessions_valid_from timestamptz;

comment on column public.users.sessions_valid_from is
  'Sessions issued before this are rejected. Set when the sign-in phone number changes, which is what revokeRefreshTokens() does in the reference.';

-- ---------------------------------------------------------------------------
-- updateUserProfile
-- ---------------------------------------------------------------------------

/*
 * Edits the parts of a profile that are not the sign-in identity and not
 * access.
 *
 * A person may edit their OWN profile with `users.edit`; editing somebody
 * else's also has to pass the anti-escalation rule. The phone number is
 * refused here on purpose: it is how somebody signs in, and it has its own
 * function with its own audit entry.
 *
 * Passing null leaves a field alone. To clear one, pass an empty string.
 */
create or replace function app.update_user_profile(
  p_user           uuid,
  p_full_name      text default null,
  p_email          text default null,
  p_position       text default null,
  p_department     text default null,
  p_specialization text default null,
  p_phone_number   text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before public.users%rowtype;
  v_name   text;
  v_before_json jsonb := '{}'::jsonb;
  v_after_json  jsonb := '{}'::jsonb;
  v_changed boolean := false;
begin
  perform app.require_permission('users.edit');
  select * into v_before from public.users where id = p_user;
  if v_before.id is null then
    raise exception 'That user could not be found.'
      using errcode = 'no_data_found', detail = 'user_not_found';
  end if;
  if p_user <> auth.uid() then
    perform app.require_can_administer(p_user);
  end if;

  if p_phone_number is not null
     and app.normalize_phone(p_phone_number) is distinct from v_before.phone_number then
    raise exception 'Use "Change phone number" to change the sign-in phone number.'
      using errcode = 'invalid_parameter_value', detail = 'use_change_phone';
  end if;

  if p_full_name is not null then
    v_name := app.require_name(p_full_name);
    if v_name is distinct from v_before.full_name then
      v_before_json := v_before_json || jsonb_build_object('fullName', v_before.full_name);
      v_after_json  := v_after_json  || jsonb_build_object('fullName', v_name);
      update public.users set full_name = v_name where id = p_user;
      v_changed := true;
    end if;
  end if;

  if p_email is not null then
    declare v_email text := app.optional_email(nullif(p_email, ''));
    begin
      if v_email is distinct from v_before.email then
        v_before_json := v_before_json || jsonb_build_object('email', v_before.email);
        v_after_json  := v_after_json  || jsonb_build_object('email', v_email);
        update public.users set email = v_email where id = p_user;
        v_changed := true;
      end if;
    end;
  end if;

  if p_position is not null then
    declare v_position text := app.optional_text(nullif(p_position, ''), 'Position', 80);
    begin
      if v_position is distinct from v_before.position then
        v_before_json := v_before_json || jsonb_build_object('position', v_before.position);
        v_after_json  := v_after_json  || jsonb_build_object('position', v_position);
        update public.users set position = v_position where id = p_user;
        v_changed := true;
      end if;
    end;
  end if;

  if p_department is not null then
    declare v_department text := app.optional_text(nullif(p_department, ''), 'Department', 80);
    begin
      if v_department is distinct from v_before.department then
        v_before_json := v_before_json || jsonb_build_object('department', v_before.department);
        v_after_json  := v_after_json  || jsonb_build_object('department', v_department);
        update public.users set department = v_department where id = p_user;
        v_changed := true;
      end if;
    end;
  end if;

  if p_specialization is not null then
    declare v_special text := app.optional_text(nullif(p_specialization, ''), 'Specialisation', 80);
    begin
      -- Only a worker has a specialisation, exactly as in the reference.
      if v_special is not null and v_before.role <> 'worker' then
        raise exception 'Only a worker has a specialisation.'
          using errcode = 'invalid_parameter_value', detail = 'specialization';
      end if;
      if v_special is distinct from v_before.specialization then
        v_before_json := v_before_json || jsonb_build_object('specialization', v_before.specialization);
        v_after_json  := v_after_json  || jsonb_build_object('specialization', v_special);
        update public.users set specialization = v_special where id = p_user;
        v_changed := true;
      end if;
    end;
  end if;

  if not v_changed then
    raise exception 'Nothing has changed.'
      using errcode = 'invalid_parameter_value', detail = 'no_changes';
  end if;

  update public.users set updated_at = now(), updated_by = auth.uid() where id = p_user;
  perform app.audit('user.updated', 'users', p_user::text, p_user, null, null,
    v_before_json, v_after_json);
  return p_user;
end;
$$;

-- ---------------------------------------------------------------------------
-- changeUserPhone
-- ---------------------------------------------------------------------------

/*
 * The sign-in identity.
 *
 * Nobody changes their own — that is how an account is quietly taken over.
 * Every existing session ends, so the person signs in again with the new
 * number and their current password. The audit entry carries MASKED numbers:
 * an audit log is read by people who have no business knowing anybody's phone
 * number in full.
 */
create or replace function app.change_user_phone(
  p_user   uuid,
  p_phone  text,
  p_reason text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before public.users%rowtype;
  v_phone  text := app.normalize_phone(p_phone);
begin
  perform app.require_permission('users.edit');
  perform app.require_not_self(p_user,
    'Ask another administrator to change your own phone number.');
  if v_phone is null then
    raise exception 'Enter a valid phone number, e.g. 0772 123 456.'
      using errcode = 'invalid_parameter_value', detail = 'phone';
  end if;

  select * into v_before from public.users where id = p_user for update;
  if v_before.id is null then
    raise exception 'That user could not be found.'
      using errcode = 'no_data_found', detail = 'user_not_found';
  end if;
  perform app.require_can_administer(p_user);
  if v_phone = v_before.phone_number then
    raise exception 'Nothing has changed.'
      using errcode = 'invalid_parameter_value', detail = 'no_changes';
  end if;
  if exists (select 1 from public.users where phone_number = v_phone and id <> p_user) then
    raise exception 'This phone number is already used by another account.'
      using errcode = 'unique_violation', detail = 'phone_in_use';
  end if;

  update public.users
     set phone_number = v_phone,
         -- Every session issued before now is over.
         sessions_valid_from = now(),
         updated_at = now(), updated_by = auth.uid()
   where id = p_user;

  perform app.audit('user.phone_changed', 'users', p_user::text, p_user,
    'Sign-in phone number changed; existing sessions ended', p_reason,
    jsonb_build_object('phoneNumber', app.mask_phone(v_before.phone_number)),
    jsonb_build_object('phoneNumber', app.mask_phone(v_phone)));

  return v_phone;
end;
$$;

-- ---------------------------------------------------------------------------
-- linkStaff
-- ---------------------------------------------------------------------------

/*
 * Links a person to their staff reference, or clears it.
 *
 * In this port the staff fields live on the person, so there is no second
 * record to keep in step. What survives from the reference is the rule that
 * matters: a staff reference belongs to ONE person, and the profile photo
 * does not follow a person to a different reference, because a photo is filed
 * under the reference it was taken for.
 */
create or replace function app.link_staff(p_user uuid, p_staff_id text default null)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_before public.users%rowtype;
  v_staff  text := nullif(upper(btrim(coalesce(p_staff_id, ''))), '');
begin
  perform app.require_permission('users.edit');
  select * into v_before from public.users where id = p_user for update;
  if v_before.id is null then
    raise exception 'That user could not be found.'
      using errcode = 'no_data_found', detail = 'user_not_found';
  end if;
  perform app.require_can_administer(p_user);

  if v_staff is not null and v_staff !~ '^[A-Z0-9-]{3,32}$' then
    raise exception 'Staff IDs use capital letters, digits and dashes, e.g. RMX-STF-0001.'
      using errcode = 'invalid_parameter_value', detail = 'staff_id';
  end if;
  if v_staff is not distinct from v_before.staff_id then
    raise exception 'Nothing has changed.'
      using errcode = 'invalid_parameter_value', detail = 'no_changes';
  end if;
  if v_staff is not null
     and exists (select 1 from public.users where staff_id = v_staff and id <> p_user) then
    raise exception 'Staff ID % is already linked to another user.', v_staff
      using errcode = 'unique_violation', detail = 'staff_linked';
  end if;

  update public.users
     set staff_id = v_staff,
         -- A photo lives under its staff reference's folder, so it cannot follow.
         profile_photo_path = null,
         updated_at = now(), updated_by = auth.uid()
   where id = p_user;

  if v_before.staff_id is not null then
    perform app.audit('staff.unlinked', 'users', p_user::text, p_user, null, null,
      jsonb_build_object('staffId', v_before.staff_id), null);
  end if;
  if v_staff is not null then
    perform app.audit('staff.linked', 'users', p_user::text, p_user, null, null,
      null, jsonb_build_object('staffId', v_staff));
  end if;
  return v_staff;
end;
$$;

-- ---------------------------------------------------------------------------
-- updateServiceIntake
-- ---------------------------------------------------------------------------

/*
 * Changes the services on a job.
 *
 * A service may be removed only while nobody has started it: once work is
 * accepted, started or finished, it is part of what the customer is owed and
 * removing it silently would change the bill. An invoiced job cannot be
 * edited at all — the invoice has to be cancelled first.
 *
 * Cancelling the whole job is `app.cancel_service_intake`, which was already
 * ported; this is the part that was missing.
 */
create or replace function app.update_service_intake(
  p_intake      uuid,
  p_service_ids uuid[] default null,
  p_open        boolean default false,
  p_reason      text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_intake public.service_intakes%rowtype;
  v_order  record;
  v_service record;
  v_wanted uuid[];
  v_added  integer := 0;
  v_removed integer := 0;
  v_status text;
begin
  perform app.require_permission('jobs.create');
  select * into v_intake from public.service_intakes where id = p_intake for update;
  if v_intake.id is null then
    raise exception 'That service intake could not be found.'
      using errcode = 'no_data_found', detail = 'intake_not_found';
  end if;
  if v_intake.status = 'cancelled' then
    raise exception 'This service intake was cancelled.'
      using errcode = 'invalid_parameter_value', detail = 'cancelled';
  end if;
  if exists (select 1 from public.invoices where service_intake_id = p_intake
              and status <> 'cancelled') then
    raise exception 'This job has been invoiced. Cancel the invoice first.'
      using errcode = 'invalid_parameter_value', detail = 'invoiced';
  end if;
  if p_service_ids is null and not p_open then
    raise exception 'Nothing has changed.'
      using errcode = 'invalid_parameter_value', detail = 'no_changes';
  end if;

  if p_service_ids is not null then
    select array_agg(distinct s) into v_wanted from unnest(p_service_ids) s;
    if v_wanted is null or array_length(v_wanted, 1) is null
       or array_length(v_wanted, 1) > 20 then
      raise exception 'Choose between one and 20 services.'
        using errcode = 'invalid_parameter_value', detail = 'services';
    end if;
    if exists (select 1 from unnest(v_wanted) w
                where not exists (select 1 from public.services s
                                   where s.id = w and s.is_active)) then
      raise exception 'One of those services is not available.'
        using errcode = 'no_data_found', detail = 'service_not_found';
    end if;

    -- Remove what is no longer wanted, but only while nobody has touched it.
    for v_order in
      select * from public.worker_orders
       where service_intake_id = p_intake and status <> 'cancelled'
         and not (service_id = any (v_wanted))
    loop
      if v_order.status <> 'pending' and v_order.status <> 'assigned' then
        raise exception '"%" is already being worked on and cannot be removed.',
          v_order.service_name
          using errcode = 'invalid_parameter_value', detail = 'order_started';
      end if;
      update public.worker_orders
         set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
             cancel_reason = 'Service removed from the job', updated_at = now()
       where id = v_order.id;
      v_removed := v_removed + 1;
    end loop;

    -- Add what is new.
    for v_service in
      select s.* from public.services s
       where s.id = any (v_wanted)
         and not exists (select 1 from public.worker_orders o
                          where o.service_intake_id = p_intake and o.service_id = s.id
                            and o.status <> 'cancelled')
       order by s.name
    loop
      -- Numbered the same way create_service_intake numbers them: the job
      -- number and the next free position on it.
      insert into public.worker_orders
        (order_number, service_intake_id, job_number, vehicle_id, number_plate,
         vehicle_summary, customer_id, service_id, service_name, category, status,
         created_by, updated_by)
      values
        (v_intake.job_number || '/' ||
           ((select count(*) from public.worker_orders
              where service_intake_id = p_intake) + 1)::text,
         p_intake, v_intake.job_number, v_intake.vehicle_id, v_intake.number_plate,
         v_intake.vehicle_summary, v_intake.customer_id, v_service.id, v_service.name,
         v_service.category, 'pending', auth.uid(), auth.uid());
      v_added := v_added + 1;
    end loop;

    if v_added = 0 and v_removed = 0 and not p_open then
      raise exception 'Nothing has changed.'
        using errcode = 'invalid_parameter_value', detail = 'no_changes';
    end if;
  end if;

  if p_service_ids is not null then
    -- The selected services, with their PRICES read from the catalogue —
    -- never from the request, exactly as when the job was created.
    update public.service_intakes i
       set selected_services = coalesce((
             select jsonb_agg(jsonb_build_object(
                      'serviceId', s.id, 'name', s.name, 'category', s.category,
                      'priceUgx', s.price_ugx,
                      'qualifiesForLoyalty', s.qualifies_for_loyalty) order by s.name)
               from public.services s
              where s.id in (select o.service_id from public.worker_orders o
                              where o.service_intake_id = p_intake
                                and o.status <> 'cancelled')), '[]'::jsonb),
           service_ids = coalesce((
             select array_agg(distinct o.service_id) from public.worker_orders o
              where o.service_intake_id = p_intake and o.status <> 'cancelled'), '{}'),
           service_count = (
             select count(distinct o.service_id)::integer from public.worker_orders o
              where o.service_intake_id = p_intake and o.status <> 'cancelled')
     where i.id = p_intake;
  end if;

  if p_open and v_intake.status = 'draft' then
    update public.service_intakes set status = 'open' where id = p_intake;
  end if;

  -- The intake's own summary is derived, never edited by hand.
  perform app.refresh_intake(p_intake);
  select status into v_status from public.service_intakes where id = p_intake;

  perform app.audit('service_intake.updated', 'jobs', p_intake::text, null,
    v_intake.job_number, p_reason,
    jsonb_build_object('status', v_intake.status, 'serviceCount', v_intake.service_count),
    jsonb_build_object('status', v_status, 'servicesAdded', v_added,
                       'servicesRemoved', v_removed));
  return v_status;
end;
$$;
