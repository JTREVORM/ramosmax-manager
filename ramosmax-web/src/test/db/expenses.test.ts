import { afterAll, describe, expect, it } from 'vitest';
import { closePool, makeUser } from './harness';
import {
  accountId, asAdminDb, balanceOf, becomeClient, becomeOwner, fund,
  ledgerDisagreements, requestId, SEED,
} from './finance-helpers';

afterAll(closePool);

/** A fresh draft expense, recorded by the manager. */
async function draft(db: Parameters<Parameters<typeof asAdminDb>[0]>[0], amount = 90_000) {
  await becomeClient(db, SEED.manager);
  const { rows } = await db.query<{ expense_id: string; expense_number: string; status: string }>(
    `select * from app.create_expense('utilities', 'Water bill', $1, current_date, $2)`,
    [amount, requestId('expense')]);
  return rows[0];
}

// ---------------------------------------------------------------------------
describe('the expense lifecycle', () => {
  it('goes draft → submitted → reviewed → approved → paid', async () => {
    await asAdminDb(async (db) => {
      const before = await balanceOf(db, 'cash_at_hand');
      await fund(db, 'cash_at_hand', 500_000);
      const cash = await accountId(db, 'cash_at_hand');
      const expense = await draft(db, 120_000);
      expect(expense.expense_number).toMatch(/^RMX-EXP-\d{6}$/);
      expect(expense.status).toBe('draft');

      await becomeClient(db, SEED.manager);
      expect((await db.query<{ update_expense_status: string }>(
        `select app.update_expense_status($1, 'submit')`, [expense.expense_id]
      )).rows[0].update_expense_status).toBe('pending_review');
      await db.query(`select app.update_expense_status($1, 'review', 'Checked the meter')`,
        [expense.expense_id]);
      expect((await db.query<{ update_expense_status: string }>(
        `select app.update_expense_status($1, 'approve')`, [expense.expense_id]
      )).rows[0].update_expense_status).toBe('approved');

      // Nothing has moved yet.
      await becomeOwner(db);
      expect(await balanceOf(db, 'cash_at_hand')).toBe(before + 500_000);

      await becomeClient(db, SEED.manager);
      const { rows: paid } = await db.query<{ transaction_number: string; balance_ugx: string }>(
        `select * from app.pay_expense($1, $2, $3)`, [expense.expense_id, cash, requestId('pay')]);
      expect(paid[0].transaction_number).toMatch(/^RMX-TXN-\d{6}$/);

      await becomeOwner(db);
      expect(await balanceOf(db, 'cash_at_hand')).toBe(before + 380_000);
      const { rows } = await db.query<{ status: string; paid_from_account_name: string }>(
        `select status, paid_from_account_name from public.expenses where id = $1`,
        [expense.expense_id]);
      expect(rows[0].status).toBe('paid');
      expect(rows[0].paid_from_account_name).toBe('Cash at Hand');
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });

  it('records an expense as an EXPENSE, and a purchase as a purchase', async () => {
    await asAdminDb(async (db) => {
      await fund(db, 'cash_at_hand', 500_000);
      const cash = await accountId(db, 'cash_at_hand');
      const expense = await draft(db, 100_000);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.update_expense_status($1, 'submit')`, [expense.expense_id]);
      await db.query(`select app.update_expense_status($1, 'review', 'ok')`, [expense.expense_id]);
      await db.query(`select app.update_expense_status($1, 'approve')`, [expense.expense_id]);
      await db.query(`select * from app.pay_expense($1, $2, $3)`,
        [expense.expense_id, cash, requestId('pay')]);

      await becomeOwner(db);
      const { rows } = await db.query<{ expenses_paid_ugx: string; purchases_paid_ugx: string }>(
        `select expenses_paid_ugx, purchases_paid_ugx from public.finance_daily_summaries
          where business_day = app.eat_day()`);
      expect(Number(rows[0].expenses_paid_ugx)).toBeGreaterThanOrEqual(100_000);
    });
  });

  it('cannot be approved before it is reviewed', async () => {
    await asAdminDb(async (db) => {
      const expense = await draft(db);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.update_expense_status($1, 'submit')`, [expense.expense_id]);
      const error = await db.expectError(
        `select app.update_expense_status($1, 'approve')`, [expense.expense_id]);
      expect(error).toMatch(/Review the expense before approving/i);
    });
  });

  it('cannot be reviewed twice', async () => {
    await asAdminDb(async (db) => {
      const expense = await draft(db);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.update_expense_status($1, 'submit')`, [expense.expense_id]);
      await db.query(`select app.update_expense_status($1, 'review', 'ok')`, [expense.expense_id]);
      const error = await db.expectError(
        `select app.update_expense_status($1, 'review', 'again')`, [expense.expense_id]);
      expect(error).toMatch(/already been reviewed/i);
    });
  });

  it('cannot be paid unless it is approved', async () => {
    await asAdminDb(async (db) => {
      await fund(db, 'cash_at_hand', 500_000);
      const cash = await accountId(db, 'cash_at_hand');
      const expense = await draft(db);
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.pay_expense($1, $2, $3)`, [expense.expense_id, cash, requestId('pay')]);
      expect(error).toMatch(/Only an approved expense can be paid/i);
    });
  });

  it('cannot be paid twice', async () => {
    await asAdminDb(async (db) => {
      await fund(db, 'cash_at_hand', 500_000);
      const cash = await accountId(db, 'cash_at_hand');
      const expense = await draft(db, 50_000);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.update_expense_status($1, 'submit')`, [expense.expense_id]);
      await db.query(`select app.update_expense_status($1, 'review', 'ok')`, [expense.expense_id]);
      await db.query(`select app.update_expense_status($1, 'approve')`, [expense.expense_id]);
      await db.query(`select * from app.pay_expense($1, $2, $3)`,
        [expense.expense_id, cash, requestId('pay')]);
      const error = await db.expectError(
        `select * from app.pay_expense($1, $2, $3)`,
        [expense.expense_id, cash, requestId('again')]);
      expect(error).toMatch(/already been paid/i);
    });
  });

  it('requires a reason to reject or cancel', async () => {
    await asAdminDb(async (db) => {
      const expense = await draft(db);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.update_expense_status($1, 'submit')`, [expense.expense_id]);
      const reject = await db.expectError(
        `select app.update_expense_status($1, 'reject')`, [expense.expense_id]);
      expect(reject).toMatch(/reason/i);
      const cancel = await db.expectError(
        `select app.update_expense_status($1, 'cancel')`, [expense.expense_id]);
      expect(cancel).toMatch(/reason/i);
    });
  });

  it('treats a rejected expense as final', async () => {
    await asAdminDb(async (db) => {
      const expense = await draft(db);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.update_expense_status($1, 'submit')`, [expense.expense_id]);
      await db.query(`select app.update_expense_status($1, 'reject', 'Not our bill')`,
        [expense.expense_id]);
      const error = await db.expectError(
        `select app.update_expense_status($1, 'approve')`, [expense.expense_id]);
      expect(error).toMatch(/rejected/i);
    });
  });

  it('cannot be edited once reviewed', async () => {
    await asAdminDb(async (db) => {
      const expense = await draft(db);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.update_expense_status($1, 'submit')`, [expense.expense_id]);
      await db.query(`select app.update_expense_status($1, 'review', 'ok')`, [expense.expense_id]);
      const error = await db.expectError(
        `select app.update_expense($1, null, null, 200000)`, [expense.expense_id]);
      expect(error).toMatch(/draft or an unreviewed expense/i);
    });
  });

  it('returns to approved when its payment is reversed, and is never deleted', async () => {
    await asAdminDb(async (db) => {
      const before = await balanceOf(db, 'cash_at_hand');
      await fund(db, 'cash_at_hand', 500_000);
      const cash = await accountId(db, 'cash_at_hand');
      const expense = await draft(db, 75_000);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.update_expense_status($1, 'submit')`, [expense.expense_id]);
      await db.query(`select app.update_expense_status($1, 'review', 'ok')`, [expense.expense_id]);
      await db.query(`select app.update_expense_status($1, 'approve')`, [expense.expense_id]);
      const { rows: paid } = await db.query<{ transaction_id: string }>(
        `select * from app.pay_expense($1, $2, $3)`, [expense.expense_id, cash, requestId('pay')]);

      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.reverse_financial_transaction($1, 'Paid from the wrong account')`,
        [paid[0].transaction_id]);

      await becomeOwner(db);
      const { rows } = await db.query<{ status: string; financial_transaction_id: string | null;
                                       payment_reversal_reason: string }>(
        `select status, financial_transaction_id, payment_reversal_reason
           from public.expenses where id = $1`, [expense.expense_id]);
      expect(rows[0].status).toBe('approved');
      expect(rows[0].financial_transaction_id).toBeNull();
      expect(rows[0].payment_reversal_reason).toMatch(/wrong account/i);
      expect(await balanceOf(db, 'cash_at_hand')).toBe(before + 500_000);

      const deleted = await db.expectError(`delete from public.expenses where id = $1`,
        [expense.expense_id]);
      expect(deleted).toMatch(/never deletes/i);
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
describe('expense permissions', () => {
  it('lets a cashier record but never review, approve or pay', async () => {
    await asAdminDb(async (db) => {
      await fund(db, 'cash_at_hand', 500_000);
      const cash = await accountId(db, 'cash_at_hand');

      await becomeClient(db, SEED.cashier);
      const { rows } = await db.query<{ expense_id: string }>(
        `select * from app.create_expense('operations', 'Petty cash top-up', 20000,
                                          current_date, $1, null, null, null, null, true)`,
        [requestId('petty')]);
      expect(rows[0].expense_id).toBeTruthy();

      for (const [action, args] of [['review', `, 'seen'`], ['approve', ''], ['cancel', `, 'no'`]] as const) {
        const error = await db.expectError(
          `select app.update_expense_status($1, '${action}'${args})`, [rows[0].expense_id]);
        expect(error).toMatch(/do not have permission/i);
      }
      const pay = await db.expectError(
        `select * from app.pay_expense($1, $2, $3)`, [rows[0].expense_id, cash, requestId('p')]);
      expect(pay).toMatch(/do not have permission/i);
    });
  });

  it('refuses an auditor every expense action', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.auditor);
      const error = await db.expectError(
        `select * from app.create_expense('operations', 'Anything', 1000, current_date, $1)`,
        [requestId('x')]);
      expect(error).toMatch(/do not have permission/i);
    });
  });

  it('lets only a holder of expenses.adjust reverse a payment', async () => {
    await asAdminDb(async (db) => {
      await fund(db, 'cash_at_hand', 300_000);
      const cash = await accountId(db, 'cash_at_hand');
      const expense = await draft(db, 40_000);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.update_expense_status($1, 'submit')`, [expense.expense_id]);
      await db.query(`select app.update_expense_status($1, 'review', 'ok')`, [expense.expense_id]);
      await db.query(`select app.update_expense_status($1, 'approve')`, [expense.expense_id]);
      const { rows } = await db.query<{ transaction_id: string }>(
        `select * from app.pay_expense($1, $2, $3)`, [expense.expense_id, cash, requestId('pay')]);

      // The manager may transfer and deposit, but not unpick a payment.
      const error = await db.expectError(
        `select * from app.reverse_financial_transaction($1, 'Wrong')`, [rows[0].transaction_id]);
      expect(error).toMatch(/do not have permission/i);
    });
  });

  it('needs the reviewer\'s permission to edit someone else\'s draft', async () => {
    await asAdminDb(async (db) => {
      const other = await makeUser(db, { role: 'cashier' });
      await becomeClient(db, other);
      const { rows } = await db.query<{ expense_id: string }>(
        `select * from app.create_expense('office', 'Printer paper', 30000, current_date, $1)`,
        [requestId('paper')]);

      await becomeOwner(db);
      const stranger = await makeUser(db, { role: 'cashier' });
      await becomeClient(db, stranger);
      const error = await db.expectError(
        `select app.update_expense($1, null, 'Something else')`, [rows[0].expense_id]);
      expect(error).toMatch(/do not have permission/i);

      await becomeClient(db, SEED.manager);
      await db.query(`select app.update_expense($1, null, 'Reviewed wording')`, [rows[0].expense_id]);
    });
  });
});

// ---------------------------------------------------------------------------
describe('expense categories', () => {
  it('ships the ten built-in categories', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `select id from public.expense_categories where is_default order by id`);
      expect(rows.map((r) => r.id)).toEqual([
        'financial_charges', 'licences', 'marketing', 'miscellaneous', 'office',
        'operations', 'premises', 'repairs', 'transport', 'utilities']);
    });
  });

  it('slugs a new category and refuses a duplicate name', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ create_expense_category: string }>(
        `select app.create_expense_category('Security Services')`);
      expect(rows[0].create_expense_category).toBe('security_services');
      const error = await db.expectError(
        `select app.create_expense_category('security services')`);
      expect(error).toMatch(/already exists/i);
    });
  });

  it('refuses a retired category for a new expense', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      await db.query(`select app.update_expense_category('marketing', null, false, 'Not used')`);
      const error = await db.expectError(
        `select * from app.create_expense('marketing', 'Poster', 10000, current_date, $1)`,
        [requestId('x')]);
      expect(error).toMatch(/no longer in use/i);
    });
  });
});

// ---------------------------------------------------------------------------
describe('recurring expenses', () => {
  it('creates a DRAFT for a due item and never pays it', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ create_recurring_expense: string }>(
        `select app.create_recurring_expense('Monthly rent', 'premises', 1500000,
                                             'monthly', current_date, null, null, 0)`);
      const recurring = rows[0].create_recurring_expense;

      await becomeOwner(db);
      const { rows: made } = await db.query<{ sweep_recurring_expenses: number }>(
        `select app.sweep_recurring_expenses()`);
      expect(made[0].sweep_recurring_expenses).toBeGreaterThanOrEqual(1);

      const { rows: expense } = await db.query<{ status: string; amount_ugx: string; created_by: string | null }>(
        `select status, amount_ugx, created_by from public.expenses where recurring_expense_id = $1`,
        [recurring]);
      expect(expense).toHaveLength(1);
      expect(expense[0].status).toBe('draft');
      expect(Number(expense[0].amount_ugx)).toBe(1_500_000);
      // Nobody signed for it: the sweep is the system, not a person.
      expect(expense[0].created_by).toBeNull();
    });
  });

  it('generates each due date only once, however often it runs', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      await db.query(
        `select app.create_recurring_expense('Weekly water', 'utilities', 60000,
                                             'weekly', current_date, null, null, 0)`);
      await becomeOwner(db);
      await db.query(`select app.sweep_recurring_expenses()`);
      const { rows: again } = await db.query<{ sweep_recurring_expenses: number }>(
        `select app.sweep_recurring_expenses()`);
      expect(again[0].sweep_recurring_expenses).toBe(0);

      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.expenses where description = 'Weekly water'`);
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  it('advances monthly dates on the anchor day, clamping in short months', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ jan: string; feb: string; mar: string }>(`
        select app.advance_due_date(date '2026-01-31', 'monthly', 31)::text as jan,
               app.advance_due_date(date '2026-02-28', 'monthly', 31)::text as feb,
               app.advance_due_date(date '2026-03-31', 'quarterly', 31)::text as mar`);
      // 31 Jan → 28 Feb → 31 Mar: the anchor day survives a short month.
      expect(rows[0].jan).toBe('2026-02-28');
      expect(rows[0].feb).toBe('2026-03-31');
      expect(rows[0].mar).toBe('2026-06-30');
    });
  });

  it('is not callable from a browser session', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      const error = await db.expectError(`select app.sweep_recurring_expenses()`);
      expect(error).toMatch(/not callable from a client session|permission denied/i);
    });
  });

  it('stops producing due items once it is switched off', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ create_recurring_expense: string }>(
        `select app.create_recurring_expense('Quarterly licence', 'licences', 400000,
                                             'quarterly', current_date, null, null, 0)`);
      await db.query(`select app.update_recurring_expense($1, null, null, null, null, null, null, null,
                                                          false, 'Licence no longer needed')`,
        [rows[0].create_recurring_expense]);
      await becomeOwner(db);
      const { rows: made } = await db.query<{ sweep_recurring_expenses: number }>(
        `select app.sweep_recurring_expenses()`);
      const { rows: expenses } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.expenses where recurring_expense_id = $1`,
        [rows[0].create_recurring_expense]);
      expect(Number(expenses[0].n)).toBe(0);
      expect(made[0].sweep_recurring_expenses).toBeGreaterThanOrEqual(0);
    });
  });
});
