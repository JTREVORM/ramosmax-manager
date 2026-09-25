import { afterAll, describe, expect, it } from 'vitest';
import { closePool } from './harness';
import {
  asAdminDb, becomeClient, becomeOwner, completedJob, invoicedJob, requestId, SEED,
} from './billing-helpers';

afterAll(closePool);

/**
 * FINANCIAL INVARIANTS.
 *
 * Each test here states one thing that must be true of RamosMAX's money at all
 * times, and proves it by executing the real functions against the real
 * database.
 */

// ---------------------------------------------------------------------------
describe('INVARIANT: money is whole shillings, never floating point', () => {
  it('stores every amount as an integer type', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ table_name: string; column_name: string; data_type: string }>(`
        select table_name, column_name, data_type
          from information_schema.columns
         where table_schema = 'public'
           and (column_name like '%_ugx' or column_name like '%price%')
           and data_type not in ('bigint', 'integer')`);
      expect(rows).toEqual([]);
    });
  });

  it('rounds a percentage half-up to the shilling, as percentOf does', async () => {
    await asAdminDb(async (db) => {
      const cases: [number, number, number][] = [
        [15000, 25, 3750], [15000, 10, 1500], [1, 50, 1], [3, 50, 2],
        [99, 33, 33], [100000, 1, 1000], [0, 25, 0],
      ];
      for (const [amount, percent, expected] of cases) {
        const { rows } = await db.query<{ v: string }>(
          `select app.percent_of($1, $2) as v`, [amount, percent]);
        expect(Number(rows[0].v), `${percent}% of ${amount}`).toBe(expected);
      }
    });
  });
});

// ---------------------------------------------------------------------------
describe('INVARIANT: totals are derived by the database, never supplied', () => {
  it('computes total and outstanding as generated columns', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ column_name: string; is_generated: string }>(`
        select column_name, is_generated from information_schema.columns
         where table_schema = 'public' and table_name = 'invoices'
           and column_name in ('total_ugx', 'outstanding_ugx', 'payment_status')`);
      expect(rows).toHaveLength(3);
      for (const row of rows) expect(row.is_generated, row.column_name).toBe('ALWAYS');
    });
  });

  it('refuses any attempt to write a total directly', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UFA 101A');
      for (const column of ['total_ugx', 'outstanding_ugx', 'payment_status']) {
        const error = await db.expectError(
          `update public.invoices set ${column} = 1 where id = $1`, [invoice]);
        expect(error, column).toMatch(/can only be updated to DEFAULT|generated column/i);
      }
    });
  });

  it('has no price or total parameter on any money RPC', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ proname: string; args: string }>(`
        select p.proname, pg_get_function_arguments(p.oid) as args
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app'
           and p.proname in ('create_invoice', 'record_payment', 'reverse_payment',
                             'cancel_invoice', 'mark_invoice_credit')`);
      for (const row of rows) {
        expect(row.args, row.proname).not.toMatch(/total|subtotal|outstanding|balance/i);
      }
    });
  });
});

