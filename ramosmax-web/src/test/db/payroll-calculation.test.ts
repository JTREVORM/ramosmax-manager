import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, becomeClient, becomeOwner, closePool, SEED } from './harness';
import {
  approvedLoss,
  attend,
  calculateAllowances,
  employ,
  payslip,
  preparePayroll,
  recentPeriod,
  requestId,
  ugx,
  verify,
} from './workforce-helpers';

afterAll(closePool);

/**
 * THE PAYROLL FORMULA, COMPUTED BY THE SERVER.
 *
 *   gross = basic salary + approved allowances in the period + other earnings
 *   net   = gross − deductions, and never below zero
 *
 * Nothing in `app.create_payroll`, `app.prepare_payroll` or
 * `app.update_payroll_status` accepts a figure. A browser cannot tell the
 * system what someone earns; it can only ask for the period to be worked out.
 */

/**
 * A recent whole month, chosen from the database's own clock so every fixture
 * day stays inside the backdating window however long this suite lives.
 */
/** An approved allowance for [staff] on a day inside the period. */
async function allowanceOn(
  db: Parameters<Parameters<typeof asAdminDb>[0]>[0],
  staff: string,
  day: string,
) {
  const record = await attend(db, staff, day, '08:00');
  await verify(db, [record.attendance_id]);
  await calculateAllowances(db, day);
  await becomeClient(db, SEED.manager);
  const { rows } = await db.query<{ id: string }>(
    `select id from public.worker_allowances
      where staff_uid = $1 and business_day = $2::date and status = 'calculated'`,
    [staff, day],
  );
  if (rows.length > 0) {
    await db.query(`select app.review_allowance(array[$1]::uuid[], 'full')`, [rows[0].id]);
  }
  await becomeOwner(db);
}

describe('payroll: gross pay', () => {
  it('is the basic salary when nothing else applies', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 600_000 });
      const period = await recentPeriod(db);
      const { payroll } = await preparePayroll(db, period.year, period.month);
      const item = (await payslip(db, payroll, staff))!;
      expect(ugx(item.basic_salary_ugx)).toBe(600_000);
      expect(ugx(item.gross_ugx)).toBe(600_000);
      expect(ugx(item.net_ugx)).toBe(600_000);
    });
  });

  it('adds every approved allowance that falls inside the period', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 600_000 });
      const period = await recentPeriod(db);
      await allowanceOn(db, staff, period.days[0]);
      await allowanceOn(db, staff, period.days[1]);
      const { payroll } = await preparePayroll(db, period.year, period.month);
      const item = (await payslip(db, payroll, staff))!;
      expect(ugx(item.allowances_ugx)).toBe(10_000);
      expect(Number(item.allowance_days)).toBe(2);
      expect(ugx(item.gross_ugx)).toBe(610_000);
    });
  });

  it('leaves out an allowance from another month', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 600_000 });
      const period = await recentPeriod(db);
      await allowanceOn(db, staff, period.earlier);
      const { payroll } = await preparePayroll(db, period.year, period.month);
      const item = (await payslip(db, payroll, staff))!;
      expect(ugx(item.allowances_ugx)).toBe(0);
      expect(ugx(item.gross_ugx)).toBe(600_000);
    });
  });

  it('leaves out an allowance that was never approved', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 600_000 });
      const period = await recentPeriod(db);
      const record = await attend(db, staff, period.days[0], '09:30');
      await verify(db, [record.attendance_id]);
      await calculateAllowances(db, period.days[0]);
      const { payroll } = await preparePayroll(db, period.year, period.month);
      const item = (await payslip(db, payroll, staff))!;
      expect(ugx(item.allowances_ugx)).toBe(0);
    });
  });

  it('adds another earning, with its reason', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 600_000 });
      const period = await recentPeriod(db);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ payroll_id: string }>(
        `select * from app.create_payroll('monthly', $1, $2)`,
        [period.year, period.month],
      );
      await db.query(`select * from app.prepare_payroll($1)`, [rows[0].payroll_id]);
      // Adding an earning is `payroll.adjust`, an Administrator's permission,
      // and it is added to a payroll that has been prepared.
      await becomeClient(db, SEED.admin);
      await db.query(
        `select app.add_payroll_earning($1, $2, 'Weekend cover', 50000, 'Worked the public holiday')`,
        [rows[0].payroll_id, staff],
      );
      await db.query(`select * from app.prepare_payroll($1)`, [rows[0].payroll_id]);
      await becomeOwner(db);
      const item = (await payslip(db, rows[0].payroll_id, staff))!;
      expect(ugx(item.other_earnings_ugx)).toBe(50_000);
      expect(ugx(item.gross_ugx)).toBe(650_000);
    });
  });

  it('drops a removed earning at the next preparation', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 600_000 });
      const period = await recentPeriod(db);
      await becomeClient(db, SEED.admin);
      const { rows } = await db.query<{ payroll_id: string }>(
        `select * from app.create_payroll('monthly', $1, $2)`,
        [period.year, period.month],
      );
      await db.query(`select * from app.prepare_payroll($1)`, [rows[0].payroll_id]);
      const { rows: earning } = await db.query<{ add_payroll_earning: string }>(
        `select app.add_payroll_earning($1, $2, 'Weekend cover', 50000, 'Extra shift')`,
        [rows[0].payroll_id, staff],
      );
      await db.query(`select * from app.prepare_payroll($1)`, [rows[0].payroll_id]);
      await db.query(`select app.remove_payroll_earning($1, 'Entered against the wrong person')`, [
        earning[0].add_payroll_earning,
      ]);
      await db.query(`select * from app.prepare_payroll($1)`, [rows[0].payroll_id]);
      await becomeOwner(db);
      const item = (await payslip(db, rows[0].payroll_id, staff))!;
      expect(ugx(item.other_earnings_ugx)).toBe(0);
      expect(ugx(item.gross_ugx)).toBe(600_000);
    });
  });
});

