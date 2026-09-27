-- ===========================================================================
-- RamosMAX Web — 0056: the views were never locked down
-- ===========================================================================
-- WHAT WAS WRONG
--
-- Every schema migration ends by revoking everything on its new TABLES from
-- `anon` and `authenticated` and then granting back only SELECT. The RLS
-- migrations, which create the six VIEWS, only ever granted SELECT — they
-- never revoked first, because locally there was nothing to revoke.
--
-- A hosted Supabase project is not locally. It ships with
--
--   alter default privileges for role postgres in schema public
--     grant all on tables to postgres, anon, authenticated, service_role;
--
-- and the same again for `supabase_admin`. A VIEW is a "table" for the
-- purposes of default privileges, so all six were born with INSERT, UPDATE,
-- DELETE and TRUNCATE for `anon` and `authenticated`, and nothing ever took
-- them away. The local bootstrap had no default privileges at all, so no test
-- could have seen it — which is fixed separately, in
-- `supabase/local/00_platform_bootstrap.sql`.
--
-- WHY IT MATTERED
--
-- `payment_accounts` and `share_register` are owner-run views
-- (`security_invoker = false`) and both are auto-updatable. PostgreSQL checks
-- the base table's privileges against the VIEW OWNER for such a view, and the
-- owner is `postgres`, which on Supabase holds BYPASSRLS. An INSERT does not
-- evaluate the view's WHERE clause, so the permission predicate written into
-- the view body is never consulted on the way in.
--
-- The result was reproducible: as `anon` — the key that ships in every browser
-- bundle — `insert into public.payment_accounts ...` wrote a row into
-- `financial_accounts`, and the same connection could not then read the table
-- back. SELECT, UPDATE and DELETE happened to be refused, but only because
-- evaluating the predicate needs `app.has_either_permission`, which `anon`
-- cannot execute. That is an accident, not a control. `share_register` was one
-- NOT NULL column away from the same thing.
--
-- WHAT THIS DOES
--
--   1. takes every privilege on every view in `public` away from `anon`,
--      `authenticated` and PUBLIC, and grants back SELECT to `authenticated`
--      alone — the same shape the tables have had all along;
--   2. does the same for sequences, which were also granted `rwU`;
--   3. rewrites the default privileges so a view, table, sequence or function
--      created in `public` later cannot inherit any of it again.
--
-- It changes no policy, no function, no RLS, and no business rule. It takes
-- away privileges that were never intended and nothing else.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Everything that exists now
-- ---------------------------------------------------------------------------
do $$
declare
  v_name text;
begin
  for v_name in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('v', 'm')
     order by c.relname
  loop
    execute format('revoke all on public.%I from anon, authenticated, public', v_name);
    -- The application reads every one of these as `authenticated`, through a
    -- connection that has already dropped to that role. Read, and nothing else.
    execute format('grant select on public.%I to authenticated', v_name);
  end loop;

  -- Tables too, in case any were added without the revoke their schema
  -- migration should have carried. This is a no-op where it was done right.
  --
  -- This also takes the two COLUMN-scoped grants with it, because a revoke at
  -- table level removes the column grants underneath. They are put back
  -- immediately below — deliberately, and written out in full, so that the
  -- only two ways a browser session may write to a table directly are stated
  -- in one place rather than inherited from four migrations ago.
  for v_name in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
     order by c.relname
  loop
    execute format('revoke insert, update, delete, truncate, references, trigger
                      on public.%I from anon, authenticated, public', v_name);
    execute format('revoke all on public.%I from anon', v_name);
  end loop;
end;
$$;

revoke all on all sequences in schema public from anon, authenticated, public;
revoke all on all functions in schema public from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- 1b. The two intended exceptions, restored exactly as `0003` wrote them
-- ---------------------------------------------------------------------------
-- A client-side audit entry: the columns only, and `audit_logs`'s own policy
-- still requires user_id = auth.uid(), the caller's real role, source
-- 'client', and no target or reason. Nothing here relaxes that.
grant insert (user_id, user_role, action, module, record_id,
              description, previous_value, new_value, source)
  on public.audit_logs to authenticated;

-- Somebody's own sign-in stamp and their own notification preferences. Two
-- columns, and the policy still restricts the row to their own.
grant update (last_login_at, notification_preferences) on public.users to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Everything created from now on
-- ---------------------------------------------------------------------------
-- Supabase sets these for `postgres` and for `supabase_admin`. Changing the
-- ones belonging to `supabase_admin` needs membership in that role, which
-- `postgres` does not have on a hosted project — so it is attempted and the
-- refusal is reported rather than failing the migration. Objects this
-- application creates are created by `postgres`, which is the one that counts.
do $$
declare
  v_role text;
begin
  foreach v_role in array array['postgres', 'supabase_admin'] loop
    if not exists (select 1 from pg_roles where rolname = v_role) then
      continue;
    end if;
    begin
      execute format(
        'alter default privileges for role %I in schema public
           revoke all on tables from anon, authenticated', v_role);
      execute format(
        'alter default privileges for role %I in schema public
           revoke all on sequences from anon, authenticated', v_role);
      execute format(
        'alter default privileges for role %I in schema public
           revoke all on functions from anon, authenticated', v_role);
      raise notice 'Default privileges for % in schema public: anon and authenticated get nothing.',
        v_role;
    exception when insufficient_privilege or others then
      -- Only worth reporting. `postgres` owns everything this application
      -- creates, so its defaults are the ones that decide.
      raise notice 'Could not change default privileges for % (%). Objects created by % are unaffected.',
        v_role, sqlerrm, 'postgres';
    end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Say so, loudly, if any of it is still wrong
-- ---------------------------------------------------------------------------
do $$
declare
  v_writes integer;
  v_anon   integer;
begin
  select count(*) into v_writes
    from information_schema.role_table_grants
   where grantee = 'authenticated' and table_schema = 'public'
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  select count(*) into v_anon
    from information_schema.role_table_grants
   where grantee = 'anon' and table_schema = 'public';

  if v_writes > 0 or v_anon > 0 then
    raise exception 'Privileges are still wrong: % write grant(s) for authenticated, % grant(s) for anon.',
      v_writes, v_anon
      using errcode = 'insufficient_privilege', detail = 'default_deny_violated';
  end if;
  raise notice 'Default-deny restored: no write grant for authenticated, nothing at all for anon.';
end;
$$;
