-- ===========================================================================
-- RamosMAX Web — Final phase — 0050: execute privileges for 0049
-- ===========================================================================
-- PUBLIC only, as in 0046 and 0048: the explicit grants the earlier
-- migrations made to `authenticated` are untouched, and what goes is the
-- blanket grant every new function receives.
-- ===========================================================================

revoke execute on all functions in schema app from public;
revoke execute on all functions in schema app from anon;
alter default privileges in schema app revoke execute on functions from public;

grant execute on function
  app.update_user_profile(uuid, text, text, text, text, text, text),
  app.change_user_phone(uuid, text, text),
  app.link_staff(uuid, text),
  app.update_service_intake(uuid, uuid[], boolean, text)
to authenticated;
