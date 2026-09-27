import { afterAll, describe, expect, it } from 'vitest';
import { closePool, makeUser } from './harness';
import {
  accountId, asAdminDb, balanceOf, becomeClient, becomeOwner, fund,
  ledgerDisagreements, requestId, SEED, stockedItem,
} from './finance-helpers';

afterAll(closePool);

const quantityOf = async (db: Parameters<Parameters<typeof asAdminDb>[0]>[0], item: string) => {
  const { rows } = await db.query<{ quantity: number; stock_status: string }>(
    `select quantity, stock_status from public.inventory_items where id = $1`, [item]);
  return rows[0];
};

// ---------------------------------------------------------------------------
describe('INVARIANT: a quantity equals the sum of its movements', () => {
  it('holds across stock in, usage, stock out and adjustment', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Rebuild Wax', 40, 5_000);

      await becomeClient(db, SEED.manager);
      await db.query(`select * from app.record_stock_movement($1, 'usage', 6, 'Used on a job', $2)`,
        [item, requestId('u')]);
      await db.query(`select * from app.record_stock_movement($1, 'stock_in', 10, 'Top-up', $2)`,
        [item, requestId('i')]);
      await db.query(`select * from app.record_stock_movement($1, 'stock_out', 2, 'Spilled', $2, 'wastage')`,
        [item, requestId('o')]);
      await db.query(`select * from app.adjust_stock($1, 40, 'Physical count', $2)`,
        [item, requestId('c')]);

      await becomeOwner(db);
      const { rows } = await db.query<{ quantity: number; movements: string }>(`
        select i.quantity, coalesce(sum(m.quantity_change), 0) as movements
          from public.inventory_items i
          left join public.stock_movements m on m.item_id = i.id
         where i.id = $1 group by i.quantity`, [item]);
      expect(Number(rows[0].movements)).toBe(rows[0].quantity);
      expect(rows[0].quantity).toBe(40);
    });
  });

  it('records quantity_before and quantity_after on every movement', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Chain Lube', 12);
      await becomeClient(db, SEED.manager);
      await db.query(`select * from app.record_stock_movement($1, 'usage', 5, 'Used', $2)`,
        [item, requestId('u')]);

      await becomeOwner(db);
      const { rows } = await db.query<{ quantity_before: number; quantity_after: number; type: string }>(
        `select quantity_before, quantity_after, type from public.stock_movements
          where item_id = $1 order by movement_number`, [item]);
      expect(rows[0]).toMatchObject({ type: 'stock_in', quantity_before: 0, quantity_after: 12 });
      expect(rows[1]).toMatchObject({ type: 'usage', quantity_before: 12, quantity_after: 7 });
    });
  });
});

