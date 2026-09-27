import { afterAll, describe, expect, it } from 'vitest';
import { closePool } from './harness';
import {
  accountId, approvedExpense, asAdminDb, awaitingOf, balanceOf, becomeClient, becomeOwner,
  fund, ledgerDisagreements, requestId, SEED, snapshot,
} from './finance-helpers';

afterAll(closePool);

// ---------------------------------------------------------------------------
describe('INVARIANT: an account balance equals the sum of its ledger movements', () => {
  it('holds across payments, opening balances, transfers, deposits and adjustments', async () => {
    await asAdminDb(async (db) => {
      const before = await snapshot(db);
      const cash = await accountId(db, 'cash_at_hand');
      const bank = await accountId(db, 'stanbic_main');
      await fund(db, 'cash_at_hand', 1_000_000);

      await becomeClient(db, SEED.manager);
      await db.query(`select * from app.transfer_funds($1, $2, 200000, 'Banking', $3)`,
        [cash, bank, requestId('t')]);
      await db.query(`select * from app.record_bank_deposit($1, $2, 150000, 'SLIP-1', $3)`,
        [cash, bank, requestId('d')]);

      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.record_account_adjustment($1, 'out', 50000, 'Counted short', $2)`,
        [cash, requestId('a')]);

      await becomeOwner(db);
      expect(await ledgerDisagreements(db)).toEqual([]);
      // +1,000,000 opening − 200,000 transferred − 150,000 deposited − 50,000 adjusted
      expect(await balanceOf(db, 'cash_at_hand') - before.cash_at_hand.balance).toBe(600_000);
      expect(await balanceOf(db, 'stanbic_main') - before.stanbic_main.balance).toBe(350_000);
    });
  });

  it('records the balance after the movement on BOTH sides of a transfer', async () => {
    await asAdminDb(async (db) => {
      const before = await snapshot(db);
      const cash = await accountId(db, 'cash_at_hand');
      const bank = await accountId(db, 'stanbic_main');
      await fund(db, 'cash_at_hand', 500_000);

      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ transaction_id: string }>(
        `select * from app.transfer_funds($1, $2, 120000, 'Banking', $3)`,
        [cash, bank, requestId('t')]);

      await becomeOwner(db);
      const { rows: entries } = await db.query<{ delta_ugx: string; balance_after_ugx: string; code: string }>(
        `select e.delta_ugx, e.balance_after_ugx, a.code
           from public.financial_transaction_entries e
           join public.financial_accounts a on a.id = e.account_id
          where e.transaction_id = $1 order by e.delta_ugx`,
        [rows[0].transaction_id]);

      expect(entries).toHaveLength(2);
      expect(Number(entries[0].delta_ugx)).toBe(-120_000);
      expect(Number(entries[0].balance_after_ugx)).toBe(before.cash_at_hand.balance + 380_000);
      expect(Number(entries[1].delta_ugx)).toBe(120_000);
      expect(Number(entries[1].balance_after_ugx)).toBe(before.stanbic_main.balance + 120_000);
    });
  });

  it('gives one transaction number to a transfer, not two', async () => {
    await asAdminDb(async (db) => {
      const cash = await accountId(db, 'cash_at_hand');
      const bank = await accountId(db, 'stanbic_main');
      await fund(db, 'cash_at_hand', 300_000);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ transaction_number: string }>(
        `select * from app.transfer_funds($1, $2, 100000, 'Banking', $3)`,
        [cash, bank, requestId('t')]);
      expect(rows[0].transaction_number).toMatch(/^RMX-TXN-\d{6}$/);

      await becomeOwner(db);
      const { rows: count } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.financial_transactions
          where transaction_number = $1`, [rows[0].transaction_number]);
      expect(Number(count[0].n)).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
describe('INVARIANT: there is no overdraft', () => {
  it('refuses a transfer larger than the balance, and moves nothing', async () => {
    await asAdminDb(async (db) => {
      const before = await snapshot(db);
      const cash = await accountId(db, 'cash_at_hand');
      const bank = await accountId(db, 'stanbic_main');
      await fund(db, 'cash_at_hand', 100_000);
      const funded = before.cash_at_hand.balance + 100_000;

      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.transfer_funds($1, $2, $3, 'Too much', $4)`,
        [cash, bank, funded + 1, requestId('t')]);
      expect(error).toMatch(/available/i);

      await becomeOwner(db);
      expect(await balanceOf(db, 'cash_at_hand')).toBe(funded);
      expect(await balanceOf(db, 'stanbic_main')).toBe(before.stanbic_main.balance);
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });

  it('refuses an expense payment above the balance, leaving the expense approved', async () => {
    await asAdminDb(async (db) => {
      const before = await snapshot(db);
      const cash = await accountId(db, 'cash_at_hand');
      const expense = await approvedExpense(db, before.cash_at_hand.balance + 1);

      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.pay_expense($1, $2, $3)`, [expense, cash, requestId('p')]);
      expect(error).toMatch(/available/i);

      await becomeOwner(db);
      const { rows } = await db.query<{ status: string }>(
        `select status from public.expenses where id = $1`, [expense]);
      expect(rows[0].status).toBe('approved');
      expect(await balanceOf(db, 'cash_at_hand')).toBe(before.cash_at_hand.balance);
    });
  });

  it('is enforced by a CHECK constraint on the account itself', async () => {
    await asAdminDb(async (db) => {
      const error = await db.expectError(
        `update public.financial_accounts set balance_ugx = -1 where code = 'cash_at_hand'`);
      expect(error).toMatch(/accounts_balance_non_negative/);
    });
  });
});

// ---------------------------------------------------------------------------
describe('INVARIANT: a transfer is atomic', () => {
  it('leaves nothing behind when the destination is inactive', async () => {
    await asAdminDb(async (db) => {
      const before = await snapshot(db);
      const cash = await accountId(db, 'cash_at_hand');
      await fund(db, 'cash_at_hand', 400_000);

      await becomeClient(db, SEED.admin);
      const { rows: created } = await db.query<{ id: string }>(
        `select app.create_financial_account('Closed Bank', 'bank', 'Test Bank') as id`);
      await db.query(`select app.update_financial_account($1, null, null, null, null, false, 'Not in use')`,
        [created[0].id]);

      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.transfer_funds($1, $2, 100000, 'Move it', $3)`,
        [cash, created[0].id, requestId('t')]);
      expect(error).toMatch(/inactive/i);

      await becomeOwner(db);
      expect(await balanceOf(db, 'cash_at_hand')).toBe(before.cash_at_hand.balance + 400_000);
      const { rows: entries } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.financial_transactions
          where destination_account_id = $1`, [created[0].id]);
      expect(Number(entries[0].n)).toBe(0);
    });
  });

  it('refuses a transfer to the same account', async () => {
    await asAdminDb(async (db) => {
      const cash = await accountId(db, 'cash_at_hand');
      await fund(db, 'cash_at_hand', 100_000);
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.transfer_funds($1, $1, 10000, 'Nowhere', $2)`, [cash, requestId('t')]);
      expect(error).toMatch(/different accounts/i);
    });
  });

  it('refuses a future-dated transfer', async () => {
    await asAdminDb(async (db) => {
      const cash = await accountId(db, 'cash_at_hand');
      const bank = await accountId(db, 'stanbic_main');
      await fund(db, 'cash_at_hand', 100_000);
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.transfer_funds($1, $2, 10000, 'Later', $3, current_date + 1)`,
        [cash, bank, requestId('t')]);
      expect(error).toMatch(/cannot be in the future/i);
    });
  });
});

// ---------------------------------------------------------------------------
describe('cash awaiting banking', () => {
  it('grows with cash takings and shrinks when the cash is banked', async () => {
    await asAdminDb(async (db) => {
      const { invoicedJob } = await import('./billing-helpers');
      const before = await snapshot(db);
      const cash = await accountId(db, 'cash_at_hand');
      const bank = await accountId(db, 'stanbic_main');

      const job = await invoicedJob(db, 'UGA 811A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, $2, 'cash', $3)`,
        [job.invoice, job.subtotal, requestId('pay')]);

      await becomeOwner(db);
      expect(await awaitingOf(db, 'cash_at_hand') - before.cash_at_hand.awaiting).toBe(job.subtotal);

      await becomeClient(db, SEED.manager);
      await db.query(`select * from app.record_bank_deposit($1, $2, $3, 'SLIP-9', $4)`,
        [cash, bank, job.subtotal, requestId('d')]);

      await becomeOwner(db);
      // The takings have gone to the bank; anything waiting before this test
      // was deposited with them.
      expect(await awaitingOf(db, 'cash_at_hand')).toBe(
        Math.max(0, before.cash_at_hand.awaiting - 0));
      expect(await balanceOf(db, 'stanbic_main') - before.stanbic_main.balance).toBe(job.subtotal);
    });
  });

  it('does not count an opening float as takings', async () => {
    await asAdminDb(async (db) => {
      const before = await snapshot(db);
      await fund(db, 'cash_at_hand', 750_000);
      // The float raises the balance and NOT the amount waiting to be banked.
      expect(await awaitingOf(db, 'cash_at_hand')).toBe(before.cash_at_hand.awaiting);
      expect(await balanceOf(db, 'cash_at_hand') - before.cash_at_hand.balance).toBe(750_000);
    });
  });

  it('comes back when a deposit is reversed', async () => {
    await asAdminDb(async (db) => {
      const { invoicedJob } = await import('./billing-helpers');
      const before = await snapshot(db);
      const cash = await accountId(db, 'cash_at_hand');
      const bank = await accountId(db, 'stanbic_main');
      const job = await invoicedJob(db, 'UGA 812A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, $2, 'cash', $3)`,
        [job.invoice, job.subtotal, requestId('pay')]);

      await becomeClient(db, SEED.manager);
      const { rows: deposit } = await db.query<{ transaction_id: string }>(
        `select * from app.record_bank_deposit($1, $2, $3, 'SLIP-10', $4)`,
        [cash, bank, job.subtotal, requestId('d')]);

      const depositTxn = deposit[0].transaction_id;
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.reverse_financial_transaction($1, 'Slip rejected by the bank')`,
        [depositTxn]);

      await becomeOwner(db);
      expect(await awaitingOf(db, 'cash_at_hand')).toBe(
        before.cash_at_hand.awaiting + job.subtotal);
      expect(await balanceOf(db, 'stanbic_main')).toBe(before.stanbic_main.balance);
      const { rows } = await db.query<{ status: string }>(
        `select status from public.bank_deposits where transaction_id = $1`, [depositTxn]);
      expect(rows[0].status).toBe('reversed');
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });

  it('never exceeds the cash actually held', async () => {
    await asAdminDb(async (db) => {
      const { invoicedJob } = await import('./billing-helpers');
      const before = await snapshot(db);
      const cash = await accountId(db, 'cash_at_hand');
      const job = await invoicedJob(db, 'UGA 813A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, $2, 'cash', $3)`,
        [job.invoice, job.subtotal, requestId('pay')]);

      // Cash spent on an expense is no longer waiting to be banked.
      const expense = await approvedExpense(db, before.cash_at_hand.balance + job.subtotal);
      await becomeClient(db, SEED.manager);
      await db.query(`select * from app.pay_expense($1, $2, $3)`, [expense, cash, requestId('p')]);

      await becomeOwner(db);
      expect(await balanceOf(db, 'cash_at_hand')).toBe(0);
      expect(await awaitingOf(db, 'cash_at_hand')).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
describe('bank deposits', () => {
  it('refuses a deposit into anything but a bank', async () => {
    await asAdminDb(async (db) => {
      const cash = await accountId(db, 'cash_at_hand');
      const mtn = await accountId(db, 'mtn_merchant');
      await fund(db, 'cash_at_hand', 200_000);
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.record_bank_deposit($1, $2, 50000, 'SLIP', $3)`,
        [cash, mtn, requestId('d')]);
      expect(error).toMatch(/bank account to deposit into/i);
    });
  });

  it('refuses a deposit out of a bank account', async () => {
    await asAdminDb(async (db) => {
      const bank = await accountId(db, 'stanbic_main');
      await fund(db, 'stanbic_main', 200_000);
      await becomeClient(db, SEED.admin);
      const { rows: second } = await db.query<{ id: string }>(
        `select app.create_financial_account('Second Bank', 'bank', 'Another Bank') as id`);
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.record_bank_deposit($1, $2, 50000, 'SLIP', $3)`,
        [bank, second[0].id, requestId('d')]);
      expect(error).toMatch(/transfer to move money between bank accounts/i);
    });
  });

  it('requires a slip or reference number', async () => {
    await asAdminDb(async (db) => {
      const cash = await accountId(db, 'cash_at_hand');
      const bank = await accountId(db, 'stanbic_main');
      await fund(db, 'cash_at_hand', 200_000);
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.record_bank_deposit($1, $2, 50000, '', $3)`,
        [cash, bank, requestId('d')]);
      expect(error).toMatch(/bank reference/i);
    });
  });
});

// ---------------------------------------------------------------------------
describe('opening balances', () => {
  it('can be recorded once per account', async () => {
    await asAdminDb(async (db) => {
      const bank = await accountId(db, 'stanbic_main');
      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.record_opening_balance($1, 300000, 'Go-live')`, [bank]);
      const error = await db.expectError(
        `select * from app.record_opening_balance($1, 100000, 'Again')`, [bank]);
      expect(error).toMatch(/already has an opening balance/i);
    });
  });

  it('can be recorded again only after its entry is reversed', async () => {
    await asAdminDb(async (db) => {
      const before = await snapshot(db);
      const bank = await accountId(db, 'stanbic_main');
      await becomeClient(db, SEED.admin);
      const { rows } = await db.query<{ transaction_id: string }>(
        `select * from app.record_opening_balance($1, 300000, 'Wrong figure')`, [bank]);
      await db.query(`select * from app.reverse_financial_transaction($1, 'Counted wrongly')`,
        [rows[0].transaction_id]);
      await db.query(`select * from app.record_opening_balance($1, 250000, 'Corrected')`, [bank]);

      await becomeOwner(db);
      expect(await balanceOf(db, 'stanbic_main') - before.stanbic_main.balance).toBe(250_000);
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });

  it('cannot be rewritten once later transactions exist', async () => {
    await asAdminDb(async (db) => {
      const cash = await accountId(db, 'cash_at_hand');
      const bank = await accountId(db, 'stanbic_main');
      await fund(db, 'cash_at_hand', 400_000);
      await becomeClient(db, SEED.manager);
      await db.query(`select * from app.transfer_funds($1, $2, 100000, 'Banking', $3)`,
        [cash, bank, requestId('t')]);

      await becomeClient(db, SEED.admin);
      const error = await db.expectError(
        `select * from app.record_opening_balance($1, 999999, 'Second thoughts')`, [cash]);
      expect(error).toMatch(/already has an opening balance/i);

      await becomeOwner(db);
      const direct = await db.expectError(
        `update public.financial_transactions set amount_ugx = 1
          where entry_type = 'opening_balance'`);
      expect(direct).toMatch(/immutable/i);
    });
  });
});

// ---------------------------------------------------------------------------
describe('reconciliation', () => {
  it('derives the system balance itself and never changes it', async () => {
    await asAdminDb(async (db) => {
      const before = await snapshot(db);
      const cash = await accountId(db, 'cash_at_hand');
      await fund(db, 'cash_at_hand', 500_000);
      const held = before.cash_at_hand.balance + 500_000;

      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ system_balance_ugx: string; difference_ugx: string; status: string }>(
        `select * from app.reconcile_account($1, $2, $3)`, [cash, held - 20_000, requestId('r')]);

      // The SERVER read the system figure; the browser only said what was counted.
      expect(Number(rows[0].system_balance_ugx)).toBe(held);
      expect(Number(rows[0].difference_ugx)).toBe(-20_000);
      expect(rows[0].status).toBe('discrepancy');

      await becomeOwner(db);
      expect(await balanceOf(db, 'cash_at_hand')).toBe(held);
    });
  });

  it('reports a match as balanced', async () => {
    await asAdminDb(async (db) => {
      const before = await snapshot(db);
      const cash = await accountId(db, 'cash_at_hand');
      await fund(db, 'cash_at_hand', 500_000);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ status: string; difference_ugx: string }>(
        `select * from app.reconcile_account($1, $2, $3)`,
        [cash, before.cash_at_hand.balance + 500_000, requestId('r')]);
      expect(rows[0].status).toBe('balanced');
      expect(Number(rows[0].difference_ugx)).toBe(0);
    });
  });

  it('closes a difference only with an adjustment of exactly that amount', async () => {
    await asAdminDb(async (db) => {
      const before = await snapshot(db);
      const cash = await accountId(db, 'cash_at_hand');
      await fund(db, 'cash_at_hand', 500_000);
      const held = before.cash_at_hand.balance + 500_000;
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ reconciliation_id: string }>(
        `select * from app.reconcile_account($1, $2, $3)`, [cash, held - 20_000, requestId('r')]);

      await becomeClient(db, SEED.admin);
      const wrong = await db.expectError(
        `select * from app.record_account_adjustment($1, 'out', 15000, 'Close it', $2, $3)`,
        [cash, requestId('a'), rows[0].reconciliation_id]);
      expect(wrong).toMatch(/difference is −UGX 20,000/i);

      const backwards = await db.expectError(
        `select * from app.record_account_adjustment($1, 'in', 20000, 'Close it', $2, $3)`,
        [cash, requestId('a2'), rows[0].reconciliation_id]);
      expect(backwards).toMatch(/difference is/i);

      await db.query(
        `select * from app.record_account_adjustment($1, 'out', 20000, 'Counted short', $2, $3)`,
        [cash, requestId('a3'), rows[0].reconciliation_id]);

      await becomeOwner(db);
      const { rows: after } = await db.query<{ status: string; adjustment_transaction_id: string }>(
        `select status, adjustment_transaction_id from public.reconciliations where id = $1`,
        [rows[0].reconciliation_id]);
      expect(after[0].status).toBe('adjusted');
      expect(after[0].adjustment_transaction_id).not.toBeNull();
      expect(await balanceOf(db, 'cash_at_hand')).toBe(held - 20_000);
    });
  });

  it('refuses an adjustment against another account\'s reconciliation', async () => {
    await asAdminDb(async (db) => {
      const before = await snapshot(db);
      const cash = await accountId(db, 'cash_at_hand');
      const bank = await accountId(db, 'stanbic_main');
      await fund(db, 'cash_at_hand', 500_000);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ reconciliation_id: string }>(
        `select * from app.reconcile_account($1, $2, $3)`,
        [cash, before.cash_at_hand.balance + 480_000, requestId('r')]);

      await becomeClient(db, SEED.admin);
      const error = await db.expectError(
        `select * from app.record_account_adjustment($1, 'out', 20000, 'Close it', $2, $3)`,
        [bank, requestId('a'), rows[0].reconciliation_id]);
      expect(error).toMatch(/for another account/i);
    });
  });

  it('keeps the counted figures immutable', async () => {
    await asAdminDb(async (db) => {
      const cash = await accountId(db, 'cash_at_hand');
      await fund(db, 'cash_at_hand', 500_000);
      await becomeClient(db, SEED.manager);
      await db.query(`select * from app.reconcile_account($1, 480000, $2)`, [cash, requestId('r')]);

      await becomeOwner(db);
      const error = await db.expectError(
        `update public.reconciliations set actual_balance_ugx = 1`);
      expect(error).toMatch(/immutable/i);
      const deleted = await db.expectError(`delete from public.reconciliations`);
      expect(deleted).toMatch(/never deletes/i);
    });
  });
});

// ---------------------------------------------------------------------------
describe('INVARIANT: financial history is never deleted or rewritten', () => {
  it('refuses to delete a ledger movement, a deposit or a reconciliation', async () => {
    await asAdminDb(async (db) => {
      const cash = await accountId(db, 'cash_at_hand');
      const bank = await accountId(db, 'stanbic_main');
      await fund(db, 'cash_at_hand', 500_000);
      await becomeClient(db, SEED.manager);
      await db.query(`select * from app.record_bank_deposit($1, $2, 100000, 'SLIP', $3)`,
        [cash, bank, requestId('d')]);
      await db.query(`select * from app.reconcile_account($1, 400000, $2)`, [cash, requestId('r')]);

      await becomeOwner(db);
      for (const table of ['financial_transaction_entries', 'bank_deposits', 'reconciliations']) {
        // The guard fires on the first row, whichever suite created it.
        const error = await db.expectError(`delete from public.${table}`);
        expect(error).toMatch(/never deletes|append-only/i);
      }
    });
  });

  it('refuses to alter a per-account movement', async () => {
    await asAdminDb(async (db) => {
      await fund(db, 'cash_at_hand', 100_000);
      const error = await db.expectError(
        `update public.financial_transaction_entries set delta_ugx = 1`);
      expect(error).toMatch(/append-only/i);
    });
  });

  it('refuses to reverse the same transaction twice', async () => {
    await asAdminDb(async (db) => {
      const cash = await accountId(db, 'cash_at_hand');
      const bank = await accountId(db, 'stanbic_main');
      await fund(db, 'cash_at_hand', 500_000);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ transaction_id: string }>(
        `select * from app.transfer_funds($1, $2, 100000, 'Banking', $3)`,
        [cash, bank, requestId('t')]);

      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.reverse_financial_transaction($1, 'Wrong account')`,
        [rows[0].transaction_id]);
      const error = await db.expectError(
        `select * from app.reverse_financial_transaction($1, 'Again')`, [rows[0].transaction_id]);
      expect(error).toMatch(/already been reversed/i);
    });
  });

  it('refuses to reverse a reversal', async () => {
    await asAdminDb(async (db) => {
      const cash = await accountId(db, 'cash_at_hand');
      const bank = await accountId(db, 'stanbic_main');
      await fund(db, 'cash_at_hand', 500_000);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ transaction_id: string }>(
        `select * from app.transfer_funds($1, $2, 100000, 'Banking', $3)`,
        [cash, bank, requestId('t')]);
      await becomeClient(db, SEED.admin);
      const { rows: reversal } = await db.query<{ transaction_id: string }>(
        `select * from app.reverse_financial_transaction($1, 'Wrong account')`,
        [rows[0].transaction_id]);
      const error = await db.expectError(
        `select * from app.reverse_financial_transaction($1, 'Undo the undo')`,
        [reversal[0].transaction_id]);
      expect(error).toMatch(/cannot itself be reversed/i);
    });
  });

  it('sends a customer payment to the payment reversal instead', async () => {
    await asAdminDb(async (db) => {
      const { invoicedJob } = await import('./billing-helpers');
      const job = await invoicedJob(db, 'UGA 814A');
      await becomeClient(db, SEED.cashier);
      await db.query(`select * from app.record_payment($1, $2, 'cash', $3)`,
        [job.invoice, job.subtotal, requestId('pay')]);

      await becomeOwner(db);
      const { rows } = await db.query<{ id: string }>(
        `select id from public.financial_transactions where entry_type = 'customer_payment'`);

      await becomeClient(db, SEED.admin);
      const error = await db.expectError(
        `select * from app.reverse_financial_transaction($1, 'Not this way')`, [rows[0].id]);
      expect(error).toMatch(/from its invoice instead/i);
    });
  });
});

// ---------------------------------------------------------------------------
describe('accounts', () => {
  it('will not create a second cash account', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      const error = await db.expectError(
        `select app.create_financial_account('Petty Cash', 'cash')`);
      expect(error).toMatch(/one cash account/i);
    });
  });

  it('refuses a duplicate name or account number', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      const duplicate = await db.expectError(
        `select app.create_financial_account('Cash at Hand', 'bank')`);
      expect(duplicate).toMatch(/already exists/i);

      await db.query(`select app.create_financial_account('Equity Bank', 'bank', 'Equity', 'ACC-001')`);
      const number = await db.expectError(
        `select app.create_financial_account('Equity Two', 'bank', 'Equity', 'acc-001')`);
      expect(number).toMatch(/number already exists/i);
    });
  });

  it('never lets an account that receives payments be deactivated', async () => {
    await asAdminDb(async (db) => {
      const cash = await accountId(db, 'cash_at_hand');
      await becomeClient(db, SEED.admin);
      const error = await db.expectError(
        `select app.update_financial_account($1, null, null, null, null, false, 'Closing it')`, [cash]);
      expect(error).toMatch(/receives customer payments/i);
    });
  });

  it('refuses to deactivate an account that still holds money', async () => {
    await asAdminDb(async (db) => {
      const bank = await accountId(db, 'stanbic_main');
      await fund(db, 'stanbic_main', 100_000);
      await becomeClient(db, SEED.admin);
      const error = await db.expectError(
        `select app.update_financial_account($1, null, null, null, null, false, 'Closing it')`, [bank]);
      expect(error).toMatch(/Move the balance/i);
    });
  });

  it('records an opening balance given at creation', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.admin);
      const { rows } = await db.query<{ id: string }>(
        `select app.create_financial_account('Centenary', 'bank', 'Centenary Bank', 'C-1', null, 250000) as id`);
      await becomeOwner(db);
      const { rows: account } = await db.query<{ balance_ugx: string; opening_balance_recorded: boolean }>(
        `select balance_ugx, opening_balance_recorded from public.financial_accounts where id = $1`,
        [rows[0].id]);
      expect(Number(account[0].balance_ugx)).toBe(250_000);
      expect(account[0].opening_balance_recorded).toBe(true);
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });
});
