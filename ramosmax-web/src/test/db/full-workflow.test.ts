import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, closePool, makeUser, type Session } from './harness';
import { becomeClient, becomeOwner, requestId, SEED } from './billing-helpers';
import { balanceOf, fund, ledgerDisagreements } from './finance-helpers';
import { autoPost, shareClass, testClassCode } from './ownership-helpers';

afterAll(closePool);

/**
 * ONE WHOLE BUSINESS DAY, end to end.
 *
 * Every phase of RamosMAX in a single transaction, each step taken by the
 * role that is allowed to take it, with the invariants checked as they pass:
 *
 *   a customer and a vehicle           (Phase 3)
 *   an intake, assigned, worked, done  (Phase 3)
 *   an invoice, a payment, a receipt   (Phase 4)
 *   an expense paid, stock received    (Phase 5)
 *   attendance, an allowance, payroll  (Phase 6)
 *   a loss reported                    (Phase 6)
 *   shares issued, a dividend paid     (Phase 7)
 *   an after-hours shift and handover  (Phase 8)
 *   a report that agrees with all of it (Phase 9)
 *
 * The point is not that each step works — the phase suites prove that. The
 * point is that they still agree with each other when they all happen on the
 * same day to the same business: one ledger, one set of balances, one set of
 * totals.
 */
const money = async (db: Session, code: string) => balanceOf(db, code);

