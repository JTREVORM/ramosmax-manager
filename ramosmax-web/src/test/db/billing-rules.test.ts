import { afterAll, describe, expect, it } from 'vitest';
import { closePool } from './harness';
import {
  asAdminDb, becomeClient, becomeOwner, invoicedJob, requestId, SEED,
} from './billing-helpers';

afterAll(closePool);

// ---------------------------------------------------------------------------
describe('discounts', () => {
  it('applies a percentage, rounding half-up as the reference does', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHA 101A');
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ v: string }>(
        `select app.apply_invoice_discount($1, 'percentage', 10, 'promotional') as v`, [invoice]);
      expect(Number(rows[0].v)).toBe(1500);

      await becomeOwner(db);
      const { rows: inv } = await db.query<{ discount_ugx: string; total_ugx: string }>(
        `select discount_ugx, total_ugx from public.invoices where id = $1`, [invoice]);
      expect(Number(inv[0].discount_ugx)).toBe(1500);
      expect(Number(inv[0].total_ugx)).toBe(13500);
    });
  });

  it('applies a fixed amount', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHA 102A');
      await becomeClient(db, SEED.manager);
      await db.query(
        `select app.apply_invoice_discount($1, 'fixed', 2000, 'service_issue')`, [invoice]);
      await becomeOwner(db);
      const { rows } = await db.query<{ total_ugx: string }>(
        `select total_ugx from public.invoices where id = $1`, [invoice]);
      expect(Number(rows[0].total_ugx)).toBe(13000);
    });
  });

  it('records who approved it when the actor may approve', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHA 103A');
      await becomeClient(db, SEED.manager);
      await db.query(
        `select app.apply_invoice_discount($1, 'percentage', 10, 'promotional')`, [invoice]);
      await becomeOwner(db);
      const { rows } = await db.query<{ approved_by: string }>(
        `select approved_by from public.discounts where invoice_id = $1`, [invoice]);
      expect(rows[0].approved_by).toBe(SEED.manager);
    });
  });

  // The threshold is APPROVAL_THRESHOLD_PERCENT = 25 in billing.js.
  it('lets a cashier WITH discounts.apply give up to 25%', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHA 104A');
      await db.query(
        `update public.users set permissions = array['discounts.apply'] where id = $1`,
        [SEED.cashier]);
      await becomeClient(db, SEED.cashier);
      expect(await db.expectError(
        `select app.apply_invoice_discount($1, 'percentage', 25, 'promotional')`, [invoice]))
        .toBeNull();
    });
  });

  it('refuses a cashier ABOVE 25% with approval_required', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHA 105A');
      await db.query(
        `update public.users set permissions = array['discounts.apply'] where id = $1`,
        [SEED.cashier]);
      await becomeClient(db, SEED.cashier);
      const error = await db.expectError(
        `select app.apply_invoice_discount($1, 'percentage', 26, 'promotional')`, [invoice]);
      expect(error).toMatch(/need a manager's approval/);
    });
  });

  it('applies the threshold to the AMOUNT, so a large fixed discount is caught too', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHA 106A');
      await db.query(
        `update public.users set permissions = array['discounts.apply'] where id = $1`,
        [SEED.cashier]);
      await becomeClient(db, SEED.cashier);
      // 5,000 of 15,000 is 33%.
      const error = await db.expectError(
        `select app.apply_invoice_discount($1, 'fixed', 5000, 'promotional')`, [invoice]);
      expect(error).toMatch(/need a manager's approval/);
    });
  });

  it('refuses a cashier with NO discounts.apply at all', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHA 107A');
      await becomeClient(db, SEED.cashier);
      const error = await db.expectError(
        `select app.apply_invoice_discount($1, 'percentage', 5, 'promotional')`, [invoice]);
      expect(error).toMatch(/do not have permission/);
    });
  });

  it('requires a description when the reason is "other"', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHA 108A');
      await becomeClient(db, SEED.manager);
      expect(await db.expectError(
        `select app.apply_invoice_discount($1, 'percentage', 10, 'other')`, [invoice]))
        .toMatch(/Describe the reason/);
      expect(await db.expectError(
        `select app.apply_invoice_discount($1, 'percentage', 10, 'other', 'Goodwill')`, [invoice]))
        .toBeNull();
    });
  });

  it('refuses an invalid reason code', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHA 109A');
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select app.apply_invoice_discount($1, 'percentage', 10, 'because_i_said')`, [invoice]);
      expect(error).toMatch(/valid reason/);
    });
  });

  it('refuses a percentage outside 1..100 and a fixed above the subtotal', async () => {
    await asAdminDb(async (db) => {
      const { invoice, subtotal } = await invoicedJob(db, 'UHA 110A');
      await becomeClient(db, SEED.manager);
      expect(await db.expectError(
        `select app.apply_invoice_discount($1, 'percentage', 101, 'promotional')`, [invoice]))
        .toMatch(/between 1 and 100/);
      expect(await db.expectError(
        `select app.apply_invoice_discount($1, 'percentage', 0, 'promotional')`, [invoice]))
        .toMatch(/between 1 and 100/);
      expect(await db.expectError(
        `select app.apply_invoice_discount($1, 'fixed', $2, 'promotional')`, [invoice, subtotal + 1]))
        .toMatch(/more than the invoice subtotal/);
    });
  });

  it('allows only ONE discount per invoice', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHA 111A');
      await becomeClient(db, SEED.manager);
      await db.query(
        `select app.apply_invoice_discount($1, 'percentage', 10, 'promotional')`, [invoice]);
      const error = await db.expectError(
        `select app.apply_invoice_discount($1, 'percentage', 5, 'promotional')`, [invoice]);
      expect(error).toMatch(/already has a discount/);
    });
  });

  it('refuses a discount once a payment exists', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHA 112A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, 5000, 'cash', $2)`,
        [invoice, requestId('disc')]);
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select app.apply_invoice_discount($1, 'percentage', 10, 'promotional')`, [invoice]);
      expect(error).toMatch(/once a payment has been recorded/);
    });
  });
});

// ---------------------------------------------------------------------------
describe('partial payments', () => {
  it('walks unpaid -> partially_paid -> paid, with the server deriving each', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHB 201A');
      const status = async () => (await db.query<{ payment_status: string; outstanding_ugx: string }>(
        `select payment_status, outstanding_ugx from public.invoices where id = $1`, [invoice])).rows[0];

      expect((await status()).payment_status).toBe('unpaid');

      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, 5000, 'cash', $2)`,
        [invoice, requestId('p1')]);
      await becomeOwner(db);
      expect((await status()).payment_status).toBe('partially_paid');
      expect(Number((await status()).outstanding_ugx)).toBe(10000);

      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, 4000, 'cash', $2)`,
        [invoice, requestId('p2')]);
      await db.query(`select * from app.record_payment($1, 6000, 'cash', $2)`,
        [invoice, requestId('p3')]);
      await becomeOwner(db);
      expect((await status()).payment_status).toBe('paid');
      expect(Number((await status()).outstanding_ugx)).toBe(0);
    });
  });

  it('refuses a payment against an already-paid invoice', async () => {
    await asAdminDb(async (db) => {
      const { invoice, subtotal } = await invoicedJob(db, 'UHB 202A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, $2, 'cash', $3)`,
        [invoice, subtotal, requestId('full')]);
      const error = await db.expectError(
        `select * from app.record_payment($1, 1000, 'cash', $2)`, [invoice, requestId('extra')]);
      expect(error).toMatch(/already fully paid/);
    });
  });

  it('refuses a payment against a cancelled invoice', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHB 203A');
      await becomeClient(db, SEED.manager);
      await db.query(`select app.cancel_invoice($1, 'Wrong job')`, [invoice]);
      await becomeClient(db, SEED.cashier);
      const error = await db.expectError(
        `select * from app.record_payment($1, 1000, 'cash', $2)`, [invoice, requestId('canc')]);
      expect(error).toMatch(/was cancelled/);
    });
  });

  it('requires a reference for every method except cash', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHB 204A');
      await becomeClient(db, SEED.cashier);
      for (const method of ['mtn_merchant', 'airtel_merchant', 'bank']) {
        expect(await db.expectError(
          `select * from app.record_payment($1, 1000, $2, $3)`,
          [invoice, method, requestId(`ref-${method}`)]), method)
          .toMatch(/transaction reference/);
      }
      expect(await db.expectError(
        `select * from app.record_payment($1, 1000, 'cash', $2)`, [invoice, requestId('cash-ok')]))
        .toBeNull();
    });
  });

  it('posts each method to its own account', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHB 205A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, 5000, 'cash', $2)`,
        [invoice, requestId('m1')]);
      await db.query(`select * from app.record_payment($1, 5000, 'mtn_merchant', $2, 'MTN123')`,
        [invoice, requestId('m2')]);
      await db.query(`select * from app.record_payment($1, 5000, 'airtel_merchant', $2, 'AIR456')`,
        [invoice, requestId('m3')]);

      await becomeOwner(db);
      const { rows } = await db.query<{ method: string; code: string }>(`
        select p.method, a.code from public.payments p
          join public.financial_accounts a on a.id = p.financial_account_id
         where p.invoice_id = $1 order by p.created_at`, [invoice]);
      expect(rows.map((r) => [r.method, r.code])).toEqual([
        ['cash', 'cash_at_hand'],
        ['mtn_merchant', 'mtn_merchant'],
        ['airtel_merchant', 'airtel_merchant'],
      ]);
    });
  });

  it('issues a receipt carrying the full snapshot', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHB 206A');
      await becomeClient(db, SEED.cashier);
      const { rows } = await db.query<{ receipt_number: string }>(
        `select * from app.record_payment($1, 5000, 'cash', $2)`, [invoice, requestId('rcp')]);
      expect(String(rows[0].receipt_number)).toMatch(/^RMX-RCP-\d{6}$/);

      await becomeOwner(db);
      const { rows: receipt } = await db.query<{ snapshot: Record<string, unknown> }>(
        `select snapshot from public.receipts where receipt_number = $1`, [rows[0].receipt_number]);
      const snapshot = receipt[0].snapshot;
      expect(snapshot.businessName).toBe('RamosMAX Automotive Care (U) Ltd');
      expect(Number(snapshot.paymentUgx)).toBe(5000);
      expect(Number(snapshot.balanceUgx)).toBe(10000);
      expect(Array.isArray(snapshot.lines)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
describe('payment reversal', () => {
  it('keeps the payment, restores the balance and takes the money back out', async () => {
    await asAdminDb(async (db) => {
      const { invoice, subtotal } = await invoicedJob(db, 'UHC 301A');
      await becomeClient(db, SEED.cashier);
      const { rows: paid } = await db.query<{ payment_id: string }>(
        `select * from app.record_payment($1, $2, 'cash', $3)`,
        [invoice, subtotal, requestId('rev')]);

      await becomeOwner(db);
      const before = Number((await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where code = 'cash_at_hand'`))
        .rows[0].balance_ugx);

      await becomeClient(db, SEED.admin);
      const { rows: result } = await db.query<{ outstanding_ugx: string; payment_status: string }>(
        `select * from app.reverse_payment($1, 'Charged in error')`, [paid[0].payment_id]);
      expect(Number(result[0].outstanding_ugx)).toBe(subtotal);
      expect(result[0].payment_status).toBe('unpaid');

      await becomeOwner(db);
      const after = await db.query<{
        status: string; reversal_reason: string; balance: string; receipt_status: string;
      }>(`
        select p.status, p.reversal_reason,
               (select balance_ugx from public.financial_accounts where code = 'cash_at_hand') as balance,
               (select status from public.receipts where payment_id = p.id) as receipt_status
          from public.payments p where p.id = $1`, [paid[0].payment_id]);
      // The payment is KEPT.
      expect(after.rows[0].status).toBe('reversed');
      expect(after.rows[0].reversal_reason).toBe('Charged in error');
      expect(after.rows[0].receipt_status).toBe('reversed');
      expect(Number(after.rows[0].balance)).toBe(before - subtotal);
    });
  });

  it('writes a reversal ledger entry linked to the original', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHC 302A');
      await becomeClient(db, SEED.cashier);
      const { rows: paid } = await db.query<{ payment_id: string }>(
        `select * from app.record_payment($1, 5000, 'cash', $2)`, [invoice, requestId('rev2')]);
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.reverse_payment($1, 'Duplicate')`, [paid[0].payment_id]);

      await becomeOwner(db);
      const { rows } = await db.query<{ entry_type: string; direction: string; reverses_id: string }>(`
        select t.entry_type, t.direction, t.reverses_id
          from public.financial_transactions t
          join public.payments p on p.financial_transaction_id = t.reverses_id
         where p.id = $1`, [paid[0].payment_id]);
      expect(rows[0].entry_type).toBe('reversal');
      expect(rows[0].direction).toBe('out');
      expect(rows[0].reverses_id).not.toBeNull();
    });
  });

  it('requires a reason and cannot be done twice', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHC 303A');
      await becomeClient(db, SEED.cashier);
      const { rows: paid } = await db.query<{ payment_id: string }>(
        `select * from app.record_payment($1, 5000, 'cash', $2)`, [invoice, requestId('rev3')]);

      await becomeClient(db, SEED.admin);
      expect(await db.expectError(`select * from app.reverse_payment($1, '')`, [paid[0].payment_id]))
        .toMatch(/Enter a reason/);
      await db.query(`select * from app.reverse_payment($1, 'Charged in error')`,
        [paid[0].payment_id]);
      expect(await db.expectError(
        `select * from app.reverse_payment($1, 'Again')`, [paid[0].payment_id]))
        .toMatch(/already been reversed/);
    });
  });

  it('is refused to a manager or cashier: only payments.reverse may do it', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHC 304A');
      await becomeClient(db, SEED.cashier);
      const { rows: paid } = await db.query<{ payment_id: string }>(
        `select * from app.record_payment($1, 5000, 'cash', $2)`, [invoice, requestId('rev4')]);

      for (const role of ['cashier', 'manager'] as const) {
        await becomeClient(db, SEED[role]);
        expect(await db.expectError(
          `select * from app.reverse_payment($1, 'Trying it on')`, [paid[0].payment_id]), role)
          .toMatch(/do not have permission/);
      }
    });
  });

  it('lets an invoice be cancelled only after its payments are reversed', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHC 305A');
      await becomeClient(db, SEED.cashier);
      const { rows: paid } = await db.query<{ payment_id: string }>(
        `select * from app.record_payment($1, 5000, 'cash', $2)`, [invoice, requestId('rev5')]);

      await becomeClient(db, SEED.manager);
      expect(await db.expectError(`select app.cancel_invoice($1, 'Mistake')`, [invoice]))
        .toMatch(/Reverse this invoice's payments/);

      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.reverse_payment($1, 'Mistake')`, [paid[0].payment_id]);
      await becomeClient(db, SEED.manager);
      expect(await db.expectError(`select app.cancel_invoice($1, 'Mistake')`, [invoice])).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
