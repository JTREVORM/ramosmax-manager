-- ===========================================================================
-- RamosMAX Web — Phase A — 0001: the `app` schema and the access model tables
-- ===========================================================================
-- Ports the Phase 9 access model (functions/src/access.js, access_catalog.json,
-- lib/core/auth/permissions.dart, firebase/firestore.rules) to PostgreSQL.
--
-- POSTURE: DEFAULT DENY, exactly as firebase/firestore.rules.
--   * Business tables grant SELECT only, and only via an RLS policy.
--   * No `authenticated` role ever holds INSERT/UPDATE/DELETE on a business
--     table. Every mutation goes through a SECURITY DEFINER function, which is
--     the direct equivalent of "allow write: if false" plus a callable.
--   * `app` is a private schema: it is NOT exposed through PostgREST.
--
-- Phase A creates the access model only. Business tables arrive in Phases B-I.
-- This migration is additive and non-destructive: it drops nothing.
-- ===========================================================================

create schema if not exists app;

-- The app schema holds privileged helpers and is never client-reachable.
revoke all on schema app from public;
revoke all on schema app from anon, authenticated;
grant usage on schema app to authenticated;  -- to CALL helpers, not to read tables

-- ---------------------------------------------------------------------------
-- Reference data: roles, permission groups, permissions, role defaults
-- ---------------------------------------------------------------------------
-- The database is the single source of truth for the catalogue. TypeScript
-- types are generated from the same upstream source, so the UI cannot name a
-- permission that does not exist here.

create table if not exists app.roles (
  id                                text primary key,
  rank                              integer not null,
  grants_all                        boolean not null default false,
  password_resettable_by_non_admin  boolean not null default false
);

comment on column app.roles.rank is
  'Higher outranks lower. Mirrors roleRanks in access_catalog.json; used by require_can_administer / require_can_assign_role.';
comment on column app.roles.grants_all is
  'True for admin only. app.has_permission() short-circuits on it, as hasPermission() does in firestore.rules.';

create table if not exists app.permission_groups (
  id          text primary key,
  label       text not null,
  sort_order  integer not null default 0
);

create table if not exists app.permissions (
  key                    text primary key,
  label                  text not null,
  group_id               text not null references app.permission_groups (id),
  is_admin_only          boolean not null default false,
  is_authorization_only  boolean not null default false
);

comment on column app.permissions.is_admin_only is
  'Only an Administrator may grant, deny or temporarily hand this out (users.* except users.view, plus settings.manage).';
comment on column app.permissions.is_authorization_only is
  'Exists only inside an after-hours authorisation window. Never granted permanently or via the generic temporary-access editor.';

create table if not exists app.role_permissions (
  role_id         text not null references app.roles (id) on delete cascade,
  permission_key  text not null references app.permissions (key) on delete cascade,
  primary key (role_id, permission_key)
);

-- ---------------------------------------------------------------------------
-- users — the business profile, 1:1 with auth.users
-- ---------------------------------------------------------------------------
-- Mirrors the Firestore `users/{uid}` document. Credentials live in Supabase
-- Auth and never here: no password, plain or hashed, is ever stored.
--
-- People sign in with a PHONE NUMBER. auth.users.email holds a random hidden
-- identity on the reserved .invalid domain (see passwords.js newSignInIdentity),
-- so it can never be derived from a phone number. Phase B implements the flow.

create table if not exists public.users (
  id                        uuid primary key references auth.users (id) on delete restrict,

  -- Identity as people know it.
  phone_number              text not null unique,
  full_name                 text not null,
  email                     text,

  -- Access.
  role                      text not null references app.roles (id),
  active                    boolean not null default true,
  access_expires_at         timestamptz,

  -- Credential state (server-owned; never client-writable).
  password_set              boolean not null default false,
  must_change_password      boolean not null default false,
  password_changed_at       timestamptz,
  password_reset_at         timestamptz,
  password_reset_by         uuid references public.users (id),

  -- Direct grants and denials. Temporary grants are a table, not a map.
  permissions               text[] not null default '{}',
  denied_permissions        text[] not null default '{}',

  -- Employment link and profile.
  staff_id                  text unique,
  specialization            text,
  profile_photo_path        text,

  -- Platform.
  notification_preferences  jsonb not null default '{}'::jsonb,
  last_login_at             timestamptz,

  -- Audit-trail continuity with the Firebase implementation.
  legacy_uid                text unique,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid references public.users (id),
  updated_by                uuid references public.users (id),

  constraint users_phone_e164 check (phone_number ~ '^\+[1-9][0-9]{7,14}$')
);

comment on table public.users is
  'RamosMAX business profile. Being signed in grants nothing: a session needs BOTH a Supabase Auth sign-in AND an active profile here.';
comment on column public.users.must_change_password is
  'Set when an administrator issues a temporary password. Counts as INACTIVE for everything (app.is_active()), so the forced change cannot be skipped by a modified client.';
comment on column public.users.access_expires_at is
  'Ends the whole account''s access (e.g. at contract end) without anyone remembering to deactivate it.';
comment on column public.users.legacy_uid is
  'The Firebase UID this profile was migrated from, so historic audit entries remain attributable.';

create index if not exists users_role_idx   on public.users (role) where active;
create index if not exists users_staff_idx  on public.users (staff_id);

