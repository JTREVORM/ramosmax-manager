import { afterAll, describe, expect, it } from 'vitest';
import { asClient, closePool, SEED } from './harness';
import { asAdminDb, becomeClient, becomeOwner, requestId } from './billing-helpers';
import { accountId, fund, stockedItem } from './finance-helpers';
import { effectivePermissions, ROLES, type AccessProfile, type Role } from '@/lib/permissions';

afterAll(closePool);

/**
 * RPC PERMISSION PARITY for finance, expenses and inventory.
 *
 * Same rule as Phase D: knowing the name of a function is not permission to
 * call it. Every role calls every Phase E RPC directly against the database,
 * and the outcome is compared with the Phase 9 permission catalogue.
 */

const profile = (role: Role): AccessProfile => ({
  role,
  active: true,
  mustChangePassword: false,
  permissions: [],
  deniedPermissions: [],
  temporaryGrants: [],
});

interface Fixtures {
  cash: string;
  bank: string;
  expense: string;
  item: string;
  supplier: string;
  purchase: string;
  movement: string;
  transaction: string;
  reconciliation: string;
}

interface RpcCase {
  name: string;
  requires: string;
  call: (f: Fixtures) => [string, unknown[]];
}

const RPCS: RpcCase[] = [
  // --- finance ---
  { name: 'create_financial_account', requires: 'finance.accounts.manage',
    call: () => [`select app.create_financial_account($1, 'bank', 'A Bank')`,
                 [`Parity Bank ${Math.random().toString(36).slice(2, 8)}`]] },
  { name: 'update_financial_account', requires: 'finance.accounts.manage',
    call: ({ bank }) => [`select app.update_financial_account($1, null, 'Renamed Provider')`, [bank]] },
  { name: 'record_opening_balance', requires: 'finance.accounts.manage',
    call: ({ bank }) => [`select * from app.record_opening_balance($1, 1000, 'Parity')`, [bank]] },
  { name: 'transfer_funds', requires: 'finance.transfer',
    call: ({ cash, bank }) => [`select * from app.transfer_funds($1, $2, 1000, 'Parity', $3)`,
                               [cash, bank, requestId('parity')]] },
  { name: 'record_bank_deposit', requires: 'finance.deposit',
    call: ({ cash, bank }) => [`select * from app.record_bank_deposit($1, $2, 1000, 'SLIP', $3)`,
                               [cash, bank, requestId('parity')]] },
  { name: 'reconcile_account', requires: 'finance.reconcile',
    call: ({ cash }) => [`select * from app.reconcile_account($1, 1000, $2)`,
                         [cash, requestId('parity')]] },
  { name: 'record_account_adjustment', requires: 'finance.adjust',
    call: ({ cash }) => [`select * from app.record_account_adjustment($1, 'in', 1000, 'Parity', $2)`,
                         [cash, requestId('parity')]] },
  { name: 'reverse_financial_transaction', requires: 'finance.adjust',
    call: ({ transaction }) => [`select * from app.reverse_financial_transaction($1, 'Parity')`,
                                [transaction]] },

  // --- expenses ---
  { name: 'create_expense', requires: 'expenses.create',
    call: () => [`select * from app.create_expense('operations', 'Parity', 1000, current_date, $1)`,
                 [requestId('parity')]] },
  // Editing SOMEONE ELSE'S expense — which is what this fixture is — needs the
  // reviewer's permission on top of expenses.create.
  { name: 'update_expense (another person\'s)', requires: 'expenses.review',
    call: ({ expense }) => [`select app.update_expense($1, null, 'Parity edit')`, [expense]] },
  { name: 'update_expense_status (review)', requires: 'expenses.review',
    call: ({ expense }) => [`select app.update_expense_status($1, 'review', 'Parity')`, [expense]] },
  { name: 'update_expense_status (approve)', requires: 'expenses.approve',
    call: ({ expense }) => [`select app.update_expense_status($1, 'approve')`, [expense]] },
  { name: 'update_expense_status (cancel)', requires: 'expenses.cancel',
    call: ({ expense }) => [`select app.update_expense_status($1, 'cancel', 'Parity')`, [expense]] },
  { name: 'pay_expense', requires: 'expenses.pay',
    call: ({ expense, cash }) => [`select * from app.pay_expense($1, $2, $3)`,
                                  [expense, cash, requestId('parity')]] },
  { name: 'create_expense_category', requires: 'expenses.categories.manage',
    call: () => [`select app.create_expense_category($1)`,
                 [`Parity ${Math.random().toString(36).slice(2, 8)}`]] },
  { name: 'update_expense_category', requires: 'expenses.categories.manage',
    call: () => [`select app.update_expense_category('office', 'Office and stationery')`, []] },
  { name: 'create_recurring_expense', requires: 'expenses.recurring.manage',
    call: () => [`select app.create_recurring_expense('Parity rent', 'premises', 1000,
                                                       'monthly', current_date)`, []] },

  // --- inventory ---
  { name: 'create_inventory_item', requires: 'inventory.manage',
    call: () => [`select * from app.create_inventory_item($1, 'other', 'piece')`,
                 [`Parity Item ${Math.random().toString(36).slice(2, 8)}`]] },
  { name: 'update_inventory_item', requires: 'inventory.manage',
    call: ({ item }) => [`select app.update_inventory_item($1, null, null, null, 1, 2)`, [item]] },
  { name: 'create_supplier', requires: 'inventory.suppliers.manage',
    call: () => [`select * from app.create_supplier($1)`,
                 [`Parity Supplier ${Math.random().toString(36).slice(2, 8)}`]] },
  { name: 'update_supplier', requires: 'inventory.suppliers.manage',
    call: ({ supplier }) => [`select app.update_supplier($1, null, 'A Contact')`, [supplier]] },
  { name: 'record_stock_movement (in)', requires: 'inventory.stock.in',
    call: ({ item }) => [`select * from app.record_stock_movement($1, 'stock_in', 1, 'Parity', $2)`,
                         [item, requestId('parity')]] },
  { name: 'record_stock_movement (usage)', requires: 'inventory.stock.out',
    call: ({ item }) => [`select * from app.record_stock_movement($1, 'usage', 1, 'Parity', $2)`,
                         [item, requestId('parity')]] },
  { name: 'adjust_stock', requires: 'inventory.stock.adjust',
    call: ({ item }) => [`select * from app.adjust_stock($1, 1, 'Parity count', $2)`,
                         [item, requestId('parity')]] },
  { name: 'reverse_stock_movement', requires: 'inventory.stock.adjust',
    call: ({ movement }) => [`select * from app.reverse_stock_movement($1, 'Parity')`, [movement]] },
  { name: 'create_purchase', requires: 'inventory.purchase.create',
    call: ({ supplier, item }) => [`select * from app.create_purchase($1, $2::jsonb, $3)`,
      [supplier, JSON.stringify([{ itemId: item, quantity: 1, unitCostUgx: 1000 }]), requestId('parity')]] },
  { name: 'update_purchase_status', requires: 'inventory.purchase.approve',
    call: ({ purchase }) => [`select app.update_purchase_status($1, 'cancel', 'Parity')`, [purchase]] },
  { name: 'receive_purchase', requires: 'inventory.stock.in',
    call: ({ purchase }) => [`select * from app.receive_purchase($1, $2)`,
                             [purchase, requestId('parity')]] },
  { name: 'pay_purchase', requires: 'expenses.pay',
    call: ({ purchase, cash }) => [`select * from app.pay_purchase($1, $2, $3)`,
                                   [purchase, cash, requestId('parity')]] },
];

