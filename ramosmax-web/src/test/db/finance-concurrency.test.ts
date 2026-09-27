import { afterAll, describe, expect, it } from 'vitest';
import { closePool, getPool, SEED } from './harness';
import { requestId } from './billing-helpers';

afterAll(closePool);

/**
 * IDEMPOTENCY AND CONCURRENCY for the money and stock that Phase E moves.
 *
 * Like the billing suite, these tests COMMIT: proving that two SIMULTANEOUS
 * transactions cannot both spend the same shilling, or issue the same unit of
 * stock, requires real, separate, committing transactions.
 *
 * Every test works on records it creates itself and asserts only about those.
 */

interface Runner {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/** Runs `fn` in its own committed transaction as `uid` (null = the owner). */
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

/** A committed bank account holding `amount`, of its own. */
async function fundedAccount(amount: number): Promise<{ id: string; name: string }> {
  return committedAs(SEED.admin, async (run) => {
    const name = `Test ${unique('Bank')}`;
    const account = (await run.query(
      `select app.create_financial_account($1, 'bank', 'Test Bank') as id`, [name]))[0].id as string;
    // An opening balance must be a positive amount; an empty account simply
    // has none recorded.
    if (amount > 0) {
      await run.query(`select * from app.record_opening_balance($1, $2, 'Test float')`, [account, amount]);
    }
    return { id: account, name };
  });
}

/** A committed item with `quantity` in stock. */
async function stockedItem(quantity: number, unitCost = 1_000): Promise<string> {
  return committedAs(SEED.manager, async (run) => {
    const supplier = (await run.query(
      `select supplier_id from app.create_supplier($1)`, [`Test ${unique('Supplier')}`]))[0]
      .supplier_id as string;
    return (await run.query(
      `select item_id from app.create_inventory_item($1, 'chemicals', 'litre', 0, 0, null, true,
                                                     $2, $3, null, $4)`,
      [`Test ${unique('Item')}`, supplier, unitCost, quantity]))[0].item_id as string;
  });
}

/** An approved, unpaid expense for `amount`. */
async function approvedExpense(amount: number): Promise<string> {
  return committedAs(SEED.manager, async (run) => {
    const id = (await run.query(
      `select expense_id from app.create_expense('operations', $1, $2, current_date, $3,
                                                  null, null, null, null, true)`,
      [unique('Expense'), amount, requestId('exp')]))[0].expense_id as string;
    await run.query(`select app.update_expense_status($1, 'review', 'Checked')`, [id]);
    await run.query(`select app.update_expense_status($1, 'approve')`, [id]);
    return id;
  });
}

const settle = async <T>(work: Promise<T>[]) =>
  (await Promise.allSettled(work)).map((r) => r.status);

const balanceOf = async (id: string) =>
  Number((await committedAs(null, (run) =>
    run.query(`select balance_ugx from public.financial_accounts where id = $1`, [id])))[0].balance_ugx);

const quantityOf = async (id: string) =>
  Number((await committedAs(null, (run) =>
    run.query(`select quantity from public.inventory_items where id = $1`, [id])))[0].quantity);

// ---------------------------------------------------------------------------
describe('idempotency', () => {
  it('transfers once for a repeated request id', async () => {
    const source = await fundedAccount(500_000);
    const target = await fundedAccount(0);
    const request = requestId('transfer');

    const first = await committedAs(SEED.manager, (run) =>
      run.query(`select * from app.transfer_funds($1, $2, 100000, 'Banking', $3)`,
        [source.id, target.id, request]));
    const again = await committedAs(SEED.manager, (run) =>
      run.query(`select * from app.transfer_funds($1, $2, 100000, 'Banking', $3)`,
        [source.id, target.id, request]));

    expect(again[0].transaction_number).toBe(first[0].transaction_number);
    expect(await balanceOf(source.id)).toBe(400_000);
    expect(await balanceOf(target.id)).toBe(100_000);
  });

  it('refuses the same request id for a different transfer', async () => {
    const source = await fundedAccount(500_000);
    const target = await fundedAccount(0);
    const request = requestId('transfer');
    await committedAs(SEED.manager, (run) =>
      run.query(`select * from app.transfer_funds($1, $2, 100000, 'Banking', $3)`,
        [source.id, target.id, request]));

    await expect(committedAs(SEED.manager, (run) =>
      run.query(`select * from app.transfer_funds($1, $2, 250000, 'Banking', $3)`,
        [source.id, target.id, request]))).rejects.toThrow(/already used for a different request/i);
    expect(await balanceOf(source.id)).toBe(400_000);
  });

  it('records one bank deposit for a repeated request id', async () => {
    const bank = await fundedAccount(0);
    const cash = (await committedAs(null, (run) =>
      run.query(`select id from public.financial_accounts where code = 'cash_at_hand'`)))[0].id as string;
    const before = await balanceOf(cash);
    await committedAs(SEED.admin, (run) =>
      run.query(`select * from app.record_account_adjustment($1, 'in', 200000, 'Test float', $2)`,
        [cash, requestId('adj')]));

    const request = requestId('deposit');
    const first = await committedAs(SEED.manager, (run) =>
      run.query(`select * from app.record_bank_deposit($1, $2, 120000, 'SLIP-X', $3)`,
        [cash, bank.id, request]));
    const again = await committedAs(SEED.manager, (run) =>
      run.query(`select * from app.record_bank_deposit($1, $2, 120000, 'SLIP-X', $3)`,
        [cash, bank.id, request]));

    expect(again[0].deposit_number).toBe(first[0].deposit_number);
    expect(await balanceOf(bank.id)).toBe(120_000);
    expect(await balanceOf(cash)).toBe(before + 80_000);
  });

  it('pays an expense once for a repeated request id', async () => {
    const account = await fundedAccount(500_000);
    const expense = await approvedExpense(90_000);
    const request = requestId('expense_payment');

    const first = await committedAs(SEED.manager, (run) =>
      run.query(`select * from app.pay_expense($1, $2, $3)`, [expense, account.id, request]));
    const again = await committedAs(SEED.manager, (run) =>
      run.query(`select * from app.pay_expense($1, $2, $3)`, [expense, account.id, request]));

    expect(again[0].transaction_number).toBe(first[0].transaction_number);
    expect(await balanceOf(account.id)).toBe(410_000);
  });

  it('issues stock once for a repeated request id', async () => {
    const item = await stockedItem(20);
    const request = requestId('stock');
    await committedAs(SEED.manager, (run) =>
      run.query(`select * from app.record_stock_movement($1, 'usage', 5, 'Used', $2)`, [item, request]));
    await committedAs(SEED.manager, (run) =>
      run.query(`select * from app.record_stock_movement($1, 'usage', 5, 'Used', $2)`, [item, request]));
    expect(await quantityOf(item)).toBe(15);
  });
});

// ---------------------------------------------------------------------------
describe('concurrent transfers from one account', () => {
  it('never overdraws the source', async () => {
    const source = await fundedAccount(15_000);
    const target = await fundedAccount(0);

    // Three at once, UGX 5,000 each, against UGX 15,000: all three fit exactly.
    const results = await settle([0, 1, 2].map((i) =>
      committedAs(SEED.manager, (run) =>
        run.query(`select * from app.transfer_funds($1, $2, 5000, 'Split banking', $3)`,
          [source.id, target.id, requestId(`c${i}`)]))));

    expect(results.filter((r) => r === 'fulfilled')).toHaveLength(3);
    expect(await balanceOf(source.id)).toBe(0);
    expect(await balanceOf(target.id)).toBe(15_000);
  });

  it('lets only as many simultaneous transfers succeed as the balance allows', async () => {
    const source = await fundedAccount(15_000);
    const target = await fundedAccount(0);

    const results = await settle([0, 1, 2, 3].map((i) =>
      committedAs(SEED.manager, (run) =>
        run.query(`select * from app.transfer_funds($1, $2, 5000, 'Split banking', $3)`,
          [source.id, target.id, requestId(`d${i}`)]))));

    expect(results.filter((r) => r === 'fulfilled')).toHaveLength(3);
    expect(results.filter((r) => r === 'rejected')).toHaveLength(1);
    expect(await balanceOf(source.id)).toBe(0);
    expect(await balanceOf(target.id)).toBe(15_000);
  });

  it('survives simultaneous duplicates of ONE request id', async () => {
    const source = await fundedAccount(100_000);
    const target = await fundedAccount(0);
    const request = requestId('same');

    await settle([0, 1, 2].map(() =>
      committedAs(SEED.manager, (run) =>
        run.query(`select * from app.transfer_funds($1, $2, 30000, 'Banking', $3)`,
          [source.id, target.id, request]))));

    expect(await balanceOf(target.id)).toBe(30_000);
    expect(await balanceOf(source.id)).toBe(70_000);
  });
});

// ---------------------------------------------------------------------------
describe('concurrent expense payment, deposit and reversal', () => {
  it('pays an expense only once when two people press Pay together', async () => {
    const account = await fundedAccount(500_000);
    const expense = await approvedExpense(120_000);

    const results = await settle([0, 1].map((i) =>
      committedAs(SEED.manager, (run) =>
        run.query(`select * from app.pay_expense($1, $2, $3)`,
          [expense, account.id, requestId(`p${i}`)]))));

    expect(results.filter((r) => r === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(account.id)).toBe(380_000);
  });

  it('records one deposit when the button is pressed twice at once', async () => {
    const bank = await fundedAccount(0);
    const source = await fundedAccount(0);
    // A mobile-money account can bank its float; a bank cannot deposit to a bank.
    const mtn = (await committedAs(null, (run) =>
      run.query(`select id from public.financial_accounts where code = 'mtn_merchant'`)))[0].id as string;
    void source;
    const before = await balanceOf(mtn);
    await committedAs(SEED.admin, (run) =>
      run.query(`select * from app.record_account_adjustment($1, 'in', 300000, 'Test float', $2)`,
        [mtn, requestId('adj')]));

    const results = await settle([0, 1].map((i) =>
      committedAs(SEED.manager, (run) =>
        run.query(`select * from app.record_bank_deposit($1, $2, 300000, 'SLIP-Y', $3)`,
          [mtn, bank.id, requestId(`dep${i}`)]))));

    expect(results.filter((r) => r === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(bank.id)).toBe(300_000);
    expect(await balanceOf(mtn)).toBe(before);
  });

  it('reverses a transaction only once, however many people try', async () => {
    const source = await fundedAccount(200_000);
    const target = await fundedAccount(0);
    const transfer = await committedAs(SEED.manager, (run) =>
      run.query(`select * from app.transfer_funds($1, $2, 50000, 'Banking', $3)`,
        [source.id, target.id, requestId('t')]));

    const results = await settle([0, 1].map(() =>
      committedAs(SEED.admin, (run) =>
        run.query(`select * from app.reverse_financial_transaction($1, 'Wrong account')`,
          [transfer[0].transaction_id]))));

    expect(results.filter((r) => r === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(source.id)).toBe(200_000);
    expect(await balanceOf(target.id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('concurrent stock movements', () => {
  it('cannot issue the same units twice', async () => {
    const item = await stockedItem(10);

    // Two people each try to issue 7 of the 10 in stock.
    const results = await settle([0, 1].map((i) =>
      committedAs(SEED.manager, (run) =>
        run.query(`select * from app.record_stock_movement($1, 'usage', 7, 'Used', $2)`,
          [item, requestId(`s${i}`)]))));

    expect(results.filter((r) => r === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r === 'rejected')).toHaveLength(1);
    expect(await quantityOf(item)).toBe(3);
  });

  it('lets exactly as many simultaneous issues succeed as there is stock', async () => {
    const item = await stockedItem(2);

    const results = await settle([0, 1, 2].map((i) =>
      committedAs(SEED.manager, (run) =>
        run.query(`select * from app.record_stock_movement($1, 'usage', 1, 'Used', $2)`,
          [item, requestId(`n${i}`)]))));

    expect(results.filter((r) => r === 'fulfilled')).toHaveLength(2);
    expect(await quantityOf(item)).toBe(0);
  });

  it('never lets a quantity go below zero under contention', async () => {
    const item = await stockedItem(5);

    await settle([3, 3, 3, 3].map((q, i) =>
      committedAs(SEED.manager, (run) =>
        run.query(`select * from app.record_stock_movement($1, 'usage', $2, 'Used', $3)`,
          [item, q, requestId(`z${i}`)]))));

    const quantity = await quantityOf(item);
    expect(quantity).toBeGreaterThanOrEqual(0);
    expect(quantity % 3).toBe(2);
  });

  it('receives a purchase once when two receipts race', async () => {
    const item = await stockedItem(0);
    const supplier = (await committedAs(null, (run) =>
      run.query(`select id from public.suppliers order by created_at desc limit 1`)))[0].id as string;
    const purchase = await committedAs(SEED.manager, (run) =>
      run.query(`select * from app.create_purchase($1, $2::jsonb, $3)`,
        [supplier, JSON.stringify([{ itemId: item, quantity: 8, unitCostUgx: 1000 }]), requestId('pur')]));

    const results = await settle([0, 1].map((i) =>
      committedAs(SEED.manager, (run) =>
        run.query(`select * from app.receive_purchase($1, $2)`,
          [purchase[0].purchase_id, requestId(`rec${i}`)]))));

    expect(results.filter((r) => r === 'fulfilled')).toHaveLength(1);
    expect(await quantityOf(item)).toBe(8);
  });
});
