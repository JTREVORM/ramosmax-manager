import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, closePool } from './harness';

afterAll(closePool);

/**
 * THE ALLOW-LIST, GUARDED.
 *
 * PostgreSQL grants EXECUTE on a new function to PUBLIC, and `authenticated`
 * inherits PUBLIC. Phase D closed that with a revoke, a default privilege and
 * an explicit allow-list; this test makes the allow-list a fact that cannot
 * drift. If a helper added later becomes callable from a browser session, this
 * fails and names it.
 *
 * Adding a function here is a deliberate act: it means a signed-in user may
 * call it, and that the function checks the caller's permissions itself.
 */

/** Read-only predicates the RLS policies themselves call. */
const RLS_HELPERS = [
  'is_signed_in()',
  'is_active()',
  'is_admin()',
  'current_role_id()',
  'has_permission(text)',
  'has_either_permission(text,text)',
  'own_with(text,uuid)',
  'is_client_session()',
];

/** Pure helpers and figures the UI legitimately shows. */
const PURE_HELPERS = [
  'plate_key(text)',
  'display_plate(text)',
  'parse_plate(text)',
  'is_plate_shape(text)',
  'normalize_phone(text)',
  'mask_phone(text)',
  'mask_account_number(text)',
  'eat_day(timestamp with time zone)',
  'percent_of(bigint,bigint)',
  'discount_approval_threshold_percent()',
  'job_status_for(jsonb)',
  'loyalty_config()',
  'vehicle_loyalty(uuid)',
  'search_vehicles(text,integer)',
  'assignable_workers()',
  'high_value_threshold_ugx()',
  'max_amount_ugx()',
  // workforce (Phase F): the policy, the period arithmetic and the limits the
  // forms show. None reveals a salary, a deduction or anyone's pay.
  'payroll_policy()',
  'payroll_period(text,integer,integer,date)',
  'max_backdate_days()',
  'max_salary_ugx()',
  'eat_day_start(date)',
  'iso_weekday(date)',
  // ownership (final phase): the two policies, the derived lines of an entry
  // the caller may already read, and the percentage arithmetic.
  'share_policy()',
  'dividend_policy()',
  'share_transaction_lines(uuid)',
  'ownership_percent(bigint,bigint)',
  // after-hours (final phase): the policy, the list of permissions an
  // authorisation may hand out, and the caller's OWN open session. None of
  // them reveals anybody else's session, cash or handover.
  'after_hours_policy()',
  'after_hours_methods()',
  'after_hours_grantable()',
  'after_hours_default_grants()',
  'after_hours_context(uuid)',
];

