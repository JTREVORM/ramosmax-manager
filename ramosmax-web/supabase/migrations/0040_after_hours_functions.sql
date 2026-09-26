-- ===========================================================================
-- RamosMAX Web — Final phase — 0040: authorisations and sessions
-- ===========================================================================
-- The authorisation hands out ORDINARY temporary grants. Expiry is therefore
-- a comparison against the server clock inside app.effective_permissions(),
-- not an event somebody has to remember to fire: at `expires_at` the grants
-- simply stop being returned, in every RLS policy and every function, whether
-- or not any sweep has run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Tags on the records an after-hours session produces
-- ---------------------------------------------------------------------------
-- There is no after-hours intake, invoice, job or payment. There is the
-- ordinary one, tagged with the session that produced it.

alter table public.service_intakes
  add column if not exists is_after_hours boolean not null default false,
  add column if not exists after_hours_session_id uuid,
  add column if not exists after_hours_session_number text,
  add column if not exists after_hours_worker_uid uuid;

alter table public.invoices
  add column if not exists is_after_hours boolean not null default false,
  add column if not exists after_hours_session_id uuid,
  add column if not exists after_hours_session_number text,
  add column if not exists after_hours_worker_uid uuid;

alter table public.worker_orders
  add column if not exists is_after_hours boolean not null default false,
  add column if not exists after_hours_session_id uuid,
  add column if not exists after_hours_session_number text,
  add column if not exists after_hours_worker_uid uuid;

alter table public.payments
  add column if not exists is_after_hours boolean not null default false,
  add column if not exists after_hours_session_id uuid,
  add column if not exists after_hours_session_number text,
  add column if not exists after_hours_worker_uid uuid;

create index if not exists payments_after_hours_idx
  on public.payments (after_hours_session_id) where after_hours_session_id is not null;

-- ---------------------------------------------------------------------------
-- The grantable list
-- ---------------------------------------------------------------------------

/*
 * Everything an after-hours authorisation may hand out, and nothing else.
 *
 * What is missing from this list is the point of it: no user, role or
 * password administration, no salaries, no payroll, no finance configuration
 * or accounts, no payment reversal, no dividends, shareholders or shares, no
 * inventory configuration, no prices or discounts, no attendance approval, no
 * settings and no audit log. A worker on duty at night can serve customers.
 * They cannot become an administrator for the night.
 */
create or replace function app.after_hours_grantable()
returns text[]
language sql
immutable
as $$
  select array[
    'after_hours.operate', 'after_hours.cash.collect',
    'jobs.view', 'jobs.create', 'jobs.assign',
    'invoices.view', 'invoices.create',
    'customers.view', 'customers.manage', 'vehicles.manage']::text[];
$$;

/* What an authorisation grants when the approver does not choose. */
create or replace function app.after_hours_default_grants()
returns text[]
language sql
immutable
as $$
  select array[
    'after_hours.operate', 'after_hours.cash.collect',
    'jobs.view', 'jobs.create', 'jobs.assign',
    'invoices.view', 'invoices.create']::text[];
$$;

create or replace function app.require_grant_list(p_input text[])
returns text[]
language plpgsql
immutable
as $$
declare
  v_list    text[];
  v_refused text[];
begin
  if p_input is null then return app.after_hours_default_grants(); end if;
  select array_agg(distinct p) into v_list from unnest(p_input) p where p is not null;
  if v_list is null or array_length(v_list, 1) is null then
    raise exception 'Choose the after-hours permissions.'
      using errcode = 'invalid_parameter_value', detail = 'permission';
  end if;
  select array_agg(p) into v_refused from unnest(v_list) p
   where not (p = any (app.after_hours_grantable()));
  if v_refused is not null then
    raise exception 'After-hours work cannot include %.', array_to_string(v_refused, ', ')
      using errcode = 'invalid_parameter_value', detail = 'permission_not_allowed';
  end if;
  -- Operating the session is what an authorisation IS, so it is always in.
  if not ('after_hours.operate' = any (v_list)) then
    v_list := array['after_hours.operate'] || v_list;
  end if;
  -- Return them in catalogue order, so two identical requests look identical.
  select array_agg(p order by ord) into v_list
    from unnest(app.after_hours_grantable()) with ordinality as g(p, ord)
   where p = any (v_list);
  return v_list;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permissions a person holds WITHOUT any temporary grant
