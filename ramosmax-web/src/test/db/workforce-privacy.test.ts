import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, becomeClient, becomeOwner, closePool, makeUser, SEED } from './harness';
import {
  approvedLoss,
  approvePayroll,
  attend,
  calculateAllowances,
  employ,
  payingAccount,
  preparePayroll,
  requestId,
  ugx,
  verify,
  recentPeriod,
} from './workforce-helpers';

afterAll(closePool);

/**
 * PAY IS PRIVATE, AND THE RULES ARE BELOW THE UI.
 *
 * Every test here reads the tables directly as a signed-in session — no route,
 * no server function, no screen. A rule that only the interface enforces is
 * not a rule, so these queries are exactly what a determined person with a
 * browser console could send.
 */

/** Two employees, a prepared payroll, and the option of paying it. */
async function scene(db: Parameters<Parameters<typeof asAdminDb>[0]>[0], pay = false) {
  const account = await payingAccount(db, 5_000_000);
  const me = await employ(db, { salaryUgx: 600_000 });
  const colleague = await employ(db, { salaryUgx: 900_000 });
  const { year, month } = await recentPeriod(db);
  const { payroll } = await preparePayroll(db, year, month);
  if (pay) {
    await approvePayroll(db, payroll);
    await becomeClient(db, SEED.admin);
    await db.query(`select * from app.pay_payroll($1, $2, $3)`, [
      payroll,
      account,
      requestId('privacy-pay'),
    ]);
    await becomeOwner(db);
  }
  return { me, colleague, payroll };
}

describe('privacy: payslips', () => {
  it('shows a worker NOTHING until the payroll has been paid', async () => {
    await asAdminDb(async (db) => {
      const { me, payroll } = await scene(db, false);
      await becomeClient(db, me);
      const { rows } = await db.query(`select id from public.payroll_items where payroll_id = $1`, [
        payroll,
      ]);
      expect(rows).toHaveLength(0);
    });
  });

  it('shows a worker their OWN payslip once it has been paid', async () => {
    await asAdminDb(async (db) => {
      const { me, payroll } = await scene(db, true);
      await becomeClient(db, me);
      const { rows } = await db.query<{ staff_uid: string; net_ugx: string }>(
        `select staff_uid, net_ugx from public.payroll_items where payroll_id = $1`,
        [payroll],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].staff_uid).toBe(me);
      expect(ugx(rows[0].net_ugx)).toBe(600_000);
    });
  });

  it('never shows a worker a colleague’s payslip, however they ask', async () => {
    await asAdminDb(async (db) => {
      const { me, colleague, payroll } = await scene(db, true);
      await becomeClient(db, me);
      // By id.
      expect(
        (await db.query(`select id from public.payroll_items where staff_uid = $1`, [colleague]))
          .rows,
      ).toHaveLength(0);
      // By asking for everything.
      expect(
        (
          await db.query<{ staff_uid: string }>(`select staff_uid from public.payroll_items`)
        ).rows.every((r) => r.staff_uid === me),
      ).toBe(true);
      // By aggregate, which would leak the total without naming anyone.
      const { rows } = await db.query<{ total: string | null }>(
        `select sum(net_ugx)::text as total from public.payroll_items where payroll_id = $1`,
        [payroll],
      );
      expect(ugx(rows[0].total)).toBe(600_000);
    });
  });

  it('never shows a worker a colleague’s salary or salary history', async () => {
    await asAdminDb(async (db) => {
      const { me, colleague } = await scene(db, true);
      await becomeClient(db, me);
      expect(
        (
          await db.query(`select staff_uid from public.salary_profiles where staff_uid = $1`, [
            colleague,
          ])
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await db.query(`select staff_uid from public.salary_history where staff_uid = $1`, [
            colleague,
          ])
        ).rows,
      ).toHaveLength(0);
      // Their own, they may see.
      expect(
        (await db.query(`select staff_uid from public.salary_profiles where staff_uid = $1`, [me]))
          .rows,
      ).toHaveLength(1);
    });
  });

  it('never shows a worker a colleague’s deductions or loss recoveries', async () => {
    await asAdminDb(async (db) => {
      const me = await employ(db, { salaryUgx: 600_000 });
      const colleague = await employ(db, { salaryUgx: 900_000 });
      const { incident } = await approvedLoss(db, colleague, 300_000, 150_000);
      await becomeClient(db, SEED.manager);
      await db.query(`select * from app.schedule_loss_recovery($1, 50000, app.eat_day() - 60)`, [
        incident,
      ]);
      await becomeClient(db, me);
      expect(
        (
          await db.query(`select id from public.salary_deductions where staff_uid = $1`, [
            colleague,
          ])
        ).rows,
      ).toHaveLength(0);
      expect(
        (await db.query(`select id from public.loss_incidents where staff_uid = $1`, [colleague]))
          .rows,
      ).toHaveLength(0);
    });
  });

  it('never shows a worker a colleague’s attendance or allowances', async () => {
    await asAdminDb(async (db) => {
      const me = await employ(db);
      const colleague = await employ(db);
      const { rows: day } = await db.query<{ d: string }>(`select (app.eat_day() - 3)::text as d`);
      const record = await attend(db, colleague, day[0].d, '08:00');
      await verify(db, [record.attendance_id]);
      await calculateAllowances(db, day[0].d);
      await becomeClient(db, me);
      expect(
        (await db.query(`select id from public.attendance where staff_uid = $1`, [colleague])).rows,
      ).toHaveLength(0);
      expect(
        (
          await db.query(`select id from public.worker_allowances where staff_uid = $1`, [
            colleague,
          ])
        ).rows,
      ).toHaveLength(0);
    });
  });

  it('shows a worker their own attendance and allowance', async () => {
    await asAdminDb(async (db) => {
      const me = await employ(db);
      const { rows: day } = await db.query<{ d: string }>(`select (app.eat_day() - 3)::text as d`);
      const record = await attend(db, me, day[0].d, '08:00');
      await verify(db, [record.attendance_id]);
      await calculateAllowances(db, day[0].d);
      await becomeClient(db, me);
      expect(
        (await db.query(`select id from public.attendance where id = $1`, [record.attendance_id]))
          .rows,
      ).toHaveLength(1);
      expect(
        (await db.query(`select id from public.worker_allowances where staff_uid = $1`, [me])).rows,
      ).toHaveLength(1);
    });
  });
});

