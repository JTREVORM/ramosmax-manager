import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, closePool, type Session } from './harness';
import { becomeClient, becomeOwner, invoicedJob, requestId, SEED } from './billing-helpers';
import { balanceOf, fund } from './finance-helpers';
import { autoPost, shareClass, testClassCode } from './ownership-helpers';

afterAll(closePool);

const today = async (db: Session): Promise<string> =>
  (await db.query<{ d: string }>(`select app.eat_day()::text as d`)).rows[0].d;

async function report(
  db: Session,
  name: string,
  options: { from?: string; to?: string; as?: string } = {},
): Promise<Record<string, unknown>> {
  const day = await today(db);
  await becomeClient(db, options.as ?? SEED.admin);
  const { rows } = await db.query<{ r: Record<string, unknown> }>(
    `select app.business_report($1, $2::date, $3::date) as r`,
    [name, options.from ?? day, options.to ?? day]);
  await becomeOwner(db);
  return rows[0].r;
}

type Section = {
  key: string;
  title: string;
  figures: Array<{ key: string; label: string; value: number; kind: string }>;
  tables: Array<{ key: string; rows: Array<Record<string, unknown>> }>;
};

const sections = (r: Record<string, unknown>) => r.sections as Section[];
const section = (r: Record<string, unknown>, key: string) =>
  sections(r).find((s) => s.key === key);
const figure = (s: Section | undefined, key: string) =>
  Number(s?.figures.find((f) => f.key === key)?.value ?? Number.NaN);
const table = (s: Section | undefined, key: string) => s?.tables.find((t) => t.key === key);

/**
 * REPORTS.
 *
 * Every figure is worked out on the server from the authoritative records.
 * The client sends a name and a period and nothing else — there is no total
 * it could send, and none it could change.
 */
