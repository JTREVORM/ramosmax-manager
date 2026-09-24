-- ===========================================================================
-- RamosMAX Web — Phase A — 0003: access helpers and Phase A RLS policies
-- ===========================================================================
-- Direct translation of firebase/firestore.rules and functions/src/access.js.
-- Each function below names the rule it reproduces. These are the foundation
-- every later phase's RLS policy is built on, so they are deliberately small,
-- STABLE and individually testable.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- isSignedIn()
-- ---------------------------------------------------------------------------

create or replace function app.is_signed_in()
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select auth.uid() is not null;
$$;

-- ---------------------------------------------------------------------------
-- isActive()
-- ---------------------------------------------------------------------------
-- A RamosMAX session requires BOTH a Supabase Auth sign-in AND an active
-- business profile. Being signed in on its own grants nothing.
--
-- `must_change_password` counts as inactive: until the person replaces a
-- temporary password they can read their own profile and nothing else, so the
-- forced change cannot be skipped by a modified client.
--
-- `access_expires_at` ends the whole account's access without anyone having to
-- remember to deactivate it.

create or replace function app.is_active()
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select exists (
    select 1
      from public.users u
     where u.id = auth.uid()
       and u.active
       and u.must_change_password is not true
       and (u.access_expires_at is null or u.access_expires_at > now())
  );
$$;

-- ---------------------------------------------------------------------------
-- role()  — 'none' unless the account is active, as in the rules
-- ---------------------------------------------------------------------------

create or replace function app.current_role_id()
returns text
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select coalesce(
    (select u.role from public.users u where u.id = auth.uid() and app.is_active()),
    'none'
  );
$$;

create or replace function app.is_admin()
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select app.current_role_id() = 'admin';
$$;

-- ---------------------------------------------------------------------------
-- effectivePermissions()
-- ---------------------------------------------------------------------------
--   (role defaults ∪ direct grants ∪ LIVE temporary grants) − explicit denials
--
-- Empty for inactive, expired or must-change-password accounts, exactly as
-- access.js effectivePermissions() returns an empty Set for them.
--
-- A temporary grant is live only inside its window, evaluated against the
-- SERVER clock. It therefore starts and stops being honoured on time with no
-- cleanup job. The 15-minute sweep is housekeeping and "ending soon" notices
-- only — never the thing that makes a grant expire.

create or replace function app.effective_permissions(p_user uuid default auth.uid())
returns text[]
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  with live as (
    select u.*
      from public.users u
     where u.id = p_user
       and u.active
       and u.must_change_password is not true
       and (u.access_expires_at is null or u.access_expires_at > now())
  ),
  granted as (
    -- role defaults (admin is grants_all and is expanded to the whole catalogue)
    select p.key
      from live
      join app.roles r on r.id = live.role
      join app.permissions p
        on r.grants_all
        or exists (
             select 1 from app.role_permissions rp
              where rp.role_id = r.id and rp.permission_key = p.key
           )
    union
    -- direct grants (ignoring anything not in the catalogue, as access.js does)
    select p.key
      from live
      join app.permissions p on p.key = any (live.permissions)
    union
    -- live temporary grants
    select tg.permission_key
      from live
      join public.temporary_grants tg on tg.user_id = live.id
     where tg.revoked_at is null
       and tg.starts_at  <= now()
       and tg.expires_at >  now()
  )
  select coalesce(array_agg(g.key order by g.key), '{}')
    from granted g
   where not exists (
     select 1 from live where g.key = any (live.denied_permissions)
   );
$$;

comment on function app.effective_permissions(uuid) is
  'Ports access.js effectivePermissions(). Used by every RLS policy — keep it STABLE and indexed.';

-- ---------------------------------------------------------------------------
-- hasPermission() / hasEitherPermission() / ownWith()
-- ---------------------------------------------------------------------------

create or replace function app.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select p_permission = any (app.effective_permissions());
$$;

create or replace function app.has_either_permission(p_a text, p_b text)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select app.effective_permissions() && array[p_a, p_b];
$$;

-- ownWith(): a person's own record, when they hold the "view own" permission.
create or replace function app.own_with(p_permission text, p_subject uuid)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select p_subject = auth.uid() and app.has_permission(p_permission);
$$;

-- ---------------------------------------------------------------------------
-- Guards ported from access.js, for use by Phase B+ mutation functions
-- ---------------------------------------------------------------------------