/** The command surface: every function a browser may ask for by name. */
const COMMANDS = [
  // access (Phase B)
  'set_user_role(uuid,text,text)',
  'set_user_active(uuid,boolean,text)',
  'set_user_permissions(uuid,text[],text[],text)',
  'grant_temporary_permission(uuid,text,timestamp with time zone,timestamp with time zone,text)',
  'revoke_temporary_permission(uuid,text)',
  // operations (Phase C)
  'create_customer(text,text,text,text,text,text)',
  'update_customer(uuid,text,text,text,text,text,text)',
  'set_customer_status(uuid,boolean,text)',
  'create_vehicle(text,text,text,text,integer,text,uuid,text)',
  'update_vehicle(uuid,text,text,text,integer,text,text)',
  'change_vehicle_plate(uuid,text,text)',
  'set_vehicle_customer(uuid,uuid,text)',
  'set_vehicle_status(uuid,boolean,text)',
  'create_service(text,text,bigint,text,integer,boolean)',
  'update_service(uuid,text,text,bigint,text,integer,boolean,text)',
  'set_service_active(uuid,boolean)',
  'create_service_intake(uuid,uuid[],text,boolean)',
  'cancel_service_intake(uuid,text)',
  'assign_worker_order(uuid,uuid,text)',
  'reassign_worker_order(uuid,uuid,text)',
  'cancel_worker_order(uuid,text)',
  'update_worker_order_status(uuid,text,text,text)',
  // money (Phase D)
  'create_invoice(uuid)',
  'apply_invoice_discount(uuid,text,bigint,text,text)',
  'mark_invoice_credit(uuid,text)',
  'record_payment(uuid,bigint,text,text,text,text,uuid)',
  'reverse_payment(uuid,text)',
  'cancel_invoice(uuid,text)',
  'apply_loyalty_reward(uuid,bigint)',
  'adjust_loyalty_points(uuid,integer,text)',
  'reverse_loyalty_transaction(uuid,text)',
  // finance (Phase E)
  'create_financial_account(text,text,text,text,text,bigint)',
  'update_financial_account(uuid,text,text,text,text,boolean,text)',
  'record_opening_balance(uuid,bigint,text)',
  'transfer_funds(uuid,uuid,bigint,text,text,date,text,text)',
  'record_bank_deposit(uuid,uuid,bigint,text,text,date,text)',
  'reconcile_account(uuid,bigint,text,date,text)',
  'record_account_adjustment(uuid,text,bigint,text,text,uuid)',
  'reverse_financial_transaction(uuid,text)',
  // expenses (Phase E)
  'create_expense_category(text)',
  'update_expense_category(text,text,boolean,text)',
  'create_expense(text,text,bigint,date,text,text,uuid,text,text,boolean)',
  'update_expense(uuid,text,text,bigint,date,text,uuid,text,text,text)',
  'update_expense_status(uuid,text,text,text)',
  'pay_expense(uuid,uuid,text,text,date)',
  'create_recurring_expense(text,text,bigint,text,date,text,uuid,integer,text)',
  'update_recurring_expense(uuid,text,bigint,date,integer,text,uuid,text,boolean,text)',
  // inventory (Phase E)
  'create_inventory_item(text,text,text,integer,integer,text,boolean,uuid,bigint,text,integer)',
  'update_inventory_item(uuid,text,text,text,integer,integer,text,boolean,uuid,bigint,boolean,text)',
  'record_stock_movement(uuid,text,integer,text,text,text,text,bigint,uuid,uuid)',
  'adjust_stock(uuid,integer,text,text)',
  'reverse_stock_movement(uuid,text)',
  'create_supplier(text,text,text,text,text,text)',
  'update_supplier(uuid,text,text,text,text,text,text,boolean,text)',
  'create_purchase(uuid,jsonb,text,date,text,text)',
  'update_purchase_status(uuid,text,text)',
  'receive_purchase(uuid,text,uuid,text)',
  'pay_purchase(uuid,uuid,text,text)',
  // workforce (Phase F)
  'update_payroll_policy(jsonb,text)',
  'record_attendance(uuid,text,date,timestamp with time zone,timestamp with time zone,text)',
  'clock_out(uuid,timestamp with time zone)',
  'verify_attendance(uuid[],text,text,text)',
  'correct_attendance(uuid,text,text,timestamp with time zone,timestamp with time zone,text,boolean)',
  'calculate_allowances(date)',
  'review_allowance(uuid[],text,text,bigint)',
  'pay_allowances(uuid[],uuid,text,text,date)',
  'reverse_allowance_payment(uuid,text)',
  'cancel_allowance(uuid[],text)',
  'set_salary_profile(uuid,bigint,date,text,boolean,bigint,boolean,text,text)',
  'create_payroll(text,integer,integer,date,text)',
  'prepare_payroll(uuid,text)',
  'correct_payroll(uuid,text)',
  'add_payroll_earning(uuid,uuid,text,bigint,text)',
  'remove_payroll_earning(uuid,text)',
  'update_payroll_status(uuid,text,text,text)',
  'pay_payroll(uuid,uuid,text,text,date)',
  'reverse_payroll_payment(uuid,text)',
  'lock_payroll(uuid)',
  'cancel_payroll(uuid,text)',
  'create_loss_incident(text,bigint,text,text,uuid,date,text)',
  'review_loss_incident(uuid,text)',
  'decide_loss_incident(uuid,text,text,bigint)',
  'schedule_loss_recovery(uuid,bigint,date,text)',
  'cancel_loss_incident(uuid,text)',
  'create_salary_deduction(uuid,text,bigint,text,text,text,bigint,date)',
  'decide_salary_deduction(uuid,text,text)',
  'cancel_salary_deduction(uuid,text)',
  // ownership (final phase)
  'create_shareholder(text,text,text,text,text,text,text,date,text)',
  'update_shareholder(uuid,text,text,text,text,text,text,text,text)',
  'set_shareholder_status(uuid,text,text)',
  'link_shareholder_account(uuid,uuid,text)',
  'create_share_class(text,text,bigint,text)',
  'update_share_class(text,text,text,bigint,boolean,text)',
  'update_shareholding_policy(text,jsonb,text)',
  'issue_shares(uuid,text,bigint,text,date,text,bigint,uuid,date,text,text,text)',
  'transfer_shares(uuid,uuid,text,bigint,text,text,date,text,text)',
  'adjust_shares(uuid,text,bigint,text,text,boolean,date,text,text)',
  'decide_share_transaction(uuid,text,text)',
  'record_share_contribution(uuid,bigint,text,text,uuid,date,text,text)',
  'reverse_share_contribution(uuid,text)',
  'reverse_share_transaction(uuid,text,text)',
  'ownership_as_of(date,text)',
  'my_shareholding()',
  'create_dividend(text,date,text,text,bigint,bigint,date,date,text,text)',
  'update_dividend(uuid,text,date,text,bigint,bigint,date,date,text,text)',
  'calculate_dividend(uuid)',
  'update_dividend_status(uuid,text,text)',
  'pay_dividend(uuid,uuid[],uuid,text,text,date)',
  'reverse_dividend_payment(uuid,text)',
  'cancel_dividend(uuid,text)',
  // after-hours and cash handovers (final phase)
  'update_after_hours_policy(jsonb,text)',
  'authorize_after_hours(uuid,timestamp with time zone,text,text,timestamp with time zone,text[],bigint)',
  'revoke_after_hours(uuid,text)',
  'open_after_hours_session(text,text)',
  'close_after_hours_session(uuid,text)',
  'cancel_after_hours_session(uuid,text)',
  'submit_cash_handover(uuid,bigint,text,text)',
  'receive_cash_handover(uuid,bigint,text,text,text)',
  'review_cash_discrepancy(uuid,text)',
  'resolve_cash_discrepancy(uuid,text,text,text,boolean,boolean)',
  'my_after_hours()',
  'sweep_after_hours()',
];

