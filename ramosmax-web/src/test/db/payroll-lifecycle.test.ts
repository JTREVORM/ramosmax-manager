import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, becomeClient, becomeOwner, closePool, makeUser, SEED } from './harness';
import {
  approvePayroll,
  employ,
  ownAccount,
  payingAccount,
  payslip,
  preparePayroll,
  requestId,
  ugx,
  recentPeriod,
} from './workforce-helpers';
import { balanceOf, ledgerDisagreements, snapshot } from './finance-helpers';

afterAll(closePool);

/**
 * PREPARE → REVIEW → APPROVE (Administrator) → PAY → LOCK.
 *
 * Nobody carries a payroll through alone: the person who prepares it does not
 * review it, and approval is an Administrator's. Nobody reviews or approves a
 * payroll that includes their own pay.
 */

async function preparedPayroll(
  db: Parameters<Parameters<typeof asAdminDb>[0]>[0],
  salary = 600_000,
) {
  const staff = await employ(db, { salaryUgx: salary });
  const { year, month } = await recentPeriod(db);
  const { payroll, number } = await preparePayroll(db, year, month);
  return { staff, payroll, number };
}

describe('payroll: the period', () => {
  it('allows one payroll per frequency and period at the DATABASE', async () => {
    await asAdminDb(async (db) => {
      const { year, month } = await recentPeriod(db);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ payroll_id: string; period_key: string }>(
        `select * from app.create_payroll('monthly', $1, $2)`,
        [year, month],
      );
      expect(
        await db.expectError(`select * from app.create_payroll('monthly', $1, $2)`, [year, month]),
      ).toMatch(/already a monthly payroll/i);

      // And below the function: the partial unique index is the guarantee.
      await becomeOwner(db);
      expect(
        await db.expectError(
          `insert into public.payroll
           (payroll_number, frequency, period_key, period_label, period_start, period_end,
            period_last_day, created_by)
         select 'RMX-PAY-DUP', frequency, period_key, period_label, period_start, period_end,
                period_last_day, created_by
           from public.payroll where id = $1`,
          [rows[0].payroll_id],
        ),
      ).toMatch(/payroll_one_per_period|duplicate key/i);
    });
  });

  it('allows a weekly payroll over the same days', async () => {
    await asAdminDb(async (db) => {
      const { year, month } = await recentPeriod(db);
      await becomeClient(db, SEED.manager);
      await db.query(`select * from app.create_payroll('monthly', $1, $2)`, [year, month]);
      const { rows } = await db.query<{ period_key: string }>(
        `select * from app.create_payroll('weekly', null, null,
           (date_trunc('week', app.eat_day() - 10))::date)`,
      );
      expect(rows[0].period_key).toMatch(/^W\d{4}-\d{2}-\d{2}$/);
    });
  });

  it('insists a weekly payroll starts on a Monday', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      expect(
        await db.expectError(
          `select * from app.create_payroll('weekly', null, null,
           (date_trunc('week', app.eat_day() - 10)::date + 2))`,
        ),
      ).toMatch(/starts on a Monday/i);
    });
  });

  it('refuses a period that has not finished', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      expect(
        await db.expectError(
          `select * from app.create_payroll('monthly',
           extract(year from app.eat_day() + 60)::int, extract(month from app.eat_day() + 60)::int)`,
        ),
      ).toBeTruthy();
    });
  });
});

