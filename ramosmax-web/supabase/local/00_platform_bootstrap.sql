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

create extension if not exists pgcrypto;

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