/** Everything a parity call might need, set up as the people who may. */
async function fixtures(db: Parameters<Parameters<typeof asAdminDb>[0]>[0]): Promise<Fixtures> {
  const cash = await accountId(db, 'cash_at_hand');
  const bank = await accountId(db, 'stanbic_main');
  await fund(db, 'cash_at_hand', 1_000_000);

  await becomeClient(db, SEED.manager);
  const { rows: expense } = await db.query<{ expense_id: string }>(
    `select * from app.create_expense('operations', 'Parity fixture', 5000, current_date, $1,
                                       null, null, null, null, true)`,
    [requestId('fixture')]);

  const { item, supplier } = await stockedItem(db, `Parity ${Math.random().toString(36).slice(2, 8)}`, 20);

  await becomeClient(db, SEED.manager);
  const { rows: movement } = await db.query<{ movement_id: string }>(
    `select * from app.record_stock_movement($1, 'usage', 1, 'Parity fixture', $2)`,
    [item, requestId('fixture')]);
  const { rows: purchase } = await db.query<{ purchase_id: string }>(
    `select * from app.create_purchase($1, $2::jsonb, $3)`,
    [supplier, JSON.stringify([{ itemId: item, quantity: 2, unitCostUgx: 1000 }]), requestId('fixture')]);
  const { rows: transfer } = await db.query<{ transaction_id: string }>(
    `select * from app.transfer_funds($1, $2, 1000, 'Parity fixture', $3)`,
    [cash, bank, requestId('fixture')]);
  const { rows: reconciliation } = await db.query<{ reconciliation_id: string }>(
    `select * from app.reconcile_account($1, 1, $2)`, [cash, requestId('fixture')]);

  await becomeOwner(db);
  return {
    cash, bank,
    expense: expense[0].expense_id,
    item, supplier,
    purchase: purchase[0].purchase_id,
    movement: movement[0].movement_id,
    transaction: transfer[0].transaction_id,
    reconciliation: reconciliation[0].reconciliation_id,
  };
}