describe('payroll: effective-dated salary', () => {
  it('uses the version in force at the end of the period', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 500_000, from: '2020-01-01' });
      const period = await recentPeriod(db);
      await becomeClient(db, SEED.admin);
      await db.query(
        `select * from app.set_salary_profile($1, 700000, $2::date, 'monthly', null, null, true, 'Promotion')`,
        [staff, period.days[0]],
      );
      await becomeOwner(db);
      const { payroll } = await preparePayroll(db, period.year, period.month);
      expect(ugx((await payslip(db, payroll, staff))!.basic_salary_ugx)).toBe(700_000);
    });
  });

  it('ignores a version that starts after the period', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 500_000, from: '2020-01-01' });
      const period = await recentPeriod(db);
      await becomeClient(db, SEED.admin);
      await db.query(
        `select * from app.set_salary_profile($1, 900000, ($2::date + 60), 'monthly', null, null, true, 'Promotion')`,
        [staff, period.days[1]],
      );
      await becomeOwner(db);
      const { payroll } = await preparePayroll(db, period.year, period.month);
      expect(ugx((await payslip(db, payroll, staff))!.basic_salary_ugx)).toBe(500_000);
    });
  });

  /**
   * THE POINT OF SALARY HISTORY. A raise agreed in June must not quietly
   * change what April's payroll says was paid.
   */
  it('does not change a payroll that has already been prepared', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 500_000, from: '2020-01-01' });
      const period = await recentPeriod(db);
      const { payroll } = await preparePayroll(db, period.year, period.month);
      const before = ugx((await payslip(db, payroll, staff))!.basic_salary_ugx);

      await becomeClient(db, SEED.admin);
      await db.query(
        `select * from app.set_salary_profile($1, 900000, ($2::date + 60), 'monthly', null, null, true, 'Promotion')`,
        [staff, period.days[1]],
      );
      await becomeOwner(db);

      expect(ugx((await payslip(db, payroll, staff))!.basic_salary_ugx)).toBe(before);
      expect(before).toBe(500_000);
    });
  });

  it('refuses a version dated before the latest one', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 500_000, from: '2025-04-01' });
      await becomeClient(db, SEED.admin);
      expect(
        await db.expectError(
          `select * from app.set_salary_profile($1, 400000, '2025-01-01', 'monthly', null, null, true, 'Backdating')`,
          [staff],
        ),
      ).toMatch(/cannot be backdated/i);
    });
  });

  it('keeps every version, appended and never rewritten', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 500_000, from: '2020-01-01' });
      await becomeClient(db, SEED.admin);
      await db.query(
        `select * from app.set_salary_profile($1, 700000, app.eat_day(), 'monthly', null, null, true, 'Promotion')`,
        [staff],
      );
      await becomeOwner(db);
      const { rows } = await db.query<{ version: number; basic_salary_ugx: string }>(
        `select version, basic_salary_ugx from public.salary_history
          where staff_uid = $1 order by version`,
        [staff],
      );
      expect(rows.map((r) => [r.version, ugx(r.basic_salary_ugx)])).toEqual([
        [1, 500_000],
        [2, 700_000],
      ]);
      expect(
        await db.expectError(
          `update public.salary_history set basic_salary_ugx = 1 where staff_uid = $1`,
          [staff],
        ),
      ).toBeTruthy();
      expect(
        await db.expectError(`delete from public.salary_history where staff_uid = $1`, [staff]),
      ).toBeTruthy();
    });
  });

  it('will not let anyone set their own salary', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      expect(
        await db.expectError(`select * from app.set_salary_profile($1, 9000000, '2025-04-01')`, [
          SEED.admin,
        ]),
      ).toMatch(/your own salary/i);
    });
  });
});