const ALLOWED = new Set([...RLS_HELPERS, ...PURE_HELPERS, ...COMMANDS]);

async function executableByClients(): Promise<string[]> {
  return asAdminDb(async (db) => {
    const { rows } = await db.query<{ signature: string }>(`
      -- Types only. Identity arguments would include the parameter NAMES,
      -- which are not part of what is being granted.
      select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app'
         and has_function_privilege('authenticated', p.oid, 'execute')
       order by 1`);
    // `oidvectortypes` separates with ", "; the list above uses plain commas.
    return rows.map((r) => r.signature.replace(/,\s+/g, ','));
  });
}

describe('no app function is callable by a client unless it is on the allow-list', () => {
  it('exposes nothing unexpected', async () => {
    const exposed = await executableByClients();
    const surprises = exposed.filter((s) => !ALLOWED.has(s));
    expect(surprises, 'these became browser-callable without being allow-listed').toEqual([]);
  });

  it('still exposes everything the application needs', async () => {
    const exposed = new Set(await executableByClients());
    const missing = [...ALLOWED].filter((s) => !exposed.has(s));
    expect(missing, 'these are allow-listed but not actually granted').toEqual([]);
  });

  it('keeps the money and stock machinery off the list', async () => {
    const exposed = new Set(await executableByClients());
    for (const internal of [
      'post_transaction',
      'move_account',
      'summarise_day',
      'merge_account_totals',
      'post_ledger_entry',
      'post_purchase_payment',
      'move_stock',
      'reverse_spending_record',
      'sweep_recurring_expenses',
      'claim_request',
      'complete_request',
      'next_reference',
      'audit',
      'audit_auth',
      'post_loyalty',
      'effective_permissions',
      // Phase F: the workforce machinery the server keeps to itself.
      'calculate_payroll',
      'salary_version_on',
      'allowance_amount',
      'allowance_ineligibility',
      'allowance_suggestion',
      'lateness',
      'incident_status',
      'read_employee',
      'policy_int',
      'policy_bool',
      // Final phase: the ownership machinery the server keeps to itself.
      'rebuild_ownership',
      'post_share_transaction',
      'submit_share_transaction',
      'write_share_contribution',
      'post_ownership_reversal',
      'holdings_as_of',
      'holdings_by_class',
      'never_negative',
      'locked_record_date',
      'read_shareholder',
      'read_share_class',
      'read_dividend',
      'contribution_for',
      'check_share_payment',
      'permanent_permissions',
      'require_temporary_window',
      'require_grant_list',
      'authorization_is_live',
      'expected_from_payments',
      'tag_after_hours',
      'tag_completed_order',
      'count_on_session',
      'count_completed_order',
      'record_payment_custody',
      'record_reversal_custody',
      'require_not_own_handover',
    ]) {
      const found = [...exposed].filter((s) => s.startsWith(`${internal}(`));
      expect(found, `${internal} is callable by a client`).toEqual([]);
    }
  });

  it('grants nothing at all to anon', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ n: string }>(`
        select count(*)::text as n
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app' and has_function_privilege('anon', p.oid, 'execute')`);
      expect(Number(rows[0].n)).toBe(0);
    });
  });

  it('leaves no default privilege that would expose a future function', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ n: string }>(`
        select count(*)::text as n from pg_default_acl d
          join pg_namespace n on n.oid = d.defaclnamespace
         where n.nspname = 'app' and d.defaclobjtype = 'f'
           and array_to_string(d.defaclacl, ',') like '%=X/%'
           and array_to_string(d.defaclacl, ',') not like '%postgres=X/%'`);
      expect(Number(rows[0].n)).toBe(0);
    });
  });
});