describe('every Phase E RPC refuses every role that lacks its permission', () => {
  for (const rpc of RPCS) {
    for (const role of ROLES) {
      const granted = effectivePermissions(profile(role));
      const allowed = granted.has(rpc.requires as never);

      it(`${role} ${allowed ? 'MAY' : 'may NOT'} call ${rpc.name} (${rpc.requires})`, async () => {
        await asAdminDb(async (db) => {
          const f = await fixtures(db);
          const [sql, params] = rpc.call(f);

          await becomeClient(db, SEED[role]);
          const error = await db.expectError(sql, params);

          if (allowed) {
            // It may fail on a business rule, but NEVER on permission.
            expect(error ?? '', `${role} -> ${rpc.name}`).not.toMatch(/do not have permission/);
          } else {
            expect(error, `${role} -> ${rpc.name}`).toMatch(/do not have permission|not active/);
          }
        });
      });
    }
  }
});

// ---------------------------------------------------------------------------
describe('a cashier gains no financial visibility by knowing a name', () => {
  const HIDDEN = [
    'financial_accounts', 'financial_transactions', 'financial_transaction_entries',
    'finance_daily_summaries', 'bank_deposits', 'reconciliations',
    'inventory_items', 'stock_movements', 'suppliers', 'inventory_purchases',
  ];

  it('reads no balance, ledger entry, deposit, reconciliation or stock row', async () => {
    await asAdminDb(async (db) => {
      await fund(db, 'cash_at_hand', 500_000);
      await becomeClient(db, SEED.cashier);
      for (const table of HIDDEN) {
        const { rows } = await db.query<{ n: string }>(
          `select count(*)::text as n from public.${table}`);
        expect(Number(rows[0].n), table).toBe(0);
      }
    });
  });

  it('still sees the accounts it may record a payment against, without balances', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.cashier);
      const { rows } = await db.query<{ name: string }>(
        `select name from public.payment_accounts order by name`);
      expect(rows.length).toBeGreaterThan(0);

      const columns = await db.expectError(`select balance_ugx from public.payment_accounts`);
      expect(columns).toMatch(/balance_ugx/);
    });
  });

  it('may read the expenses it records, and nothing financial beyond them', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.cashier);
      // expenses.view is a Cashier default; finance.view is not.
      await db.query(`select count(*) from public.expenses`);
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.finance_daily_summaries`);
      expect(Number(rows[0].n)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
describe('a worker gains nothing from finance, expenses or inventory', () => {
  it('reads no row from any of them', async () => {
    await asAdminDb(async (db) => {
      await fund(db, 'cash_at_hand', 100_000);
      await stockedItem(db, `Worker Blind ${Math.random().toString(36).slice(2, 8)}`, 5);
      await becomeClient(db, SEED.worker);
      for (const table of ['financial_accounts', 'expenses', 'inventory_items',
                           'stock_movements', 'suppliers', 'bank_deposits']) {
        const { rows } = await db.query<{ n: string }>(
          `select count(*)::text as n from public.${table}`);
        expect(Number(rows[0].n), table).toBe(0);
      }
    });
  });
});

// ---------------------------------------------------------------------------
describe('an auditor reads everything and writes nothing', () => {
  it('sees the ledger and the stock, and is refused every command', async () => {
    await asAdminDb(async (db) => {
      await fund(db, 'cash_at_hand', 100_000);
      const cash = await accountId(db, 'cash_at_hand');
      await stockedItem(db, `Audit ${Math.random().toString(36).slice(2, 8)}`, 5);

      await becomeClient(db, SEED.auditor);
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.financial_transactions`);
      expect(Number(rows[0].n)).toBeGreaterThan(0);

      for (const [sql, params] of [
        [`select * from app.transfer_funds($1, $1, 1, 'x', $2)`, [cash, requestId('a')]],
        [`select * from app.record_account_adjustment($1, 'in', 1, 'x', $2)`, [cash, requestId('b')]],
        [`select * from app.create_expense('operations', 'x', 1, current_date, $1)`, [requestId('c')]],
        [`select * from app.create_supplier('x')`, []],
      ] as [string, unknown[]][]) {
        expect(await db.expectError(sql, params), sql).toMatch(/do not have permission/);
      }
    });
  });
});

