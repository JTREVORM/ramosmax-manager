import { afterAll, describe, expect, it } from 'vitest';
import { closePool, getPool, SEED } from './harness';
import { requestId } from './billing-helpers';

afterAll(closePool);

/**
 * IDEMPOTENCY AND CONCURRENCY for ownership and dividends.
 *
 * These tests COMMIT. Two simultaneous approvals of the same share request,
 * or two dividend payments racing one account, cannot be proved with a
 * rolled-back transaction.
 */

interface Runner {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

async function committedAs<T>(uid: string | null, fn: (run: Runner) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    if (uid !== null) {
      await client.query(
        `set local request.jwt.claims = '${JSON.stringify({ sub: uid, role: 'authenticated' })}'`);
      await client.query('set local role authenticated');
    }
    const result = await fn({
      query: async (sql, params) => (await client.query(sql, params as never)).rows,
    });
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 8)}`;
const settle = async <T>(work: Promise<T>[]) =>
  (await Promise.allSettled(work)).map((r) => r.status);
const ugx = (v: unknown) => Number(v ?? 0);

/** The shared ORDINARY class, created once and left committed. */
async function ensureClass(): Promise<void> {
  await committedAs(SEED.admin, async (run) => {
    const rows = await run.query(`select id from public.share_classes where id = 'ordinary'`);
    if (rows.length === 0) {
      await run.query(`select app.create_share_class('ORDINARY', 'Ordinary shares', 100000)`);
    }
  });
}

async function committedShareholder(): Promise<string> {
  await ensureClass();
  return committedAs(SEED.admin, async (run) =>
    (await run.query(`select shareholder_id as id from app.create_shareholder($1, $2)`,
      [unique('Concurrent Owner'), requestId('sh')]))[0].id as string);
}

async function fundedAccount(amount: number): Promise<string> {
  return committedAs(SEED.admin, async (run) => {
    const id = (await run.query(
      `select app.create_financial_account($1, 'bank', 'Test Bank') as id`,
      [`Test ${unique('Capital')}`]))[0].id as string;
    if (amount > 0) {
      await run.query(`select * from app.record_opening_balance($1, $2, 'Test float')`, [id, amount]);
    }
    return id;
  });
}

const balanceOf = async (id: string) =>
  Number((await committedAs(null, (run) =>
    run.query(`select balance_ugx from public.financial_accounts where id = $1`, [id])))[0].balance_ugx);

const sharesOf = async (id: string) =>
  Number((await committedAs(null, (run) =>
    run.query(`select total_shares from public.shareholders where id = $1`, [id])))[0].total_shares);

/** Approval on or off, as the test needs. */
async function setApproval(required: boolean): Promise<void> {
  await committedAs(SEED.admin, async (run) => {
    const current = (await run.query(`select app.share_policy() as p`))[0].p as Record<string, boolean>;
    if (current.requireApproval !== required) {
      await run.query(
        `select app.update_shareholding_policy('share', $1::jsonb, 'Concurrency test')`,
        [JSON.stringify({ requireApproval: required })]);
    }
  });
}

// ---------------------------------------------------------------------------
describe('share approval', () => {
  it('approves once when two approvals arrive at the same moment', async () => {
    await setApproval(true);
    const holder = await committedShareholder();
    const account = await fundedAccount(50_000_000);
    const txn = await committedAs(SEED.admin, async (run) =>
      (await run.query(
        `select transaction_id as id from app.issue_shares($1, 'ordinary', 100, $2, null,
                                                           'account', 10000000, $3)`,
        [holder, requestId('issue'), account]))[0].id as string);

    const outcomes = await settle([1, 2].map(() =>
      committedAs(SEED.admin, (run) =>
        run.query(`select app.decide_share_transaction($1, 'approve')`, [txn]))));

    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
    expect(await sharesOf(holder)).toBe(100);
    const entries = await committedAs(null, (run) => run.query(
      `select id from public.financial_transactions
        where entry_type = 'share_capital_contribution' and reference_id = $1`, [txn]));
    expect(entries, 'one share-capital entry, not two').toHaveLength(1);
  });

  it('lets an approval and a rejection race, and only one wins', async () => {
    await setApproval(true);
    const holder = await committedShareholder();
    const account = await fundedAccount(50_000_000);
    const txn = await committedAs(SEED.admin, async (run) =>
      (await run.query(
        `select transaction_id as id from app.issue_shares($1, 'ordinary', 50, $2, null,
                                                           'account', 5000000, $3)`,
        [holder, requestId('issue2'), account]))[0].id as string);

    const outcomes = await settle([
      committedAs(SEED.admin, (run) =>
        run.query(`select app.decide_share_transaction($1, 'approve')`, [txn])),
      committedAs(SEED.admin, (run) =>
        run.query(`select app.decide_share_transaction($1, 'reject', 'Changed our minds')`, [txn])),
    ]);
    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
    const rows = await committedAs(null, (run) => run.query(
      `select status from public.share_transactions where id = $1`, [txn]));
    expect(['posted', 'rejected']).toContain(rows[0].status);
  });

  it('issues once for a repeated request id', async () => {
    await setApproval(false);
    const holder = await committedShareholder();
    const account = await fundedAccount(50_000_000);
    const key = requestId('issue-idempotent');
    const before = await balanceOf(account);

    const first = await committedAs(SEED.admin, (run) => run.query(
      `select transaction_number from app.issue_shares($1, 'ordinary', 10, $2, null,
                                                       'account', 1000000, $3)`,
      [holder, key, account]));
    const again = await committedAs(SEED.admin, (run) => run.query(
      `select transaction_number from app.issue_shares($1, 'ordinary', 10, $2, null,
                                                       'account', 1000000, $3)`,
      [holder, key, account]));

    expect(again[0].transaction_number).toBe(first[0].transaction_number);
    expect(await balanceOf(account)).toBe(before + 1_000_000);
    expect(await sharesOf(holder)).toBe(10);
  });

  it('refuses the same request id for a different issue', async () => {
    await setApproval(false);
    const holder = await committedShareholder();
    const account = await fundedAccount(50_000_000);
    const key = requestId('issue-shared');
    await committedAs(SEED.admin, (run) => run.query(
      `select * from app.issue_shares($1, 'ordinary', 10, $2, null, 'account', 1000000, $3)`,
      [holder, key, account]));
    await expect(committedAs(SEED.admin, (run) => run.query(
      `select * from app.issue_shares($1, 'ordinary', 25, $2, null, 'account', 2500000, $3)`,
      [holder, key, account]))).rejects.toThrow(/already used for a different request/i);
    expect(await sharesOf(holder)).toBe(10);
  });

  it('lets only one of two simultaneous transfers of the same shares win', async () => {
    await setApproval(false);
    const from = await committedShareholder();
    const to = await committedShareholder();
    const account = await fundedAccount(50_000_000);
    await committedAs(SEED.admin, (run) => run.query(
      `select * from app.issue_shares($1, 'ordinary', 100, $2, null, 'account', 10000000, $3)`,
      [from, requestId('for-transfer'), account]));

    const outcomes = await settle([1, 2].map((n) =>
      committedAs(SEED.admin, (run) => run.query(
        `select * from app.transfer_shares($1, $2, 'ordinary', 60, $3, $4)`,
        [from, to, `Sale ${n}`, requestId('race-transfer')]))));

    // Both cannot take 60 of 100.
    expect(outcomes.filter((s) => s === 'fulfilled').length).toBeLessThanOrEqual(1);
    expect(await sharesOf(from)).toBeGreaterThanOrEqual(0);
    expect(await sharesOf(from) + await sharesOf(to)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
describe('dividend payment', () => {
  /**
   * A committed, approved dividend over one holder's shares.
   *
   * Each calculated dividend LOCKS ownership on and before its record date,
   * and a paid one keeps that lock for good — which is the point of it. So
   * every fixture works one day past whatever is already locked.
   */
  async function approvedDividend(pool: number) {
    await setApproval(false);
    const holder = await committedShareholder();
    const account = await fundedAccount(50_000_000);
    const day = (await committedAs(null, (run) => run.query(
      `select least(coalesce(app.locked_record_date() + 1, app.eat_day() - 400),
                    app.eat_day())::text as d`)))[0].d as string;
    await committedAs(SEED.admin, (run) => run.query(
      `select * from app.issue_shares($1, 'ordinary', 100, $2, $3::date, 'account', 10000000, $4)`,
      [holder, requestId('div-issue'), day, account]));

    return committedAs(SEED.admin, async (run) => {
      const id = (await run.query(
        `select dividend_id as id from app.create_dividend($1, $2::date, $3, 'pool', $4)`,
        [unique('FY'), day, requestId('div'), pool]))[0].id as string;
      await run.query(`select * from app.calculate_dividend($1)`, [id]);
      await run.query(`select app.update_dividend_status($1, 'declare')`, [id]);
      await run.query(`select app.update_dividend_status($1, 'approve')`, [id]);
      const allocations = (await run.query(
        `select id from public.dividend_allocations where dividend_id = $1 and current`, [id]))
        .map((r) => r.id as string);
      // The allocated total is what will actually be paid: the pool may leave
      // a shilling or two unallocated when it does not divide exactly.
      const allocated = Number((await run.query(
        `select allocated_ugx from public.dividends where id = $1`, [id]))[0].allocated_ugx);
      return { id, allocations, account, holder, allocated };
    });
  }

  it('pays once when two payments arrive at the same moment', async () => {
    const dividend = await approvedDividend(1_000_000);
    const before = await balanceOf(dividend.account);

    const outcomes = await settle([1, 2].map(() =>
      committedAs(SEED.admin, (run) => run.query(
        `select * from app.pay_dividend($1, $2::uuid[], $3, $4)`,
        [dividend.id, dividend.allocations, dividend.account, requestId('concurrent-div')]))));

    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(dividend.account)).toBe(before - dividend.allocated);
    const entries = await committedAs(null, (run) => run.query(
      `select id from public.financial_transactions
        where entry_type = 'dividend_payment' and reference_id = any($1::uuid[])`,
      [dividend.allocations]));
    expect(entries).toHaveLength(dividend.allocations.length);
  });

  it('pays once for a repeated request id', async () => {
    const dividend = await approvedDividend(500_000);
    const before = await balanceOf(dividend.account);
    const key = requestId('div-idempotent');

    const first = await committedAs(SEED.admin, (run) => run.query(
      `select * from app.pay_dividend($1, $2::uuid[], $3, $4)`,
      [dividend.id, dividend.allocations, dividend.account, key]));
    const again = await committedAs(SEED.admin, (run) => run.query(
      `select * from app.pay_dividend($1, $2::uuid[], $3, $4)`,
      [dividend.id, dividend.allocations, dividend.account, key]));

    expect(again[0].amount_ugx).toBe(first[0].amount_ugx);
    expect(await balanceOf(dividend.account)).toBe(before - dividend.allocated);
  });

  it('spends no more than the account holds when two dividends race for it', async () => {
    const one = await approvedDividend(30_000_000);
    const two = await approvedDividend(30_000_000);
    // One account for both, with room for one payment only.
    const account = await fundedAccount(Math.max(one.allocated, two.allocated) + 5_000_000);
    const before = await balanceOf(account);

    const outcomes = await settle([one, two].map((d) =>
      committedAs(SEED.admin, (run) => run.query(
        `select * from app.pay_dividend($1, $2::uuid[], $3, $4)`,
        [d.id, d.allocations, account, requestId('div-race')]))));

    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(account)).toBeGreaterThanOrEqual(5_000_000);
    expect(before - (await balanceOf(account)))
      .toBeLessThanOrEqual(Math.max(one.allocated, two.allocated));
  });

  it('reverses once when two reversals arrive together', async () => {
    const dividend = await approvedDividend(400_000);
    await committedAs(SEED.admin, (run) => run.query(
      `select * from app.pay_dividend($1, $2::uuid[], $3, $4)`,
      [dividend.id, dividend.allocations, dividend.account, requestId('to-reverse')]));
    const before = await balanceOf(dividend.account);
    const first = Number((await committedAs(null, (run) => run.query(
      `select net_ugx from public.dividend_allocations where id = $1`,
      [dividend.allocations[0]])))[0].net_ugx);

    const outcomes = await settle([1, 2].map(() =>
      committedAs(SEED.admin, (run) => run.query(
        `select * from app.reverse_dividend_payment($1, 'Paid in error')`,
        [dividend.allocations[0]]))));

    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(dividend.account)).toBe(before + first);
  });
});

// ---------------------------------------------------------------------------
describe('the ledger still adds up afterwards', () => {
  it('has every account equal to the sum of its movements', async () => {
    const rows = await committedAs(null, (run) => run.query(`
      select a.code from public.financial_accounts a
       left join public.financial_transaction_entries e on e.account_id = a.id
       group by a.id, a.code, a.balance_ugx
      having a.balance_ugx <> coalesce(sum(e.delta_ugx), 0)`));
    expect(rows).toEqual([]);
    expect(ugx(0)).toBe(0);
  });
});
