import { afterAll, describe, expect, it } from 'vitest';
import { asAdminDb, closePool } from './harness';
import { invoicedJob, requestId } from './billing-helpers';
import { balanceOf, ledgerDisagreements } from './finance-helpers';
import {
  authorize, becomeClient, becomeOwner, closeSession, collect, eligibleWorker, makeUser,
  openSession, SEED, sessionRow, supervisor,
} from './after-hours-helpers';

afterAll(closePool);

/**
 * AFTER-HOURS PAYMENTS.
 *
 * The worked example from the reference implementation, end to end:
 *
 *   float UGX 50,000 + cash UGX 30,000 (+ Airtel UGX 15,000, NOT counted)
 *     → expected UGX 80,000
 *   reversing a UGX 15,000 cash payment while the session is open
 *     → expected UGX 65,000
 *   closing recalculates UGX 65,000 from the payments themselves
 *   a later reversal leaves it at UGX 65,000
 *
 * And throughout: ONE ledger. A payment taken at night is revenue once, in
 * the account of its method, exactly as in daylight.
 */
describe('after-hours payments: who may take them', () => {
  it('a collect-only worker with no open session is told to open one', async () => {
    await asAdminDb(async (db) => {
      const staff = await makeUser(db, {
        role: 'worker',
        permissions: ['after_hours.request', 'after_hours.cash.collect', 'invoices.view'],
      });
      const job = await invoicedJob(db, 'UAH 611X');
      expect(await collect(db, { invoice: job.invoice, amount: 5_000, by: staff }))
        .toMatch(/open your after-hours session/i);
    });
  });

  it('a worker with neither permission is refused outright', async () => {
    await asAdminDb(async (db) => {
      const job = await invoicedJob(db, 'UAH 612X');
      expect(await collect(db, { invoice: job.invoice, amount: 5_000, by: SEED.worker }))
        .toMatch(/do not have permission/i);
    });
  });

  it('a cashier keeps taking payments with no session at all', async () => {
    await asAdminDb(async (db) => {
      const job = await invoicedJob(db, 'UAH 613X');
      expect(await collect(db, { invoice: job.invoice, amount: 5_000, by: SEED.cashier }))
        .toBeNull();
      const { rows } = await db.query<{ is_after_hours: boolean }>(
        `select is_after_hours from public.payments where invoice_id = $1`, [job.invoice]);
      expect(rows[0].is_after_hours).toBe(false);
    });
  });

  it('refuses once the authorisation has ended, and says to hand over', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['invoices.view']);
      const boss = await supervisor(db);
      const auth = await authorize(db, { staff, by: boss });
      await openSession(db, staff);
      const job = await invoicedJob(db, 'UAH 614X');

      await db.query(
        `update public.after_hours_access
            set starts_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
          where id = $1`, [auth.authorization_id]);
      await db.query(
        `update public.temporary_grants
            set starts_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
          where authorization_id = $1`, [auth.authorization_id]);

      expect(await collect(db, { invoice: job.invoice, amount: 5_000, by: staff }))
        .toMatch(/do not have permission|has ended or was revoked/i);
    });
  });

  it('refuses a method the policy does not allow after hours', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['invoices.view']);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      await openSession(db, staff);
      const job = await invoicedJob(db, 'UAH 615X');
      // Bank is off after hours by default.
      expect(await collect(db, { invoice: job.invoice, amount: 5_000, method: 'bank', by: staff }))
        .toMatch(/not allowed after hours/i);
    });
  });
});