// ---------------------------------------------------------------------------
describe('INVARIANT: stock can never go negative', () => {
  it('refuses a movement that would take an item below zero', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Short Supply', 3);
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.record_stock_movement($1, 'usage', 4, 'Too many', $2)`,
        [item, requestId('u')]);
      expect(error).toMatch(/Only 3 litre\(s\).*in stock; 4 requested/i);

      await becomeOwner(db);
      expect((await quantityOf(db, item)).quantity).toBe(3);
    });
  });

  it('is enforced by a CHECK constraint on the item itself', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Constraint Check', 1);
      const error = await db.expectError(
        `update public.inventory_items set quantity = -1 where id = $1`, [item]);
      expect(error).toMatch(/item_quantity_non_negative/);
    });
  });

  it('refuses a reversal that would take stock below zero', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Reversal Floor', 0);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ movement_id: string }>(
        `select * from app.record_stock_movement($1, 'stock_in', 5, 'Delivery', $2)`,
        [item, requestId('i')]);
      await db.query(`select * from app.record_stock_movement($1, 'usage', 5, 'All used', $2)`,
        [item, requestId('u')]);
      const error = await db.expectError(
        `select * from app.reverse_stock_movement($1, 'Wrong delivery note')`, [rows[0].movement_id]);
      expect(error).toMatch(/in stock/i);
    });
  });
});

// ---------------------------------------------------------------------------
describe('stock status', () => {
  it('is computed by the database from the levels', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Status Item', 10);
      expect((await quantityOf(db, item)).stock_status).toBe('ok');

      await becomeClient(db, SEED.manager);
      await db.query(`select * from app.record_stock_movement($1, 'usage', 6, 'Used', $2)`,
        [item, requestId('u')]);
      await becomeOwner(db);
      expect((await quantityOf(db, item)).stock_status).toBe('low');

      await becomeClient(db, SEED.manager);
      await db.query(`select * from app.record_stock_movement($1, 'usage', 4, 'Used', $2)`,
        [item, requestId('u2')]);
      await becomeOwner(db);
      expect((await quantityOf(db, item)).stock_status).toBe('out_of_stock');
    });
  });

  it('raises an event when an item first becomes low', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Event Item', 10);
      await becomeClient(db, SEED.manager);
      await db.query(`select * from app.record_stock_movement($1, 'usage', 7, 'Used', $2)`,
        [item, requestId('u')]);

      await becomeOwner(db);
      const { rows } = await db.query<{ type: string; stock_status: string }>(
        `select type, stock_status from public.inventory_events where item_id = $1`, [item]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'low_stock', stock_status: 'low' });
    });
  });

  it('says nothing more while it simply stays low', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Quiet Item', 10);
      await becomeClient(db, SEED.manager);
      await db.query(`select * from app.record_stock_movement($1, 'usage', 7, 'Used', $2)`,
        [item, requestId('u')]);
      await db.query(`select * from app.record_stock_movement($1, 'usage', 1, 'Used', $2)`,
        [item, requestId('u2')]);

      await becomeOwner(db);
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.inventory_events where item_id = $1`, [item]);
      expect(Number(rows[0].n)).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
describe('high-value stock-out approval', () => {
  it('reads the threshold from the settings, defaulting to UGX 200,000', async () => {
    await asAdminDb(async (db) => {
      const { rows } = await db.query<{ threshold: string }>(
        `select app.high_value_threshold_ugx() as threshold`);
      expect(Number(rows[0].threshold)).toBe(200_000);

      await db.query(
        `insert into public.settings (key, value)
         values ('inventory', jsonb_build_object('highValueThresholdUgx', 350000))
         on conflict (key) do update set value = excluded.value`);
      const { rows: changed } = await db.query<{ threshold: string }>(
        `select app.high_value_threshold_ugx() as threshold`);
      expect(Number(changed[0].threshold)).toBe(350_000);

      // A nonsense setting falls back rather than disabling the rule.
      await db.query(
        `update public.settings set value = jsonb_build_object('highValueThresholdUgx', 'lots')
          where key = 'inventory'`);
      const { rows: bad } = await db.query<{ threshold: string }>(
        `select app.high_value_threshold_ugx() as threshold`);
      expect(Number(bad[0].threshold)).toBe(200_000);
    });
  });

  it('allows a stock-out below the threshold without approval', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Cheap Stock', 50, 1_000);
      const worker = await makeUser(db, { role: 'worker', permissions: ['inventory.view', 'inventory.stock.out'] });

      await becomeClient(db, worker);
      // 10 × 1,000 = 10,000, well under 200,000.
      const { rows } = await db.query<{ quantity_after: number }>(
        `select * from app.record_stock_movement($1, 'stock_out', 10, 'Damaged', $2, 'damaged')`,
        [item, requestId('o')]);
      expect(rows[0].quantity_after).toBe(40);
    });
  });

  it('refuses a stock-out at or above the threshold without inventory.stock.adjust', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Costly Stock', 50, 20_000);
      const worker = await makeUser(db, { role: 'worker', permissions: ['inventory.view', 'inventory.stock.out'] });

      await becomeClient(db, worker);
      // 10 × 20,000 = 200,000, exactly the threshold.
      const error = await db.expectError(
        `select * from app.record_stock_movement($1, 'stock_out', 10, 'Damaged', $2, 'damaged')`,
        [item, requestId('o')]);
      expect(error).toMatch(/UGX 200,000 or more need a manager/i);

      await becomeOwner(db);
      expect((await quantityOf(db, item)).quantity).toBe(50);
    });
  });

  it('records the approver when an authorised person does it', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Approved Stock', 50, 20_000);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ movement_id: string }>(
        `select * from app.record_stock_movement($1, 'stock_out', 10, 'Damaged', $2, 'damaged')`,
        [item, requestId('o')]);

      await becomeOwner(db);
      const { rows: movement } = await db.query<{ approved_by: string | null }>(
        `select approved_by from public.stock_movements where id = $1`, [rows[0].movement_id]);
      expect(movement[0].approved_by).toBe(SEED.manager);
    });
  });

  it('refuses a second stock-out under the same request id', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Idempotent Stock', 50, 20_000);
      const request = requestId('o');
      await becomeClient(db, SEED.manager);
      const first = await db.query<{ quantity_after: number }>(
        `select * from app.record_stock_movement($1, 'stock_out', 10, 'Damaged', $2, 'damaged')`,
        [item, request]);
      const again = await db.query<{ quantity_after: number }>(
        `select * from app.record_stock_movement($1, 'stock_out', 10, 'Damaged', $2, 'damaged')`,
        [item, request]);
      expect(again.rows[0].quantity_after).toBe(first.rows[0].quantity_after);

      await becomeOwner(db);
      expect((await quantityOf(db, item)).quantity).toBe(40);
    });
  });
});

