-- ===========================================================================
-- RamosMAX Web — Phase E — 0020: execute privileges for the new functions
-- ===========================================================================
-- Same model as 0014: deny by default, allow an explicit list. The default
-- privilege set in 0014 already stops PostgreSQL granting EXECUTE to PUBLIC on
-- anything created since, and this repeats the revoke so a function created by
-- another role, or a restored dump, cannot slip through.
-- ===========================================================================

revoke execute on all functions in schema app from public, anon, authenticated;
alter default privileges in schema app revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Everything Phases A–D already allowed
-- ---------------------------------------------------------------------------

grant execute on function
  app.is_signed_in(),
  app.is_active(),
  app.is_admin(),
  app.current_role_id(),
  app.has_permission(text),
  app.has_either_permission(text, text),
  app.own_with(text, uuid),
  app.is_client_session(),
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
  app.search_vehicles(text, integer),
  app.assignable_workers(),
  app.set_user_role(uuid, text, text),
  app.set_user_active(uuid, boolean, text),
  app.set_user_permissions(uuid, text[], text[], text),
  app.grant_temporary_permission(uuid, text, timestamptz, timestamptz, text),
  app.revoke_temporary_permission(uuid, text),
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
  app.create_service_intake(uuid, uuid[], text, boolean),
  app.cancel_service_intake(uuid, text),
  app.assign_worker_order(uuid, uuid, text),
  app.reassign_worker_order(uuid, uuid, text),
  app.cancel_worker_order(uuid, text),
  app.update_worker_order_status(uuid, text, text, text),
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
-- Phase E: pure helpers the UI legitimately shows
-- ---------------------------------------------------------------------------
-- Both are read-only figures the person needs BEFORE sending anything: the
-- threshold above which a stock-out needs approval, and the largest single
-- amount the system accepts. Neither reveals a balance.

grant execute on function
  app.high_value_threshold_ugx(),
  app.max_amount_ugx(),
  app.mask_account_number(text)
to authenticated;

-- ---------------------------------------------------------------------------
-- Phase E: the command surface
-- ---------------------------------------------------------------------------
-- Each re-checks the caller's permissions itself; being callable is not being
-- allowed.

grant execute on function
  -- finance
  app.create_financial_account(text, text, text, text, text, bigint),
  app.update_financial_account(uuid, text, text, text, text, boolean, text),
  app.record_opening_balance(uuid, bigint, text),
  app.transfer_funds(uuid, uuid, bigint, text, text, date, text, text),
  app.record_bank_deposit(uuid, uuid, bigint, text, text, date, text),
  app.reconcile_account(uuid, bigint, text, date, text),
  app.record_account_adjustment(uuid, text, bigint, text, text, uuid),
  app.reverse_financial_transaction(uuid, text),
  -- expenses
  app.create_expense_category(text),
  app.update_expense_category(text, text, boolean, text),
  app.create_expense(text, text, bigint, date, text, text, uuid, text, text, boolean),
  app.update_expense(uuid, text, text, bigint, date, text, uuid, text, text, text),
  app.update_expense_status(uuid, text, text, text),
  app.pay_expense(uuid, uuid, text, text, date),
  app.create_recurring_expense(text, text, bigint, text, date, text, uuid, integer, text),
  app.update_recurring_expense(uuid, text, bigint, date, integer, text, uuid, text, boolean, text),
  -- inventory
  app.create_inventory_item(text, text, text, integer, integer, text, boolean, uuid, bigint, text, integer),
  app.update_inventory_item(uuid, text, text, text, integer, integer, text, boolean, uuid, bigint, boolean, text),
  app.record_stock_movement(uuid, text, integer, text, text, text, text, bigint, uuid, uuid),
  app.adjust_stock(uuid, integer, text, text),
  app.reverse_stock_movement(uuid, text),
  app.create_supplier(text, text, text, text, text, text),
  app.update_supplier(uuid, text, text, text, text, text, text, boolean, text),
  app.create_purchase(uuid, jsonb, text, date, text, text),
  app.update_purchase_status(uuid, text, text),
  app.receive_purchase(uuid, text, uuid, text),
  app.pay_purchase(uuid, uuid, text, text)
to authenticated;

-- ---------------------------------------------------------------------------
-- Everything else stays denied
-- ---------------------------------------------------------------------------
-- Not granted above, and therefore unreachable from a browser session:
--   app.post_transaction, app.move_account, app.summarise_day   fabricating money
--   app.post_ledger_entry, app.post_purchase_payment            the same, by another door
--   app.move_stock                                              fabricating stock
--   app.reverse_spending_record                                 unpicking a payment
--   app.sweep_recurring_expenses                                creating due items at will
--   app.read_expense_category, app.account_number_input,
--   app.require_*, app.merge_account_totals                     internal helpers
--
-- `src/test/db/rpc-exposure.test.ts` fails if a function in `app` becomes
-- executable without being named here, so a helper added later cannot become
-- browser-callable by accident.