describe('after-hours payments: the expected cash', () => {
  it('follows the reference example exactly', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['invoices.view']);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss, floatUgx: 50_000 });
      const session = await openSession(db, staff);

      const cashJob = await invoicedJob(db, 'UAH 616X', ['Full Valet']);
      const momoJob = await invoicedJob(db, 'UAH 617X', ['Full Valet']);
      expect(await collect(db, { invoice: cashJob.invoice, amount: 30_000, by: staff })).toBeNull();
      expect(await collect(db, {
        invoice: momoJob.invoice, amount: 15_000, method: 'airtel_merchant', by: staff,
      })).toBeNull();

      const s = await sessionRow(db, session.session_id);
      // Mobile money went straight to the merchant account. It is recorded,
      // but it is not in the worker's hands.
      expect(Number(s.cash_collected_ugx)).toBe(30_000);
      expect(Number(s.non_cash_collected_ugx)).toBe(15_000);
      expect(Number(s.expected_cash_ugx)).toBe(80_000);

      // Reverse a UGX 15,000 cash payment WHILE the session is open.
      const smallJob = await invoicedJob(db, 'UAH 618X', ['Body Wash']);
      expect(await collect(db, { invoice: smallJob.invoice, amount: 15_000, by: staff })).toBeNull();
      expect(Number((await sessionRow(db, session.session_id)).expected_cash_ugx)).toBe(95_000);

      const { rows: payment } = await db.query<{ id: string }>(
        `select id from public.payments where invoice_id = $1`, [smallJob.invoice]);
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.reverse_payment($1, 'Customer changed their mind')`,
        [payment[0].id]);
      await becomeOwner(db);

      expect(Number((await sessionRow(db, session.session_id)).expected_cash_ugx)).toBe(80_000);
    });
  });

  it('recalculates from the payments at close, not from the running total', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['invoices.view']);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss, floatUgx: 50_000 });
      const session = await openSession(db, staff);
      const job = await invoicedJob(db, 'UAH 619X', ['Body Wash']);
      expect(await collect(db, { invoice: job.invoice, amount: 15_000, by: staff })).toBeNull();

      // Corrupt the running total. The close must ignore it entirely.
      await db.query(
        `update public.after_hours_sessions set expected_cash_ugx = 999999 where id = $1`,
        [session.session_id]);

      const closed = await closeSession(db, session.session_id, staff);
      expect(closed.expected_cash_ugx).toBe(65_000);
      const { rows } = await db.query<{ expected_cash_ugx: string }>(
        `select expected_cash_ugx from public.cash_handovers where session_id = $1`,
        [session.session_id]);
      expect(Number(rows[0].expected_cash_ugx)).toBe(65_000);
    });
  });

  it('a reversal AFTER the close leaves the frozen figure alone', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['invoices.view']);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss, floatUgx: 50_000 });
      const session = await openSession(db, staff);
      const job = await invoicedJob(db, 'UAH 620X', ['Body Wash']);
      expect(await collect(db, { invoice: job.invoice, amount: 15_000, by: staff })).toBeNull();
      const closed = await closeSession(db, session.session_id, staff);
      expect(closed.expected_cash_ugx).toBe(65_000);

      const { rows: payment } = await db.query<{ id: string }>(
        `select id from public.payments where invoice_id = $1`, [job.invoice]);
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.reverse_payment($1, 'Refunded the next morning')`,
        [payment[0].id]);
      await becomeOwner(db);

      // The refund came out of Cash at Hand, not the worker's pocket.
      const { rows } = await db.query<{ expected_cash_ugx: string }>(
        `select expected_cash_ugx from public.cash_handovers where session_id = $1`,
        [session.session_id]);
      expect(Number(rows[0].expected_cash_ugx)).toBe(65_000);
      const s = await sessionRow(db, session.session_id);
      expect(Number(s.expected_cash_ugx)).toBe(65_000);
      expect(Number(s.post_close_reversals_ugx)).toBe(15_000);

      const { rows: entry } = await db.query<{ after_session_closed: boolean; cash_delta_ugx: string }>(
        `select after_session_closed, cash_delta_ugx from public.after_hours_cash
          where kind = 'payment_reversal' and session_id = $1`, [session.session_id]);
      expect(entry[0].after_session_closed).toBe(true);
      expect(Number(entry[0].cash_delta_ugx)).toBe(0);
    });
  });
});