-- ---------------------------------------------------------------------------

/*
 * Eligibility is judged on what somebody holds permanently. Otherwise an
 * authorisation could be used to make the next authorisation possible, and
 * after-hours access would bootstrap itself.
 */
create or replace function app.permanent_permissions(p_user uuid)
returns text[]
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  with live as (
    select u.id, u.role, u.permissions, u.denied_permissions
      from public.users u where u.id = p_user and u.active
  ), granted as (
    select p.key
      from live
      join app.roles r on r.id = live.role
      join app.permissions p
        on r.grants_all
        or exists (select 1 from app.role_permissions rp
                    where rp.role_id = r.id and rp.permission_key = p.key)
    union
    select p.key from live join app.permissions p on p.key = any (live.permissions)
  )
  select coalesce(array_agg(g.key order by g.key), '{}')
    from granted g
   where not exists (select 1 from live where g.key = any (live.denied_permissions));
$$;

-- ---------------------------------------------------------------------------
-- The temporary window, in one place
-- ---------------------------------------------------------------------------

/*
 * access.js requireTemporaryWindow: a start in the recent past is treated as
 * now (five minutes of tolerated clock skew), the window must be positive,
 * and it may last at most 30 days and begin at most 30 days ahead.
 */
create or replace function app.require_temporary_window(
  p_starts_at  timestamptz,
  p_expires_at timestamptz
)
returns timestamptz
language plpgsql
stable
as $$
declare v_start timestamptz := coalesce(p_starts_at, now());
begin
  if p_expires_at is null then
    raise exception 'Choose a valid start and end time.'
      using errcode = 'invalid_parameter_value', detail = 'window';
  end if;
  if v_start < now() - interval '5 minutes' then
    raise exception 'The start time cannot be in the past.'
      using errcode = 'invalid_parameter_value', detail = 'window';
  end if;
  v_start := greatest(v_start, now());
  if p_expires_at <= v_start then
    raise exception 'The end time must be after the start time.'
      using errcode = 'invalid_parameter_value', detail = 'window';
  end if;
  if p_expires_at - v_start > interval '30 days' then
    raise exception 'Temporary access can last at most 30 days.'
      using errcode = 'invalid_parameter_value', detail = 'window';
  end if;
  if v_start - now() > interval '30 days' then
    raise exception 'Temporary access must start within the next 30 days.'
      using errcode = 'invalid_parameter_value', detail = 'window';
  end if;
  return v_start;
end;
$$;