describe('a whole business day', () => {
  it('runs every phase in sequence, and the books still balance', async () => {
    await asAdminDb(async (db) => {
      const openingCash = await money(db, 'cash_at_hand');
      const day = (await db.query<{ d: string }>(`select app.eat_day()::text as d`)).rows[0].d;

      // --- Phase 3: a customer drives in --------------------------------
      await becomeClient(db, SEED.manager);
      const { rows: customer } = await db.query<{ id: string }>(
        `select app.create_customer('Whole Day Customer', '0772400111') as id`);
      const { rows: vehicle } = await db.query<{ id: string }>(
        `select app.create_vehicle('UDX 900W', 'Hilux', 'White', 'Toyota', null, null, $1) as id`,
        [customer[0].id]);

      await becomeClient(db, SEED.cashier);
      const { rows: service } = await db.query<{ id: string }>(
        `select id from public.services where name = 'Full Valet'`);
      const { rows: intake } = await db.query<{ id: string }>(
        `select app.create_service_intake($1, array[$2::uuid]) as id`,
        [vehicle[0].id, service[0].id]);

      await becomeOwner(db);
      const { rows: orders } = await db.query<{ id: string }>(
        `select id from public.worker_orders where service_intake_id = $1`, [intake[0].id]);
      expect(orders.length).toBe(1);

      await becomeClient(db, SEED.manager);
      await db.query(`select app.assign_worker_order($1, $2)`, [orders[0].id, SEED.worker]);
      await becomeClient(db, SEED.worker);
      for (const action of ['accept', 'start', 'complete']) {
        await db.query(`select app.update_worker_order_status($1, $2)`, [orders[0].id, action]);
      }

      // --- Phase 4: it is invoiced and paid ------------------------------
      await becomeClient(db, SEED.cashier);
      const { rows: invoice } = await db.query<{ id: string }>(
        `select app.create_invoice($1) as id`, [intake[0].id]);
      const { rows: amounts } = await db.query<{ total_ugx: string; outstanding_ugx: string }>(
        `select total_ugx, outstanding_ugx from public.invoices where id = $1`, [invoice[0].id]);
      const invoiceTotal = Number(amounts[0].total_ugx);
      expect(Number(amounts[0].outstanding_ugx)).toBe(invoiceTotal);

      const { rows: payment } = await db.query<{ receipt_number: string }>(
        `select * from app.record_payment($1, $2, 'cash', $3)`,
        [invoice[0].id, invoiceTotal, requestId('day')]);
      expect(payment[0].receipt_number).toMatch(/^RMX-RCP-/);
      await becomeOwner(db);
      expect(await money(db, 'cash_at_hand')).toBe(openingCash + invoiceTotal);

      // --- Phase 5: money goes out too -----------------------------------
      await becomeClient(db, SEED.manager);
      const { rows: category } = await db.query<{ id: string }>(
        `select id from public.expense_categories order by name limit 1`);
      const { rows: expense } = await db.query<{ expense_id: string }>(
        `select * from app.create_expense($1, 'Water for the bay', 40000, $2::date, $3,
           'Utility Co', null, null, null, true)`,
        [category[0].id, day, requestId('expense-create')]);
      // Review and approval are separate steps, in that order.
      await db.query(`select * from app.update_expense_status($1, 'review', 'Checked the meter')`,
        [expense[0].expense_id]);
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.update_expense_status($1, 'approve', 'Needed today')`,
        [expense[0].expense_id]);
      const { rows: account } = await db.query<{ id: string }>(
        `select id from public.financial_accounts where code = 'cash_at_hand'`);
      await db.query(`select * from app.pay_expense($1, $2, $3)`,
        [expense[0].expense_id, account[0].id, requestId('expense')]);
      await becomeOwner(db);
      const afterExpense = await money(db, 'cash_at_hand');
      expect(afterExpense).toBe(openingCash + invoiceTotal - 40_000);

      // --- Phase 6: the people who did the work --------------------------
      const { rows: when } = await db.query<{ d: string }>(`
        select g.d::date::text as d
          from generate_series(date_trunc('month', app.eat_day())::date, app.eat_day() - 1,
                               interval '1 day') g(d)
         where extract(isodow from g.d) between 1 and 6
         order by g.d desc limit 1`);
      const worker = await makeUser(db, {
        role: 'worker', permissions: ['attendance.view.own', 'payroll.view.own'],
      });
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.set_salary_profile($1, 600000, '2020-01-01')`, [worker]);
      await becomeClient(db, SEED.manager);
      const { rows: attendance } = await db.query<{ attendance_id: string }>(
        `select * from app.record_attendance($1, 'present', $2::date,
           (($2::date + time '08:45') at time zone 'Africa/Kampala'))`, [worker, when[0].d]);
      await db.query(`select app.verify_attendance(array[$1]::uuid[], 'approve')`,
        [attendance[0].attendance_id]);
      await db.query(`select * from app.calculate_allowances($1::date)`, [when[0].d]);
      await becomeOwner(db);
      const { rows: allowance } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.worker_allowances
          where staff_uid = $1 and business_day = $2::date`, [worker, when[0].d]);
      expect(Number(allowance[0].n)).toBe(1);

      await becomeClient(db, SEED.manager);
      const { rows: loss } = await db.query<{ loss_number: string }>(
        `select * from app.create_loss_incident('damaged_equipment', 120000,
           'A pressure hose burst', $1)`, [requestId('loss')]);
      expect(loss[0].loss_number).toMatch(/^RMX-LOSS-/);

      // --- Phase 7: the owners -------------------------------------------
      const klass = await shareClass(db, testClassCode(), 100_000);
      await autoPost(db);
      await becomeClient(db, SEED.admin);
      const { rows: holder } = await db.query<{ shareholder_id: string }>(
        `select * from app.create_shareholder('Whole Day Owner', $1)`, [requestId('owner')]);
      await db.query(
        `select * from app.issue_shares($1, $2, 20, $3, null, 'account', 2000000, $4)`,
        [holder[0].shareholder_id, klass, requestId('issue'), account[0].id]);
      await becomeOwner(db);
      const afterCapital = await money(db, 'cash_at_hand');
      expect(afterCapital).toBe(afterExpense + 2_000_000);

      // --- Phase 8: the night shift ---------------------------------------
      const nightWorker = await makeUser(db, {
        role: 'worker', permissions: ['after_hours.request'],
      });
      const supervisor = await makeUser(db, {
        role: 'manager', permissions: ['after_hours.approve', 'after_hours.view'],
      });
      const counter = await makeUser(db, {
        role: 'manager', permissions: ['cash_handover.approve'],
      });
      await becomeClient(db, supervisor);
      await db.query(
        `select * from app.authorize_after_hours($1, null, 'Evening shift', $2, null, null,
           50000, 8)`, [nightWorker, requestId('authorize')]);
      await becomeClient(db, nightWorker);
      const { rows: session } = await db.query<{ session_id: string }>(
        `select * from app.open_after_hours_session($1)`, [requestId('session')]);
      const { rows: closed } = await db.query<{ handover_id: string; expected_cash_ugx: number }>(
        `select * from app.close_after_hours_session($1)`, [session[0].session_id]);
      expect(Number(closed[0].expected_cash_ugx)).toBe(50_000);

      await becomeClient(db, counter);
      const { rows: received } = await db.query<{ status: string; difference_ugx: number }>(
        `select * from app.receive_cash_handover($1, 50000, $2)`,
        [closed[0].handover_id, requestId('receive')]);
      expect(received[0].status).toBe('received');
      await becomeOwner(db);
      // A handover moves custody, not money.
      expect(await money(db, 'cash_at_hand')).toBe(afterCapital);

      // --- The books ------------------------------------------------------
      expect(await ledgerDisagreements(db)).toEqual([]);

      // --- Phase 9: the report agrees with all of it ----------------------
      await becomeClient(db, SEED.admin);
      const { rows: report } = await db.query<{ r: Record<string, unknown> }>(
        `select app.business_report('executive', $1::date, $1::date) as r`, [day]);
      await becomeOwner(db);

      type Section = { key: string; figures: Array<{ key: string; value: number }> };
      const sections = report[0].r.sections as Section[];
      const value = (sectionKey: string, figureKey: string) =>
        Number(sections.find((s) => s.key === sectionKey)
          ?.figures.find((f) => f.key === figureKey)?.value ?? Number.NaN);

      // The revenue in the report is the payment that was taken.
      expect(value('revenue', 'operating_revenue')).toBeGreaterThanOrEqual(invoiceTotal);
      // The balance in the report is the balance in the ledger.
      expect(value('finance', 'balance_cash_at_hand')).toBe(await money(db, 'cash_at_hand'));
      // Share capital is in the report as capital, and never as revenue.
      expect(value('ownership', 'capital_in_period')).toBeGreaterThanOrEqual(2_000_000);
      // The operating expense is an expense, and the share capital is not.
      expect(value('finance', 'expenses_paid')).toBeGreaterThanOrEqual(40_000);
    });
  });

  it('leaves every account agreeing with its own ledger entries', async () => {
    await asAdminDb(async (db) => {
      await fund(db, 'cash_at_hand', 100_000);
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });
});
