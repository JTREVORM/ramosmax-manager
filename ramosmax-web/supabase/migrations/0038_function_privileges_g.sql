-- ===========================================================================
-- RamosMAX Web — Final phase — 0038: execute privileges, extended
-- ===========================================================================
-- Same model as 0014, 0020 and 0031: deny by default, allow an explicit list.
-- PostgreSQL grants EXECUTE to PUBLIC on every new function, so the revoke is
-- repeated here and the list below is the WHOLE browser-callable surface of
-- the system.
-- ===========================================================================

revoke execute on all functions in schema app from public, anon, authenticated;
alter default privileges in schema app revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Phases A–F, unchanged
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
  app.reverse_loyalty_transaction(uuid, text),
  app.high_value_threshold_ugx(),
  app.max_amount_ugx(),
  app.mask_account_number(text),
  app.create_financial_account(text, text, text, text, text, bigint),
  app.update_financial_account(uuid, text, text, text, text, boolean, text),
  app.record_opening_balance(uuid, bigint, text),
  app.transfer_funds(uuid, uuid, bigint, text, text, date, text, text),
  app.record_bank_deposit(uuid, uuid, bigint, text, text, date, text),
  app.reconcile_account(uuid, bigint, text, date, text),
  app.record_account_adjustment(uuid, text, bigint, text, text, uuid),
  app.reverse_financial_transaction(uuid, text),
  app.create_expense_category(text),
  app.update_expense_category(text, text, boolean, text),
  app.create_expense(text, text, bigint, date, text, text, uuid, text, text, boolean),
  app.update_expense(uuid, text, text, bigint, date, text, uuid, text, text, text),
  app.update_expense_status(uuid, text, text, text),
  app.pay_expense(uuid, uuid, text, text, date),
  app.create_recurring_expense(text, text, bigint, text, date, text, uuid, integer, text),
  app.update_recurring_expense(uuid, text, bigint, date, integer, text, uuid, text, boolean, text),
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
-- Phase F: figures the screen needs before anything is sent
-- ---------------------------------------------------------------------------
-- The policy is already readable (`settings` is readable by any active user,
-- as in firestore.rules), and these are the limits and the period arithmetic
-- the forms show. None reveals a salary, a deduction or anyone's pay.

grant execute on function
  app.payroll_policy(),
  app.payroll_period(text, integer, integer, date),
  app.max_backdate_days(),
  app.max_salary_ugx(),
  app.eat_day_start(date),
  app.iso_weekday(date)
to authenticated;

-- ---------------------------------------------------------------------------
-- Phase F: the command surface
-- ---------------------------------------------------------------------------
-- Each re-checks the caller's permissions itself; being callable is not being
-- allowed.

grant execute on function
  -- policy
  app.update_payroll_policy(jsonb, text),
  -- attendance
  app.record_attendance(uuid, text, date, timestamptz, timestamptz, text),
  app.clock_out(uuid, timestamptz),
  app.verify_attendance(uuid[], text, text, text),
  app.correct_attendance(uuid, text, text, timestamptz, timestamptz, text, boolean),
  -- allowances
  app.calculate_allowances(date),
  app.review_allowance(uuid[], text, text, bigint),
  app.pay_allowances(uuid[], uuid, text, text, date),
  app.reverse_allowance_payment(uuid, text),
  app.cancel_allowance(uuid[], text),
  -- salary
  app.set_salary_profile(uuid, bigint, date, text, boolean, bigint, boolean, text, text),
  -- payroll
  app.create_payroll(text, integer, integer, date, text),
  app.prepare_payroll(uuid, text),
  app.correct_payroll(uuid, text),
  app.add_payroll_earning(uuid, uuid, text, bigint, text),
  app.remove_payroll_earning(uuid, text),
  app.update_payroll_status(uuid, text, text, text),
  app.pay_payroll(uuid, uuid, text, text, date),
  app.reverse_payroll_payment(uuid, text),
  app.lock_payroll(uuid),
  app.cancel_payroll(uuid, text),
  -- losses and deductions
  app.create_loss_incident(text, bigint, text, text, uuid, date, text),
  app.review_loss_incident(uuid, text),
  app.decide_loss_incident(uuid, text, text, bigint),
  app.schedule_loss_recovery(uuid, bigint, date, text),
  app.cancel_loss_incident(uuid, text),
  app.create_salary_deduction(uuid, text, bigint, text, text, text, bigint, date),
  app.decide_salary_deduction(uuid, text, text),
  app.cancel_salary_deduction(uuid, text)