// ---------------------------------------------------------------------------
describe('adjustments and reversals', () => {
  it('records the difference, not the new quantity', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Counted Item', 20);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ difference: number; quantity_after: number }>(
        `select * from app.adjust_stock($1, 18, 'Physical count', $2)`, [item, requestId('c')]);
      expect(rows[0].difference).toBe(-2);
      expect(rows[0].quantity_after).toBe(18);

      await becomeOwner(db);
      const { rows: movement } = await db.query<{ type: string; counted_quantity: number; system_quantity: number }>(
        `select type, counted_quantity, system_quantity from public.stock_movements
          where item_id = $1 order by movement_number desc limit 1`, [item]);
      expect(movement[0]).toMatchObject({ type: 'adjustment_out', counted_quantity: 18, system_quantity: 20 });
    });
  });

  it('refuses a count that matches', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Matching Item', 15);
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.adjust_stock($1, 15, 'Physical count', $2)`, [item, requestId('c')]);
      expect(error).toMatch(/No adjustment is needed/i);
    });
  });

  it('reverses a movement once, and never a purchase receipt', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Reversible Item', 30);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ movement_id: string }>(
        `select * from app.record_stock_movement($1, 'usage', 5, 'Used', $2)`, [item, requestId('u')]);
      await db.query(`select * from app.reverse_stock_movement($1, 'Recorded on the wrong item')`,
        [rows[0].movement_id]);
      await becomeOwner(db);
      expect((await quantityOf(db, item)).quantity).toBe(30);

      await becomeClient(db, SEED.manager);
      const again = await db.expectError(
        `select * from app.reverse_stock_movement($1, 'Again')`, [rows[0].movement_id]);
      expect(again).toMatch(/already been reversed/i);

      await becomeOwner(db);
      const { rows: opening } = await db.query<{ id: string }>(
        `select id from public.stock_movements where item_id = $1 and purchase_id is null
          order by movement_number limit 1`, [item]);
      expect(opening[0].id).toBeTruthy();
    });
  });

  it('sends a purchase receipt to a supplier return instead', async () => {
    await asAdminDb(async (db) => {
      const { item, supplier } = await stockedItem(db, 'Purchased Item', 0);
      await becomeClient(db, SEED.manager);
      const { rows: purchase } = await db.query<{ purchase_id: string }>(
        `select * from app.create_purchase($1, $2::jsonb, $3)`,
        [supplier, JSON.stringify([{ itemId: item, quantity: 10, unitCostUgx: 5000 }]), requestId('p')]);
      await db.query(`select * from app.receive_purchase($1, $2)`,
        [purchase[0].purchase_id, requestId('r')]);

      await becomeOwner(db);
      const { rows } = await db.query<{ id: string }>(
        `select id from public.stock_movements where purchase_id = $1`, [purchase[0].purchase_id]);

      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.reverse_stock_movement($1, 'Wrong delivery')`, [rows[0].id]);
      expect(error).toMatch(/return to the supplier/i);
    });
  });

  it('keeps every movement immutable', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Immutable Item', 5);
      const update = await db.expectError(
        `update public.stock_movements set quantity_change = 99 where item_id = $1`, [item]);
      expect(update).toMatch(/immutable/i);
      const remove = await db.expectError(
        `delete from public.stock_movements where item_id = $1`, [item]);
      expect(remove).toMatch(/never deletes/i);
    });
  });
});