create or replace function app.require_active()
returns void
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
begin
  if not app.is_active() then
    raise exception 'Your RamosMAX account is not active.'
      using errcode = 'insufficient_privilege', detail = 'actor_inactive';
  end if;
end;
$$;

create or replace function app.require_permission(variadic p_any_of text[])
returns void
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
begin
  perform app.require_active();
  if not (app.effective_permissions() && p_any_of) then
    raise exception 'You do not have permission to do this.'
      using errcode = 'insufficient_privilege', detail = 'forbidden';
  end if;
end;
$$;

-- Only an Admin may hand out an admin-only permission, and nobody may grant a
-- permission they do not hold themselves (access.js requireCanGrant).
create or replace function app.require_can_grant(p_permission text)
returns void
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_admin_only boolean;
begin
  select is_admin_only into v_admin_only from app.permissions where key = p_permission;
  if v_admin_only is null then
    raise exception 'Unknown permission.' using errcode = 'invalid_parameter_value', detail = 'permission';
  end if;
  if v_admin_only and not app.is_admin() then
    raise exception 'Only an Administrator can grant this permission.'
      using errcode = 'insufficient_privilege', detail = 'admin_only_permission';
  end if;
  if not app.has_permission(p_permission) then
    raise exception 'You cannot grant a permission you do not hold yourself.'
      using errcode = 'insufficient_privilege', detail = 'not_held';
  end if;
end;
$$;

-- Never granted permanently or through the generic temporary-access editor
-- (access.js requireNotAuthorizationOnly).
create or replace function app.require_not_authorization_only(p_permission text)
returns void
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
begin
  if exists (select 1 from app.permissions where key = p_permission and is_authorization_only) then
    raise exception 'This permission is given only by an after-hours authorisation (After-Hours -> Authorise).'
      using errcode = 'invalid_parameter_value', detail = 'authorization_only';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Phone normalisation — ports access.js normalizePhone() exactly
-- ---------------------------------------------------------------------------
-- Uganda: 0772123456 / 256772123456 / +256772123456 -> +256772123456, with the
-- leading digit restricted to 3, 4 or 7. Other countries must already be E.164.
-- Returns null when the input is not a valid number.

create or replace function app.normalize_phone(p_input text)
returns text
language plpgsql
immutable
as $$
declare
  v text;
begin
  if p_input is null then return null; end if;
  v := regexp_replace(p_input, '[^0-9+]', '', 'g');

  if v like '+%' then
    if v !~ '^\+[1-9][0-9]{7,14}$' then return null; end if;
    if v like '+256%' and v !~ '^\+256[347][0-9]{8}$' then return null; end if;
    return v;
  end if;

  if v like '256%' and length(v) > 9 then v := substr(v, 4); end if;
  if v like '0%' then v := substr(v, 2); end if;
  if v ~ '^[347][0-9]{8}$' then return '+256' || v; end if;
  return null;
end;
$$;

-- `+256 772 •••456` — phone numbers are masked in audit entries (access.js maskPhone).
create or replace function app.mask_phone(p_e164 text)
returns text
language sql
immutable
as $$
  select case
    when p_e164 is null or length(p_e164) < 7 then p_e164
    else left(p_e164, length(p_e164) - 6) || '...' || right(p_e164, 3)
  end;
$$;

-- ---------------------------------------------------------------------------
-- East Africa Time business day
-- ---------------------------------------------------------------------------
-- Attendance, allowances, daily summaries and report periods are all keyed to
-- the EAT business day, never to UTC.

create or replace function app.eat_day(p_at timestamptz default now())
returns date
language sql
immutable
as $$
  select (p_at at time zone 'Africa/Kampala')::date;
$$;

-- ---------------------------------------------------------------------------
-- Audit helper — called INSIDE the same transaction as the change it records
-- ---------------------------------------------------------------------------

create or replace function app.audit(
  p_action    text,
  p_module    text,
  p_record_id text default null,
  p_target    uuid default null,
  p_description text default null,
  p_reason    text default null,
  p_previous  jsonb default null,
  p_new       jsonb default null
)
returns void
language sql
security definer
set search_path = app, public, pg_temp
as $$
  insert into public.audit_logs
    (user_id, user_role, action, module, record_id, target_user_id,
     description, reason, previous_value, new_value, source)
  values
    (auth.uid(), app.current_role_id(), p_action, p_module, p_record_id, p_target,
     p_description, p_reason, p_previous, p_new, 'server');