to authenticated;

-- ---------------------------------------------------------------------------
-- Ownership: figures a screen legitimately shows
-- ---------------------------------------------------------------------------
-- The two policies and the derived lines of an entry the caller may already
-- read. None of these reveals a contact detail or another person's holding.

grant execute on function
  app.share_policy(),
  app.dividend_policy(),
  app.share_transaction_lines(uuid),
  app.ownership_percent(bigint, bigint)
to authenticated;

-- ---------------------------------------------------------------------------
-- Ownership: the command surface
-- ---------------------------------------------------------------------------

grant execute on function
  -- shareholders, classes and policy
  app.create_shareholder(text, text, text, text, text, text, text, date, text),
  app.update_shareholder(uuid, text, text, text, text, text, text, text, text),
  app.set_shareholder_status(uuid, text, text),
  app.link_shareholder_account(uuid, uuid, text),
  app.create_share_class(text, text, bigint, text),
  app.update_share_class(text, text, text, bigint, boolean, text),
  app.update_shareholding_policy(text, jsonb, text),
  -- the ownership ledger
  app.issue_shares(uuid, text, bigint, text, date, text, bigint, uuid, date, text, text, text),
  app.transfer_shares(uuid, uuid, text, bigint, text, text, date, text, text),
  app.adjust_shares(uuid, text, bigint, text, text, boolean, date, text, text),
  app.decide_share_transaction(uuid, text, text),
  app.record_share_contribution(uuid, bigint, text, text, uuid, date, text, text),
  app.reverse_share_contribution(uuid, text),
  app.reverse_share_transaction(uuid, text, text),
  app.ownership_as_of(date, text),
  -- self-service: the ONLY way a shareholder reads their own record
  app.my_shareholding(),
  -- dividends
  app.create_dividend(text, date, text, text, bigint, bigint, date, date, text, text),
  app.update_dividend(uuid, text, date, text, bigint, bigint, date, date, text, text),
  app.calculate_dividend(uuid),
  app.update_dividend_status(uuid, text, text),
  app.pay_dividend(uuid, uuid[], uuid, text, text, date),
  app.reverse_dividend_payment(uuid, text),
  app.cancel_dividend(uuid, text)
to authenticated;

-- ---------------------------------------------------------------------------
-- Everything else stays denied
-- ---------------------------------------------------------------------------
-- Not granted above, and therefore unreachable from a browser session:
--   app.post_transaction, app.move_account, app.summarise_day,
--   app.post_ledger_entry, app.post_purchase_payment, app.move_stock,
--   app.reverse_spending_record, app.sweep_recurring_expenses,
--   app.post_ownership_reversal                        fabricating money
--   app.calculate_payroll, app.salary_version_on,
--   app.allowance_*, app.lateness, app.incident_status  staff pay machinery
--   app.rebuild_ownership, app.post_share_transaction,
--   app.submit_share_transaction, app.write_share_contribution,
--   app.holdings_as_of, app.holdings_by_class,
--   app.never_negative, app.locked_record_date          ownership machinery
--   app.read_shareholder, app.read_share_class,
--   app.read_dividend, app.require_*, app.guard_*       internal helpers
--
-- `src/test/db/rpc-exposure.test.ts` fails if a function in `app` becomes
-- executable without being named here.