/**
 * WORKFORCE REPORTING IS NOT PAY VISIBILITY.
 *
 * `reports.payroll.view` gives management-level totals. It must not, by
 * itself, let anyone read what an individual earns.
 */
describe('privacy: payroll reporting', () => {
  const reporter = (db: Parameters<Parameters<typeof asAdminDb>[0]>[0]) =>
    makeUser(db, {
      role: 'manager',
      permissions: ['reports.payroll.view'],
      deniedPermissions: ['payroll.view', 'salary.view'],
    });

  it('gives totals but no individual pay', async () => {
    await asAdminDb(async (db) => {
      const { payroll } = await scene(db, true);
      const uid = await reporter(db);
      await becomeClient(db, uid);

      const { rows: headers } = await db.query<{ total_net_ugx: string; employee_count: number }>(
        `select total_net_ugx, employee_count from public.payroll where id = $1`,
        [payroll],
      );
      expect(ugx(headers[0].total_net_ugx)).toBe(1_500_000);
      expect(headers[0].employee_count).toBe(2);

      expect(
        (await db.query(`select id from public.payroll_items where payroll_id = $1`, [payroll]))
          .rows,
        'no payslip',
      ).toHaveLength(0);
      expect(
        (await db.query(`select staff_uid from public.salary_profiles`)).rows,
        'no salary',
      ).toHaveLength(0);
      expect(
        (await db.query(`select staff_uid from public.salary_history`)).rows,
        'no salary history',
      ).toHaveLength(0);
      expect(
        (await db.query(`select id from public.payroll_earnings`)).rows,
        'no earning',
      ).toHaveLength(0);
    });
  });

  it('reads the reporting view without gaining anyone’s pay', async () => {
    await asAdminDb(async (db) => {
      const { payroll } = await scene(db, true);
      const uid = await reporter(db);
      await becomeClient(db, uid);
      const { rows } = await db.query<{ total_net_ugx: string }>(
        `select total_net_ugx from public.payroll_report_totals where id = $1`,
        [payroll],
      );
      expect(ugx(rows[0].total_net_ugx)).toBe(1_500_000);
      const { rows: columns } = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name = 'payroll_report_totals'`,
      );
      expect(columns.map((c) => c.column_name)).not.toContain('staff_uid');
    });
  });

  it('gives a cashier nothing at all', async () => {
    await asAdminDb(async (db) => {
      const { payroll, colleague } = await scene(db, true);
      await becomeClient(db, SEED.cashier);
      expect(
        (await db.query(`select id from public.payroll where id = $1`, [payroll])).rows,
      ).toHaveLength(0);
      expect((await db.query(`select id from public.payroll_items`)).rows).toHaveLength(0);
      expect(
        (
          await db.query(`select staff_uid from public.salary_profiles where staff_uid = $1`, [
            colleague,
          ])
        ).rows,
      ).toHaveLength(0);
      expect((await db.query(`select id from public.loss_incidents`)).rows).toHaveLength(0);
    });
  });

  it('gives an auditor everything, read-only', async () => {
    await asAdminDb(async (db) => {
      const { payroll, colleague } = await scene(db, true);
      await becomeClient(db, SEED.auditor);
      expect(
        (await db.query(`select id from public.payroll_items where payroll_id = $1`, [payroll]))
          .rows,
      ).toHaveLength(2);
      expect(
        (
          await db.query(`select staff_uid from public.salary_history where staff_uid = $1`, [
            colleague,
          ])
        ).rows.length,
      ).toBeGreaterThan(0);
      expect(
        await db.denied(`update public.payroll_items set net_ugx = 1 where payroll_id = $1`, [
          payroll,
        ]),
      ).toBe(true);
      expect(await db.denied(`select app.lock_payroll($1)`, [payroll])).toBe(true);
    });
  });
});

describe('privacy: notifications carry identifiers only', () => {
  it('never puts an amount or a salary in a workforce event', async () => {
    await asAdminDb(async (db) => {
      const { me } = await scene(db, true);
      // Every event ever written, including the ones the committing suites
      // left behind.
      const { rows } = await db.query<{ type: string; payload: Record<string, unknown> }>(
        `select type, payload from public.workforce_events`,
      );
      expect(rows.length).toBeGreaterThan(0);

      // An event carries a REFERENCE NUMBER and nothing else: never a figure,
      // and never anything that could be read as one.
      const IDENTIFIERS = new Set([
        'attendanceNumber',
        'allowanceNumber',
        'payrollNumber',
        'lossNumber',
        'deductionNumber',
      ]);
      for (const row of rows) {
        for (const [key, value] of Object.entries(row.payload ?? {})) {
          expect(IDENTIFIERS, `${row.type}.${key}`).toContain(key);
          expect(typeof value, `${row.type}.${key}`).toBe('string');
          expect(String(value), `${row.type}.${key}`).toMatch(/^RMX-[A-Z]+-\d+/);
        }
      }
      expect(me).toBeTruthy();
    });
  });

  it('shows a worker only the events addressed to them', async () => {
    await asAdminDb(async (db) => {
      const { me, colleague } = await scene(db, true);
      await becomeClient(db, me);
      const { rows } = await db.query<{ recipient_uid: string | null; audience: string }>(
        `select recipient_uid, audience from public.workforce_events`,
      );
      for (const row of rows) {
        expect(row.recipient_uid).toBe(me);
      }
      expect(rows.some((r) => r.recipient_uid === colleague)).toBe(false);
    });
  });
});

describe('privacy: nobody writes through the tables', () => {
  it('refuses every direct workforce write from a signed-in Administrator', async () => {
    await asAdminDb(async (db) => {
      const staff = await employ(db);
      await becomeClient(db, SEED.admin);
      for (const statement of [
        `insert into public.attendance (attendance_number, staff_uid, business_day, working_day,
           reporting_time, grace_period_minutes, late_threshold_minutes, expected_reporting_at,
           arrival_status, recorded_via, recorded_by, updated_by)
         values ('X', $1, app.eat_day(), true, '08:00', 15, 120, now(), 'absent', 'manager', $1, $1)`,
        `update public.attendance set minutes_late = 0 where staff_uid = $1`,
        `insert into public.salary_history (staff_uid, version, basic_salary_ugx, payment_frequency,
           allowance_eligible, active, effective_from, created_by)
         values ($1, 99, 9000000, 'monthly', true, true, app.eat_day(), $1)`,
        `update public.salary_profiles set basic_salary_ugx = 9000000 where staff_uid = $1`,
        `insert into public.worker_allowances (allowance_number, staff_uid, business_day,
           calculated_amount_ugx, created_by, updated_by)
         values ('X', $1, app.eat_day(), 500000, $1, $1)`,
        `update public.loss_incidents set outstanding_ugx = 0 where staff_uid = $1`,
        `update public.salary_deductions set remaining_ugx = 0 where staff_uid = $1`,
        `insert into public.workforce_events (type, reference_type, reference_id, audience)
         values ('x', 'payroll', gen_random_uuid(), 'staff')`,
      ]) {
        expect(await db.denied(statement, [staff]), statement.slice(0, 40)).toBe(true);
      }
    });
  });

  it('refuses a worker trying to make their own payslip visible', async () => {
    await asAdminDb(async (db) => {
      const { me, payroll } = await scene(db, false);
      await becomeClient(db, me);
      expect(
        await db.denied(
          `update public.payroll_items set visible_to_staff = true where payroll_id = $1`,
          [payroll],
        ),
      ).toBe(true);
    });
  });
});
