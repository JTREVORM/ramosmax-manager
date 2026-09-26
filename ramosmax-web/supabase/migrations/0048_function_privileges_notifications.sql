-- ===========================================================================
-- RamosMAX Web — Final phase — 0048: execute privileges for notifications
-- ===========================================================================
-- Again PUBLIC only: the explicit grants the earlier migrations made to
-- `authenticated` are untouched, and what goes is the blanket grant every new
-- function receives.
--
-- NOT granted, and therefore unreachable from a browser:
--   app.notify                 writes somebody's inbox
--   app.deliver_events         turns events into notices for everybody
--   app.pending_push           carries the keys that address a device
--   app.record_push            records a delivery
--   app.skip_muted_push        housekeeping
--   app.drop_push_subscription removes somebody's device
--
-- Those five belong to the delivery job, which runs with service privileges
-- on the server and never in a browser session.
-- ===========================================================================

revoke execute on all functions in schema app from public;
revoke execute on all functions in schema app from anon;
alter default privileges in schema app revoke execute on functions from public;

grant execute on function
  app.my_notifications(integer, boolean),
  app.unread_notification_count(),
  app.mark_notification_read(uuid),
  app.notification_preferences(),
  app.set_notification_preferences(jsonb),
  app.notification_categories(),
  app.mutable_categories(),
  app.register_push_subscription(text, text, text, text),
  app.remove_push_subscription(text)
to authenticated;
