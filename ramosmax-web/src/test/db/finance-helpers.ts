import { asAdminDb, becomeClient, becomeOwner, type Session, SEED } from './harness';
import { requestId } from './billing-helpers';

/** The id of a seeded account, by its code. */
export async function accountId(db: Session, code: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `select id from public.financial_accounts where code = $1`, [code]);
  return rows[0].id;
}

export async function balanceOf(db: Session, code: string): Promise<number> {
  const { rows } = await db.query<{ balance_ugx: string; awaiting_banking_ugx: string }>(
    `select balance_ugx, awaiting_banking_ugx from public.financial_accounts where code = $1`, [code]);
  return Number(rows[0].balance_ugx);
}

export async function awaitingOf(db: Session, code: string): Promise<number> {
  const { rows } = await db.query<{ awaiting_banking_ugx: string }>(
    `select awaiting_banking_ugx from public.financial_accounts where code = $1`, [code]);
  return Number(rows[0].awaiting_banking_ugx);
}

/**
 * Puts money into an account the only way the system allows: an opening
 * balance, recorded by an administrator.
 */
export async function fund(db: Session, code: string, amount: number): Promise<void> {
  const id = await accountId(db, code);
  await becomeClient(db, SEED.admin);
  await db.query(`select * from app.record_opening_balance($1, $2, 'Test float')`, [id, amount]);
  await becomeOwner(db);
}

/** An approved, unpaid expense. Nothing has moved yet. */
export async function approvedExpense(
  db: Session,
  amount = 120_000,
  category = 'utilities',
): Promise<string> {
  await becomeClient(db, SEED.manager);
  const { rows } = await db.query<{ expense_id: string }>(
    `select * from app.create_expense($1, $2, $3, current_date, $4, 'A Vendor', null, null, null, true)`,
    [category, 'Test expense', amount, requestId('expense')]);
  await db.query(`select app.update_expense_status($1, 'review', 'Checked')`, [rows[0].expense_id]);
  await db.query(`select app.update_expense_status($1, 'approve')`, [rows[0].expense_id]);
  await becomeOwner(db);
  return rows[0].expense_id;
}

/** A supplier and an item, with `quantity` already in stock. */
export async function stockedItem(
  db: Session,
  name: string,
  quantity = 10,
  unitCost = 20_000,
): Promise<{ item: string; supplier: string }> {
  await becomeClient(db, SEED.manager);
  const { rows: supplier } = await db.query<{ supplier_id: string }>(
    `select * from app.create_supplier($1)`, [`${name} Supplies`]);
  const { rows: item } = await db.query<{ item_id: string }>(
    `select * from app.create_inventory_item($1, 'chemicals', 'litre', 2, 4, null, true, $2, $3, null, $4)`,
    [name, supplier[0].supplier_id, unitCost, quantity]);
  await becomeOwner(db);
  return { item: item[0].item_id, supplier: supplier[0].supplier_id };
}

/**
 * The balances and waiting amounts of every account, as they stand now.
 *
 * The idempotency and concurrency suites COMMIT, so the development database
 * carries their rows. Every assertion here is therefore about what a test
 * CHANGED, never about an absolute figure.
 */
export async function snapshot(db: Session): Promise<Record<string, { balance: number; awaiting: number }>> {
  const { rows } = await db.query<{ code: string; balance_ugx: string; awaiting_banking_ugx: string }>(
    `select code, balance_ugx, awaiting_banking_ugx from public.financial_accounts`);
  return Object.fromEntries(rows.map((r) => [r.code,
    { balance: Number(r.balance_ugx), awaiting: Number(r.awaiting_banking_ugx) }]));
}

/** Every account's balance must equal the sum of its ledger movements. */
export async function ledgerDisagreements(db: Session): Promise<unknown[]> {
  const { rows } = await db.query(`
    select a.code, a.balance_ugx, coalesce(sum(e.delta_ugx), 0) as ledger
      from public.financial_accounts a
      left join public.financial_transaction_entries e on e.account_id = a.id
     group by a.id, a.code, a.balance_ugx
    having a.balance_ugx <> coalesce(sum(e.delta_ugx), 0)`);
  return rows;
}

export { asAdminDb, becomeClient, becomeOwner, requestId, SEED };