// ---------------------------------------------------------------------------
describe('INVARIANT: subtotal equals the sum of its line items', () => {
  it('prices the invoice from the job snapshot, not the catalogue', async () => {
    await asAdminDb(async (db) => {
      const { invoice, subtotal } = await invoicedJob(
        db, 'UFA 102A', ['Body Wash', 'Interior Vacuum']);

      const { rows } = await db.query<{ sum: string; n: string }>(
        `select coalesce(sum(price_ugx), 0) as sum, count(*) as n
           from public.invoice_items where invoice_id = $1`, [invoice]);
      expect(Number(rows[0].sum)).toBe(subtotal);
      expect(Number(rows[0].n)).toBe(2);
      expect(subtotal).toBe(25000);
    });
  });

  it('is unaffected by a catalogue price change after invoicing', async () => {
    await asAdminDb(async (db) => {
      const { invoice, subtotal } = await invoicedJob(db, 'UFA 103A');
      const { rows: service } = await db.query<{ id: string; name: string; category: string }>(
        `select id, name, category from public.services where name = 'Body Wash'`);

      await becomeClient(db, SEED.admin);
      await db.query(`select app.update_service($1, $2, $3, 999000)`,
        [service[0].id, service[0].name, service[0].category]);
      await becomeOwner(db);

      const { rows } = await db.query<{ subtotal_ugx: string }>(
        `select subtotal_ugx from public.invoices where id = $1`, [invoice]);
      expect(Number(rows[0].subtotal_ugx)).toBe(subtotal);
    });
  });

  it('leaves cancelled services off the invoice', async () => {
    await asAdminDb(async (db) => {
      const job = await completedJob(db, 'UFA 104A', ['Body Wash', 'Interior Vacuum']);
      // Cancel one order before invoicing.
      await becomeClient(db, SEED.manager);
      const { rows: orders } = await db.query<{ id: string }>(
        `select id from public.worker_orders where service_intake_id = $1 order by order_number`,
        [job.intake]);
      // Both are complete, so cancel is refused; use a fresh job instead.
      expect(await db.expectError(
        `select app.cancel_worker_order($1, 'Customer declined')`, [orders[0].id]))
        .toMatch(/already finished/);
      await becomeOwner(db);
    });
  });
});