describe('after-hours payments: one ledger, and only one', () => {
  it('posts the payment exactly as a daytime payment, with no second entry', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['invoices.view']);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      await openSession(db, staff);

      const before = await balanceOf(db, 'cash_at_hand');
      const { rows: countBefore } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.financial_transactions`);

      const job = await invoicedJob(db, 'UAH 621X');
      expect(await collect(db, { invoice: job.invoice, amount: 10_000, by: staff })).toBeNull();

      const { rows: countAfter } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.financial_transactions`);
      expect(Number(countAfter[0].n) - Number(countBefore[0].n)).toBe(1);
      expect(await balanceOf(db, 'cash_at_hand')).toBe(before + 10_000);
      expect(await ledgerDisagreements(db)).toEqual([]);

      const { rows: entry } = await db.query<{ entry_type: string }>(
        `select t.entry_type from public.financial_transactions t
           join public.payments p on p.financial_transaction_id = t.id
          where p.invoice_id = $1`, [job.invoice]);
      expect(entry[0].entry_type).toBe('customer_payment');
    });
  });

  it('writes a custody entry that explains the cash, and nothing financial', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['invoices.view']);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      const session = await openSession(db, staff);
      const job = await invoicedJob(db, 'UAH 622X');
      expect(await collect(db, { invoice: job.invoice, amount: 10_000, by: staff })).toBeNull();

      const { rows } = await db.query<{
        entry_number: string; kind: string; cash_delta_ugx: string; affects_expected: boolean;
        receipt_number: string; method: string;
      }>(`select entry_number, kind, cash_delta_ugx, affects_expected, receipt_number, method
            from public.after_hours_cash where session_id = $1 and kind = 'payment'`,
        [session.session_id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].entry_number).toMatch(/^RMX-AHC-\d{6}$/);
      expect(Number(rows[0].cash_delta_ugx)).toBe(10_000);
      expect(rows[0].affects_expected).toBe(true);
      expect(rows[0].receipt_number).toMatch(/^RMX-RCP-/);

      // The custody sub-ledger is NOT a financial account.
      const { rows: accounts } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.financial_accounts where code like '%custody%'`);
      expect(Number(accounts[0].n)).toBe(0);
    });
  });

  it('mobile money never enters the worker’s custody', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['invoices.view']);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      const session = await openSession(db, staff);
      const job = await invoicedJob(db, 'UAH 623X');
      expect(await collect(db, {
        invoice: job.invoice, amount: 10_000, method: 'mtn_merchant', by: staff,
      })).toBeNull();

      const { rows } = await db.query<{ cash_delta_ugx: string; affects_expected: boolean }>(
        `select cash_delta_ugx, affects_expected from public.after_hours_cash
          where session_id = $1 and kind = 'payment'`, [session.session_id]);
      expect(Number(rows[0].cash_delta_ugx)).toBe(0);
      expect(rows[0].affects_expected).toBe(false);
      expect(Number((await sessionRow(db, session.session_id)).expected_cash_ugx)).toBe(0);
    });
  });

  it('a worker on duty still cannot reverse a payment', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['invoices.view']);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      await openSession(db, staff);
      const job = await invoicedJob(db, 'UAH 624X');
      expect(await collect(db, { invoice: job.invoice, amount: 10_000, by: staff })).toBeNull();
      const { rows: payment } = await db.query<{ id: string }>(
        `select id from public.payments where invoice_id = $1`, [job.invoice]);

      await becomeClient(db, staff);
      expect(await db.expectError(`select * from app.reverse_payment($1, 'Mistake')`,
        [payment[0].id])).toMatch(/do not have permission/i);
      await becomeOwner(db);
    });
  });

  it('the payment is idempotent, on duty as in daylight', async () => {
    await asAdminDb(async (db) => {
      const staff = await eligibleWorker(db, ['invoices.view']);
      const boss = await supervisor(db);
      await authorize(db, { staff, by: boss });
      const session = await openSession(db, staff);
      const job = await invoicedJob(db, 'UAH 625X');
      const id = requestId('double-tap');

      await becomeClient(db, staff);
      await db.query(`select * from app.record_payment($1, 5000, 'cash', $2)`, [job.invoice, id]);
      await db.query(`select * from app.record_payment($1, 5000, 'cash', $2)`, [job.invoice, id]);
      await becomeOwner(db);

      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.payments where invoice_id = $1`, [job.invoice]);
      expect(Number(rows[0].n)).toBe(1);
      expect(Number((await sessionRow(db, session.session_id)).payment_count)).toBe(1);
    });
  });
});