describe('payroll: separation of duties', () => {
  it('walks prepare → submit → review → approve', async () => {
    await asAdminDb(async (db) => {
      const { payroll } = await preparedPayroll(db);
      await becomeClient(db, SEED.manager);
      expect(
        (
          await db.query<{ update_payroll_status: string }>(
            `select app.update_payroll_status($1, 'submit')`,
            [payroll],
          )
        ).rows[0].update_payroll_status,
      ).toBe('pending_review');
      await db.query(
        `select app.update_payroll_status($1, 'review', null, 'Checked line by line')`,
        [payroll],
      );
      await becomeClient(db, SEED.admin);
      expect(
        (
          await db.query<{ update_payroll_status: string }>(
            `select app.update_payroll_status($1, 'approve')`,
            [payroll],
          )
        ).rows[0].update_payroll_status,
      ).toBe('approved');
    });
  });

  it('refuses approval before review', async () => {
    await asAdminDb(async (db) => {
      const { payroll } = await preparedPayroll(db);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.update_payroll_status($1, 'submit')`, [payroll]);
      await becomeClient(db, SEED.admin);
      expect(
        await db.expectError(`select app.update_payroll_status($1, 'approve')`, [payroll]),
      ).toMatch(/Review the payroll before approving/i);
    });
  });

  it('refuses approval by anyone but an Administrator while the policy says so', async () => {
    await asAdminDb(async (db) => {
      const { payroll } = await preparedPayroll(db);
      const approver = await makeUser(db, { role: 'manager', permissions: ['payroll.approve'] });
      await becomeClient(db, SEED.manager);
      await db.query(`select app.update_payroll_status($1, 'submit')`, [payroll]);
      await db.query(`select app.update_payroll_status($1, 'review')`, [payroll]);
      await becomeClient(db, approver);
      expect(
        await db.expectError(`select app.update_payroll_status($1, 'approve')`, [payroll]),
      ).toMatch(/approved by an Administrator/i);
    });
  });

  it('refuses to let someone review a payroll that includes their own pay', async () => {
    await asAdminDb(async (db) => {
      const reviewer = await makeUser(db, {
        role: 'manager',
        permissions: ['payroll.prepare', 'payroll.review'],
      });
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.set_salary_profile($1, 800000, '2020-01-01')`, [reviewer]);
      await becomeOwner(db);
      const { year, month } = await recentPeriod(db);
      const { payroll } = await preparePayroll(db, year, month);
      await becomeClient(db, reviewer);
      await db.query(`select app.update_payroll_status($1, 'submit')`, [payroll]);
      expect(
        await db.expectError(`select app.update_payroll_status($1, 'review')`, [payroll]),
      ).toMatch(/includes your own pay/i);
    });
  });

  it('refuses to review the same payroll twice', async () => {
    await asAdminDb(async (db) => {
      const { payroll } = await preparedPayroll(db);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.update_payroll_status($1, 'submit')`, [payroll]);
      await db.query(`select app.update_payroll_status($1, 'review')`, [payroll]);
      expect(
        await db.expectError(`select app.update_payroll_status($1, 'review')`, [payroll]),
      ).toMatch(/already been reviewed|waiting for review/i);
    });
  });

  it('returns a payroll for correction, with a reason', async () => {
    await asAdminDb(async (db) => {
      const { payroll } = await preparedPayroll(db);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.update_payroll_status($1, 'submit')`, [payroll]);
      expect(
        await db.expectError(`select app.update_payroll_status($1, 'return')`, [payroll]),
      ).toMatch(/reason/i);
      await db.query(`select app.update_payroll_status($1, 'return', 'One salary is wrong')`, [
        payroll,
      ]);
      await becomeOwner(db);
      const { rows } = await db.query<{ status: string; returned_reason: string }>(
        `select status, returned_reason from public.payroll where id = $1`,
        [payroll],
      );
      expect(rows[0]).toEqual({ status: 'prepared', returned_reason: 'One salary is wrong' });
    });
  });

  it('refuses to submit a payroll with nobody in it', async () => {
    await asAdminDb(async (db) => {
      // A week before anybody's salary starts, and one no committed payroll
      // has already claimed.
      const { rows: week } = await db.query<{ d: string }>(`
        select g.d::date::text as d
          from generate_series(date '2016-01-04', date '2019-12-23', interval '7 day') g(d)
         where not exists (select 1 from public.payroll p
                            where p.period_key = 'W' || g.d::date::text and p.status <> 'cancelled')
         order by g.d limit 1`);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ payroll_id: string }>(
        `select * from app.create_payroll('weekly', null, null, $1::date)`,
        [week[0].d],
      );
      await db.query(`select * from app.prepare_payroll($1)`, [rows[0].payroll_id]);
      expect(
        await db.expectError(`select app.update_payroll_status($1, 'submit')`, [
          rows[0].payroll_id,
        ]),
      ).toMatch(/nobody to pay/i);
    });
  });
});