describe('customer credit', () => {
  it('records money OWED without creating a payment or moving cash', async () => {
    await asAdminDb(async (db) => {
      const { invoice, subtotal } = await invoicedJob(db, 'UHD 401A');
      const before = Number((await db.query<{ balance_ugx: string }>(
        `select balance_ugx from public.financial_accounts where code = 'cash_at_hand'`))
        .rows[0].balance_ugx);

      await becomeClient(db, SEED.cashier);
      await db.query(`select app.mark_invoice_credit($1, 'Regular customer, will pay Friday')`,
        [invoice]);

      await becomeOwner(db);
      const { rows } = await db.query<{
        payment_status: string; outstanding_ugx: string; on_credit: boolean;
        payments: string; balance: string;
      }>(`
        select i.payment_status, i.outstanding_ugx, i.on_credit,
               (select count(*) from public.payments where invoice_id = i.id) as payments,
               (select balance_ugx from public.financial_accounts where code = 'cash_at_hand') as balance
          from public.invoices i where i.id = $1`, [invoice]);

      expect(rows[0].payment_status).toBe('credit');
      expect(rows[0].on_credit).toBe(true);
      expect(Number(rows[0].outstanding_ugx)).toBe(subtotal);
      // CREDIT IS NOT CASH: no payment, and no money moved.
      expect(Number(rows[0].payments)).toBe(0);
      expect(Number(rows[0].balance)).toBe(before);
    });
  });

  it('accepts payments against a credit invoice and closes it as paid', async () => {
    await asAdminDb(async (db) => {
      const { invoice, subtotal } = await invoicedJob(db, 'UHD 402A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select app.mark_invoice_credit($1, 'Will pay later')`, [invoice]);
      await db.query(`select * from app.record_payment($1, 5000, 'cash', $2)`,
        [invoice, requestId('cr1')]);

      await becomeOwner(db);
      // Still on credit while a balance remains.
      let status = (await db.query<{ payment_status: string }>(
        `select payment_status from public.invoices where id = $1`, [invoice])).rows[0];
      expect(status.payment_status).toBe('credit');

      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, $2, 'cash', $3)`,
        [invoice, subtotal - 5000, requestId('cr2')]);
      await becomeOwner(db);
      status = (await db.query<{ payment_status: string }>(
        `select payment_status from public.invoices where id = $1`, [invoice])).rows[0];
      expect(status.payment_status).toBe('paid');
    });
  });

  it('refuses credit on a fully paid or cancelled invoice', async () => {
    await asAdminDb(async (db) => {
      const { invoice, subtotal } = await invoicedJob(db, 'UHD 403A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, $2, 'cash', $3)`,
        [invoice, subtotal, requestId('cr3')]);
      expect(await db.expectError(`select app.mark_invoice_credit($1, 'Too late')`, [invoice]))
        .toMatch(/already fully paid/);
    });
  });

  it('requires a reason and refuses a caller without credit.manage', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UHD 404A');
      await becomeClient(db, SEED.cashier);
      expect(await db.expectError(`select app.mark_invoice_credit($1, '')`, [invoice]))
        .toMatch(/Enter a reason/);
      await becomeClient(db, SEED.worker);
      expect(await db.expectError(`select app.mark_invoice_credit($1, 'Trying')`, [invoice]))
        .toMatch(/do not have permission/);
    });
  });
});