// ---------------------------------------------------------------------------
describe('purchases are not expenses', () => {
  it('pays a purchase to the ledger and creates no expense record', async () => {
    await asAdminDb(async (db) => {
      const before = await balanceOf(db, 'cash_at_hand');
      // The concurrency suite COMMITS its rows, so every count and total here
      // is about what THIS test changed.
      const { rows: startRows } = await db.query<{ expenses: string; purchases: string; paid: string }>(
        `select (select count(*) from public.expenses) as expenses,
                coalesce((select purchases_paid_ugx from public.finance_daily_summaries
                           where business_day = app.eat_day()), 0) as purchases,
                coalesce((select expenses_paid_ugx from public.finance_daily_summaries
                           where business_day = app.eat_day()), 0) as paid`);
      const start = startRows[0];
      await fund(db, 'cash_at_hand', 1_000_000);
      const cash = await accountId(db, 'cash_at_hand');
      const { item, supplier } = await stockedItem(db, 'Bought Item', 0, 15_000);

      await becomeClient(db, SEED.manager);
      const { rows: purchase } = await db.query<{ purchase_id: string; total_ugx: string; status: string }>(
        `select * from app.create_purchase($1, $2::jsonb, $3)`,
        [supplier, JSON.stringify([{ itemId: item, quantity: 20, unitCostUgx: 15000 }]), requestId('p')]);
      // The SERVER priced it: 20 × 15,000.
      expect(Number(purchase[0].total_ugx)).toBe(300_000);
      expect(purchase[0].status).toBe('approved');

      await db.query(`select * from app.receive_purchase($1, $2, $3)`,
        [purchase[0].purchase_id, requestId('r'), cash]);

      await becomeOwner(db);
      expect((await quantityOf(db, item)).quantity).toBe(20);
      expect(await balanceOf(db, 'cash_at_hand')).toBe(before + 700_000);

      // Buying stock creates NO expense record.
      const { rows: expenses } = await db.query<{ n: string }>(
        `select count(*)::text as n from public.expenses`);
      expect(Number(expenses[0].n)).toBe(Number(start.expenses));

      const { rows: summary } = await db.query<{ purchases_paid_ugx: string; expenses_paid_ugx: string }>(
        `select purchases_paid_ugx, expenses_paid_ugx from public.finance_daily_summaries
          where business_day = app.eat_day()`);
      expect(Number(summary[0].purchases_paid_ugx) - Number(start.purchases)).toBe(300_000);
      expect(Number(summary[0].expenses_paid_ugx)).toBe(Number(start.paid));
      expect(await ledgerDisagreements(db)).toEqual([]);
    });
  });

  it('receives nothing when the payment cannot be funded', async () => {
    await asAdminDb(async (db) => {
      const cash = await accountId(db, 'cash_at_hand');
      const before = await balanceOf(db, 'cash_at_hand');
      const { item, supplier } = await stockedItem(db, 'Unfunded Item', 0, 50_000);

      await becomeClient(db, SEED.manager);
      const { rows: purchase } = await db.query<{ purchase_id: string }>(
        `select * from app.create_purchase($1, $2::jsonb, $3)`,
        [supplier, JSON.stringify([{ itemId: item, quantity: 100, unitCostUgx: 50000 }]), requestId('p')]);
      const error = await db.expectError(`select * from app.receive_purchase($1, $2, $3)`,
        [purchase[0].purchase_id, requestId('r'), cash]);
      expect(error).toMatch(/available/i);

      await becomeOwner(db);
      // Neither the stock nor the money moved.
      expect((await quantityOf(db, item)).quantity).toBe(0);
      expect(await balanceOf(db, 'cash_at_hand')).toBe(before);
      const { rows } = await db.query<{ status: string }>(
        `select status from public.inventory_purchases where id = $1`, [purchase[0].purchase_id]);
      expect(rows[0].status).toBe('approved');
    });
  });

  it('cannot be received twice', async () => {
    await asAdminDb(async (db) => {
      const { item, supplier } = await stockedItem(db, 'Once Item', 0, 1_000);
      await becomeClient(db, SEED.manager);
      const { rows: purchase } = await db.query<{ purchase_id: string }>(
        `select * from app.create_purchase($1, $2::jsonb, $3)`,
        [supplier, JSON.stringify([{ itemId: item, quantity: 5, unitCostUgx: 1000 }]), requestId('p')]);
      await db.query(`select * from app.receive_purchase($1, $2)`,
        [purchase[0].purchase_id, requestId('r')]);
      const error = await db.expectError(`select * from app.receive_purchase($1, $2)`,
        [purchase[0].purchase_id, requestId('r2')]);
      expect(error).toMatch(/already been received/i);
    });
  });

  it('waits for approval when the person may not approve purchases', async () => {
    await asAdminDb(async (db) => {
      const { item, supplier } = await stockedItem(db, 'Pending Item', 0, 1_000);
      const buyer = await makeUser(db, {
        role: 'worker', permissions: ['inventory.view', 'inventory.purchase.create'] });

      await becomeClient(db, buyer);
      const { rows } = await db.query<{ purchase_id: string; status: string }>(
        `select * from app.create_purchase($1, $2::jsonb, $3)`,
        [supplier, JSON.stringify([{ itemId: item, quantity: 5, unitCostUgx: 1000 }]), requestId('p')]);
      expect(rows[0].status).toBe('pending_approval');

      await becomeClient(db, SEED.manager);
      const error = await db.expectError(`select * from app.receive_purchase($1, $2)`,
        [rows[0].purchase_id, requestId('r')]);
      expect(error).toMatch(/Only an approved purchase can be received/i);

      await db.query(`select app.update_purchase_status($1, 'approve')`, [rows[0].purchase_id]);
      await db.query(`select * from app.receive_purchase($1, $2)`, [rows[0].purchase_id, requestId('r2')]);
      await becomeOwner(db);
      expect((await quantityOf(db, item)).quantity).toBe(5);
    });
  });

  it('refuses to cancel a purchase that has been paid', async () => {
    await asAdminDb(async (db) => {
      await fund(db, 'cash_at_hand', 500_000);
      const cash = await accountId(db, 'cash_at_hand');
      const { item, supplier } = await stockedItem(db, 'Paid Item', 0, 1_000);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ purchase_id: string }>(
        `select * from app.create_purchase($1, $2::jsonb, $3)`,
        [supplier, JSON.stringify([{ itemId: item, quantity: 5, unitCostUgx: 1000 }]), requestId('p')]);
      await db.query(`select * from app.pay_purchase($1, $2, $3)`,
        [rows[0].purchase_id, cash, requestId('pay')]);
      const error = await db.expectError(
        `select app.update_purchase_status($1, 'cancel', 'Changed our minds')`, [rows[0].purchase_id]);
      expect(error).toMatch(/Reverse the payment before cancelling/i);
    });
  });

  it('returns a purchase to unpaid when its payment is reversed, keeping the stock', async () => {
    await asAdminDb(async (db) => {
      const before = await balanceOf(db, 'cash_at_hand');
      await fund(db, 'cash_at_hand', 500_000);
      const cash = await accountId(db, 'cash_at_hand');
      const { item, supplier } = await stockedItem(db, 'Reversed Purchase', 0, 2_000);

      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ purchase_id: string }>(
        `select * from app.create_purchase($1, $2::jsonb, $3)`,
        [supplier, JSON.stringify([{ itemId: item, quantity: 10, unitCostUgx: 2000 }]), requestId('p')]);
      const { rows: paid } = await db.query<{ transaction_id: string }>(
        `select * from app.receive_purchase($1, $2, $3)`, [rows[0].purchase_id, requestId('r'), cash]);
      void paid;

      await becomeOwner(db);
      const { rows: txn } = await db.query<{ financial_transaction_id: string }>(
        `select financial_transaction_id from public.inventory_purchases where id = $1`,
        [rows[0].purchase_id]);

      await becomeClient(db, SEED.admin);
      await db.query(`select * from app.reverse_financial_transaction($1, 'Paid the wrong supplier')`,
        [txn[0].financial_transaction_id]);

      await becomeOwner(db);
      const { rows: after } = await db.query<{ payment_status: string; status: string }>(
        `select payment_status, status from public.inventory_purchases where id = $1`,
        [rows[0].purchase_id]);
      expect(after[0].payment_status).toBe('unpaid');
      expect(after[0].status).toBe('received');
      expect((await quantityOf(db, item)).quantity).toBe(10);
      expect(await balanceOf(db, 'cash_at_hand')).toBe(before + 500_000);
    });
  });

  it('prices every line itself, ignoring any total the caller supplies', async () => {
    await asAdminDb(async (db) => {
      const { item, supplier } = await stockedItem(db, 'Priced Item', 0, 3_000);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ purchase_id: string; total_ugx: string }>(
        `select * from app.create_purchase($1, $2::jsonb, $3)`,
        [supplier, JSON.stringify([
          { itemId: item, quantity: 7, unitCostUgx: 3000, lineTotalUgx: 1, totalUgx: 1 }]),
         requestId('p')]);
      expect(Number(rows[0].total_ugx)).toBe(21_000);

      await becomeOwner(db);
      const { rows: line } = await db.query<{ line_total_ugx: string }>(
        `select line_total_ugx from public.inventory_purchase_items where purchase_id = $1`,
        [rows[0].purchase_id]);
      expect(Number(line[0].line_total_ugx)).toBe(21_000);
    });
  });

  it('refuses the same item twice in one purchase', async () => {
    await asAdminDb(async (db) => {
      const { item, supplier } = await stockedItem(db, 'Duplicated Item', 0, 1_000);
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.create_purchase($1, $2::jsonb, $3)`,
        [supplier, JSON.stringify([
          { itemId: item, quantity: 1, unitCostUgx: 1000 },
          { itemId: item, quantity: 2, unitCostUgx: 1000 }]), requestId('p')]);
      expect(error).toMatch(/purchase_line_once|already exists|duplicate/i);
    });
  });
});

// ---------------------------------------------------------------------------
describe('items and suppliers', () => {
  it('allocates a SKU per category', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ sku: string }>(
        `select * from app.create_inventory_item('Tyre Foam', 'chemicals', 'can')`);
      // Three digits, and more once a category passes 999 items.
      expect(rows[0].sku).toMatch(/^RMX-CHEM-\d{3,}$/);
      const { rows: towel } = await db.query<{ sku: string }>(
        `select * from app.create_inventory_item('Drying Towel', 'towels_cloths', 'piece')`);
      expect(towel[0].sku).toMatch(/^RMX-TOWL-\d{3,}$/);
    });
  });

  it('offers no way to write a quantity or a SKU', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Fixed Item', 5);

      // The item RPC simply has no quantity or SKU parameter to send.
      const { rows: args } = await db.query<{ args: string }>(
        `select pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app' and p.proname = 'update_inventory_item'`);
      expect(args[0].args).not.toMatch(/quantity|sku/i);

      // And a signed-in user cannot write the table by any other route.
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `update public.inventory_items set quantity = 99 where id = $1`, [item]);
      expect(error).toMatch(/permission denied/i);
    });
  });

  it('refuses a reorder level below the minimum', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      const error = await db.expectError(
        `select * from app.create_inventory_item('Bad Levels', 'other', 'piece', 10, 5)`);
      expect(error).toMatch(/reorder level cannot be below/i);
    });
  });

  it('refuses stock-in for an inactive item', async () => {
    await asAdminDb(async (db) => {
      const { item } = await stockedItem(db, 'Retired Item', 5);
      await becomeClient(db, SEED.manager);
      await db.query(`select app.update_inventory_item($1, null, null, null, null, null, null, null,
                                                        null, null, false, 'No longer used')`, [item]);
      const error = await db.expectError(
        `select * from app.record_stock_movement($1, 'stock_in', 5, 'Delivery', $2)`,
        [item, requestId('i')]);
      expect(error).toMatch(/inactive/i);
    });
  });

  it('numbers suppliers and refuses duplicates', async () => {
    await asAdminDb(async (db) => {
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ supplier_number: string }>(
        `select * from app.create_supplier('Nakawa Traders', 'John', '0772333444')`);
      expect(rows[0].supplier_number).toMatch(/^RMX-SUP-\d{6}$/);
      const error = await db.expectError(`select * from app.create_supplier('nakawa traders')`);
      expect(error).toMatch(/already exists/i);
    });
  });

  it('counts a received purchase against its supplier', async () => {
    await asAdminDb(async (db) => {
      const { item, supplier } = await stockedItem(db, 'Counted Purchase', 0, 4_000);
      await becomeClient(db, SEED.manager);
      const { rows } = await db.query<{ purchase_id: string }>(
        `select * from app.create_purchase($1, $2::jsonb, $3)`,
        [supplier, JSON.stringify([{ itemId: item, quantity: 5, unitCostUgx: 4000 }]), requestId('p')]);
      await db.query(`select * from app.receive_purchase($1, $2)`, [rows[0].purchase_id, requestId('r')]);

      await becomeOwner(db);
      const { rows: s } = await db.query<{ purchase_count: number; total_purchased_ugx: string }>(
        `select purchase_count, total_purchased_ugx from public.suppliers where id = $1`, [supplier]);
      expect(s[0].purchase_count).toBe(1);
      expect(Number(s[0].total_purchased_ugx)).toBe(20_000);
    });
  });
});
