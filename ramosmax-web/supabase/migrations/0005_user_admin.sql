-- ===========================================================================
-- RamosMAX Web — Phase B — 0005: user administration
-- ===========================================================================
-- Ports functions/src/user_admin.js and the guards in functions/src/access.js.
--
-- Every function here is SECURITY DEFINER and begins by re-checking the
-- caller, exactly as each callable Cloud Function does. The client holds no
-- INSERT/UPDATE/DELETE privilege on public.users or public.temporary_grants,
-- so these functions are the ONLY way the access model changes.
--
-- Each writes its audit entry inside the SAME transaction as the change.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Guards ported from access.js
-- ---------------------------------------------------------------------------

create or replace function app.require_not_self(p_target uuid, p_message text)
returns void
language plpgsql
stable
as $$
begin
  if auth.uid() = p_target then
    raise exception '%', p_message using errcode = 'insufficient_privilege', detail = 'self_modification';
  end if;
end;
$$;

-- Admin accounts are managed only by admins; everyone else may manage only
-- roles ranked BELOW their own (a peer rank is refused).
create or replace function app.require_can_administer(p_target uuid)
returns void
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_actor_role  text := app.current_role_id();
  v_target_role text;
begin
  select role into v_target_role from public.users where id = p_target;
  if v_target_role is null then
    raise exception 'That account could not be found.'
      using errcode = 'no_data_found', detail = 'target';
  end if;

  if v_actor_role = 'admin' then return; end if;

  if v_target_role = 'admin' then
    raise exception 'Only an Administrator can manage Administrator accounts.'
      using errcode = 'insufficient_privilege', detail = 'admin_target';
  end if;

  if (select rank from app.roles where id = v_target_role)
     >= (select rank from app.roles where id = v_actor_role) then
    raise exception 'You can only manage accounts with a more junior role than yours.'
      using errcode = 'insufficient_privilege', detail = 'rank';
  end if;
end;
$$;

create or replace function app.require_can_assign_role(p_role text)
returns void
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_actor_role text := app.current_role_id();
begin
  if not exists (select 1 from app.roles where id = p_role) then
    raise exception 'Choose a valid role.' using errcode = 'invalid_parameter_value', detail = 'role';
  end if;
  if v_actor_role = 'admin' then return; end if;

  if p_role = 'admin' then
    raise exception 'Only an Administrator can assign the Administrator role.'
      using errcode = 'insufficient_privilege', detail = 'assign_admin';
  end if;
  if (select rank from app.roles where id = p_role)
     >= (select rank from app.roles where id = v_actor_role) then
    raise exception 'You cannot assign a role at or above your own.'
      using errcode = 'insufficient_privilege', detail = 'rank';
  end if;
end;
$$;

-- Password resets: Admins for anyone they may administer; everyone else only
-- for the roles flagged password_resettable_by_non_admin — by default Workers
-- ONLY, not Cashiers, even though Cashiers rank below Managers.
create or replace function app.require_can_reset_password(p_target uuid)
returns void
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_target_role text;
begin
  perform app.require_can_administer(p_target);
  if app.current_role_id() = 'admin' then return; end if;

  select role into v_target_role from public.users where id = p_target;
  if not (select password_resettable_by_non_admin from app.roles where id = v_target_role) then
    raise exception 'You can only reset passwords for Workers.'
      using errcode = 'insufficient_privilege', detail = 'reset_scope';
  end if;
end;
$$;

-- Administrators always keep user-management access; change the role instead.
create or replace function app.require_allowed_denials(p_target_role text, p_denied text[])
returns void
language plpgsql
immutable
as $$
begin
  if p_target_role <> 'admin' then return; end if;
  if exists (select 1 from unnest(p_denied) d where d like 'users.%') then
    raise exception 'Administrators always keep user-management access. Change the role instead.'
      using errcode = 'invalid_parameter_value', detail = 'admin_user_permissions';
  end if;
end;
$$;

-- LAST-ADMINISTRATOR PROTECTION — ports requireAnotherActiveAdmin().
--
-- The other Administrators are counted with isAccountLive semantics, NOT
-- merely `active`: an Administrator who is locked out by a pending password
-- change, or whose access period has ended, cannot actually administer
-- anything and so is not a safety net.
create or replace function app.is_account_live(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select app.is_account_enabled(p_user)
     and coalesce((select not must_change_password from public.users where id = p_user), false);
$$;

create or replace function app.require_another_active_admin(p_target uuid)
returns void
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.users u
     where u.role = 'admin' and u.id <> p_target and app.is_account_live(u.id)
  ) then
    raise exception 'RamosMAX must always have at least one active Administrator. Add another Administrator first.'
      using errcode = 'restrict_violation', detail = 'last_admin';
  end if;
end;
$$;

create or replace function app.require_valid_permissions(p_keys text[])
returns void
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_unknown text;
begin
  select k into v_unknown
    from unnest(coalesce(p_keys, '{}')) k
   where not exists (select 1 from app.permissions where key = k)
   limit 1;
  if v_unknown is not null then
    raise exception 'One of the selected permissions is not recognised.'
      using errcode = 'invalid_parameter_value', detail = 'permission';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- set_user_role
