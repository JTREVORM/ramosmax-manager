-- ===========================================================================
-- RamosMAX Web — Phase B — 0004: authentication support functions
-- ===========================================================================
-- Ports functions/src/session.js and functions/src/passwords.js.
--
-- Division of responsibility, mirroring the reference implementation:
--   * Supabase Auth (GoTrue) holds the credential and issues the session, as
--     Firebase Authentication did. NO password, plain or hashed, is stored by
--     RamosMAX itself.
--   * Everything else — throttling, the account decision, the password policy,
--     the audit trail — is decided HERE, on the server, exactly as session.js
--     decided it in a Cloud Function.
--
-- The hidden sign-in identity is preserved: GoTrue's `email` is a random
-- address on the reserved .invalid domain, so it can never be derived from a
-- phone number and no mail can ever be delivered for it. People only ever type
-- a phone number.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Password policy — ports passwords.js passwordProblems()
-- ---------------------------------------------------------------------------
-- The server is authoritative. src/lib/auth/password-policy.ts mirrors this
-- for immediate form feedback; the parity tests run the same cases against both.

create or replace function app.password_problems(
  p_password text,
  p_phone     text default null,
  p_staff_id  text default null,
  p_full_name text default null
)
returns text[]
language plpgsql
immutable
as $$
declare
  -- NOTE: every append below casts explicitly to ::text. Without the cast,
  -- `text[] || 'literal'` resolves the untyped literal through the
  -- anyarray || anyarray operator and fails with "malformed array literal".
  v_problems text[] := '{}';
  v_lower    text;
  v_compact  text;
  v_digits   text;
  v_part     text;
  v_common   text[] := array[
    'password','password1','passw0rd','qwerty','qwerty123','12345678','123456789',
    'abc12345','letmein','welcome','welcome1','admin123','ramosmax','ramos123',
    'ramosmax1','changeme'
  ];
begin
  if p_password is null then return array['Enter a password.'::text]; end if;

  if length(p_password) < 8   then v_problems := v_problems || 'Use at least 8 characters.'::text; end if;
  if length(p_password) > 128 then v_problems := v_problems || 'Use at most 128 characters.'::text; end if;
  if p_password !~ '[A-Z]'    then v_problems := v_problems || 'Add an uppercase letter.'::text; end if;
  if p_password !~ '[a-z]'    then v_problems := v_problems || 'Add a lowercase letter.'::text; end if;
  if p_password !~ '[0-9]'    then v_problems := v_problems || 'Add a number.'::text; end if;
  if p_password !~ '[^A-Za-z0-9]' then
    v_problems := v_problems || 'Add a symbol, e.g. ! @ # $ %.'::text;
  end if;

  v_lower   := lower(p_password);
  v_compact := regexp_replace(v_lower, '[^a-z0-9]', '', 'g');
  if v_lower = any (v_common) or v_compact = any (v_common)
     or v_compact ~ '^(ramos|password|qwerty)' then
    v_problems := v_problems || 'This password is too easy to guess.'::text;
  end if;

  v_digits := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  if length(v_digits) >= 6
     and position(right(v_digits, 6) in regexp_replace(p_password, '[^0-9]', '', 'g')) > 0 then
    v_problems := v_problems || 'Do not use your phone number.'::text;
  end if;

  if p_staff_id is not null
     and position(regexp_replace(lower(p_staff_id), '[^a-z0-9]', '', 'g') in v_compact) > 0 then
    v_problems := v_problems || 'Do not use your staff ID.'::text;
  end if;

  foreach v_part in array regexp_split_to_array(lower(coalesce(p_full_name, '')), '\s+') loop
    if length(v_part) >= 4 and position(v_part in v_lower) > 0 then
      v_problems := v_problems || 'Do not use your name.'::text;
      exit;
    end if;
  end loop;

  return v_problems;
end;
$$;

-- ---------------------------------------------------------------------------
-- Temporary password generation — ports passwords.js generatePassword()
-- ---------------------------------------------------------------------------
-- 12 characters, cryptographically random, one from each class, no look-alike
-- characters (no 0/O/o, 1/l/I) so it can be read aloud or copied from a screen.

create or replace function app.generate_password(p_length integer default 12)
returns text
language plpgsql
volatile
as $$
declare
  v_upper   text := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_lower   text := 'abcdefghijkmnpqrstuvwxyz';
  v_digits  text := '23456789';
  v_special text := '!@#$%*?-+=';
  v_all     text;
  v_chars   text[];
  v_out     text;
  i         integer;
  j         integer;
  v_swap    text;
