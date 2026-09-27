-- ===========================================================================
-- LOCAL DEVELOPMENT ONLY — emulation of the Supabase platform layer
-- ===========================================================================
-- THIS IS NOT AN APPLICATION MIGRATION. It is never applied to a Supabase
-- project: Supabase provides all of it already. It exists so the RamosMAX
-- migrations and their RLS policies can be executed and tested against a real
-- PostgreSQL server in environments without Docker or a hosted project.
--
-- It reproduces the parts of Supabase the application actually depends on:
--   * the anon / authenticated / service_role / authenticator roles, and the
--     PostgREST pattern of connecting as `authenticator` then SET ROLE;
--   * the `auth` schema, `auth.users`, and auth.uid() / auth.role() / auth.jwt()
--     reading the same `request.jwt.claims` GUC that Supabase uses;
--   * pgcrypto, so passwords are bcrypt-hashed exactly as GoTrue stores them.
--
-- Fidelity note: GoTrue's HTTP API (sign-in, session issuing, token refresh)
-- is NOT emulated. Password verification here uses the same bcrypt hash GoTrue
-- writes, so the credential check is genuine, but issuing a JWT session is a
-- Supabase service concern and is tested separately.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- pgcrypto, where the platform actually puts it
-- ---------------------------------------------------------------------------
-- A hosted Supabase project installs its extensions into a schema called
-- `extensions`, NOT into `public`, and gives the `postgres` role a search_path
-- of `"$user", public, extensions` so ordinary SQL still finds them.
--
-- A SECURITY DEFINER function with a pinned `search_path = app, public,
-- pg_temp` does NOT: a pinned path overrides the role's. So `digest()` is
-- reachable from a migration and from a script, and unreachable from inside
-- the functions that do the work — which is how the first hosted sign-in
-- returned 500 with `function digest(text, unknown) does not exist` while
-- every migration had applied cleanly and the first administrator had been
-- created without complaint.
--
-- Installing it into `public` here, as this file used to, made the local
-- database the one place where that could not happen. It is installed where
-- the platform installs it, and the session path is set to match, so the
-- pinned-path functions are exercised against the real resolution rules.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

-- For every FUTURE connection (tests, the application, the e2e scripts), as
-- the `postgres` role has on a hosted project...
do $$
begin
  execute format('alter database %I set search_path = "$user", public, extensions',
                 current_database());
end;
$$;
-- ...and for this one, so the migrations that follow it in this session see
-- what a migration run against the hosted project sees.
set search_path = "$user", public, extensions;

-- ---------------------------------------------------------------------------
-- Platform roles (as Supabase creates them)
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  -- PostgREST connects as this role and then SET ROLE's to anon/authenticated.
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
end;
$$;

grant anon, authenticated, service_role to authenticator;

grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The default privileges a hosted project ships with
-- ---------------------------------------------------------------------------
-- This is the uncomfortable part of the platform, and leaving it out of the
-- emulation is what let a real hole through: a hosted Supabase project runs
--
--   alter default privileges for role postgres in schema public
--     grant all on tables to postgres, anon, authenticated, service_role;
--
-- and the same for sequences and functions, and again for `supabase_admin`.
-- Every object created in `public` is therefore born reachable by `anon`
-- unless something takes that away, and a VIEW counts as a table.
--
-- Without this line the local database was permissive in the opposite
-- direction to the real one, so 1,652 tests could all pass while six views on
-- the hosted project carried INSERT for the anon key. Reproducing the
-- platform's generosity here is what makes those tests mean something:
-- `0056` is what takes it away again, and the suite now proves it did.
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- auth schema
-- ---------------------------------------------------------------------------

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- The columns RamosMAX touches. GoTrue's real table has more.
create table if not exists auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text unique,
  phone               text unique,
  encrypted_password  text,
  email_confirmed_at  timestamptz,
  banned_until        timestamptz,
  raw_app_meta_data   jsonb not null default '{}'::jsonb,
  raw_user_meta_data  jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- auth.uid() — reads the verified JWT claims PostgREST sets per request.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    'anon'
  );
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;

-- auth.users is never readable by a client; the application reads public.users.
revoke all on auth.users from anon, authenticated;