$$;

-- ===========================================================================
-- Phase A RLS policies
-- ===========================================================================
-- SELECT-only grants. No INSERT/UPDATE/DELETE privilege is granted to
-- `authenticated` on any table — the equivalent of "allow write: if false".

-- --- reference catalogue: readable by any signed-in user -------------------

drop policy if exists roles_read on app.roles;
create policy roles_read on app.roles
  for select to authenticated using (app.is_signed_in());

drop policy if exists permission_groups_read on app.permission_groups;
create policy permission_groups_read on app.permission_groups
  for select to authenticated using (app.is_signed_in());

drop policy if exists permissions_read on app.permissions;
create policy permissions_read on app.permissions
  for select to authenticated using (app.is_signed_in());

drop policy if exists role_permissions_read on app.role_permissions;
create policy role_permissions_read on app.role_permissions
  for select to authenticated using (app.is_signed_in());

grant select on app.roles, app.permission_groups, app.permissions, app.role_permissions
  to authenticated;

-- --- users ----------------------------------------------------------------
-- allow get: own profile, or users.view. allow list: users.view.
-- A signed-in (not yet active) user must still be able to read their OWN
-- profile, otherwise a forced password change could never be completed.

drop policy if exists users_read on public.users;
create policy users_read on public.users
  for select to authenticated
  using (id = auth.uid() or app.has_permission('users.view'));

-- Self-service: session bookkeeping only. role, active, permissions,
-- denied_permissions, staff_id and every credential field are NOT writable
-- here. The column allow-list is enforced by the trigger below, because RLS
-- alone cannot restrict WHICH columns change.
drop policy if exists users_self_update on public.users;
create policy users_self_update on public.users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create or replace function app.guard_users_self_update()
returns trigger
language plpgsql
as $$
begin
  -- SECURITY DEFINER functions run as the table owner and bypass this guard;
  -- only a direct client UPDATE reaches it as a non-owner.
  if current_user = session_user and auth.uid() = new.id then
    if new.role                 is distinct from old.role
    or new.active               is distinct from old.active
    or new.permissions          is distinct from old.permissions
    or new.denied_permissions   is distinct from old.denied_permissions
    or new.access_expires_at    is distinct from old.access_expires_at
    or new.staff_id             is distinct from old.staff_id
    or new.must_change_password is distinct from old.must_change_password
    or new.password_set         is distinct from old.password_set
    or new.phone_number         is distinct from old.phone_number
    then
      raise exception 'Only session fields may be updated by the account holder.'
        using errcode = 'insufficient_privilege', detail = 'self_update_scope';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists users_self_update_guard on public.users;
create trigger users_self_update_guard
  before update on public.users
  for each row execute function app.guard_users_self_update();

grant select on public.users to authenticated;
grant update (last_login_at, notification_preferences) on public.users to authenticated;

-- --- temporary_grants -----------------------------------------------------
-- History of temporary grants: own, or users.view.

drop policy if exists temporary_grants_read on public.temporary_grants;
create policy temporary_grants_read on public.temporary_grants
  for select to authenticated
  using ((user_id = auth.uid() and app.is_active()) or app.has_permission('users.view'));

grant select on public.temporary_grants to authenticated;

-- --- settings -------------------------------------------------------------
-- Read-only reference data for any active user.

drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings
  for select to authenticated using (app.is_active());

grant select on public.settings to authenticated;

-- --- audit_logs -----------------------------------------------------------
-- Append-only. Readable with audit.view. A client may append an entry only as
-- itself, with its own current role, and can NEVER pose as the server.
-- There is deliberately no UPDATE or DELETE policy, and the trigger in 0001
-- raises on both regardless.

drop policy if exists audit_read on public.audit_logs;
create policy audit_read on public.audit_logs
  for select to authenticated using (app.has_permission('audit.view'));

drop policy if exists audit_append on public.audit_logs;
create policy audit_append on public.audit_logs
  for insert to authenticated
  with check (
    app.is_active()
    and user_id   = auth.uid()
    and user_role = app.current_role_id()
    and source    = 'client'
    and target_user_id is null
    and reason         is null
  );

grant select on public.audit_logs to authenticated;
grant insert (user_id, user_role, action, module, record_id,
              description, previous_value, new_value, source)
  on public.audit_logs to authenticated;