-- ---------------------------------------------------------------------------

create or replace function app.set_user_role(p_target uuid, p_role text, p_reason text default null)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_previous    text;
  v_was_active  boolean;
begin
  perform app.require_permission('users.roles.manage');
  perform app.require_not_self(p_target, 'You cannot change your own role.');
  perform app.require_can_administer(p_target);
  perform app.require_can_assign_role(p_role);

  select role, active into v_previous, v_was_active from public.users where id = p_target;
  if v_previous = p_role then
    raise exception 'The user already has this role.'
      using errcode = 'invalid_parameter_value', detail = 'no_changes';
  end if;

  -- A promotion to Administrator must not leave existing user-management
  -- denials in place, as requireAllowedDenials checks in the reference.
  perform app.require_allowed_denials(p_role,
    (select denied_permissions from public.users where id = p_target));

  -- Demoting the last live Administrator is refused.
  if v_previous = 'admin' and v_was_active then
    perform app.require_another_active_admin(p_target);
  end if;

  update public.users
     set role = p_role,
         -- Specialisation describes a worker's trade; it means nothing else.
         specialization = case when p_role = 'worker' then specialization else null end,
         updated_by = auth.uid()
   where id = p_target;

  perform app.audit('user.role_changed', 'users', p_target::text, p_target,
    null, p_reason,
    jsonb_build_object('role', v_previous), jsonb_build_object('role', p_role));
end;
$$;

-- ---------------------------------------------------------------------------
-- set_user_active
-- ---------------------------------------------------------------------------

create or replace function app.set_user_active(p_target uuid, p_active boolean, p_reason text default null)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_previous boolean;
begin
  perform app.require_permission(case when p_active then 'users.activate' else 'users.deactivate' end);
  perform app.require_not_self(p_target, case when p_active
    then 'You cannot activate your own account.'
    else 'You cannot deactivate your own account.' end);
  perform app.require_can_administer(p_target);

  select active into v_previous from public.users where id = p_target;
  if v_previous = p_active then
    raise exception '%', case when p_active
      then 'This account is already active.' else 'This account is already inactive.' end
      using errcode = 'invalid_parameter_value', detail = 'no_changes';
  end if;

  -- Deactivating the last live Administrator is refused.
  if not p_active and (select role from public.users where id = p_target) = 'admin' then
    perform app.require_another_active_admin(p_target);
  end if;

  update public.users set active = p_active, updated_by = auth.uid() where id = p_target;

  perform app.audit(
    case when p_active then 'user.activated' else 'user.deactivated' end,
    'users', p_target::text, p_target, null, p_reason,
    jsonb_build_object('active', v_previous), jsonb_build_object('active', p_active));
end;
$$;

-- ---------------------------------------------------------------------------
-- set_user_permissions — permanent grants and denials
-- ---------------------------------------------------------------------------