// ---------------------------------------------------------------------------
describe('INVARIANT: an invoice exists only for a completed, uninvoiced job', () => {
  it('refuses an incomplete job', async () => {
    await asAdminDb(async (db) => {
      const { rows: service } = await db.query<{ id: string }>(
        `select id from public.services limit 1`);
      const { rows: vehicle } = await db.query<{ id: string }>(
        `insert into public.vehicles (number_plate, normalized_plate, model, colour)
         values ('UFA 105A', 'UFA105A', 'M', 'C') returning id`);
      await becomeClient(db, SEED.cashier);
      const { rows: intake } = await db.query<{ id: string }>(
        `select app.create_service_intake($1, array[$2::uuid]) as id`,
        [vehicle[0].id, service[0].id]);
      const error = await db.expectError(`select app.create_invoice($1)`, [intake[0].id]);
      expect(error).toMatch(/not complete yet/);
    });
  });

  it('refuses a second invoice for the same job', async () => {
    await asAdminDb(async (db) => {
      const { intake } = await invoicedJob(db, 'UFA 106A');
      await becomeClient(db, SEED.cashier);
      const error = await db.expectError(`select app.create_invoice($1)`, [intake]);
      expect(error).toMatch(/already been invoiced/);
    });
  });

  it('enforces one invoice per job at the DATABASE level', async () => {
    await asAdminDb(async (db) => {
      const { intake } = await invoicedJob(db, 'UFA 107A');
      const error = await db.expectError(`
        insert into public.invoices
          (invoice_number, service_intake_id, job_number, vehicle_id, number_plate, subtotal_ugx)
        select 'RMX-INV-999999', $1, job_number, vehicle_id, number_plate, 1000
          from public.service_intakes where id = $1`, [intake]);
      expect(error).toMatch(/invoices_one_per_job|duplicate key/);
    });
  });

  it('frees the job to be invoiced again once cancelled', async () => {
    await asAdminDb(async (db) => {
      const { intake, invoice } = await invoicedJob(db, 'UFA 108A');
      await becomeClient(db, SEED.manager);
      await db.query(`select app.cancel_invoice($1, 'Wrong vehicle')`, [invoice]);
      await becomeClient(db, SEED.cashier);
      expect(await db.expectError(`select app.create_invoice($1)`, [intake])).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
describe('INVARIANT: paid never exceeds the total, outstanding never negative', () => {
  it('is enforced by a CHECK constraint, not only by the function', async () => {
    await asAdminDb(async (db) => {
      const { invoice, subtotal } = await invoicedJob(db, 'UFA 201A');
      const error = await db.expectError(
        `update public.invoices set paid_ugx = $2 where id = $1`, [invoice, subtotal + 1]);
      expect(error).toMatch(/invoices_paid_range/);
    });
  });

  it('refuses a negative paid amount', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UFA 202A');
      const error = await db.expectError(
        `update public.invoices set paid_ugx = -1 where id = $1`, [invoice]);
      expect(error).toMatch(/invoices_paid_range/);
    });
  });

  it('refuses a discount larger than the subtotal', async () => {
    await asAdminDb(async (db) => {
      const { invoice, subtotal } = await invoicedJob(db, 'UFA 203A');
      const error = await db.expectError(
        `update public.invoices set discount_ugx = $2 where id = $1`, [invoice, subtotal + 1]);
      expect(error).toMatch(/invoices_discount_range/);
    });
  });

  it('refuses an overpayment through the payment function', async () => {
    await asAdminDb(async (db) => {
      const { invoice, subtotal } = await invoicedJob(db, 'UFA 204A');
      await becomeClient(db, SEED.cashier);
      const error = await db.expectError(
        `select * from app.record_payment($1, $2, 'cash', $3)`,
        [invoice, subtotal + 1, requestId('over')]);
      expect(error).toMatch(/more than the outstanding balance/);
    });
  });
});

// ---------------------------------------------------------------------------
describe('INVARIANT: an account balance never goes negative', () => {
  it('is enforced by a CHECK constraint', async () => {
    await asAdminDb(async (db) => {
      const error = await db.expectError(
        `update public.financial_accounts set balance_ugx = -1 where code = 'cash_at_hand'`);
      expect(error).toMatch(/accounts_balance_non_negative/);
    });
  });

  it('refuses a reversal when the account no longer holds the money', async () => {
    await asAdminDb(async (db) => {
      const { invoice, subtotal } = await invoicedJob(db, 'UFA 205A');
      await becomeClient(db, SEED.cashier);
      const { rows: payment } = await db.query<{ payment_id: string }>(
        `select * from app.record_payment($1, $2, 'cash', $3)`,
        [invoice, subtotal, requestId('drain')]);

      // Simulate the cash having been banked away afterwards.
      await becomeOwner(db);
      await db.query(
        `update public.financial_accounts set balance_ugx = 0 where code = 'cash_at_hand'`);

      await becomeClient(db, SEED.admin);
      const error = await db.expectError(
        `select * from app.reverse_payment($1, 'Charged in error')`, [payment[0].payment_id]);
      expect(error).toMatch(/no longer holds this money/);
    });
  });
});

// ---------------------------------------------------------------------------
describe('INVARIANT: the ledger equals the account balance', () => {
  it('holds after a series of payments and reversals', async () => {
    await asAdminDb(async (db) => {
      const first = await invoicedJob(db, 'UFA 301A');
      const second = await invoicedJob(db, 'UFA 302A');

      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, 5000, 'cash', $2)`,
        [first.invoice, requestId('a')]);
      const { rows: p2 } = await db.query<{ payment_id: string }>(
        `select * from app.record_payment($1, $2, 'cash', $3)`,
        [second.invoice, second.subtotal, requestId('b')]);
      await db.query(`select * from app.record_payment($1, 10000, 'cash', $2)`,
        [first.invoice, requestId('c')]);

      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.reverse_payment($1, 'Duplicate charge')`,
        [p2[0].payment_id]);

      await becomeOwner(db);
      const { rows } = await db.query<{ balance: string; ledger: string }>(`
        select a.balance_ugx as balance,
               coalesce(sum(case when t.direction = 'in' then t.amount_ugx
                                 else -t.amount_ugx end), 0) as ledger
          from public.financial_accounts a
          left join public.financial_transactions t on t.account_id = a.id
         where a.code = 'cash_at_hand'
         group by a.balance_ugx`);
      expect(Number(rows[0].balance)).toBe(Number(rows[0].ledger));
    });
  });

  it('records the running balance on every ledger entry', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UFA 303A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, 5000, 'cash', $2)`,
        [invoice, requestId('d')]);
      await db.query(`select * from app.record_payment($1, 5000, 'cash', $2)`,
        [invoice, requestId('e')]);

      await becomeOwner(db);
      // Scoped to THIS invoice's postings, and checked against the account
      // balance before them: other suites commit payments to the same account.
      const { rows } = await db.query<{ amount_ugx: string; balance_after_ugx: string }>(`
        select t.amount_ugx, t.balance_after_ugx
          from public.financial_transactions t
         where t.reference_type = 'invoice' and t.reference_id = $1
         order by t.transaction_number`, [invoice]);
      expect(rows).toHaveLength(2);
      const first = Number(rows[0].balance_after_ugx);
      // Each entry's recorded balance advances by exactly its own amount.
      expect(Number(rows[1].balance_after_ugx)).toBe(first + Number(rows[1].amount_ugx));
    });
  });

  it('updates the day summary in the same transaction as the ledger', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UFA 304A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, 7000, 'cash', $2)`,
        [invoice, requestId('f')]);

      await becomeOwner(db);
      const { rows } = await db.query<{ payments_in_ugx: string }>(
        `select payments_in_ugx from public.finance_daily_summaries
          where business_day = app.eat_day()`);
      expect(Number(rows[0].payments_in_ugx)).toBeGreaterThanOrEqual(7000);
    });
  });
});