describe('reports: the period', () => {
  it('refuses a period that ends before it starts', async () => {
    await asAdminDb(async (db) => {
      const day = await today(db);
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select app.business_report('financial', $1::date, $1::date - 1)`, [day]))
        .toMatch(/end on or after its start/i);
      await becomeOwner(db);
    });
  });

  it('refuses a period that starts in the future', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select app.business_report('financial', app.eat_day() + 1, app.eat_day() + 2)`))
        .toMatch(/cannot start in the future/i);
      await becomeOwner(db);
    });
  });

  it('refuses more than 400 days', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select app.business_report('financial', app.eat_day() - 400, app.eat_day())`))
        .toMatch(/at most 400 days/i);
      // Exactly 400 is fine.
      expect(await db.expectError(
        `select app.business_report('financial', app.eat_day() - 399, app.eat_day())`)).toBeNull();
      await becomeOwner(db);
    });
  });

  it('refuses a missing date', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(`select app.business_report('financial', null, app.eat_day())`))
        .toMatch(/choose the period/i);
      await becomeOwner(db);
    });
  });

  it('refuses a report nobody has heard of', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      expect(await db.expectError(
        `select app.business_report('everything', app.eat_day(), app.eat_day())`))
        .toMatch(/choose a report/i);
      await becomeOwner(db);
    });
  });

  it('reports the period back, and when it was generated', async () => {
    await asAdminDb(async (db) => {
      const day = await today(db);
      const r = await report(db, 'financial');
      expect(r.report).toBe('financial');
      expect(r.from).toBe(day);
      expect(r.to).toBe(day);
      expect(r.days).toBe(1);
      expect(r.truncated).toBe(false);
      expect(typeof r.generatedAt).toBe('string');
    });
  });
});

describe('reports: money agrees with the ledger', () => {
  it('counts a customer payment as operating revenue, once', async () => {
    await asAdminDb(async (db) => {
      // The concurrency suites commit money on the same day, so every figure
      // here is measured as a DIFFERENCE this test caused.
      const before = section(await report(db, 'revenue'), 'revenue');
      const job = await invoicedJob(db, 'URP 101A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, 10000, 'cash', $2)`,
        [job.invoice, requestId('report')]);
      await becomeOwner(db);

      const after = section(await report(db, 'revenue'), 'revenue');
      expect(figure(after, 'payments_gross') - figure(before, 'payments_gross')).toBe(10_000);
      expect(figure(after, 'operating_revenue') - figure(before, 'operating_revenue')).toBe(10_000);
      expect(figure(after, 'payment_reversals') - figure(before, 'payment_reversals')).toBe(0);
    });
  });

  it('counts a reversed payment ONCE, as reversed, and excludes it from net', async () => {
    await asAdminDb(async (db) => {
      const beforeMethods = section(await report(db, 'payment_methods'), 'payment_methods');
      const beforeRevenue = section(await report(db, 'revenue'), 'revenue');
      const job = await invoicedJob(db, 'URP 102A');
      await becomeClient(db, SEED.cashier);
      const { rows } = await db.query<{ payment_id: string }>(
        `select * from app.record_payment($1, 10000, 'cash', $2)`,
        [job.invoice, requestId('report')]);
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.reverse_payment($1, 'Customer changed their mind')`,
        [rows[0].payment_id]);
      await becomeOwner(db);

      const methods = section(await report(db, 'payment_methods'), 'payment_methods');
      expect(figure(methods, 'count') - figure(beforeMethods, 'count')).toBe(1);
      expect(figure(methods, 'gross') - figure(beforeMethods, 'gross')).toBe(10_000);
      expect(figure(methods, 'reversed') - figure(beforeMethods, 'reversed')).toBe(10_000);
      // Counted once, as reversed, and excluded from net.
      expect(figure(methods, 'net') - figure(beforeMethods, 'net')).toBe(0);

      const revenue = section(await report(db, 'revenue'), 'revenue');
      expect(figure(revenue, 'operating_revenue') - figure(beforeRevenue, 'operating_revenue'))
        .toBe(0);
      expect(figure(revenue, 'payment_reversals') - figure(beforeRevenue, 'payment_reversals'))
        .toBe(10_000);
    });
  });

  it('never counts share capital or dividends as revenue', async () => {
    await asAdminDb(async (db) => {
      const before = section(await report(db, 'revenue'), 'revenue');
      await fund(db, 'cash_at_hand', 50_000_000);
      const klass = await shareClass(db, testClassCode(), 100_000);
      await autoPost(db);
      await becomeClient(db, SEED.admin);
      const { rows: sh } = await db.query<{ shareholder_id: string }>(
        `select * from app.create_shareholder('Report Owner', $1)`, [requestId('sh')]);
      const { rows: account } = await db.query<{ id: string }>(
        `select id from public.financial_accounts where code = 'cash_at_hand'`);
      await db.query(
        `select * from app.issue_shares($1, $2, 10, $3, null, 'account', 1000000, $4)`,
        [sh[0].shareholder_id, klass, requestId('issue'), account[0].id]);
      await becomeOwner(db);

      const revenue = section(await report(db, 'revenue'), 'revenue');
      expect(figure(revenue, 'operating_revenue') - figure(before, 'operating_revenue')).toBe(0);
      const capitalOf = (s: Section | undefined) =>
        Number(table(s, 'not_revenue')?.rows
          .find((x) => String(x.item).includes('Share capital'))?.amountUgx ?? 0);
      expect(capitalOf(revenue) - capitalOf(before)).toBe(1_000_000);
    });
  });

  it('shows purchases, staff pay and dividends apart from operating expenses', async () => {
    await asAdminDb(async (db) => {
      const r = await report(db, 'expenses');
      const out = section(r, 'money_out');
      expect(out).toBeDefined();
      for (const key of ['operating', 'purchases', 'staff_pay', 'dividends']) {
        expect(Number.isFinite(figure(out, key)), key).toBe(true);
      }
    });
  });

  it('the daily table adds up to the totals', async () => {
    await asAdminDb(async (db) => {
      const job = await invoicedJob(db, 'URP 103A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, 10000, 'cash', $2)`,
        [job.invoice, requestId('report')]);
      await becomeOwner(db);

      const s = section(await report(db, 'financial'), 'financial');
      const daily = table(s, 'daily');
      const sum = (daily?.rows ?? []).reduce((a, row) => a + Number(row.salesUgx), 0);
      expect(sum - (daily?.rows ?? []).reduce((a, row) => a + Number(row.reversedUgx), 0))
        .toBe(figure(s, 'sales'));
      expect((daily?.rows ?? []).length).toBeGreaterThan(0);
    });
  });

  it('the account balances in the report are the ledger balances', async () => {
    await asAdminDb(async (db) => {
      await fund(db, 'cash_at_hand', 250_000);
      const s = section(await report(db, 'executive'), 'finance');
      expect(figure(s, 'balance_cash_at_hand')).toBe(await balanceOf(db, 'cash_at_hand'));
    });
  });
});

