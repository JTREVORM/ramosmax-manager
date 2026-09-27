import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, closePool, makeUser, type Session } from './harness';
import { becomeClient, becomeOwner, invoicedJob, requestId, SEED } from './billing-helpers';
import {
  authorize, closeSession, eligibleWorker, openSession, supervisor,
} from './after-hours-helpers';

afterAll(closePool);

async function report(db: Session, name: string, as: string): Promise<Record<string, unknown>> {
  await becomeClient(db, as);
  const { rows } = await db.query<{ r: Record<string, unknown> }>(
    `select app.business_report($1, app.eat_day() - 7, app.eat_day()) as r`, [name]);
  await becomeOwner(db);
  return rows[0].r;
}

type Section = {
  key: string;
  figures: Array<{ key: string; value: number }>;
  tables: Array<{ key: string; columns: Array<{ key: string }>; rows: Array<Record<string, unknown>> }>;
};

const sections = (r: Record<string, unknown>) => r.sections as Section[];
const section = (r: Record<string, unknown>, key: string) =>
  sections(r).find((s) => s.key === key);
const table = (s: Section | undefined, key: string) => s?.tables.find((t) => t.key === key);

/**
 * REPORT PRIVACY.
 *
 * A report is a second way into the same data, so it is a second chance to
 * leak it. Every test here runs the report AS THE ROLE and looks at what came
 * back — not at what the screen would have drawn.
 */
describe('report privacy: who may open what', () => {
  const REFUSALS: Array<[string, string]> = [
    ['worker', 'executive'],
    ['worker', 'financial'],
    ['worker', 'outstanding'],
    ['worker', 'workforce'],
    ['worker', 'shareholders'],
    ['worker', 'after_hours'],
    ['shareholder', 'workforce'],
    ['shareholder', 'after_hours'],
    ['shareholder', 'expenses'],
    ['cashier', 'financial'],
    ['cashier', 'workforce'],
    ['cashier', 'inventory'],
    ['cashier', 'shareholders'],
    ['cashier', 'after_hours'],
  ];

  for (const [role, name] of REFUSALS) {
    it(`refuses ${name} to a ${role}`, async () => {
      await asAdminDb(async (db) => {
        await becomeClient(db, SEED[role as keyof typeof SEED]);
        expect(await db.expectError(
          `select app.business_report($1, app.eat_day(), app.eat_day())`, [name]))
          .toMatch(/do not have permission to view this report/i);
        await becomeOwner(db);
      });
    });
  }

  it('lets an auditor read, and still never write', async () => {
    await asAdminDb(async (db) => {
      for (const name of ['executive', 'financial', 'workforce', 'shareholders', 'after_hours']) {
        const r = await report(db, name, SEED.auditor);
        expect(r.report, name).toBe(name);
      }
    });
  });

  it('tells each caller which reports are theirs', async () => {
    await asAdminDb(async (db) => {
      const mine = async (uid: string) => {
        await becomeClient(db, uid);
        const { rows } = await db.query<{ r: string[] }>(`select app.my_reports() as r`);
        await becomeOwner(db);
        return rows[0].r;
      };
      expect(await mine(SEED.worker)).toEqual([]);
      expect(await mine(SEED.cashier)).toEqual(
        expect.arrayContaining(['executive', 'outstanding', 'expenses']));
      expect(await mine(SEED.cashier)).not.toContain('workforce');
      expect((await mine(SEED.admin)).length).toBe(10);
    });
  });
});

describe('report privacy: what is inside', () => {
  it('hides customer names from somebody without customers.view', async () => {
    await asAdminDb(async (db) => {
      await invoicedJob(db, 'URQ 101A');
      const reader = await makeUser(db, { role: 'worker', permissions: ['credit.view'] });

      const withNames = table(section(await report(db, 'outstanding', SEED.admin), 'outstanding'),
        'invoices');
      expect(withNames?.columns.map((c) => c.key)).toContain('customer');

      const without = table(section(await report(db, 'outstanding', reader), 'outstanding'),
        'invoices');
      expect(without?.columns.map((c) => c.key)).not.toContain('customer');
      expect(JSON.stringify(without?.rows)).not.toContain('customer');
    });
  });

  it('gives a payroll reporter totals and never an individual’s pay', async () => {
    await asAdminDb(async (db) => {
      const reader = await makeUser(db, {
        role: 'manager', permissions: ['reports.payroll.view'],
        deniedPermissions: ['payroll.view', 'salary.view', 'attendance.view', 'allowances.view'],
      });
      const s = section(await report(db, 'workforce', reader), 'workforce');
      // Payroll headers are allowed; payslips, salaries and deductions are not
      // in this report at all, for anybody.
      expect(table(s, 'payroll')).toBeDefined();
      const keys = JSON.stringify(s);
      expect(keys).not.toContain('basic_salary');
      expect(keys).not.toContain('payslip');
      expect(table(s, 'attendance_by_staff')).toBeUndefined();
    });
  });

  it('leaves attendance out for somebody who may not see attendance', async () => {
    await asAdminDb(async (db) => {
      const reader = await makeUser(db, {
        role: 'manager', permissions: ['reports.payroll.view'],
        deniedPermissions: ['attendance.view'],
      });
      const s = section(await report(db, 'workforce', reader), 'workforce');
      expect(s?.figures.map((f) => f.key)).not.toContain('attendance_late');
    });
  });

  it('gives a reporting manager the register and never a contact detail', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      await db.query(`select app.create_share_class('PRIV', 'Privacy class', 100000)`);
      await db.query(
        `select * from app.create_shareholder('Private Owner', $1, '0772900456', null, 'Kampala')`,
        [requestId('privacy')]);
      await becomeOwner(db);

      const reader = await makeUser(db, {
        role: 'manager', permissions: ['shareholders.reports.view'],
        deniedPermissions: ['shares.view', 'shareholders.view'],
      });
      const s = section(await report(db, 'shareholders', reader), 'ownership');
      const text = JSON.stringify(s);
      expect(text).not.toContain('0772900456');
      expect(text).not.toContain('Kampala');
      // And the share ledger detail is not theirs either.
      expect(table(s, 'contributions')).toBeUndefined();
    });
  });

  it('gives a holder of shares.view the ledger detail as well', async () => {
    await asAdminDb(async (db) => {
      const s = section(await report(db, 'shareholders', SEED.admin), 'ownership');
      expect(table(s, 'contributions')).toBeDefined();
      expect(s?.figures.map((f) => f.key)).toContain('issues');
    });
  });

  it('keeps after-hours cash out of a report the caller may not open', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss, floatUgx: 40_000 });
      const session = await openSession(db, staff);
      await closeSession(db, session.session_id, staff);

      await becomeClient(db, SEED.cashier);
      expect(await db.expectError(
        `select app.business_report('after_hours', app.eat_day(), app.eat_day())`))
        .toMatch(/do not have permission/i);
      await becomeOwner(db);

      // And the executive summary leaves the section out rather than refusing.
      const keys = sections(await report(db, 'executive', SEED.cashier)).map((s) => s.key);
      expect(keys).not.toContain('after_hours');
    });
  });

  it('a report never returns more than the tables themselves would', async () => {
    await asAdminDb(async (db) => {
      // The cashier cannot read loss incidents at the table…
      await becomeClient(db, SEED.cashier);
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.loss_incidents`);
      await becomeOwner(db);
      expect(Number(rows[0].n)).toBe(0);

      // …and the report does not hand them over either.
      const keys = sections(await report(db, 'executive', SEED.cashier)).map((s) => s.key);
      expect(keys).not.toContain('workforce');
    });
  });
});