// ---------------------------------------------------------------------------
describe('loyalty', () => {
  it('uses the reference defaults: 20 points, 200 threshold, 25% reward', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{
        points_per_service: number; reward_threshold: number; reward_percent: number;
        points_on_redemption: number; near_threshold: number;
      }>(`select * from app.loyalty_config()`);
      expect(rows[0]).toEqual({
        points_per_service: 20,
        reward_threshold: 200,
        reward_percent: 25,
        points_on_redemption: 200,
        near_threshold: 160,
      });
    });
  });

  it('earns only when the invoice becomes FULLY paid, and once', async () => {
    await asAdminDb(async (db) => {
      const { invoice, vehicle, subtotal } = await invoicedJob(db, 'UHE 501A');
      await becomeClient(db, SEED.cashier);

      await db.query(`select * from app.record_payment($1, 5000, 'cash', $2)`,
        [invoice, requestId('l1')]);
      await becomeOwner(db);
      let balance = (await db.query<{ points_balance: string }>(
        `select coalesce(points_balance, 0) as points_balance from public.loyalty_accounts
          where vehicle_id = $1`, [vehicle])).rows[0];
      expect(balance === undefined ? 0 : Number(balance.points_balance)).toBe(0);

      await becomeClient(db, SEED.cashier);
      const { rows } = await db.query<{ points_earned: number }>(
        `select * from app.record_payment($1, $2, 'cash', $3)`,
        [invoice, subtotal - 5000, requestId('l2')]);
      expect(Number(rows[0].points_earned)).toBe(20);

      await becomeOwner(db);
      balance = (await db.query<{ points_balance: string }>(
        `select points_balance from public.loyalty_accounts where vehicle_id = $1`, [vehicle])).rows[0];
      expect(Number(balance.points_balance)).toBe(20);

      const { rows: entries } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.loyalty_transactions
          where reference_id = $1 and type = 'earned'`, [invoice]);
      expect(Number(entries[0].n)).toBe(1);
    });
  });

  it('awards points per QUALIFYING line only', async () => {
    await asAdminDb(async (db) => {
      // Body Wash qualifies; Engine Wash does not.
      const { invoice, vehicle, subtotal } = await invoicedJob(
        db, 'UHE 502A', ['Body Wash', 'Engine Wash']);
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, $2, 'cash', $3)`,
        [invoice, subtotal, requestId('l3')]);
      await becomeOwner(db);
      const { rows } = await db.query<{ points_balance: string }>(
        `select points_balance from public.loyalty_accounts where vehicle_id = $1`, [vehicle]);
      expect(Number(rows[0].points_balance)).toBe(20);
    });
  });

  it('takes points back when the payment is reversed', async () => {
    await asAdminDb(async (db) => {
      const { invoice, vehicle, subtotal } = await invoicedJob(db, 'UHE 503A');
      await becomeClient(db, SEED.cashier);
      const { rows: paid } = await db.query<{ payment_id: string }>(
        `select * from app.record_payment($1, $2, 'cash', $3)`,
        [invoice, subtotal, requestId('l4')]);

      await becomeClient(db, SEED.admin);
      const { rows } = await db.query<{ points_removed: number }>(
        `select * from app.reverse_payment($1, 'Charged in error')`, [paid[0].payment_id]);
      expect(Number(rows[0].points_removed)).toBe(20);

      await becomeOwner(db);
      const { rows: balance } = await db.query<{ points_balance: string }>(
        `select points_balance from public.loyalty_accounts where vehicle_id = $1`, [vehicle]);
      expect(Number(balance[0].points_balance)).toBe(0);
    });
  });

  it('never lets the balance go below zero when points were already spent', async () => {
    await asAdminDb(async (db) => {
      const { invoice, vehicle, subtotal } = await invoicedJob(db, 'UHE 504A');
      await becomeClient(db, SEED.cashier);
      const { rows: paid } = await db.query<{ payment_id: string }>(
        `select * from app.record_payment($1, $2, 'cash', $3)`,
        [invoice, subtotal, requestId('l5')]);

      // Spend the points before the reversal.
      await becomeClient(db, SEED.manager);
      await db.query(`select app.adjust_loyalty_points($1, -20, 'Spent elsewhere')`, [vehicle]);

      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.reverse_payment($1, 'Charged in error')`,
        [paid[0].payment_id]);

      await becomeOwner(db);
      const { rows } = await db.query<{ points_balance: string }>(
        `select points_balance from public.loyalty_accounts where vehicle_id = $1`, [vehicle]);
      expect(Number(rows[0].points_balance)).toBe(0);
    });
  });

  it('keeps the ledger sum equal to the balance', async () => {
    await asAdminDb(async (db) => {
      const { invoice, vehicle, subtotal } = await invoicedJob(db, 'UHE 505A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, $2, 'cash', $3)`,
        [invoice, subtotal, requestId('l6')]);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.adjust_loyalty_points($1, 150, 'Goodwill')`, [vehicle]);
      await db.query(`select app.adjust_loyalty_points($1, -30, 'Correction')`, [vehicle]);

      await becomeOwner(db);
      const { rows } = await db.query<{ balance: string; ledger: string }>(`
        select a.points_balance as balance,
               (select coalesce(sum(points), 0) from public.loyalty_transactions
                 where vehicle_id = a.vehicle_id) as ledger
          from public.loyalty_accounts a where a.vehicle_id = $1`, [vehicle]);
      expect(Number(rows[0].balance)).toBe(Number(rows[0].ledger));
    });
  });

  it('unlocks one reward at the threshold and redeems it as a 25% discount', async () => {
    await asAdminDb(async (db) => {
      const { vehicle } = await invoicedJob(db, 'UHE 506A');
      await becomeClient(db, SEED.manager);
      await db.query(`select app.adjust_loyalty_points($1, 200, 'Reward test')`, [vehicle]);

      await becomeOwner(db);
      const { rows: reward } = await db.query<{ n: string; percent: number }>(`
        select count(*)::text as n, max(discount_percent) as percent
          from public.loyalty_rewards where vehicle_id = $1 and status = 'available'`, [vehicle]);
      expect(Number(reward[0].n)).toBe(1);
      expect(Number(reward[0].percent)).toBe(25);

      // A second crossing must NOT unlock a second reward.
      await becomeClient(db, SEED.manager);
      await db.query(`select app.adjust_loyalty_points($1, 200, 'More points')`, [vehicle]);
      await becomeOwner(db);
      const { rows: again } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.loyalty_rewards
          where vehicle_id = $1 and status = 'available'`, [vehicle]);
      expect(Number(again[0].n)).toBe(1);
    });
  });

  it('refuses a stale preview rather than charging a different amount', async () => {
    await asAdminDb(async (db) => {
      const { invoice, vehicle } = await invoicedJob(db, 'UHE 507A');
      await becomeClient(db, SEED.manager);
      await db.query(`select app.adjust_loyalty_points($1, 200, 'Reward test')`, [vehicle]);
      await becomeClient(db, SEED.cashier);
      const error = await db.expectError(
        `select app.apply_loyalty_reward($1, 9999)`, [invoice]);
      expect(error).toMatch(/is worth .* not 9999/);
    });
  });

  it('consumes the points and records the reward as a discount', async () => {
    await asAdminDb(async (db) => {
      const { invoice, vehicle } = await invoicedJob(db, 'UHE 508A');
      await becomeClient(db, SEED.manager);
      await db.query(`select app.adjust_loyalty_points($1, 200, 'Reward test')`, [vehicle]);
      await becomeClient(db, SEED.cashier);
      const { rows } = await db.query<{ v: string }>(
        `select app.apply_loyalty_reward($1, null) as v`, [invoice]);
      expect(Number(rows[0].v)).toBe(3750);

      await becomeOwner(db);
      const { rows: after } = await db.query<{
        discount_ugx: string; total_ugx: string; balance: string; reason_code: string;
      }>(`
        select i.discount_ugx, i.total_ugx,
               (select points_balance from public.loyalty_accounts where vehicle_id = $2) as balance,
               (select reason_code from public.discounts where invoice_id = i.id) as reason_code
          from public.invoices i where i.id = $1`, [invoice, vehicle]);
      expect(Number(after[0].discount_ugx)).toBe(3750);
      expect(Number(after[0].total_ugx)).toBe(11250);
      expect(Number(after[0].balance)).toBe(0);
      expect(after[0].reason_code).toBe('loyalty_reward');
    });
  });

  it('gives the reward back when its invoice is cancelled', async () => {
    await asAdminDb(async (db) => {
      const { invoice, vehicle } = await invoicedJob(db, 'UHE 509A');
      await becomeClient(db, SEED.manager);
      await db.query(`select app.adjust_loyalty_points($1, 200, 'Reward test')`, [vehicle]);
      await becomeClient(db, SEED.cashier);
      await db.query(`select app.apply_loyalty_reward($1, null)`, [invoice]);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.cancel_invoice($1, 'Customer changed their mind')`, [invoice]);

      await becomeOwner(db);
      const { rows } = await db.query<{ balance: string; available: string; reversed: string }>(`
        select (select points_balance from public.loyalty_accounts where vehicle_id = $1) as balance,
               (select count(*) from public.loyalty_rewards
                 where vehicle_id = $1 and status = 'available') as available,
               (select count(*) from public.loyalty_rewards
                 where vehicle_id = $1 and status = 'reversed') as reversed`, [vehicle]);
      expect(Number(rows[0].balance)).toBe(200);
      expect(Number(rows[0].reversed)).toBe(1);
      // A fresh reward unlocks because the balance allows it again.
      expect(Number(rows[0].available)).toBe(1);
    });
  });

  it('caps an adjustment at 10,000 points and requires a reason', async () => {
    await asAdminDb(async (db) => {
      const { vehicle } = await invoicedJob(db, 'UHE 510A');
      await becomeClient(db, SEED.manager);
      expect(await db.expectError(
        `select app.adjust_loyalty_points($1, 10001, 'Too many')`, [vehicle]))
        .toMatch(/up to 10,000 points/);
      expect(await db.expectError(`select app.adjust_loyalty_points($1, 50, '')`, [vehicle]))
        .toMatch(/Enter a reason/);
    });
  });

  it('reverses a ledger entry once and never twice', async () => {
    await asAdminDb(async (db) => {
      const { vehicle } = await invoicedJob(db, 'UHE 511A');
      await becomeClient(db, SEED.manager);
      await db.query(`select app.adjust_loyalty_points($1, 100, 'Goodwill')`, [vehicle]);
      await becomeOwner(db);
      const { rows: entry } = await db.query<{ id: string }>(
        `select id from public.loyalty_transactions where vehicle_id = $1 and type = 'adjustment'`,
        [vehicle]);

      await becomeClient(db, SEED.manager);
      await db.query(`select app.reverse_loyalty_transaction($1, 'Applied to the wrong vehicle')`,
        [entry[0].id]);
      expect(await db.expectError(
        `select app.reverse_loyalty_transaction($1, 'Again')`, [entry[0].id]))
        .toMatch(/already been reversed/);

      await becomeOwner(db);
      const { rows } = await db.query<{ points_balance: string }>(
        `select points_balance from public.loyalty_accounts where vehicle_id = $1`, [vehicle]);
      expect(Number(rows[0].points_balance)).toBe(0);
    });
  });

  it('refuses loyalty adjustment to anyone without loyalty.adjust', async () => {
    await asAdminDb(async (db) => {
      const { vehicle } = await invoicedJob(db, 'UHE 512A');
      for (const role of ['cashier', 'worker', 'auditor'] as const) {
        await becomeClient(db, SEED[role]);
        expect(await db.expectError(
          `select app.adjust_loyalty_points($1, 10, 'Trying')`, [vehicle]), role)
          .toMatch(/do not have permission/);
      }
    });
  });
});