describe('payroll: deductions', () => {
  const activeDeduction = async (
    db: Parameters<Parameters<typeof asAdminDb>[0]>[0],
    staff: string,
    total: number,
    instalment: number,
  ) => {
    await becomeClient(db, SEED.admin);
    const { rows } = await db.query<{ deduction_id: string }>(
      `select * from app.create_salary_deduction($1, 'authorized_deduction', $2,
         'Advance on tools agreed in writing', 'AGR-2025-11', $3, $4, '2025-01-01')`,
      [staff, total, requestId('deduction'), instalment],
    );
    await db.query(`select app.decide_salary_deduction($1, 'approve')`, [rows[0].deduction_id]);
    await becomeOwner(db);
    return rows[0].deduction_id;
  };

  it('takes the instalment and no more', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 600_000 });
      await activeDeduction(db, staff, 300_000, 50_000);
      const period = await recentPeriod(db);
      const { payroll } = await preparePayroll(db, period.year, period.month);
      const item = (await payslip(db, payroll, staff))!;
      expect(ugx(item.salary_deductions_ugx)).toBe(50_000);
      expect(ugx(item.total_deductions_ugx)).toBe(50_000);
      expect(ugx(item.net_ugx)).toBe(550_000);
    });
  });

  it('takes only what remains on the last instalment', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 600_000 });
      const deduction = await activeDeduction(db, staff, 300_000, 50_000);
      await db.query(
        `update public.salary_deductions set recovered_ugx = 280000, remaining_ugx = 20000
          where id = $1`,
        [deduction],
      );
      const period = await recentPeriod(db);
      const { payroll } = await preparePayroll(db, period.year, period.month);
      expect(ugx((await payslip(db, payroll, staff))!.total_deductions_ugx)).toBe(20_000);
    });
  });

  it('never takes a deduction that has not been approved', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 600_000 });
      await becomeClient(db, SEED.admin);
      await db.query(
        `select * from app.create_salary_deduction($1, 'authorized_deduction', 100000,
           'Waiting for approval', 'AGR-2025-12', $2, 100000, '2025-01-01')`,
        [staff, requestId('deduction-pending')],
      );
      await becomeOwner(db);
      const period = await recentPeriod(db);
      const { payroll } = await preparePayroll(db, period.year, period.month);
      expect(ugx((await payslip(db, payroll, staff))!.total_deductions_ugx)).toBe(0);
    });
  });

  it('never takes a cancelled deduction', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 600_000 });
      const deduction = await activeDeduction(db, staff, 300_000, 50_000);
      await becomeClient(db, SEED.admin);
      await db.query(`select app.cancel_salary_deduction($1, 'Settled in cash instead')`, [
        deduction,
      ]);
      await becomeOwner(db);
      const period = await recentPeriod(db);
      const { payroll } = await preparePayroll(db, period.year, period.month);
      expect(ugx((await payslip(db, payroll, staff))!.total_deductions_ugx)).toBe(0);
    });
  });

  it('never takes a deduction from someone else’s pay', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 600_000 });
      const other = await employ(db, { salaryUgx: 600_000 });
      await activeDeduction(db, staff, 300_000, 50_000);
      const period = await recentPeriod(db);
      const { payroll } = await preparePayroll(db, period.year, period.month);
      expect(ugx((await payslip(db, payroll, other))!.total_deductions_ugx)).toBe(0);
    });
  });

  /** NET PAY IS NEVER NEGATIVE. The cap is the business rule, not a guess. */
  it('caps deductions at the policy percentage of gross', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 100_000 });
      await activeDeduction(db, staff, 500_000, 500_000);
      await becomeClient(db, SEED.admin);
      await db.query(`select app.update_payroll_policy($1::jsonb, 'Protecting take-home pay')`, [
        JSON.stringify({ maxDeductionPercentOfGross: 40 }),
      ]);
      await becomeOwner(db);
      const period = await recentPeriod(db);
      const { payroll } = await preparePayroll(db, period.year, period.month);
      const item = (await payslip(db, payroll, staff))!;
      expect(ugx(item.total_deductions_ugx)).toBe(40_000);
      expect(ugx(item.net_ugx)).toBe(60_000);
      expect(item.deduction_capped).toBe(true);
      // And the line records what was planned against what was taken.
      const lines = item.deduction_lines as unknown as Array<Record<string, number>>;
      expect(lines[0].plannedUgx).toBe(500_000);
      expect(lines[0].amountUgx).toBe(40_000);
    });
  });

  it('leaves net pay at zero rather than below it', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 100_000 });
      await activeDeduction(db, staff, 500_000, 500_000);
      const period = await recentPeriod(db);
      const { payroll } = await preparePayroll(db, period.year, period.month);
      const item = (await payslip(db, payroll, staff))!;
      expect(ugx(item.total_deductions_ugx)).toBe(100_000);
      expect(ugx(item.net_ugx)).toBe(0);
    });
  });

  it('refuses a payslip the database can see is wrong', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 600_000 });
      const period = await recentPeriod(db);
      const { payroll } = await preparePayroll(db, period.year, period.month);
      const item = (await payslip(db, payroll, staff))!;
      // net = gross − deductions, and never negative: a check constraint, not
      // a convention.
      expect(
        await db.expectError(
          `update public.payroll_items set net_ugx = net_ugx + 1 where id = $1`,
          [item.id],
        ),
      ).toBeTruthy();
    });
  });

  it('takes a loss recovery only up to what the incident still has outstanding', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 600_000 });
      const { incident } = await approvedLoss(db, staff, 300_000, 150_000);
      await becomeClient(db, SEED.manager);
      await db.query(`select * from app.schedule_loss_recovery($1, 50000, '2025-01-01')`, [
        incident,
      ]);
      await becomeOwner(db);
      const period = await recentPeriod(db);
      const { payroll } = await preparePayroll(db, period.year, period.month);
      const item = (await payslip(db, payroll, staff))!;
      expect(ugx(item.loss_recoveries_ugx)).toBe(50_000);
      expect(ugx(item.net_ugx)).toBe(550_000);
    });
  });
});

