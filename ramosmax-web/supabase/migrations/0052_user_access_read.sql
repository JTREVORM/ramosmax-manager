-- ===========================================================================
-- RamosMAX Web — Final phase — 0052: reading what an account may do
-- ===========================================================================
-- The account screen states what somebody actually holds right now, temporary
-- grants included. `app.effective_permissions` answers that, but it takes any
-- uuid and checks nothing, because every caller so far has been another
-- SECURITY DEFINER function that had already established who was asking.
--
-- Handing it to a browser session would let anybody enumerate anybody else's
-- access. This wrapper is what a session may call: your own list always, and
-- somebody else's only with `users.view`.
-- ===========================================================================

create or replace function app.user_access(p_user uuid default auth.uid())
returns text[]
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
begin
  if p_user is distinct from auth.uid() then
    perform app.require_permission('users.view');
  end if;
  return app.effective_permissions(p_user);
end;
$$;

comment on function app.user_access(uuid) is
  'The permissions an account holds right now. Your own, or somebody else''s with users.view.';

-- PUBLIC only, as in 0046, 0048, 0050 and 0051.
revoke execute on all functions in schema app from public;
revoke execute on all functions in schema app from anon;
alter default privileges in schema app revoke execute on functions from public;

grant execute on function app.user_access(uuid) to authenticated;