// ---------------------------------------------------------------------------
describe('anonymous callers reach nothing in Phase E', () => {
  it('is refused every read', async () => {
    await asClient(null, async (session) => {
      for (const table of ['bank_deposits', 'reconciliations', 'expenses', 'expense_categories',
                           'recurring_expenses', 'suppliers', 'inventory_items',
                           'stock_movements', 'inventory_purchases', 'payment_accounts']) {
        expect(await session.denied(`select * from public.${table}`), table).toBe(true);
      }
    });
  });

  it('is refused every command', async () => {
    await asClient(null, async (session) => {
      for (const call of [
        `select * from app.transfer_funds(gen_random_uuid(), gen_random_uuid(), 1, 'x', 'abcdefgh')`,
        `select * from app.record_bank_deposit(gen_random_uuid(), gen_random_uuid(), 1, 'x', 'abcdefgh')`,
        `select * from app.pay_expense(gen_random_uuid(), gen_random_uuid(), 'abcdefgh')`,
        `select * from app.record_stock_movement(gen_random_uuid(), 'usage', 1, 'x', 'abcdefgh')`,
      ]) {
        expect(await session.denied(call), call).toBe(true);
      }
    });
  });
});

// ---------------------------------------------------------------------------
describe('the Phase E building blocks are not callable by a client', () => {
  const internals: [string, string][] = [
    ['fabricate a ledger entry directly',
      `select app.post_transaction('adjustment', 999999, null, gen_random_uuid())`],
    ['move an account balance', `select app.move_account(gen_random_uuid(), 999999, 'adjustment', null)`],
    ['rewrite a day summary',
      `select app.summarise_day(current_date, 'customer_payment', 999999, null, null, null)`],
    ['fabricate stock', `select app.move_stock(gen_random_uuid(), 'stock_in', 999)`],
    ['pay a purchase without the wrapper',
      `select app.post_purchase_payment(null::public.inventory_purchases, gen_random_uuid(), null, 'x')`],
    ['unpick a payment record',
      `select app.reverse_spending_record(null::public.financial_transactions, gen_random_uuid(), 'x')`],
    ['run the recurring sweep', `select app.sweep_recurring_expenses()`],
    ['read a category past its guard', `select app.read_expense_category('utilities')`],
  ];

  for (const role of ['admin', 'manager', 'cashier', 'worker', 'auditor'] as const) {
    it(`${role} cannot call any Phase E internal function`, async () => {
      await asAdminDb(async (db) => {
        await becomeClient(db, SEED[role]);
        for (const [what, sql] of internals) {
          const error = await db.expectError(sql);
          expect(error, `${role} could ${what}`).toMatch(/permission denied|does not exist|not callable/i);
        }
      });
    });
  }
});
