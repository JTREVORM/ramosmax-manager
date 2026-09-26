-- ===========================================================================
-- RamosMAX Web — 0054: the three evidence buckets
-- ===========================================================================
-- Ports `firebase/storage.rules`. Three buckets, all PRIVATE, mirroring the
-- reference's three prefixes:
--
--   finance_uploads/<kind>/<uploadId>/<file>   deposits, reconciliations,
--                                              expenses, purchases
--   payroll_uploads/<kind>/<uploadId>/<file>   attendance, losses, payroll
--   staff/<staffId>/profile/<file>             profile photos
--
-- WHO MAY REACH THEM, and why it is written this way.
--
-- In the reference, a storage rule can read the caller's Firestore profile,
-- because the caller holds a Firebase identity. Here a person holds a RamosMAX
-- session cookie and NO Supabase JWT — sign-in is by phone number against a
-- hidden identity, and the browser is never given a token of its own. So
-- `auth.uid()` is null for anything a browser sends straight to Storage, and a
-- policy written in terms of it would either deny everyone or, written
-- carelessly, allow everyone.
--
-- These buckets are therefore DEFAULT-DENY to `anon` and `authenticated`: no
-- policy grants either of them anything, so RLS on storage.objects refuses
-- every direct request. The only way in is the application server, which holds
-- the service role, and which checks the permission itself before it moves a
-- byte and then records the path through `app.attach_evidence` — the function
-- that enforces the path shape, the permission, and that evidence is never
-- replaced and never removed.
--
-- That is stricter than the reference, not weaker: there, a signed-in client
-- could write to the bucket directly; here nothing can except a server that
-- has already made the decision.
--
-- The whole migration is guarded on the `storage` schema existing, so it is a
-- no-op against the local PostgreSQL bootstrap, which has no Storage service
-- and never needs one.
-- ===========================================================================

do $$
declare
  v_bucket text;
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    raise notice 'No storage schema: skipping bucket creation (local database).';
    return;
  end if;

  foreach v_bucket in array array['finance_uploads', 'payroll_uploads', 'staff'] loop
    -- `public = false` is the whole point: no anonymous URL ever resolves.
    execute format(
      'insert into storage.buckets (id, name, public) values (%L, %L, false)
         on conflict (id) do update set public = false',
      v_bucket, v_bucket);
  end loop;

  -- Remove any policy a dashboard click may have added: these buckets answer
  -- the service role and nothing else, and a permissive policy left behind
  -- would be the one thing that opens them.
  for v_bucket in
    select policyname from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname like 'ramosmax_%'
  loop
    execute format('drop policy %I on storage.objects', v_bucket);
  end loop;

  raise notice 'Three private buckets exist and grant nothing to anon or authenticated.';
end;
$$;