/* The generic temporary-access editor, now sharing the one window rule. */
create or replace function app.grant_temporary_permission(
  p_target     uuid,
  p_permission text,
  p_starts_at  timestamptz,
  p_expires_at timestamptz,
  p_reason     text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_id    uuid;
  v_start timestamptz;
begin
  perform app.require_permission('users.permissions.temporary');
  perform app.require_can_administer(p_target);
  perform app.require_valid_permissions(array[p_permission]);
  -- after_hours.operate / after_hours.cash.collect come ONLY from an
  -- after-hours authorisation, never from the generic temporary-access editor.
  perform app.require_not_authorization_only(p_permission);
  perform app.require_can_grant(p_permission);

  v_start := app.require_temporary_window(p_starts_at, p_expires_at);

  insert into public.temporary_grants
    (user_id, permission_key, starts_at, expires_at, reason, granted_by)
  values (p_target, p_permission, v_start, p_expires_at, p_reason, auth.uid())
  returning id into v_id;

  perform app.audit('user.temporary_permission_granted', 'users', v_id::text, p_target,
    null, p_reason, null,
    jsonb_build_object('permission', p_permission, 'startsAt', v_start, 'expiresAt', p_expires_at));

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Policy
-- ---------------------------------------------------------------------------

create or replace function app.after_hours_policy()
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select jsonb_build_object(
    'allowedPaymentMethods', coalesce(v -> 'allowedPaymentMethods',
                                      '["cash","mtn_merchant","airtel_merchant"]'::jsonb),
    'maxAuthorizationHours', app.policy_int(v, 'maxAuthorizationHours', 16, 1, 24),
    'maxOpeningFloatUgx',    app.policy_int(v, 'maxOpeningFloatUgx', 1000000, 0, 10000000))
  from (select value as v from public.settings where key = 'after_hours_policy'
        union all select '{}'::jsonb where not exists
          (select 1 from public.settings where key = 'after_hours_policy') limit 1) q;
$$;

create or replace function app.after_hours_methods()
returns text[]
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select coalesce(array(select jsonb_array_elements_text(
           app.after_hours_policy() -> 'allowedPaymentMethods')), '{}')::text[];
$$;

/*
 * settings.manage: which payment methods may be taken after hours, how long
 * an authorisation may last, and the largest float anyone may be given.
 */
create or replace function app.update_after_hours_policy(p_changes jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_reason  text := app.require_reason(p_reason);
  v_before  jsonb;
  v_next    jsonb;
  v_key     text;
  v_methods text[];
  v_hours   integer;
  v_float   bigint;
begin
  perform app.require_permission('settings.manage');
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    raise exception 'One of the settings is not recognised.'
      using errcode = 'invalid_parameter_value', detail = 'policy';
  end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key not in ('allowedPaymentMethods', 'maxAuthorizationHours', 'maxOpeningFloatUgx') then
      raise exception 'One of the settings is not recognised.'
        using errcode = 'invalid_parameter_value', detail = 'policy';
    end if;
  end loop;

  v_before := app.after_hours_policy();
  v_next   := v_before || p_changes;

  select array_agg(m order by ord) into v_methods
    from unnest(array['cash', 'mtn_merchant', 'airtel_merchant', 'bank'])
           with ordinality as k(m, ord)
   where m in (select jsonb_array_elements_text(v_next -> 'allowedPaymentMethods'));
  if v_methods is null or array_length(v_methods, 1) is null
     or (select count(*) from jsonb_array_elements_text(v_next -> 'allowedPaymentMethods'))
        <> array_length(v_methods, 1) then
    raise exception 'Choose at least one valid payment method for after-hours work.'
      using errcode = 'invalid_parameter_value', detail = 'policy';
  end if;

  v_hours := (v_next ->> 'maxAuthorizationHours')::integer;
  if v_hours is null or v_hours < 1 or v_hours > 24 then
    raise exception 'An after-hours authorisation can last between 1 and 24 hours.'
      using errcode = 'invalid_parameter_value', detail = 'policy';
  end if;
  v_float := app.require_amount((v_next ->> 'maxOpeningFloatUgx')::bigint,
    'maximum opening float', 0, 10000000);

  v_next := jsonb_build_object(
    'allowedPaymentMethods', to_jsonb(v_methods),
    'maxAuthorizationHours', v_hours,
    'maxOpeningFloatUgx', v_float);
  if v_next = v_before then
    raise exception 'Nothing has changed.'
      using errcode = 'invalid_parameter_value', detail = 'no_changes';
  end if;

  insert into public.settings (key, value, updated_by, updated_at)
  values ('after_hours_policy', v_next, auth.uid(), now())
  on conflict (key) do update set value = excluded.value,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;

  perform app.audit('after_hours_policy.updated', 'after_hours', 'after_hours_policy', null,
    null, v_reason, v_before, v_next);
  return v_next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Authorisations
-- ---------------------------------------------------------------------------

/* An authorisation in force RIGHT NOW, by the server clock. */
create or replace function app.authorization_is_live(p_auth public.after_hours_access)
returns boolean
language sql
stable
as $$
  select p_auth.status = 'active'
     and p_auth.starts_at <= now()
     and p_auth.expires_at > now();
$$;

create or replace function app.authorize_after_hours(
  p_staff         uuid,
  p_expires_at    timestamptz,
  p_reason        text,
  p_request_id    text,
  p_starts_at     timestamptz default null,
  p_permissions   text[] default null,
  p_opening_float_ugx bigint default null,
  -- A length instead of an end time. The screens send this so the window is
  -- measured against the DATABASE clock: a browser or a web server whose
  -- clock is a second ahead would otherwise have a full-length shift refused
  -- for exceeding the policy by that second.
  p_hours         integer default null
)
returns table (authorization_id uuid, authorization_number text, granted text[])
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_cached    jsonb;
  v_reason    text := app.require_reason(p_reason);
  v_list      text[] := app.require_grant_list(p_permissions);
  v_start     timestamptz;
  v_expires   timestamptz;
  v_policy    jsonb;
  v_target    public.users%rowtype;
  v_permanent text[];
  v_denied    text[];
  v_to_grant  text[];
  v_clash     text;
  v_float     bigint := coalesce(p_opening_float_ugx, 0);
  v_number    text;
  v_id        uuid;
  v_perm      text;
begin
  perform app.require_permission('after_hours.approve');
  perform app.require_request_id(p_request_id);
  if (p_expires_at is null) = (p_hours is null) then
    raise exception 'Choose how long the authorisation lasts.'
      using errcode = 'invalid_parameter_value', detail = 'window';
  end if;
  v_expires := coalesce(p_expires_at,
                        coalesce(p_starts_at, now()) + make_interval(hours => p_hours));
  v_start := app.require_temporary_window(p_starts_at, v_expires);
  if v_float <> 0 then
    v_float := app.require_amount(v_float, 'opening float', 0, 10000000);
  end if;

  v_cached := app.claim_request(p_request_id, 'after_hours_authorization',
    jsonb_build_object('staff', p_staff, 'expiresAt', v_expires, 'hours', p_hours));
  if v_cached is not null then
    return query select (v_cached ->> 'authorizationId')::uuid,
                        v_cached ->> 'authorizationNumber',
                        array(select jsonb_array_elements_text(v_cached -> 'granted'))::text[];
    return;
  end if;

  if p_staff = auth.uid() then
    raise exception 'You cannot authorise yourself for after-hours work.'
      using errcode = 'insufficient_privilege', detail = 'self_authorization';
  end if;

  v_policy := app.after_hours_policy();
  if v_expires - v_start
     > make_interval(hours => (v_policy ->> 'maxAuthorizationHours')::integer) then
    raise exception 'An after-hours authorisation can last at most % hours.',
      v_policy ->> 'maxAuthorizationHours'
      using errcode = 'invalid_parameter_value', detail = 'window';
  end if;
  if v_float > (v_policy ->> 'maxOpeningFloatUgx')::bigint then
    raise exception 'The opening float can be at most UGX %.',
      to_char((v_policy ->> 'maxOpeningFloatUgx')::bigint, 'FM999,999,999,999')
      using errcode = 'invalid_parameter_value', detail = 'float';
  end if;

  select * into v_target from public.users where id = p_staff;
  if v_target.id is null then
    raise exception 'That user could not be found.'
      using errcode = 'no_data_found', detail = 'user_not_found';
  end if;
  -- The same anti-escalation rule as every other access change.
  perform app.require_can_administer(p_staff);
  if not app.is_account_live(p_staff) then
    raise exception 'This account is not active.'
      using errcode = 'invalid_parameter_value', detail = 'target_inactive';
  end if;

  v_permanent := app.permanent_permissions(p_staff);
  if not ('after_hours.request' = any (v_permanent)) then
    raise exception '% is not eligible for after-hours work (after_hours.request).',
      coalesce(v_target.full_name, 'This person')
      using errcode = 'invalid_parameter_value', detail = 'not_eligible';
  end if;
  v_denied := coalesce(v_target.denied_permissions, '{}');
  if 'after_hours.operate' = any (v_denied) then
    raise exception 'After-hours operation is explicitly denied for this person.'
      using errcode = 'insufficient_privilege', detail = 'denied';
  end if;

  -- SERIALISE authorisations for this person.
  --
  -- Without this, two supervisors authorising the same worker at the same
  -- moment would both read an empty overlap check and both succeed, leaving
  -- two live windows — and a revocation of one would leave the other's grants
  -- standing. The lock is held until commit, so the check below sees whatever
  -- the other transaction did.
  perform 1 from public.users where id = p_staff for update;

  -- Two authorisations may not cover the same moment for the same person.
  select a.authorization_number into v_clash
    from public.after_hours_access a
   where a.staff_uid = p_staff and a.status = 'active'
     and a.expires_at > now()
     and a.starts_at < v_expires and a.expires_at > v_start
   limit 1;
  if v_clash is not null then
    raise exception '% already covers part of this time. Revoke it first.', v_clash
      using errcode = 'invalid_parameter_value', detail = 'authorization_overlaps';
  end if;

  select coalesce(array_agg(p order by ord), '{}') into v_to_grant
    from unnest(v_list) with ordinality as g(p, ord)
   where not (p = any (v_permanent)) and not (p = any (v_denied));

  v_number := app.next_reference('after_hours_number_seq', 'RMX-AH-');
  insert into public.after_hours_access
    (authorization_number, staff_uid, staff_name, staff_role, starts_at, expires_at, reason,
     permissions, granted, opening_float_ugx, granted_by, granted_by_name, request_id)
  values
    (v_number, p_staff, coalesce(v_target.full_name, p_staff::text), v_target.role,
     v_start, v_expires, v_reason, v_list, v_to_grant, v_float, auth.uid(),
     (select full_name from public.users where id = auth.uid()), p_request_id)
  returning id into v_id;

  foreach v_perm in array v_to_grant loop
    -- An older live grant of the same permission is superseded: it stops
    -- counting at once, so two overlapping authorisations cannot leave a
    -- permission alive after the newer one is revoked.
    update public.temporary_grants
       set revoked_at = now(), revoked_by = auth.uid(),
           revoke_reason = 'Superseded by ' || v_number
     where user_id = p_staff and permission_key = v_perm
       and revoked_at is null and expires_at > now();

    insert into public.temporary_grants
      (user_id, permission_key, starts_at, expires_at, reason, granted_by, authorization_id)
    values (p_staff, v_perm, v_start, v_expires,
            'After-hours ' || v_number || ': ' || v_reason, auth.uid(), v_id);
  end loop;

  update public.users
     set updated_at = now(), updated_by = auth.uid()
   where id = p_staff;

  perform app.audit('after_hours.authorized', 'after_hours', v_id::text, p_staff,
    v_number, v_reason, null,
    jsonb_build_object('authorizationNumber', v_number, 'startsAt', v_start,
                       'expiresAt', v_expires, 'permissions', to_jsonb(v_list),
                       'temporaryGrants', to_jsonb(v_to_grant), 'openingFloatUgx', v_float));

  insert into public.after_hours_events (type, reference_type, reference_id, audience,
                                         recipient_uid, payload)
  values ('after_hours_authorized', 'authorization', v_id, 'recipient', p_staff,
          jsonb_build_object('authorizationNumber', v_number, 'expiresAt', v_expires));

  perform app.complete_request(p_request_id, jsonb_build_object(
    'authorizationId', v_id, 'authorizationNumber', v_number, 'granted', to_jsonb(v_to_grant)));

  return query select v_id, v_number, v_to_grant;
end;
$$;

/*
 * Ends an authorisation now. Its temporary grants are revoked in the same
 * transaction, so the permissions are gone on the next query — there is no
 * window in which a revoked worker is still operating.
 *
 * A session that is already open must still be CLOSED and handed over. That
 * is deliberate: revoking access must never strand the cash.
 */
create or replace function app.revoke_after_hours(p_authorization uuid, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_reason text := app.require_reason(p_reason);
  v_auth   public.after_hours_access%rowtype;
begin
  perform app.require_permission('after_hours.approve');
  select * into v_auth from public.after_hours_access where id = p_authorization for update;
  if v_auth.id is null then
    raise exception 'That after-hours authorisation could not be found.'
      using errcode = 'no_data_found', detail = 'authorization_not_found';
  end if;
  if v_auth.status <> 'active' or v_auth.expires_at <= now() then
    raise exception 'This authorisation has already ended.'
      using errcode = 'invalid_parameter_value', detail = 'not_active';
  end if;
  perform app.require_can_administer(v_auth.staff_uid);

  update public.temporary_grants
     set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = v_reason
   where authorization_id = p_authorization and revoked_at is null;

  update public.after_hours_access
     set status = 'revoked', revoked_at = now(), revoked_by = auth.uid(),
         revoked_by_name = (select full_name from public.users where id = auth.uid()),
         revoke_reason = v_reason, updated_at = now()
   where id = p_authorization;

  perform app.audit('after_hours.revoked', 'after_hours', p_authorization::text,
    v_auth.staff_uid, v_auth.authorization_number, v_reason,
    jsonb_build_object('status', 'active'),
    jsonb_build_object('status', 'revoked', 'authorizationNumber', v_auth.authorization_number));

  insert into public.after_hours_events (type, reference_type, reference_id, audience,
                                         recipient_uid, payload)
  values ('after_hours_revoked', 'authorization', p_authorization, 'recipient', v_auth.staff_uid,
          jsonb_build_object('authorizationNumber', v_auth.authorization_number));

  return 'revoked';
end;
$$;

-- ---------------------------------------------------------------------------
-- Session context — what the ordinary business functions ask
-- ---------------------------------------------------------------------------

/*
 * The caller's open session, if any, and whether its authorisation is still
 * in force. `live` false with a session present means the worker's window has
 * ended: they may no longer collect, but they must still close and hand over.
 */
create or replace function app.after_hours_context(p_uid uuid default auth.uid())
returns table (session_id uuid, session_number text, staff_uid uuid, live boolean)
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select s.id, s.session_number, s.staff_uid, app.authorization_is_live(a)
    from public.after_hours_sessions s
    join public.after_hours_access a on a.id = s.authorization_id
   where s.staff_uid = p_uid and s.status = 'open'
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

create or replace function app.open_after_hours_session(
  p_request_id text,
  p_notes      text default null
)
returns table (session_id uuid, session_number text, opening_float_ugx bigint)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_cached jsonb;
  v_auth   public.after_hours_access%rowtype;
  v_float  bigint;
  v_number text;
  v_id     uuid;
  v_name   text;
begin
  -- after_hours.operate exists ONLY while an authorisation's grant is live,
  -- so this one check is the whole gate.
  perform app.require_permission('after_hours.operate');
  perform app.require_permission('after_hours.request');
  perform app.require_request_id(p_request_id);

  v_cached := app.claim_request(p_request_id, 'after_hours_session',
    jsonb_build_object('uid', auth.uid()));
  if v_cached is not null then
    return query select (v_cached ->> 'sessionId')::uuid, v_cached ->> 'sessionNumber',
                        (v_cached ->> 'openingFloatUgx')::bigint;
    return;
  end if;

  if exists (select 1 from public.after_hours_sessions
              where staff_uid = auth.uid() and status = 'open') then
    raise exception 'You already have an after-hours session open.'
      using errcode = 'unique_violation', detail = 'session_already_open';
  end if;

  select * into v_auth from public.after_hours_access
   where staff_uid = auth.uid() and status = 'active'
     and starts_at <= now() and expires_at > now()
   order by expires_at desc limit 1
     for update;
  if v_auth.id is null then
    raise exception 'You have no after-hours authorisation in force now.'
      using errcode = 'insufficient_privilege', detail = 'no_authorization';
  end if;

  -- One float per authorisation, and it belongs to the first session.
  v_float := case when v_auth.float_session_id is null then v_auth.opening_float_ugx else 0 end;
  select full_name into v_name from public.users where id = auth.uid();
  v_number := app.next_reference('session_number_seq', 'RMX-AHS-');

  insert into public.after_hours_sessions
    (session_number, staff_uid, staff_name, authorization_id, authorization_number,
     authorization_expires_at, supervisor_uid, supervisor_name, opening_float_ugx,
     expected_cash_ugx, notes, request_id)
  values
    (v_number, auth.uid(), coalesce(v_name, auth.uid()::text), v_auth.id,
     v_auth.authorization_number, v_auth.expires_at, v_auth.granted_by, v_auth.granted_by_name,
     v_float, v_float, app.optional_text(p_notes, 'Notes', 500), p_request_id)
  returning id into v_id;

  if v_float > 0 then
    update public.after_hours_access
       set float_session_id = v_id, updated_at = now() where id = v_auth.id;
    insert into public.after_hours_cash
      (entry_number, kind, session_id, session_number, staff_uid, staff_name,
       method, amount_ugx, cash_delta_ugx, affects_expected, created_by)
    values
      (app.next_reference('custody_number_seq', 'RMX-AHC-'), 'opening_float', v_id, v_number,
       auth.uid(), coalesce(v_name, auth.uid()::text), 'cash', v_float, v_float, true, auth.uid());
  end if;

  perform app.audit('after_hours.session_opened', 'after_hours', v_id::text, null,
    v_number, null, null,
    jsonb_build_object('sessionNumber', v_number,
                       'authorizationNumber', v_auth.authorization_number,
                       'openingFloatUgx', v_float));

  perform app.complete_request(p_request_id, jsonb_build_object(
    'sessionId', v_id, 'sessionNumber', v_number, 'openingFloatUgx', v_float));

  return query select v_id, v_number, v_float;
end;
$$;

/* The expected cash, worked out from the session's PAYMENTS. */
create or replace function app.expected_from_payments(p_session uuid, p_float bigint)
returns table (expected_cash_ugx bigint, cash_net_ugx bigint, cash_reversed_ugx bigint,
               non_cash_ugx bigint, payment_count integer)
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select p_float + coalesce(sum(p.amount_ugx)
           filter (where p.method = 'cash' and p.status <> 'reversed'), 0)::bigint,
         coalesce(sum(p.amount_ugx)
           filter (where p.method = 'cash' and p.status <> 'reversed'), 0)::bigint,
         coalesce(sum(p.amount_ugx)
           filter (where p.method = 'cash' and p.status = 'reversed'), 0)::bigint,
         coalesce(sum(p.amount_ugx)
           filter (where p.method <> 'cash' and p.status <> 'reversed'), 0)::bigint,
         count(*)::integer
    from public.payments p where p.after_hours_session_id = p_session;
$$;

/*
 * Ends a session. The expected cash is RECALCULATED from the payments — not
 * taken from the running total — and frozen on a handover when there is cash
 * to hand over.
 *
 * This works after the authorisation has ended or been revoked: whoever holds
 * the cash still has to hand it over.
 */
create or replace function app.close_after_hours_session(
  p_session uuid,
  p_notes   text default null
)
returns table (session_id uuid, status text, expected_cash_ugx bigint,
               handover_id uuid, handover_number text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_s      public.after_hours_sessions%rowtype;
  v_calc   record;
  v_notes  text := app.optional_text(p_notes, 'Notes', 500);
  v_status text;
  v_hid    uuid;
  v_hnum   text;
begin
  perform app.require_permission('after_hours.request', 'after_hours.approve');
  select * into v_s from public.after_hours_sessions where id = p_session for update;
  if v_s.id is null then
    raise exception 'That after-hours session could not be found.'
      using errcode = 'no_data_found', detail = 'session_not_found';
  end if;
  if v_s.staff_uid <> auth.uid() and not app.has_permission('after_hours.approve') then
    raise exception 'You can only close your own after-hours session.'
      using errcode = 'insufficient_privilege', detail = 'not_owner';
  end if;
  if v_s.status <> 'open' then
    raise exception 'This session is not open.'
      using errcode = 'invalid_parameter_value', detail = 'session_not_open';
  end if;

  select * into v_calc from app.expected_from_payments(p_session, v_s.opening_float_ugx);
  v_status := case when v_calc.expected_cash_ugx > 0 then 'handover_pending' else 'closed' end;

  if v_calc.expected_cash_ugx > 0 then
    v_hnum := app.next_reference('handover_number_seq', 'RMX-HO-');
    insert into public.cash_handovers
      (handover_number, session_id, session_number, authorization_id, staff_uid, staff_name,
       opening_float_ugx, cash_collected_ugx, cash_reversed_ugx, non_cash_collected_ugx,
       payment_count, expected_cash_ugx)
    values
      (v_hnum, p_session, v_s.session_number, v_s.authorization_id, v_s.staff_uid, v_s.staff_name,
       v_s.opening_float_ugx, v_calc.cash_net_ugx, v_calc.cash_reversed_ugx, v_calc.non_cash_ugx,
       v_calc.payment_count, v_calc.expected_cash_ugx)
    returning id into v_hid;
  end if;

  update public.after_hours_sessions s
     set status = v_status, closed_at = now(), closed_by = auth.uid(),
         closed_by_name = (select full_name from public.users where id = auth.uid()),
         close_notes = v_notes,
         expected_cash_ugx = v_calc.expected_cash_ugx,
         cash_collected_ugx = v_calc.cash_net_ugx + v_calc.cash_reversed_ugx,
         cash_reversed_ugx = v_calc.cash_reversed_ugx,
         handover_id = v_hid, handover_number = v_hnum,
         handover_status = case when v_hid is null then null else 'pending' end,
         updated_at = now()
   where s.id = p_session;

  perform app.audit('after_hours.session_closed', 'after_hours', p_session::text, null,
    v_s.session_number, v_notes,
    jsonb_build_object('status', 'open', 'runningExpectedCashUgx', v_s.expected_cash_ugx),
    jsonb_build_object('status', v_status, 'expectedCashUgx', v_calc.expected_cash_ugx,
                       'handoverNumber', v_hnum));

  if v_hid is not null then
    insert into public.after_hours_events (type, reference_type, reference_id, audience,
                                           recipient_uid, payload)
    values ('cash_handover_pending', 'handover', v_hid, 'cash_handover.approve', null,
            jsonb_build_object('handoverNumber', v_hnum,
                               'expectedCashUgx', v_calc.expected_cash_ugx));
    if v_s.staff_uid <> auth.uid() then
      insert into public.after_hours_events (type, reference_type, reference_id, audience,
                                             recipient_uid, payload)
      values ('cash_handover_pending', 'handover', v_hid, 'recipient', v_s.staff_uid,
              jsonb_build_object('handoverNumber', v_hnum));
    end if;
  end if;

  return query select p_session, v_status, v_calc.expected_cash_ugx, v_hid, v_hnum;
end;
$$;

/* A session opened by mistake: nothing collected, no float, with a reason. */
create or replace function app.cancel_after_hours_session(p_session uuid, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_s      public.after_hours_sessions%rowtype;
  v_reason text := app.require_reason(p_reason);
begin
  perform app.require_permission('after_hours.request', 'after_hours.approve');
  select * into v_s from public.after_hours_sessions where id = p_session for update;
  if v_s.id is null then
    raise exception 'That after-hours session could not be found.'
      using errcode = 'no_data_found', detail = 'session_not_found';
  end if;
  if v_s.staff_uid <> auth.uid() and not app.has_permission('after_hours.approve') then
    raise exception 'You can only cancel your own after-hours session.'
      using errcode = 'insufficient_privilege', detail = 'not_owner';
  end if;
  if v_s.status <> 'open' then
    raise exception 'Only an open session can be cancelled.'
      using errcode = 'invalid_parameter_value', detail = 'session_not_open';
  end if;
  if exists (select 1 from public.payments where after_hours_session_id = p_session) then
    raise exception 'Payments were recorded in this session. Close it and hand over instead.'
      using errcode = 'invalid_parameter_value', detail = 'has_payments';
  end if;
  if v_s.opening_float_ugx > 0 then
    raise exception 'This session holds an opening float. Close it and hand the float back.'
      using errcode = 'invalid_parameter_value', detail = 'has_float';
  end if;

  update public.after_hours_sessions
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         cancel_reason = v_reason, updated_at = now()
   where id = p_session;

  perform app.audit('after_hours.session_cancelled', 'after_hours', p_session::text, null,
    v_s.session_number, v_reason,
    jsonb_build_object('status', 'open'), jsonb_build_object('status', 'cancelled'));
  return 'cancelled';
end;
$$;