begin
  if p_length < 8 then p_length := 8; end if;
  v_all := v_upper || v_lower || v_digits || v_special;

  loop
    v_chars := array[
      substr(v_upper,   1 + floor(random() * length(v_upper))::int,   1),
      substr(v_lower,   1 + floor(random() * length(v_lower))::int,   1),
      substr(v_digits,  1 + floor(random() * length(v_digits))::int,  1),
      substr(v_special, 1 + floor(random() * length(v_special))::int, 1)
    ];
    while array_length(v_chars, 1) < p_length loop
      v_chars := v_chars || substr(v_all, 1 + floor(random() * length(v_all))::int, 1);
    end loop;

    -- Fisher-Yates, so the character-class order is not predictable.
    for i in reverse array_length(v_chars, 1)..2 loop
      j := 1 + floor(random() * i)::int;
      v_swap := v_chars[i]; v_chars[i] := v_chars[j]; v_chars[j] := v_swap;
    end loop;

    v_out := array_to_string(v_chars, '');
    exit when array_length(app.password_problems(v_out), 1) is null;
  end loop;

  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- The hidden sign-in identity — ports passwords.js newSignInIdentity()
-- ---------------------------------------------------------------------------

create or replace function app.new_sign_in_identity()
returns text
language sql
volatile
as $$
  select replace(gen_random_uuid()::text, '-', '') || '@users.ramosmax.invalid';
$$;

create or replace function app.is_sign_in_identity(p_email text)
returns boolean
language sql
immutable
as $$
  select p_email is not null and p_email like '%@users.ramosmax.invalid';
$$;

-- ---------------------------------------------------------------------------
-- Account state — ports access.js isAccountEnabled / isAccountLive
-- ---------------------------------------------------------------------------

