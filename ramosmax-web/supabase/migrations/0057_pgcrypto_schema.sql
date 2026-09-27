-- ===========================================================================
-- RamosMAX Web — 0057: pgcrypto is not in `public` on a hosted project
-- ===========================================================================
-- WHAT WAS WRONG
--
-- The first real sign-in on Vercel returned 500:
--
--   function digest(text, unknown) does not exist
--
-- A hosted Supabase project installs its extensions into a schema called
-- `extensions`, and gives the `postgres` role
-- `search_path = "$user", public, extensions` so ordinary SQL still finds
-- them. Every migration therefore applied cleanly, and
-- `scripts/bootstrap-admin.mjs` created the first administrator without
-- complaint — both run as `postgres`, over an ordinary connection.
--
-- A SECURITY DEFINER function does not use the role's search_path. It uses its
-- own pinned one, `app, public, pg_temp`, which is exactly the point of
-- pinning it. `extensions` is not in that list, so `digest()` is unreachable
-- from inside the functions that do the work.
--
-- Locally, `create extension pgcrypto` with no schema put it in `public`,
-- which IS in that list. The local database was the one place this could not
-- happen, which is why 1,652 tests passed against a project where nothing
-- could be written. `supabase/local/00_platform_bootstrap.sql` now installs it
-- where the platform does; without this migration, 1,080 of those tests fail.
--
-- HOW FAR IT REACHED
--
-- Two functions call `digest`, and between them they sit under everything:
--
--   * `app.phone_hash`    — the sign-in throttle. Three auth functions call
--                           it, so no sign-in could complete. This is the one
--                           that showed up.
--   * `app.claim_request` — the idempotency claim. TWENTY-EIGHT functions call
--                           it: every payment, expense, payroll, dividend,
--                           handover, stock movement and share transaction.
--                           None of them could have run either. Sign-in was
--                           simply the first thing anybody tried.
--
-- `gen_random_uuid()` is NOT affected: PostgreSQL 13 and later provide it in
-- `pg_catalog`, which is implicitly in every search_path. Verified on the
-- hosted project rather than assumed. No RamosMAX function uses `crypt`,
-- `gen_salt`, `gen_random_bytes` or `hmac`.
--
-- THE FIX
--
-- One function, and no change to any of the thirty that were failing.
-- `app.digest` is created in `app`, which is FIRST in every pinned search_path
-- in this schema, so the existing unqualified `digest(...)` calls resolve to it
-- with their bodies untouched. Its own body names pgcrypto's schema
-- explicitly — resolved here, at apply time, from the catalogue rather than
-- guessed — and its own search_path is `pg_catalog, pg_temp`, so nothing about
-- the caller can change what it does.
--
-- Rewriting 30 function bodies, or widening 30 pinned search_paths to include
-- `extensions`, would both have been larger changes with more ways to be
-- wrong. The hash is byte-for-byte what it was, so existing throttle rows and
-- idempotency fingerprints keep their meaning.
-- ===========================================================================

do $$
declare
  v_schema text;
begin
  select n.nspname into v_schema
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pgcrypto';

  if v_schema is null then
    raise exception 'pgcrypto is not installed. RamosMAX needs it for the sign-in throttle and for idempotency.'
      using errcode = 'undefined_object', detail = 'pgcrypto_missing';
  end if;

  raise notice 'pgcrypto found in schema %; app.digest will call it by name.', v_schema;

  -- SECURITY DEFINER so that it works whoever reaches it, and pinned to
  -- `pg_catalog, pg_temp` so that nothing but this body decides what it does.
  -- It reads nothing and writes nothing: it is a hash.
  execute format($fmt$
    create or replace function app.digest(p_data text, p_type text)
    returns bytea
    language sql
    immutable
    strict
    security definer
    set search_path = pg_catalog, pg_temp
    as $body$ select %I.digest(p_data, p_type) $body$;
  $fmt$, v_schema);

  -- pgcrypto offers a bytea overload too. Providing it keeps resolution
  -- unambiguous: without it, a `digest(<bytea>, ...)` call somewhere would
  -- find only the text version here, fail to cast, and then fail to find the
  -- real one — because `extensions` is still not in the caller's path.
  execute format($fmt$
    create or replace function app.digest(p_data bytea, p_type text)
    returns bytea
    language sql
    immutable
    strict
    security definer
    set search_path = pg_catalog, pg_temp
    as $body$ select %I.digest(p_data, p_type) $body$;
  $fmt$, v_schema);
end;
$$;

comment on function app.digest(text, text) is
  'pgcrypto digest, called by its real schema name. pgcrypto lives in `extensions` on a hosted project, which no pinned search_path includes.';
comment on function app.digest(bytea, text) is
  'pgcrypto digest, called by its real schema name.';

-- ---------------------------------------------------------------------------
-- The two functions on this path that had no pinned search_path of their own
-- ---------------------------------------------------------------------------
-- Both are SECURITY INVOKER, so they inherited whatever their caller had. That
-- worked only because every caller happens to be a definer function pinned to
-- `app, public, pg_temp`. Pinning them makes them correct on their own terms
-- rather than by luck, and answers the linter's `function_search_path_mutable`
-- for the two that sit on the authentication path.
--
-- The other 101 functions it flags are left alone deliberately: they are all
-- SECURITY INVOKER and run as the caller, so a mutable path cannot escalate
-- anything, and changing a hundred functions while fixing an outage is how a
-- second outage happens.
alter function app.phone_hash(text) set search_path = app, pg_catalog, pg_temp;
alter function app.new_sign_in_identity() set search_path = pg_catalog, pg_temp;

-- PUBLIC only, as in 0046, 0048, 0050, 0051, 0052 and 0053: what goes is the
-- blanket grant a new function receives, not anything granted deliberately.
revoke execute on all functions in schema app from public;
revoke execute on all functions in schema app from anon;
alter default privileges in schema app revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Prove it, here, rather than finding out from a 500
-- ---------------------------------------------------------------------------
do $$
declare
  v_hash text;
  v_probe text;
begin
  -- The exact call that failed, through the throttle that calls it.
  perform app.throttle_remaining_minutes('0772000001');

  -- And the hash itself, unchanged from what it always was.
  select app.phone_hash('+256772000001') into v_hash;
  if v_hash is null or length(v_hash) <> 64 then
    raise exception 'app.phone_hash did not return a sha256 hex digest (got %).', v_hash
      using errcode = 'raise_exception';
  end if;
  if v_hash <> encode(app.digest('ramosmax:+256772000001', 'sha256'), 'hex') then
    raise exception 'app.phone_hash no longer agrees with the digest it is built on.'
      using errcode = 'raise_exception';
  end if;

  -- `app.claim_request` is what the other twenty-eight depend on, but calling
  -- it needs a signed-in caller and a row of its own. What has to be proved is
  -- narrower than that: that an UNQUALIFIED `digest(...)` resolves from inside
  -- a function pinned to the same search_path `claim_request` has. So a probe
  -- with exactly that pinning is created, called, and dropped again.
  create function app.probe_0057() returns text
    language sql immutable
    set search_path = app, public, pg_temp
    as $probe$ select encode(digest('probe', 'sha256'), 'hex') $probe$;
  select app.probe_0057() into v_probe;
  drop function app.probe_0057();

  if v_probe <> encode(app.digest('probe', 'sha256'), 'hex') then
    raise exception 'An unqualified digest() call inside a pinned search_path does not resolve.'
      using errcode = 'raise_exception';
  end if;

  raise notice 'Sign-in throttle and pinned-search_path digest both resolve correctly.';
end;
$$;
