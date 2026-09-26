-- ===========================================================================
-- RamosMAX Web — 0055: the first administrator
-- ===========================================================================
-- `app.create_user` requires `users.create`, which only an administrator holds.
-- On a brand-new project there is no administrator, so that door cannot be the
-- first one used. This is the only other door, and it can be used exactly once.
--
-- It is NOT a bypass. It writes the same row `app.create_user` writes — active,
-- password set, and `must_change_password` TRUE, so the first thing the first
-- administrator does is replace the password nobody chose — and it writes the
-- same audit entry, marked so the trail shows plainly that this was the
-- installation and not an ordinary creation.
--
-- What it refuses:
--   * any call once an administrator exists who could have made it themselves,
--     whether or not that administrator is active — a deactivated one is
--     reactivated, not replaced;
--   * a caller that is not the service role;
--   * an identity that is not a RamosMAX sign-in identity;
--   * an identity that has no credential, or already has a profile.
--
-- Because the sign-in flow is unchanged — phone number, throttle, hidden
-- identity, credential, profile decision, forced change — the account it makes
-- signs in through the ordinary login form like any other.
-- ===========================================================================

create or replace function app.bootstrap_first_admin(
  p_auth_user uuid,
  p_phone     text,
  p_full_name text,
  p_staff_id  text default null
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
  v_email text;
begin
  -- Once anybody can administer this installation, this function is closed
  -- for good. It is not a way to add an administrator; it is a way to have
  -- the first one.
  if exists (select 1 from public.users where role = 'admin') then
    raise exception 'This installation already has an administrator. Create further accounts from User management.'
      using errcode = 'insufficient_privilege', detail = 'admin_exists';
  end if;

  select a.email into v_email from auth.users a where a.id = p_auth_user;
  if v_email is null then
    raise exception 'Create the sign-in credential first.'
      using errcode = 'no_data_found', detail = 'identity_not_found';
  end if;
  if not app.is_sign_in_identity(v_email) then
    raise exception 'That credential is not a RamosMAX sign-in identity.'
      using errcode = 'invalid_parameter_value', detail = 'identity';
  end if;
  if exists (select 1 from public.users where id = p_auth_user) then
    raise exception 'That credential already belongs to an account.'
      using errcode = 'unique_violation', detail = 'user_exists';
  end if;

  -- The same validation `app.create_user` applies, in the same order.
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
  if p_staff_id is not null and upper(btrim(p_staff_id)) !~ '^[A-Z0-9-]{3,32}$' then
    raise exception 'Staff IDs use capital letters, digits and dashes, e.g. RMX-STF-0001.'
      using errcode = 'invalid_parameter_value', detail = 'staff_id';
  end if;

  insert into public.users
    (id, phone_number, full_name, role, active, staff_id,
     password_set, must_change_password, created_by, updated_by)
  values
    (p_auth_user, v_phone, v_name, 'admin', true, nullif(upper(btrim(p_staff_id)), ''),
     true, true, p_auth_user, p_auth_user);

  -- There is nobody else to attribute this to, so the entry is attributed to
  -- the account itself. Setting the claim for the rest of this transaction is
  -- what lets `app.audit` write a trail with no caller behind it.
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_auth_user, 'role', 'authenticated')::text, true);

  perform app.audit('user.created', 'users', p_auth_user::text, p_auth_user,
    null, 'First administrator, created when the installation was set up', null,
    jsonb_build_object('role', 'admin', 'phoneNumber', app.mask_phone(v_phone),
                       'bootstrap', true));

  return p_auth_user;
end;
$$;

comment on function app.bootstrap_first_admin(uuid, text, text, text) is
  'The first administrator of a new installation. Refuses once any administrator exists. Server-only.';

-- Server-only, exactly as `app.create_user` is: it pairs with a credential
-- that only the service role can create.
revoke all on function app.bootstrap_first_admin(uuid, text, text, text)
  from anon, authenticated;

revoke execute on all functions in schema app from public;
revoke execute on all functions in schema app from anon;
alter default privileges in schema app revoke execute on functions from public;