create or replace function app.is_account_enabled(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select exists (
    select 1 from public.users u
     join app.roles r on r.id = u.role
     where u.id = p_user
       and u.active
       and (u.access_expires_at is null or u.access_expires_at > now())
  );
$$;

-- ---------------------------------------------------------------------------
-- Sign-in throttle — ports session.js
-- ---------------------------------------------------------------------------
-- MAX_FAILURES = 5 within THROTTLE_WINDOW = 15 minutes, then a 15-minute
-- lock-out. Keyed by sha256('ramosmax:' || phone) so no phone number is stored.

create or replace function app.phone_hash(p_phone text)
returns text
language sql
immutable
as $$
  select encode(digest('ramosmax:' || p_phone, 'sha256'), 'hex');
$$;

-- Returns the whole minutes remaining on a lock-out, or 0 when not locked.
create or replace function app.throttle_remaining_minutes(p_phone text)
returns integer
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select coalesce(
    (select greatest(1, ceil(extract(epoch from (t.locked_until - now())) / 60))::int
       from app.login_throttle t
      where t.phone_hash = app.phone_hash(p_phone)
        and t.locked_until is not null
        and t.locked_until > now()),
    0
  );
$$;

create or replace function app.record_sign_in_failure(p_phone text)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_hash    text := app.phone_hash(p_phone);
  v_first   timestamptz;
  v_fresh   boolean;
  v_failures integer;
begin
  select first_failure_at into v_first from app.login_throttle where phone_hash = v_hash;
  v_fresh := v_first is null or now() - v_first > interval '15 minutes';

  insert into app.login_throttle (phone_hash, failures, first_failure_at, locked_until, updated_at)
  values (v_hash, 1, now(), null, now())
  on conflict (phone_hash) do update
    set failures         = case when v_fresh then 1 else app.login_throttle.failures + 1 end,
        first_failure_at = case when v_fresh then now() else app.login_throttle.first_failure_at end,
        locked_until     = case
                             when (case when v_fresh then 1 else app.login_throttle.failures + 1 end) >= 5
                             then now() + interval '15 minutes'
                             else null
                           end,
        updated_at       = now()
  returning failures into v_failures;
end;
$$;

create or replace function app.clear_sign_in_failures(p_phone text)
returns void
language sql
volatile
security definer
set search_path = app, public, pg_temp
as $$
  delete from app.login_throttle where phone_hash = app.phone_hash(p_phone);
$$;

-- ---------------------------------------------------------------------------
-- Server-side audit for authentication events
-- ---------------------------------------------------------------------------
-- Written even when nobody is signed in (a failed sign-in has no session), so
-- this takes the subject explicitly rather than reading auth.uid().

create or replace function app.audit_auth(
  p_user        uuid,
  p_action      text,
  p_description text default null
)
returns void
language sql
volatile
security definer
set search_path = app, public, pg_temp
as $$
  insert into public.audit_logs
    (user_id, user_role, action, module, record_id, target_user_id, description, source)
  select p_user,
         coalesce((select role from public.users where id = p_user), 'none'),
         p_action, 'auth', p_user::text, p_user, p_description, 'server'
  where exists (select 1 from public.users where id = p_user);
$$;

-- ---------------------------------------------------------------------------
-- resolve_sign_in — the account decision, after the credential has been checked
-- ---------------------------------------------------------------------------
-- Ports the second half of session.js signInWithPhonePassword: the password is
-- already verified by Supabase Auth, and the RamosMAX PROFILE now decides.
--
-- Returns a single row: { outcome, must_change_password, message }.
--   'ok'             - sign in
--   'not_registered' - no profile, or no valid role
--   'inactive'       - profile deactivated
--   'expired'        - access period ended
--
-- Messages are copied verbatim from the reference implementation.

create or replace function app.resolve_sign_in(p_user uuid)
returns table (outcome text, must_change_password boolean, message text)
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_user public.users%rowtype;
begin
  select * into v_user from public.users where id = p_user;

  if v_user.id is null or not exists (select 1 from app.roles where id = v_user.role) then
    return query select 'not_registered', false,
      'This phone number is not registered for RamosMAX access. Please contact an administrator.';
    return;
  end if;

  if not app.is_account_enabled(p_user) then
    -- `active` still true means the access PERIOD ended, not a deactivation.
    if v_user.active then
      return query select 'expired', false,
        'Your RamosMAX access period has ended. Please contact an administrator.';
    else
      return query select 'inactive', false,
        'Your RamosMAX account is inactive. Please contact an administrator.';
    end if;
    return;
  end if;

  update public.users set last_login_at = now() where id = p_user;
  perform app.audit_auth(p_user, 'session.sign_in',
    'Signed in with phone number and password');

  return query select 'ok', v_user.must_change_password, null::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- Look up the hidden identity for a phone number
-- ---------------------------------------------------------------------------
-- Used only by the server-side sign-in route. It deliberately returns NULL
-- rather than raising for an unknown number, so the caller can give the SAME
-- generic answer for "no such account" and "wrong password" and never reveal
-- whether a phone number is registered.

create or replace function app.sign_in_identity_for_phone(p_phone text)
returns text
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select a.email
    from public.users u
    join auth.users a on a.id = u.id
   where u.phone_number = app.normalize_phone(p_phone)
     and app.is_sign_in_identity(a.email);
$$;

-- ---------------------------------------------------------------------------
-- complete_password_change — the profile half of changeOwnPassword
-- ---------------------------------------------------------------------------
-- Called after Supabase Auth has accepted the new password. Clears the forced
-- change and writes the audit entry in ONE transaction, as session.js does.
-- Revoking other sessions is the caller's job (an Auth-service concern).

create or replace function app.complete_password_change(p_user uuid)
returns void
language plpgsql
volatile
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_was_forced boolean;
begin
  select must_change_password into v_was_forced from public.users where id = p_user;
  if v_was_forced is null then
    raise exception 'No RamosMAX profile for this account.'
      using errcode = 'no_data_found', detail = 'not_registered';
  end if;

  update public.users
     set password_set         = true,
         must_change_password = false,
         password_changed_at  = now(),
         updated_by           = p_user
   where id = p_user;

  insert into public.audit_logs
    (user_id, user_role, action, module, record_id, target_user_id, description, new_value, source)
  select p_user, u.role, 'password.changed', 'auth', p_user::text, p_user,
         case when v_was_forced
              then 'Temporary password replaced at sign-in'
              else 'Password changed by the user' end,
         jsonb_build_object('mustChangePassword', false),
         'server'
    from public.users u where u.id = p_user;
end;
$$;

-- These are called by the server-side authentication routes using the service
-- role, never by a browser.
revoke all on function
  app.resolve_sign_in(uuid),
  app.sign_in_identity_for_phone(text),
  app.complete_password_change(uuid),
  app.record_sign_in_failure(text),
  app.clear_sign_in_failures(text),
  app.throttle_remaining_minutes(text),
  app.generate_password(integer),
  app.new_sign_in_identity()
from anon, authenticated;
