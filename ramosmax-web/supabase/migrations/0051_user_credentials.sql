-- ===========================================================================
-- RamosMAX Web — Final phase — 0051: a new person's first credential
-- ===========================================================================
-- Creating a person needs a credential before a profile can point at it. The
-- identity is a random address on the reserved `.invalid` domain — nobody
-- types it, and it exists only because the credential store wants one — and
-- the first password is generated here so no human ever chooses it.
--
-- NOT client-callable. The server calls it with service privileges, creates
-- the credential, and then `app.create_user` re-checks the caller's
-- permission before any profile is written.
-- ===========================================================================

create or replace function app.new_user_credentials()
returns table (identity text, password text)
language sql
volatile
security definer
set search_path = app, public, pg_temp
as $$
  select app.new_sign_in_identity(), app.generate_password(12);
$$;

comment on function app.new_user_credentials() is
  'A fresh sign-in identity and first password. Server-only: never granted to a browser session.';

-- PUBLIC only, as in 0046, 0048 and 0050: what goes is the blanket grant this
-- new function received, and nothing that was granted explicitly.
revoke execute on all functions in schema app from public;
revoke execute on all functions in schema app from anon;
alter default privileges in schema app revoke execute on functions from public;