describe('payroll: the browser cannot submit a figure', () => {
  it('offers no money parameter on any payroll command', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ proname: string; args: string }>(`
        select p.proname, pg_get_function_arguments(p.oid) as args
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app'
           and p.proname in ('create_payroll', 'prepare_payroll', 'correct_payroll',
                             'update_payroll_status', 'lock_payroll', 'cancel_payroll')`);
      for (const row of rows) {
        expect(row.args, `${row.proname} accepts a figure`).not.toMatch(
          /gross|net|deduction_ugx|total|salary|amount/i,
        );
      }
    });
  });

  it('refuses a direct write to a payslip from a signed-in session', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db, { salaryUgx: 600_000 });
      const period = await recentPeriod(db);
      const { payroll } = await preparePayroll(db, period.year, period.month);
      const item = (await payslip(db, payroll, staff))!;
      await becomeClient(db, SEED.admin);
      expect(
        await db.denied(`update public.payroll_items set net_ugx = 9000000 where id = $1`, [
          item.id,
        ]),
      ).toBe(true);
      expect(
        await db.denied(`update public.payroll set total_net_ugx = 9000000 where id = $1`, [
          payroll,
        ]),
      ).toBe(true);
      expect(
        await db.denied(
          `insert into public.payroll_earnings (payroll_id, staff_uid, description, amount_ugx, added_by)
         values ($1, $2, 'Bonus', 1000000, $3)`,
          [payroll, staff, SEED.admin],
        ),
      ).toBe(true);
    });
  });

  it('keeps every figure in whole UGX', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{
        table_name: string;
        column_name: string;
        data_type: string;
      }>(`
        select table_name, column_name, data_type
          from information_schema.columns
         where table_schema = 'public' and column_name like '%\\_ugx'
           and table_name in ('payroll', 'payroll_items', 'payroll_earnings', 'worker_allowances',
                              'salary_history', 'salary_profiles', 'salary_deductions',
                              'deduction_applications', 'loss_incidents')`);
      expect(rows.length).toBeGreaterThan(20);
      for (const row of rows) {
        expect(row.data_type, `${row.table_name}.${row.column_name}`).toBe('bigint');
      }
    });
  });
});