describe('payroll: payment is one atomic act', () => {
  const approved = async (db: Parameters<Parameters<typeof asAdminDb>[0]>[0], salary = 600_000) => {
    const prepared = await preparedPayroll(db, salary);
    await approvePayroll(db, prepared.payroll);
    return prepared;
  };

  it('takes the money, posts ONE ledger entry and marks every payslip paid', async () => {
    await asAdminDb(async (db) => {
      const account = await payingAccount(db, 5_000_000);
      const before = await balanceOf(db, 'cash_at_hand');
      const { staff, payroll } = await approved(db, 600_000);

      await becomeClient(db, SEED.admin);
      const { rows } = await db.query<{
        transaction_id: string;
        total_net_ugx: string;
        balance_ugx: string;
      }>(`select * from app.pay_payroll($1, $2, $3, 'April salaries')`, [
        payroll,
        account,
        requestId('payroll-pay'),
      ]);
      await becomeOwner(db);

      expect(ugx(rows[0].total_net_ugx)).toBe(600_000);
      expect(await balanceOf(db, 'cash_at_hand')).toBe(before - 600_000);

      const { rows: txn } = await db.query<{ n: string; entry_type: string }>(
        `select count(*)::text as n, min(entry_type) as entry_type
           from public.financial_transactions where reference_id = $1`,
        [payroll],
      );
      expect(Number(txn[0].n)).toBe(1);
      expect(txn[0].entry_type).toBe('payroll_payment');

      const item = (await payslip(db, payroll, staff))!;
      expect(item.payment_status).toBe('paid');
      expect(item.visible_to_staff).toBe(true);
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });

  it('adds the day to the finance summary', async () => {
    await asAdminDb(async (db) => {
      const account = await payingAccount(db, 5_000_000);
      const { payroll } = await approved(db, 600_000);
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.pay_payroll($1, $2, $3)`, [
        payroll,
        account,
        requestId('payroll-summary'),
      ]);
      await becomeOwner(db);
      const { rows } = await db.query<{ payroll_paid_ugx: string }>(
        `select payroll_paid_ugx from public.finance_daily_summaries
          where business_day = app.eat_day()`,
      );
      expect(ugx(rows[0].payroll_paid_ugx)).toBeGreaterThanOrEqual(600_000);
    });
  });

  it('pays once for a repeated request id', async () => {
    await asAdminDb(async (db) => {
      const account = await payingAccount(db, 5_000_000);
      const before = await balanceOf(db, 'cash_at_hand');
      const { payroll } = await approved(db, 600_000);
      const key = requestId('payroll-retry');
      await becomeClient(db, SEED.admin);
      const first = await db.query<{ transaction_id: string }>(
        `select * from app.pay_payroll($1, $2, $3)`,
        [payroll, account, key],
      );
      const second = await db.query<{ transaction_id: string }>(
        `select * from app.pay_payroll($1, $2, $3)`,
        [payroll, account, key],
      );
      await becomeOwner(db);
      expect(second.rows[0].transaction_id).toBe(first.rows[0].transaction_id);
      expect(await balanceOf(db, 'cash_at_hand')).toBe(before - 600_000);
    });
  });

  it('refuses to pay a payroll that is not approved', async () => {
    await asAdminDb(async (db) => {
      const account = await payingAccount(db, 5_000_000);
      const { payroll } = await preparedPayroll(db);
      await becomeClient(db, SEED.admin);
      expect(
        await db.expectError(`select * from app.pay_payroll($1, $2, $3)`, [
          payroll,
          account,
          requestId('payroll-early'),
        ]),
      ).toMatch(/Only an approved payroll/i);
    });
  });

  it('refuses to pay twice', async () => {
    await asAdminDb(async (db) => {
      const account = await payingAccount(db, 5_000_000);
      const { payroll } = await approved(db, 600_000);
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.pay_payroll($1, $2, $3)`, [
        payroll,
        account,
        requestId('payroll-a'),
      ]);
      expect(
        await db.expectError(`select * from app.pay_payroll($1, $2, $3)`, [
          payroll,
          account,
          requestId('payroll-b'),
        ]),
      ).toMatch(/already been paid/i);
    });
  });

  it('changes NOTHING when the account cannot cover it', async () => {
    await asAdminDb(async (db) => {
      const account = await ownAccount(db, 100_000);
      const { staff, payroll } = await approved(db, 600_000);
      const before = await snapshot(db);

      await becomeClient(db, SEED.admin);
      expect(
        await db.expectError(`select * from app.pay_payroll($1, $2, $3)`, [
          payroll,
          account,
          requestId('payroll-short'),
        ]),
      ).toMatch(/only UGX|available/i);
      await becomeOwner(db);

      expect(await snapshot(db)).toEqual(before);
      const { rows } = await db.query<{ status: string }>(
        `select status from public.payroll where id = $1`,
        [payroll],
      );
      expect(rows[0].status).toBe('approved');
      expect((await payslip(db, payroll, staff))!.payment_status).toBe('unpaid');
    });
  });

  it('refuses a generic finance reversal and asks for the workforce one', async () => {
    await asAdminDb(async (db) => {
      const account = await payingAccount(db, 5_000_000);
      const { payroll } = await approved(db, 600_000);
      await becomeClient(db, SEED.admin);
      const { rows } = await db.query<{ transaction_id: string }>(
        `select * from app.pay_payroll($1, $2, $3)`,
        [payroll, account, requestId('payroll-rev')],
      );
      expect(
        await db.expectError(`select app.reverse_financial_transaction($1, 'Paid in error')`, [
          rows[0].transaction_id,
        ]),
      ).toMatch(/payroll|allowance|workforce/i);
    });
  });

  it('gives everything back through the workforce reversal', async () => {
    await asAdminDb(async (db) => {
      const account = await payingAccount(db, 5_000_000);
      const before = await balanceOf(db, 'cash_at_hand');
      const { staff, payroll } = await approved(db, 600_000);
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.pay_payroll($1, $2, $3)`, [
        payroll,
        account,
        requestId('payroll-rev2'),
      ]);
      await db.query(
        `select * from app.reverse_payroll_payment($1, 'Paid from the wrong account')`,
        [payroll],
      );
      await becomeOwner(db);

      expect(await balanceOf(db, 'cash_at_hand')).toBe(before);
      const { rows } = await db.query<{ status: string }>(
        `select status from public.payroll where id = $1`,
        [payroll],
      );
      expect(rows[0].status).toBe('approved');
      const item = (await payslip(db, payroll, staff))!;
      expect(item.payment_status).toBe('unpaid');
      // The payslip goes back out of sight.
      expect(item.visible_to_staff).toBe(false);
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });
});

describe('payroll: locking', () => {
  const paid = async (db: Parameters<Parameters<typeof asAdminDb>[0]>[0]) => {
    const account = await payingAccount(db, 5_000_000);
    const prepared = await preparedPayroll(db, 600_000);
    await approvePayroll(db, prepared.payroll);
    await becomeClient(db, SEED.admin);
    await db.query(`select * from app.pay_payroll($1, $2, $3)`, [
      prepared.payroll,
      account,
      requestId('payroll-lock'),
    ]);
    await becomeOwner(db);
    return prepared;
  };

  it('locks a paid payroll', async () => {
    await asAdminDb(async (db) => {
      const { payroll } = await paid(db);
      await becomeClient(db, SEED.admin);
      expect(
        (await db.query<{ lock_payroll: string }>(`select app.lock_payroll($1)`, [payroll])).rows[0]
          .lock_payroll,
      ).toBe('locked');
    });
  });

  it('refuses to lock a payroll that has not been paid', async () => {
    await asAdminDb(async (db) => {
      const { payroll } = await preparedPayroll(db);
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(`select app.lock_payroll($1)`, [payroll])).toMatch(/paid/i);
    });
  });

  it('freezes a locked payroll against every later change', async () => {
    await asAdminDb(async (db) => {
      const { payroll } = await paid(db);
      await becomeClient(db, SEED.admin);
      await db.query(`select app.lock_payroll($1)`, [payroll]);
      expect(
        await db.expectError(`select * from app.reverse_payroll_payment($1, 'Changed my mind')`, [
          payroll,
        ]),
      ).toMatch(/locked/i);
      expect(
        await db.expectError(`select app.cancel_payroll($1, 'Changed my mind')`, [payroll]),
      ).toMatch(/locked|paid/i);
      await becomeOwner(db);
      // And below the function too: the guard freezes the money and the
      // status, with full privileges and no function in the way.
      expect(
        await db.expectError(`update public.payroll set total_net_ugx = 1 where id = $1`, [
          payroll,
        ]),
      ).toMatch(/locked payroll cannot be changed/i);
      expect(
        await db.expectError(`update public.payroll set status = 'approved' where id = $1`, [
          payroll,
        ]),
      ).toMatch(/locked payroll cannot be changed/i);
      expect(
        await db.expectError(
          `update public.payroll_items set net_ugx = 1 where payroll_id = $1 and current`,
          [payroll],
        ),
      ).toBeTruthy();
    });
  });

  it('never deletes a payroll or a payslip', async () => {
    await asAdminDb(async (db) => {
      const { payroll } = await preparedPayroll(db);
      expect(await db.expectError(`delete from public.payroll where id = $1`, [payroll])).toMatch(
        /never deletes/i,
      );
      expect(
        await db.expectError(`delete from public.payroll_items where payroll_id = $1`, [payroll]),
      ).toMatch(/never deletes/i);
    });
  });
});