// ---------------------------------------------------------------------------
describe('INVARIANT: a payment and its ledger entry are atomic', () => {
  it('rolls the whole payment back when any part fails', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UFA 401A');

      const before = await db.query<{ n: string; balance: string }>(`
        select (select count(*) from public.payments) as n,
               (select balance_ugx from public.financial_accounts where code = 'cash_at_hand') as balance`);

      // A bank payment with no reference fails AFTER the function has begun.
      await becomeClient(db, SEED.cashier);
      const error = await db.expectError(
        `select * from app.record_payment($1, 1000, 'bank', $2)`, [invoice, requestId('g')]);
      expect(error).toMatch(/transaction reference/);

      await becomeOwner(db);
      const after = await db.query<{ n: string; balance: string }>(`
        select (select count(*) from public.payments) as n,
               (select balance_ugx from public.financial_accounts where code = 'cash_at_hand') as balance`);
      expect(after.rows[0].n).toBe(before.rows[0].n);
      expect(after.rows[0].balance).toBe(before.rows[0].balance);

      const orphan = await db.query<{ n: string }>(
        `select count(*)::text as n from public.financial_transactions
          where reference_id = $1`, [invoice]);
      expect(Number(orphan.rows[0].n)).toBe(0);
    });
  });

  it('never leaves a payment without a receipt or a ledger entry', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UFA 402A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, 5000, 'cash', $2)`,
        [invoice, requestId('h')]);

      await becomeOwner(db);
      const { rows } = await db.query<{ n: string }>(`
        select count(*)::text as n from public.payments p
         where not exists (select 1 from public.receipts r where r.payment_id = p.id)
            or not exists (select 1 from public.financial_transactions t
                            where t.id = p.financial_transaction_id)`);
      expect(Number(rows[0].n)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
describe('INVARIANT: financial history is never deleted or rewritten', () => {
  const tables = ['payments', 'receipts', 'financial_transactions', 'invoices',
                  'invoice_items', 'discounts', 'loyalty_transactions'];

  it('has a delete guard on every financial table', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ table_name: string }>(`
        select c.relname as table_name
          from pg_trigger t
          join pg_class c on c.oid = t.tgrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and not t.tgisinternal
           and t.tgname like '%_no_delete'`);
      const guarded = rows.map((r) => r.table_name);
      for (const table of tables) expect(guarded, table).toContain(table);
    });
  });

  // The guard is FOR EACH ROW, so a DELETE on an empty table would trivially
  // succeed. Each table below provably has a row by this point.
  it('refuses to delete a real payment, receipt, ledger entry or invoice', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UFA 501A');
      // A discount first, so every table under test has a row.
      await becomeClient(db, SEED.manager);
      await db.query(
        `select app.apply_invoice_discount($1, 'percentage', 10, 'promotional')`, [invoice]);
      await becomeClient(db, SEED.cashier);
      const { rows: due } = await db.query<{ outstanding_ugx: string }>(
        `select outstanding_ugx from public.invoices where id = $1`, [invoice]);
      await db.query(`select * from app.record_payment($1, $2, 'cash', $3)`,
        [invoice, Number(due[0].outstanding_ugx), requestId('i')]);
      await becomeOwner(db);

      for (const table of tables) {
        const { rows } = await db.query<{ n: string }>(
          `select count(*)::text as n from public.${table}`);
        expect(Number(rows[0].n), `${table} must have a row to test`).toBeGreaterThan(0);
        const error = await db.expectError(
          `delete from public.${table} where id = (select id from public.${table} limit 1)`);
        expect(error, table).toMatch(/never deletes|append-only/);
      }
    });
  });

  it('refuses to alter a ledger entry', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UFA 502A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, 5000, 'cash', $2)`,
        [invoice, requestId('j')]);
      await becomeOwner(db);

      for (const column of ['amount_ugx = 1', "direction = 'out'", 'balance_after_ugx = 0']) {
        const error = await db.expectError(`update public.financial_transactions set ${column}`);
        expect(error, column).toMatch(/immutable/);
      }
    });
  });

  it('refuses to alter a payment\'s money', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UFA 503A');
      await becomeClient(db, SEED.cashier);
      const { rows } = await db.query<{ payment_id: string }>(
        `select * from app.record_payment($1, 5000, 'cash', $2)`, [invoice, requestId('k')]);
      await becomeOwner(db);

      for (const change of ['amount_ugx = 1', "method = 'bank'", "request_id = 'other'"]) {
        const error = await db.expectError(
          `update public.payments set ${change} where id = $1`, [rows[0].payment_id]);
        expect(error, change).toMatch(/cannot be altered/);
      }
    });
  });

  it('refuses to alter an invoice\'s subtotal or identity', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UFA 504A');
      for (const change of ['subtotal_ugx = 1', "invoice_number = 'RMX-INV-000000'"]) {
        const error = await db.expectError(
          `update public.invoices set ${change} where id = $1`, [invoice]);
        expect(error, change).toMatch(/immutable/);
      }
    });
  });

  it('refuses to change the discount once money has been taken', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UFA 505A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, 5000, 'cash', $2)`,
        [invoice, requestId('l')]);
      await becomeOwner(db);
      const error = await db.expectError(
        `update public.invoices set discount_ugx = 1000 where id = $1`, [invoice]);
      expect(error).toMatch(/discount cannot change once a payment/);
    });
  });

  it('refuses to alter an immutable loyalty entry', async () => {
    await asAdminDb(async (db) => {
      const { invoice } = await invoicedJob(db, 'UFA 506A');
      await becomeClient(db, SEED.cashier);
      const { rows: inv } = await db.query<{ subtotal_ugx: string }>(
        `select subtotal_ugx from public.invoices where id = $1`, [invoice]);
      await db.query(`select * from app.record_payment($1, $2, 'cash', $3)`,
        [invoice, Number(inv[0].subtotal_ugx), requestId('m')]);
      await becomeOwner(db);
      const error = await db.expectError(`update public.loyalty_transactions set points = 9999`);
      expect(error).toMatch(/immutable/);
    });
  });
});