-- ---------------------------------------------------------------------------
-- temporary_grants — time-boxed permissions
-- ---------------------------------------------------------------------------
-- Normalised out of the Firestore `temporaryPermissions` map. A grant is
-- effective ONLY inside its window, so it starts and stops being honoured on
-- time WITH NO CLEANUP JOB. The Phase 8 after-hours authorisations ride on
-- this same mechanism. Never make expiry depend on a scheduled sweep.

create table if not exists public.temporary_grants (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users (id) on delete cascade,
  permission_key  text not null references app.permissions (key),
  starts_at       timestamptz not null,
  expires_at      timestamptz not null,

  reason          text,
  granted_by      uuid references public.users (id),
  granted_at      timestamptz not null default now(),

  revoked_at      timestamptz,
  revoked_by      uuid references public.users (id),
  revoke_reason   text,

  -- Set when the grant comes from an after-hours authorisation (Phase H).
  authorization_id uuid,

  constraint temporary_grants_window check (expires_at > starts_at),
  -- access.js MAX_TEMPORARY_MS: temporary access lasts at most 30 days.
  constraint temporary_grants_max_length check (expires_at - starts_at <= interval '30 days')
);

create index if not exists temporary_grants_live_idx
  on public.temporary_grants (user_id, permission_key, expires_at)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- settings — read-only reference data for active users
-- ---------------------------------------------------------------------------

create table if not exists public.settings (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.users (id)
);

comment on table public.settings is
  'payroll_policy, share_policy, dividend_policy, after_hours_policy, loyalty, payment_accounts. Readable by any active user; written only by SECURITY DEFINER functions.';

-- ---------------------------------------------------------------------------
-- audit_logs — append-only, for everyone, including administrators
-- ---------------------------------------------------------------------------

create table if not exists public.audit_logs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users (id),
  user_role       text not null,
  action          text not null,
  module          text not null,
  record_id       text,
  target_user_id  uuid references public.users (id),
  description     text,
  reason          text,
  previous_value  jsonb,
  new_value       jsonb,
  -- 'client' for app-written entries, 'server' for SECURITY DEFINER functions.
  -- A client can never write 'server'; the RLS policy forbids it.
  source          text not null default 'client',
  occurred_at     timestamptz not null default now(),

  constraint audit_logs_source check (source in ('client', 'server'))
);

comment on table public.audit_logs is
  'Append-only. Entries are never edited or removed by anyone, including admins. Amendments are new entries, not rewrites.';

create index if not exists audit_logs_time_idx    on public.audit_logs (occurred_at desc);
create index if not exists audit_logs_user_idx    on public.audit_logs (user_id, occurred_at desc);
create index if not exists audit_logs_module_idx  on public.audit_logs (module, occurred_at desc);

-- ---------------------------------------------------------------------------
-- request_keys — idempotency
-- ---------------------------------------------------------------------------
-- Replaces unique_keys/{payment_request_*, request_*}. A retry after a lost
-- response returns the first result instead of acting twice. Bound to the
-- caller and the kind of request, as in the Phase 5 implementation.

create table if not exists app.request_keys (
  request_id  text primary key,
  actor_id    uuid not null references public.users (id),
  kind        text not null,
  result      jsonb,
  claimed_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- login_throttle — sign-in attempt limits
-- ---------------------------------------------------------------------------
-- Keyed by sha256('ramosmax:' || phone) so no phone number is stored. Mirrors
-- session.js: MAX_FAILURES = 5 within THROTTLE_WINDOW_MS = 15 minutes.

create table if not exists app.login_throttle (
  phone_hash       text primary key,
  failures         integer not null default 0,
  first_failure_at timestamptz,
  locked_until     timestamptz,
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Immutability triggers
-- ---------------------------------------------------------------------------
-- The append-only guarantee is enforced by the database, not only by policy,
-- so it holds even for a superuser-issued UPDATE.

create or replace function app.forbid_update_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only: rows cannot be modified or deleted', tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists audit_logs_append_only on public.audit_logs;
create trigger audit_logs_append_only
  before update or delete on public.audit_logs
  for each row execute function app.forbid_update_delete();

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists users_touch_updated_at on public.users;
create trigger users_touch_updated_at
  before update on public.users
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Default-deny privileges
-- ---------------------------------------------------------------------------
-- Mirrors `match /{document=**} { allow read, write: if false; }`.
-- SELECT is granted below only where an RLS policy also allows the row.
-- INSERT/UPDATE/DELETE are granted to NOBODY: writes go through SECURITY
-- DEFINER functions, which is the equivalent of "allow write: if false".

revoke all on all tables in schema public from anon, authenticated;
revoke all on all tables in schema app    from anon, authenticated;

alter table public.users             enable row level security;
alter table public.users             force  row level security;
alter table public.temporary_grants  enable row level security;
alter table public.temporary_grants  force  row level security;
alter table public.settings          enable row level security;
alter table public.settings          force  row level security;
alter table public.audit_logs        enable row level security;
alter table public.audit_logs        force  row level security;

-- Reference tables are readable by any signed-in user so the permission editor
-- can render; they carry no business data.
alter table app.roles              enable row level security;
alter table app.permission_groups  enable row level security;
alter table app.permissions        enable row level security;
alter table app.role_permissions   enable row level security;

-- app.request_keys and app.login_throttle have RLS enabled with NO policy at
-- all: unreachable from any client, reachable only by SECURITY DEFINER code.
alter table app.request_keys    enable row level security;
alter table app.request_keys    force  row level security;
alter table app.login_throttle  enable row level security;
alter table app.login_throttle  force  row level security;
