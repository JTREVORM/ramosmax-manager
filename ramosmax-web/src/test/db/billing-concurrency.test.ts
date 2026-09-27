import { afterAll, describe, expect, it } from 'vitest';
import { closePool, getPool, SEED } from './harness';
import { asAdminDb, requestId } from './billing-helpers';

afterAll(closePool);

/**
 * IDEMPOTENCY AND CONCURRENCY.
 *
 * These are the only tests that commit. Everywhere else the harness rolls
 * back, but proving that two SIMULTANEOUS transactions cannot double-spend
 * requires them to be real, separate, committing transactions.
 *
 * Each test cleans up after itself by using a unique vehicle plate, and
 * asserts against its own records only.
 */

/**
 * A fresh, valid Ugandan plate per call. These tests COMMIT, so a fixed
 * sequence would collide with the previous run's rows on the unique plate
 * index.
 */
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const letter = () => LETTERS[Math.floor(Math.random() * LETTERS.length)];
const nextPlate = () =>
  `U${letter()}${letter()} ${String(Math.floor(Math.random() * 900) + 100)}${letter()}`;

/** Runs `fn` in its own committed transaction as `uid`. */
async function committedAs<T>(uid: string, fn: (run: Runner) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query(
      `set local request.jwt.claims = '${JSON.stringify({ sub: uid, role: 'authenticated' })}'`);
    await client.query('set local role authenticated');
    const runner: Runner = {
      query: async (sql, params) => (await client.query(sql, params as never)).rows,
    };
    const result = await fn(runner);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

interface Runner {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/**
 * Sets up a COMMITTED, invoiced job. Unlike the rolled-back harness, these
 * records must survive the transaction so parallel connections can contend
 * for them.
 */
async function committedInvoice(services: string[] = ['Body Wash'], plate = nextPlate()) {
  const client = await getPool().connect();
  const as = async (uid: string | null) => {
    if (uid === null) {
      await client.query('reset role');
      return;
    }
    await client.query(
      `set request.jwt.claims = '${JSON.stringify({ sub: uid, role: 'authenticated' })}'`);
    await client.query('set role authenticated');
  };
  const q = async <T>(sql: string, params: unknown[] = []) =>
    (await client.query(sql, params as never)).rows as T[];

  try {
    const serviceRows = await q<{ id: string }>(
      `select id from public.services where name = any($1) order by name`, [services]);
    const vehicle = (await q<{ id: string }>(
      `insert into public.vehicles (number_plate, normalized_plate, model, colour, customer_id)
       values ($1, app.plate_key($1), 'Model', 'Colour',
               (select id from public.customers order by customer_number limit 1))
       returning id`, [plate]))[0].id;

    const invoice = await invoiceOneJob(vehicle);
    const subtotal = Number((await q<{ subtotal_ugx: string }>(
      `select subtotal_ugx from public.invoices where id = $1`, [invoice]))[0].subtotal_ugx);
    return { vehicle, invoice, subtotal };

    /** One complete job on `v`, invoiced, returning the invoice id. */
    async function invoiceOneJob(v: string): Promise<string> {
      await as(SEED.cashier);
      const intake = (await q<{ id: string }>(
        `select app.create_service_intake($1, $2::uuid[]) as id`,
        [v, serviceRows.map((r) => r.id)]))[0].id;

      await as(null);
      const orders = await q<{ id: string }>(
        `select id from public.worker_orders where service_intake_id = $1`, [intake]);

      await as(SEED.manager);
      for (const order of orders) {
        await q(`select app.assign_worker_order($1, $2)`, [order.id, SEED.worker]);
      }
      await as(SEED.worker);
      for (const order of orders) {
        for (const action of ['accept', 'start', 'complete']) {
          await q(`select app.update_worker_order_status($1, $2)`, [order.id, action]);
        }
      }
      await as(SEED.cashier);
      const id = (await q<{ id: string }>(`select app.create_invoice($1) as id`, [intake]))[0].id;
      await as(null);
      return id;
    }
  } finally {
    await client.query('reset role').catch(() => {});
    client.release();
  }
}

/** A second invoiced job on an EXISTING vehicle, once the first is closed. */
async function secondInvoiceForVehicle(vehicle: string): Promise<string> {
  const client = await getPool().connect();
  const as = async (uid: string | null) => {
    if (uid === null) { await client.query('reset role'); return; }
    await client.query(
      `set request.jwt.claims = '${JSON.stringify({ sub: uid, role: 'authenticated' })}'`);
    await client.query('set role authenticated');
  };
  const q = async <T>(sql: string, params: unknown[] = []) =>
    (await client.query(sql, params as never)).rows as T[];
  try {
    const service = (await q<{ id: string }>(
      `select id from public.services where name = 'Body Wash'`))[0].id;
    await as(SEED.cashier);
    const intake = (await q<{ id: string }>(
      `select app.create_service_intake($1, array[$2::uuid]) as id`, [vehicle, service]))[0].id;
    await as(null);
    const orders = await q<{ id: string }>(
      `select id from public.worker_orders where service_intake_id = $1`, [intake]);
    await as(SEED.manager);
    await q(`select app.assign_worker_order($1, $2)`, [orders[0].id, SEED.worker]);
    await as(SEED.worker);
    for (const action of ['accept', 'start', 'complete']) {
      await q(`select app.update_worker_order_status($1, $2)`, [orders[0].id, action]);
    }
    await as(SEED.cashier);
    const id = (await q<{ id: string }>(`select app.create_invoice($1) as id`, [intake]))[0].id;
    await as(null);
    return id;
  } finally {
    await client.query('reset role').catch(() => {});
    client.release();
  }
}

// ---------------------------------------------------------------------------
describe('idempotency', () => {
  it('records ONE payment for a repeated request id', async () => {
    const { invoice } = await committedInvoice();
    const id = requestId('idem-repeat');

    const first = await committedAs(SEED.cashier, (run) =>
      run.query(`select * from app.record_payment($1, 5000, 'cash', $2)`, [invoice, id]));
    const second = await committedAs(SEED.cashier, (run) =>
      run.query(`select * from app.record_payment($1, 5000, 'cash', $2)`, [invoice, id]));

    // The retry returns the ORIGINAL result, not a new payment.
    expect(second[0].payment_id).toBe(first[0].payment_id);
    expect(second[0].receipt_number).toBe(first[0].receipt_number);

    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.payments where invoice_id = $1`, [invoice]);
      expect(Number(rows[0].n)).toBe(1);

      const { rows: paid } = await db.query<{ paid_ugx: string }>(
        `select paid_ugx from public.invoices where id = $1`, [invoice]);
      expect(Number(paid[0].paid_ugx)).toBe(5000);
    });
  });

  it('issues ONE receipt and ONE ledger entry for a repeated request', async () => {
    const { invoice } = await committedInvoice();
    const id = requestId('idem-single');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await committedAs(SEED.cashier, (run) =>
        run.query(`select * from app.record_payment($1, 5000, 'cash', $2)`, [invoice, id]));
    }

    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ payments: string; receipts: string; ledger: string }>(`
        select (select count(*) from public.payments where invoice_id = $1)  as payments,
               (select count(*) from public.receipts where invoice_id = $1)  as receipts,
               (select count(*) from public.financial_transactions
                 where reference_type = 'invoice' and reference_id = $1)     as ledger`, [invoice]);
      expect(Number(rows[0].payments)).toBe(1);
      expect(Number(rows[0].receipts)).toBe(1);
      expect(Number(rows[0].ledger)).toBe(1);
    });
  });

  it('refuses the same request id with a DIFFERENT payload', async () => {
    const { invoice } = await committedInvoice();
    const id = requestId('idem-conflict');

    await committedAs(SEED.cashier, (run) =>
      run.query(`select * from app.record_payment($1, 5000, 'cash', $2)`, [invoice, id]));

    await expect(
      committedAs(SEED.cashier, (run) =>
        run.query(`select * from app.record_payment($1, 9000, 'cash', $2)`, [invoice, id])),
    ).rejects.toThrow(/already used for a different request/);
  });

  it('treats DIFFERENT request ids as separate payments', async () => {
    const { invoice } = await committedInvoice();
    for (const label of ['a', 'b']) {
      await committedAs(SEED.cashier, (run) =>
        run.query(`select * from app.record_payment($1, 5000, 'cash', $2)`,
          [invoice, requestId(`idem-sep-${label}`)]));
    }
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ n: string; paid: string }>(`
        select (select count(*) from public.payments where invoice_id = $1) as n,
               (select paid_ugx from public.invoices where id = $1) as paid`, [invoice]);
      expect(Number(rows[0].n)).toBe(2);
      expect(Number(rows[0].paid)).toBe(10000);
    });
  });

  it('requires a request id at all', async () => {
    const { invoice } = await committedInvoice();
    await expect(
      committedAs(SEED.cashier, (run) =>
        run.query(`select * from app.record_payment($1, 5000, 'cash', '')`, [invoice])),
    ).rejects.toThrow(/request id is required/);
  });

  it('survives SIMULTANEOUS duplicates of one request id', async () => {
    const { invoice } = await committedInvoice();
    const id = requestId('idem-parallel');

    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        committedAs(SEED.cashier, (run) =>
          run.query(`select * from app.record_payment($1, 5000, 'cash', $2)`, [invoice, id]))),
    );

    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ payments: string; paid: string; ledger: string }>(`
        select (select count(*) from public.payments where invoice_id = $1) as payments,
               (select paid_ugx from public.invoices where id = $1)         as paid,
               (select count(*) from public.financial_transactions
                 where reference_type = 'invoice' and reference_id = $1)    as ledger`, [invoice]);
      // The decisive assertion: one logical request, one payment, one posting.
      expect(Number(rows[0].payments)).toBe(1);
      expect(Number(rows[0].paid)).toBe(5000);
      expect(Number(rows[0].ledger)).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
describe('concurrent payments against one balance', () => {
  it('never lets simultaneous payments exceed the outstanding amount', async () => {
    // A UGX 15,000 invoice and four concurrent UGX 5,000 payments: exactly
    // three must succeed. This is the case functions/test/billing.test.js runs.
    const { invoice, subtotal } = await committedInvoice(['Body Wash']);
    expect(subtotal).toBe(15000);

    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        committedAs(SEED.cashier, (run) =>
          run.query(`select * from app.record_payment($1, 5000, 'cash', $2)`,
            [invoice, requestId(`race-${i}`)]))),
    );

    const succeeded = attempts.filter((a) => a.status === 'fulfilled').length;
    expect(succeeded).toBe(3);

    await asAdminDb(async (db) => {
      const { rows } = await db.query<{
        paid: string; outstanding: string; status: string; n: string;
      }>(`
        select i.paid_ugx as paid, i.outstanding_ugx as outstanding, i.payment_status as status,
               (select count(*) from public.payments p
                 where p.invoice_id = i.id and p.status = 'active') as n
          from public.invoices i where i.id = $1`, [invoice]);
      expect(Number(rows[0].paid)).toBe(15000);
      expect(Number(rows[0].outstanding)).toBe(0);
      expect(rows[0].status).toBe('paid');
      expect(Number(rows[0].n)).toBe(3);
    });
  });

  it('lets only one of two simultaneous FINAL payments succeed', async () => {
    const { invoice, subtotal } = await committedInvoice();

    const attempts = await Promise.allSettled([
      committedAs(SEED.cashier, (run) =>
        run.query(`select * from app.record_payment($1, $2, 'cash', $3)`,
          [invoice, subtotal, requestId('final-a')])),
      committedAs(SEED.admin, (run) =>
        run.query(`select * from app.record_payment($1, $2, 'cash', $3)`,
          [invoice, subtotal, requestId('final-b')])),
    ]);

    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);

    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ paid: string; n: string }>(`
        select i.paid_ugx as paid,
               (select count(*) from public.payments p where p.invoice_id = i.id) as n
          from public.invoices i where i.id = $1`, [invoice]);
      expect(Number(rows[0].paid)).toBe(subtotal);
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  it('awards loyalty exactly once under concurrent final payments', async () => {
    const { invoice, vehicle, subtotal } = await committedInvoice();

    await Promise.allSettled([
      committedAs(SEED.cashier, (run) =>
        run.query(`select * from app.record_payment($1, $2, 'cash', $3)`,
          [invoice, subtotal, requestId('loy-a')])),
      committedAs(SEED.admin, (run) =>
        run.query(`select * from app.record_payment($1, $2, 'cash', $3)`,
          [invoice, subtotal, requestId('loy-b')])),
    ]);

    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ earned: string; balance: string }>(`
        select (select count(*) from public.loyalty_transactions
                 where reference_id = $1 and type = 'earned') as earned,
               (select points_balance from public.loyalty_accounts where vehicle_id = $2) as balance`,
        [invoice, vehicle]);
      expect(Number(rows[0].earned)).toBe(1);
      // Body Wash qualifies: 1 line x 20 points.
      expect(Number(rows[0].balance)).toBe(20);
    });
  });
});

// ---------------------------------------------------------------------------
describe('concurrent reversals', () => {
  it('lets only one of two simultaneous reversals succeed', async () => {
    const { invoice, subtotal } = await committedInvoice();
    const [payment] = await committedAs(SEED.cashier, (run) =>
      run.query(`select * from app.record_payment($1, $2, 'cash', $3)`,
        [invoice, subtotal, requestId('rev-setup')]));

    const attempts = await Promise.allSettled([
      committedAs(SEED.admin, (run) =>
        run.query(`select * from app.reverse_payment($1, 'Charged in error')`,
          [payment.payment_id])),
      committedAs(SEED.admin, (run) =>
        run.query(`select * from app.reverse_payment($1, 'Charged in error')`,
          [payment.payment_id])),
    ]);

    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);

    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ n: string; paid: string }>(`
        select (select count(*) from public.financial_transactions
                 where reverses_id = (select financial_transaction_id from public.payments
                                       where id = $1)) as n,
               (select paid_ugx from public.invoices where id = $2) as paid`,
        [payment.payment_id, invoice]);
      // Exactly one reversal posting, and the balance came back once.
      expect(Number(rows[0].n)).toBe(1);
      expect(Number(rows[0].paid)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
describe('concurrent loyalty redemption', () => {
  it('redeems ONE reward on only one of two invoices for the same vehicle', async () => {
    // Both invoices belong to the SAME vehicle, so both see the same single
    // available reward and must contend for it.
    const first = await committedInvoice();
    const second = await secondInvoiceForVehicle(first.vehicle);

    await committedAs(SEED.admin, (run) =>
      run.query(`select app.adjust_loyalty_points($1, 200, 'Concurrency test setup')`,
        [first.vehicle]));

    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.loyalty_rewards
          where vehicle_id = $1 and status = 'available'`, [first.vehicle]);
      expect(Number(rows[0].n), 'exactly one reward is available').toBe(1);
    });

    const attempts = await Promise.allSettled([
      committedAs(SEED.cashier, (run) =>
        run.query(`select app.apply_loyalty_reward($1, null)`, [first.invoice])),
      committedAs(SEED.cashier, (run) =>
        run.query(`select app.apply_loyalty_reward($1, null)`, [second])),
    ]);

    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);

    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ redeemed: string; available: string; balance: string }>(`
        select (select count(*) from public.loyalty_rewards
                 where vehicle_id = $1 and status = 'redeemed')  as redeemed,
               (select count(*) from public.loyalty_rewards
                 where vehicle_id = $1 and status = 'available') as available,
               (select points_balance from public.loyalty_accounts where vehicle_id = $1) as balance`,
        [first.vehicle]);
      expect(Number(rows[0].redeemed)).toBe(1);
      expect(Number(rows[0].available)).toBe(0);
      // 200 earned, 200 consumed: the points were spent exactly once.
      expect(Number(rows[0].balance)).toBe(0);
    });
  });
});
