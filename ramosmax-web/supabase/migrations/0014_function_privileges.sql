-- ===========================================================================
-- RamosMAX Web — Phase D — 0014: function execute privileges
-- ===========================================================================
-- CLOSES A REAL HOLE.
--
-- PostgreSQL grants EXECUTE on every new function to PUBLIC. `authenticated`
-- inherits PUBLIC, so `revoke ... from authenticated` alone left the grant in
-- place: every signed-in user could call any app.* function by name, including
-- the SECURITY DEFINER internals. That meant a Worker could call
-- app.post_ledger_entry and credit a financial account out of nothing, or call
-- app.audit and write an audit entry attributed to the SERVER.
--
-- The fix is deny-by-default with an explicit allow-list, and a default
-- privilege so a function added later is never exposed by omission.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Deny everything
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema app from public, anon, authenticated;

-- Functions created in this schema from now on are not granted to PUBLIC.
alter default privileges in schema app revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- The RLS helpers
-- ---------------------------------------------------------------------------
-- A policy expression runs with the QUERYING user's privileges, so these must
-- be callable or every policy fails closed and the application cannot read
-- anything. They are all read-only predicates about the CALLER.

grant execute on function
  app.is_signed_in(),
  app.is_active(),
  app.is_admin(),
  app.current_role_id(),
  app.has_permission(text),
  app.has_either_permission(text, text),
  app.own_with(text, uuid),
  app.is_client_session()
to authenticated;

-- ---------------------------------------------------------------------------
-- Pure helpers the UI legitimately uses
-- ---------------------------------------------------------------------------

grant execute on function
  app.plate_key(text),
  app.display_plate(text),
  app.parse_plate(text),
  app.is_plate_shape(text),
  app.normalize_phone(text),
  app.mask_phone(text),
  app.eat_day(timestamptz),
  app.percent_of(bigint, bigint),
  app.discount_approval_threshold_percent(),
  app.job_status_for(jsonb),
  app.loyalty_config(),
  app.vehicle_loyalty(uuid),
  app.search_vehicles(text, integer)
to authenticated;

-- ---------------------------------------------------------------------------
-- The command surface
-- ---------------------------------------------------------------------------
-- Each re-checks the caller's permissions itself; being callable is not being
-- allowed.

grant execute on function
  -- users and access (Phase B)
  app.set_user_role(uuid, text, text),
  app.set_user_active(uuid, boolean, text),
  app.set_user_permissions(uuid, text[], text[], text),
  app.grant_temporary_permission(uuid, text, timestamptz, timestamptz, text),
  app.revoke_temporary_permission(uuid, text),
  -- customers, vehicles, services (Phase C)
  app.create_customer(text, text, text, text, text, text),
  app.update_customer(uuid, text, text, text, text, text, text),
  app.set_customer_status(uuid, boolean, text),
  app.create_vehicle(text, text, text, text, integer, text, uuid, text),
  app.update_vehicle(uuid, text, text, text, integer, text, text),
  app.change_vehicle_plate(uuid, text, text),
  app.set_vehicle_customer(uuid, uuid, text),
  app.set_vehicle_status(uuid, boolean, text),
  app.create_service(text, text, bigint, text, integer, boolean),
  app.update_service(uuid, text, text, bigint, text, integer, boolean, text),
  app.set_service_active(uuid, boolean),
  -- jobs (Phase C)
  app.create_service_intake(uuid, uuid[], text, boolean),
  app.cancel_service_intake(uuid, text),
  app.assign_worker_order(uuid, uuid, text),
  app.reassign_worker_order(uuid, uuid, text),
  app.cancel_worker_order(uuid, text),
  app.update_worker_order_status(uuid, text, text, text),
  -- money (Phase D)
  app.create_invoice(uuid),
  app.apply_invoice_discount(uuid, text, bigint, text, text),
  app.mark_invoice_credit(uuid, text),
  app.record_payment(uuid, bigint, text, text, text, text, uuid),
  app.reverse_payment(uuid, text),
  app.cancel_invoice(uuid, text),
  app.apply_loyalty_reward(uuid, bigint),
  app.adjust_loyalty_points(uuid, integer, text),
  app.reverse_loyalty_transaction(uuid, text)
to authenticated;

-- ---------------------------------------------------------------------------
-- Everything else stays denied
-- ---------------------------------------------------------------------------
-- Not granted above, and therefore unreachable by any client:
--   app.audit, app.audit_auth               forging an audit entry
--   app.post_ledger_entry                   fabricating money
--   app.claim_request, app.complete_request bypassing idempotency
--   app.post_loyalty, app.award_invoice_loyalty,
--   app.take_back_invoice_loyalty, app.return_loyalty_reward,
--   app.refresh_loyalty_reward              fabricating points
--   app.next_reference                      burning reference numbers
--   app.effective_permissions               reading another user's access
--   app.create_user, app.prepare_password_reset,
--   app.resolve_sign_in, app.record_sign_in_failure, ...  server-side auth
--   app.require_* guards                    meaningless alone, and noisy

-- ---------------------------------------------------------------------------
-- assignable_workers
-- ---------------------------------------------------------------------------
-- The worker picker previously called app.effective_permissions(uid) for every
-- staff member from a client query. That function is now closed, and exposing
-- it would have let anyone read anyone's access anyway. This returns just the
-- pickable staff, and nothing about their permissions.

create or replace function app.assignable_workers()
returns table (id uuid, full_name text, role text)
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select u.id, u.full_name, u.role
    from public.users u
   where app.has_permission('jobs.assign')
     and u.active
     and 'jobs.complete' = any (app.effective_permissions(u.id))
   order by case when u.role = 'worker' then 0 else 1 end, u.full_name;
$$;

comment on function app.assignable_workers() is
  'Staff who may be assigned work: active and holding jobs.complete. Returns nothing unless the caller holds jobs.assign.';

grant execute on function app.assignable_workers() to authenticated;