create or replace function app.set_user_permissions(
  p_target  uuid,
  p_granted text[],
  p_denied  text[],
  p_reason  text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_target_role text;
  v_previous    jsonb;
  v_key         text;
begin
  perform app.require_permission('users.permissions.manage');
  perform app.require_can_administer(p_target);
  perform app.require_valid_permissions(p_granted);
  perform app.require_valid_permissions(p_denied);

  select role into v_target_role from public.users where id = p_target;
  perform app.require_allowed_denials(v_target_role, coalesce(p_denied, '{}'));

  -- Nobody may hand out a permission they do not hold themselves, and only an
  -- Administrator may hand out an admin-only permission. Lifting a denial is
  -- also a grant, so the same check applies.
  foreach v_key in array coalesce(p_granted, '{}') loop
    perform app.require_not_authorization_only(v_key);
    perform app.require_can_grant(v_key);
  end loop;

  select jsonb_build_object('permissions', permissions, 'deniedPermissions', denied_permissions)
    into v_previous from public.users where id = p_target;

  update public.users
     set permissions        = (select coalesce(array_agg(distinct k order by k), '{}')
                                 from unnest(coalesce(p_granted, '{}')) k),
         denied_permissions = (select coalesce(array_agg(distinct k order by k), '{}')
                                 from unnest(coalesce(p_denied, '{}')) k),
         updated_by         = auth.uid()
   where id = p_target;

  perform app.audit('user.permissions_changed', 'users', p_target::text, p_target,
    null, p_reason, v_previous,
    jsonb_build_object('permissions', p_granted, 'deniedPermissions', p_denied));
end;
$$;

-- ---------------------------------------------------------------------------
-- grant_temporary_permission / revoke_temporary_permission
-- ---------------------------------------------------------------------------
-- A grant is effective ONLY inside its window, evaluated against the server
-- clock by app.effective_permissions(). It therefore starts and stops being
-- honoured on time WITH NO CLEANUP JOB. Never make expiry depend on a sweep.

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
  v_start timestamptz := coalesce(p_starts_at, now());
begin
  perform app.require_permission('users.permissions.temporary');
  perform app.require_can_administer(p_target);
  perform app.require_valid_permissions(array[p_permission]);
  -- after_hours.operate / after_hours.cash.collect come ONLY from an
  -- after-hours authorisation, never from the generic temporary-access editor.
  perform app.require_not_authorization_only(p_permission);
  perform app.require_can_grant(p_permission);

  -- access.js requireTemporaryWindow: a start in the recent past is treated as
  -- now (5 minutes of tolerated clock skew), the window must be positive, and
  -- it may last at most 30 days and begin at most 30 days ahead.
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

create or replace function app.revoke_temporary_permission(p_grant uuid, p_reason text default null)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_grant public.temporary_grants%rowtype;
begin
  perform app.require_permission('users.permissions.temporary');

  select * into v_grant from public.temporary_grants where id = p_grant;
  if v_grant.id is null then
    raise exception 'That temporary grant could not be found.'
      using errcode = 'no_data_found', detail = 'grant';
  end if;
  perform app.require_can_administer(v_grant.user_id);

  if v_grant.revoked_at is not null then
    raise exception 'That temporary access has already been revoked.'
      using errcode = 'invalid_parameter_value', detail = 'already_revoked';
  end if;

  update public.temporary_grants
     set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = p_reason
   where id = p_grant;

  perform app.audit('user.temporary_permission_revoked', 'users', p_grant::text,
    v_grant.user_id, null, p_reason,
    jsonb_build_object('permission', v_grant.permission_key), null);
end;
$$;

-- ---------------------------------------------------------------------------
-- prepare_password_reset — the profile half of resetUserPassword
-- ---------------------------------------------------------------------------
-- The caller (a server-side route holding the service role) generates and sets
-- the temporary password with Supabase Auth, then calls this to mark the
-- account as requiring a change. Returns the generated password ONCE so an
-- administrator can pass it on; it is never stored.

create or replace function app.prepare_password_reset(p_target uuid, p_reason text default null)
returns text
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_password text;
begin
  perform app.require_permission('users.passwords.reset');
  perform app.require_not_self(p_target,
    'Change your own password from your profile instead.');
  perform app.require_can_reset_password(p_target);

  v_password := app.generate_password(12);

  update public.users
     set must_change_password = true,
         password_set         = true,
         password_reset_at    = now(),
         password_reset_by    = auth.uid(),
         updated_by           = auth.uid()
   where id = p_target;

  -- The password itself is NEVER written to the audit trail.
  perform app.audit('user.password_reset', 'users', p_target::text, p_target,
    'Temporary password issued', p_reason, null,
    jsonb_build_object('mustChangePassword', true));

  return v_password;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_user — the profile half of createUser
-- ---------------------------------------------------------------------------
-- The auth.users row is created first by the server-side route through
-- Supabase Auth (with a hidden identity and a generated temporary password);
-- this records the RamosMAX profile in the same request.

create or replace function app.create_user(
  p_auth_user uuid,
  p_phone     text,
  p_full_name text,
  p_role      text,
  p_staff_id  text default null,
  p_reason    text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_phone text := app.normalize_phone(p_phone);
  v_name  text := regexp_replace(btrim(coalesce(p_full_name, '')), '\s+', ' ', 'g');
begin
  perform app.require_permission('users.create');
  perform app.require_can_assign_role(p_role);

  if v_phone is null then
    raise exception 'Enter a valid phone number, e.g. 0772 123 456.'
      using errcode = 'invalid_parameter_value', detail = 'phone';
  end if;
  if length(v_name) < 2 then
    raise exception 'Enter the full name.' using errcode = 'invalid_parameter_value', detail = 'name';
  end if;
  if length(v_name) > 80 then
    raise exception 'The name is too long (80 characters maximum).'
      using errcode = 'invalid_parameter_value', detail = 'name';
  end if;

  insert into public.users
    (id, phone_number, full_name, role, active, staff_id,
     password_set, must_change_password, created_by, updated_by)
  values
    (p_auth_user, v_phone, v_name, p_role, true, p_staff_id,
     true, true, auth.uid(), auth.uid());

  perform app.audit('user.created', 'users', p_auth_user::text, p_auth_user,
    null, p_reason, null,
    jsonb_build_object('role', p_role, 'phoneNumber', app.mask_phone(v_phone)));

  return p_auth_user;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
-- These RPCs are callable by a signed-in user; each re-checks the caller's
-- permissions itself. The ones that pair with a Supabase Auth side effect are
-- server-only and are NOT granted to the browser.

grant execute on function
  app.set_user_role(uuid, text, text),
  app.set_user_active(uuid, boolean, text),
  app.set_user_permissions(uuid, text[], text[], text),
  app.grant_temporary_permission(uuid, text, timestamptz, timestamptz, text),
  app.revoke_temporary_permission(uuid, text)
to authenticated;

revoke all on function
  app.create_user(uuid, text, text, text, text, text),
  app.prepare_password_reset(uuid, text)
from anon, authenticated;
