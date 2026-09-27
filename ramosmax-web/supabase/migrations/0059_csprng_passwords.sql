-- ===========================================================================
-- RamosMAX Web — 0059: temporary passwords from a real random source
-- ===========================================================================
-- `app.generate_password` drew every character from `random()`. That is a
-- deterministic PRNG seeded per session: fast, uniform, and not secret. Anybody
-- who learns or influences the seed can reproduce the sequence, and these are
-- the passwords handed to a new member of staff and issued by an administrator
-- reset. They are short-lived — the account can do nothing but replace one —
-- but a temporary password is still the only thing standing between somebody
-- and a first sign-in.
--
-- This replaces the source with `gen_random_bytes`, pgcrypto's CSPRNG, and
-- nothing else. The alphabet, the length, the four required character classes,
-- the look-alike exclusions (no I/l/1/O/0), the Fisher-Yates shuffle and the
-- final re-check against `app.password_problems` are all unchanged, so every
-- password this produces still satisfies exactly the same policy.
--
-- Two details that matter more than they look:
--
--   * MODULO BIAS. `byte % 62` is not uniform over 62 values, because 256 is
--     not a multiple of 62 — the first few characters of the alphabet would
--     come up slightly more often. Bytes at or above the largest multiple of
--     the alphabet size are rejected and redrawn, which is uniform.
--   * pgcrypto lives in `extensions` on a hosted project, so its schema is
--     resolved here at apply time and named explicitly, exactly as `app.digest`
--     does since 0057.
-- ===========================================================================

do $$
declare
  v_schema text;
begin
  select n.nspname into v_schema
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pgcrypto';
  if v_schema is null then
    raise exception 'pgcrypto is not installed; a temporary password needs a CSPRNG.'
      using errcode = 'undefined_object', detail = 'pgcrypto_missing';
  end if;

  execute format($fmt$
    create or replace function app.random_bytes(p_count integer)
    returns bytea
    language sql
    volatile
    strict
    security definer
    set search_path = pg_catalog, pg_temp
    as $body$ select %I.gen_random_bytes(p_count) $body$;
  $fmt$, v_schema);
end;
$$;

comment on function app.random_bytes(integer) is
  'Cryptographically secure random bytes, from pgcrypto called by its real schema name.';

-- ---------------------------------------------------------------------------
-- The same password, from a source that cannot be predicted
-- ---------------------------------------------------------------------------
create or replace function app.generate_password(p_length integer default 12)
returns text
language plpgsql
volatile
set search_path = app, pg_catalog, pg_temp
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
    -- One of each required class first, so the policy is satisfied by
    -- construction rather than by retrying until it happens.
    v_chars := array[
      substr(v_upper,   app.random_index(length(v_upper)),   1),
      substr(v_lower,   app.random_index(length(v_lower)),   1),
      substr(v_digits,  app.random_index(length(v_digits)),  1),
      substr(v_special, app.random_index(length(v_special)), 1)
    ];
    while array_length(v_chars, 1) < p_length loop
      v_chars := v_chars || substr(v_all, app.random_index(length(v_all)), 1);
    end loop;

    -- Fisher-Yates, so the character-class order is not predictable.
    for i in reverse array_length(v_chars, 1)..2 loop
      j := app.random_index(i);
      v_swap := v_chars[i]; v_chars[i] := v_chars[j]; v_chars[j] := v_swap;
    end loop;

    v_out := array_to_string(v_chars, '');
    exit when array_length(app.password_problems(v_out), 1) is null;
  end loop;

  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- A uniform index in 1..n, with the bias removed
-- ---------------------------------------------------------------------------
create or replace function app.random_index(p_upper integer)
returns integer
language plpgsql
volatile
strict
set search_path = app, pg_catalog, pg_temp
as $$
declare
  v_limit integer;
  v_byte  integer;
begin
  if p_upper < 1 then
    raise exception 'A random index needs a positive range (got %).', p_upper
      using errcode = 'invalid_parameter_value', detail = 'range';
  end if;
  if p_upper = 1 then
    return 1;
  end if;
  if p_upper > 256 then
    raise exception 'This draws from one byte, so the range must be 256 or less (got %).', p_upper
      using errcode = 'invalid_parameter_value', detail = 'range';
  end if;

  -- The largest multiple of p_upper that fits in a byte. Anything at or above
  -- it would make the low values more likely, so it is redrawn instead.
  v_limit := (256 / p_upper) * p_upper;

  loop
    v_byte := get_byte(app.random_bytes(1), 0);
    exit when v_byte < v_limit;
  end loop;

  return (v_byte % p_upper) + 1;
end;
$$;

comment on function app.random_index(integer) is
  'A uniform 1..n from a CSPRNG, rejecting the bytes that would bias it.';

-- `app.generate_password` keeps the privileges it already had: it is called
-- only from inside other functions (`new_user_credentials`,
-- `prepare_password_reset`), never by a browser.
revoke execute on all functions in schema app from public;
revoke execute on all functions in schema app from anon;
alter default privileges in schema app revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Prove it before anybody relies on it
-- ---------------------------------------------------------------------------
do $$
declare
  v_password text;
  v_seen     integer;
  i          integer;
begin
  -- Uniform, and never outside the range.
  for i in 1..400 loop
    if app.random_index(10) not between 1 and 10 then
      raise exception 'app.random_index returned a value outside 1..10.';
    end if;
  end loop;

  -- Every generated password satisfies the policy, and no two agree.
  create temporary table tmp_0059_passwords (password text) on commit drop;
  for i in 1..60 loop
    v_password := app.generate_password(12);
    if array_length(app.password_problems(v_password), 1) is not null then
      raise exception 'A generated password failed the policy: %',
        array_to_string(app.password_problems(v_password), '; ');
    end if;
    if length(v_password) <> 12 then
      raise exception 'A generated password was % characters, not 12.', length(v_password);
    end if;
    insert into tmp_0059_passwords values (v_password);
  end loop;

  select count(distinct password) into v_seen from tmp_0059_passwords;
  if v_seen < 60 then
    raise exception 'Only % of 60 generated passwords were distinct.', v_seen;
  end if;

  raise notice 'Temporary passwords now come from pgcrypto, uniformly and without bias.';
end;
$$;