describe('reports: the executive summary is assembled from what you may see', () => {
  it('gives an Administrator every section', async () => {
    await asAdminDb(async (db) => {
      const keys = sections(await report(db, 'executive')).map((s) => s.key);
      expect(keys).toEqual(expect.arrayContaining([
        'operations', 'revenue', 'finance', 'workforce', 'inventory', 'ownership', 'after_hours',
      ]));
    });
  });

  it('gives a cashier operations only', async () => {
    await asAdminDb(async (db) => {
      const keys = sections(await report(db, 'executive', { as: SEED.cashier })).map((s) => s.key);
      expect(keys).toContain('operations');
      expect(keys).not.toContain('finance');
      expect(keys).not.toContain('workforce');
      expect(keys).not.toContain('ownership');
    });
  });

  it('gives a shareholder operations, revenue and balances — and no staff pay', async () => {
    await asAdminDb(async (db) => {
      const keys = sections(await report(db, 'executive', { as: SEED.shareholder }))
        .map((s) => s.key);
      expect(keys).not.toContain('workforce');
      expect(keys).not.toContain('after_hours');
    });
  });
});

describe('reports: outstanding and credit', () => {
  it('ages an open invoice and totals what is owed', async () => {
    await asAdminDb(async (db) => {
      const job = await invoicedJob(db, 'URP 104A');
      const s = section(await report(db, 'outstanding'), 'outstanding');
      expect(figure(s, 'invoices')).toBeGreaterThan(0);
      const rows = table(s, 'invoices')?.rows ?? [];
      const mine = rows.find((x) => x.plate === 'URP 104A');
      expect(mine).toBeDefined();
      expect(Number(mine?.outstandingUgx)).toBe(job.subtotal);
      expect(Number(mine?.ageDays)).toBe(0);
      expect(Number(mine?.payments)).toBe(0);
    });
  });

  it('is owed, not revenue', async () => {
    await asAdminDb(async (db) => {
      const before = section(await report(db, 'revenue'), 'revenue');
      const job = await invoicedJob(db, 'URP 105A');
      const after = section(await report(db, 'revenue'), 'revenue');
      // The invoice is owed: it adds to what customers owe and nothing to
      // revenue, because nobody has paid it.
      expect(figure(after, 'operating_revenue') - figure(before, 'operating_revenue')).toBe(0);
      expect(figure(after, 'credit_outstanding') - figure(before, 'credit_outstanding'))
        .toBe(job.subtotal);
    });
  });
});

describe('reports: they write nothing', () => {
  it('leaves the audit trail and every table alone', async () => {
    await asAdminDb(async (db) => {
      const counts = async () => {
        const { rows } = await db.query<{ a: string; p: string; i: string }>(`
          select (select count(*) from public.audit_logs)::text as a,
                 (select count(*) from public.payments)::text as p,
                 (select count(*) from public.invoices)::text as i`);
        return rows[0];
      };
      const before = await counts();
      for (const name of ['executive', 'financial', 'revenue', 'payment_methods', 'outstanding',
        'expenses', 'inventory', 'workforce', 'shareholders', 'after_hours']) {
        await report(db, name, { from: undefined, to: undefined });
      }
      expect(await counts()).toEqual(before);
    });
  });

  it('is declared STABLE, so it cannot write even by accident', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ volatile: string }>(
        `select p.provolatile as volatile from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app' and p.proname = 'business_report'`);
      expect(rows[0].volatile).toBe('s');
    });
  });
});
