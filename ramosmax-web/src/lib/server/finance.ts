import 'server-only';
import { queryAsUser } from './db';
import { sessionUserId } from './session';

/**
 * Reads for the Phase E screens: finance, expenses and inventory.
 *
 * Every query runs AS THE SIGNED-IN USER, so RLS decides what comes back. A
 * Cashier asking for account balances receives nothing; the same Cashier
 * asking for the accounts they may record a payment against receives names and
 * masked numbers, and no balance. The page never filters for security.
 */

async function requireUser(): Promise<string> {
  const id = await sessionUserId();
  if (!id) throw new Error('Not signed in.');
  return id;
}

/* -------------------------------------------------------------------------- */
/* accounts                                                                    */
/* -------------------------------------------------------------------------- */

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  provider: string | null;
  account_number_masked: string | null;
  balance_ugx: number;
  awaiting_banking_ugx: number;
  opening_balance_ugx: number;
  opening_balance_recorded: boolean;
  is_active: boolean;
  is_default: boolean;
  transaction_count: number;
  last_transaction_at: string | null;
  notes: string | null;
}

const ACCOUNT_COLUMNS = `
  id, code, name, type, provider,
  app.mask_account_number(account_number) as account_number_masked,
  balance_ugx, awaiting_banking_ugx, opening_balance_ugx, opening_balance_recorded,
  is_active, is_default, transaction_count, last_transaction_at, notes`;

export async function listAccounts(): Promise<AccountRow[]> {
  const uid = await requireUser();
  return queryAsUser<AccountRow>(
    uid,
    `select ${ACCOUNT_COLUMNS} from public.financial_accounts
      order by is_active desc, case type when 'cash' then 0 when 'mobile_money' then 1 else 2 end, name`,
  );
}

export async function getAccount(id: string): Promise<AccountRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<AccountRow>(
    uid, `select ${ACCOUNT_COLUMNS} from public.financial_accounts where id = $1`, [id]);
  return rows[0] ?? null;
}

/** The accounts a payment or a payout may be recorded against. No balances. */
export interface PickableAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  account_number_masked: string | null;
}

export async function listPickableAccounts(): Promise<PickableAccount[]> {
  const uid = await requireUser();
  return queryAsUser<PickableAccount>(
    uid,
    `select id, code, name, type, account_number_masked
       from public.payment_accounts order by name`,
  );
}

/* -------------------------------------------------------------------------- */
/* the ledger                                                                  */
/* -------------------------------------------------------------------------- */

export interface LedgerRow {
  id: string;
  transaction_number: string;
  entry_type: string;
  reversal_of_type: string | null;
  amount_ugx: number;
  direction: string;
  source_account_name: string | null;
  destination_account_name: string | null;
  description: string | null;
  reference: string | null;
  reason: string | null;
  status: string;
  is_revenue: boolean;
  business_day: string;
  transaction_date: string;
  created_at: string;
  created_by_name: string | null;
  reverses_id: string | null;
  reversed_by_id: string | null;
}

const LEDGER_COLUMNS = `
  t.id, t.transaction_number, t.entry_type, t.reversal_of_type, t.amount_ugx, t.direction,
  s.name as source_account_name, d.name as destination_account_name,
  t.description, t.reference, t.reason, t.status, t.is_revenue,
  t.business_day, t.transaction_date, t.created_at,
  u.full_name as created_by_name, t.reverses_id, t.reversed_by_id`;

const LEDGER_FROM = `
  from public.financial_transactions t
  left join public.financial_accounts s on s.id = t.source_account_id
  left join public.financial_accounts d on d.id = t.destination_account_id
  left join public.users u on u.id = t.created_by`;

export async function listLedger(type: string, accountId?: string): Promise<LedgerRow[]> {
  const uid = await requireUser();
  return queryAsUser<LedgerRow>(
    uid,
    `select ${LEDGER_COLUMNS} ${LEDGER_FROM}
      where ($1 = 'all' or t.entry_type = $1)
        and ($2::uuid is null
             or t.source_account_id = $2::uuid or t.destination_account_id = $2::uuid)
      order by t.created_at desc limit 100`,
    [type, accountId ?? null],
  );
}

export async function getLedgerEntry(id: string): Promise<LedgerRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<LedgerRow>(
    uid, `select ${LEDGER_COLUMNS} ${LEDGER_FROM} where t.id = $1`, [id]);
  return rows[0] ?? null;
}

export interface LedgerMovement {
  account_id: string;
  account_name: string;
  delta_ugx: number;
  balance_after_ugx: number;
}

export async function listMovements(transactionId: string): Promise<LedgerMovement[]> {
  const uid = await requireUser();
  return queryAsUser<LedgerMovement>(
    uid,
    `select e.account_id, a.name as account_name, e.delta_ugx, e.balance_after_ugx
       from public.financial_transaction_entries e
       join public.financial_accounts a on a.id = e.account_id
      where e.transaction_id = $1 order by e.delta_ugx`,
    [transactionId],
  );
}

/* -------------------------------------------------------------------------- */
/* the day's totals                                                            */
/* -------------------------------------------------------------------------- */

export interface DaySummary {
  business_day: string;
  payments_in_ugx: number;
  expenses_paid_ugx: number;
  purchases_paid_ugx: number;
  transfers_ugx: number;
  deposits_ugx: number;
  adjustments_in_ugx: number;
  adjustments_out_ugx: number;
  opening_balances_ugx: number;
  reversals_ugx: number;
  transaction_count: number;
}

export async function getToday(): Promise<DaySummary | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<DaySummary>(
    uid,
    `select business_day, payments_in_ugx, expenses_paid_ugx, purchases_paid_ugx,
            transfers_ugx, deposits_ugx, adjustments_in_ugx, adjustments_out_ugx,
            opening_balances_ugx, reversals_ugx, transaction_count
       from public.finance_daily_summaries where business_day = app.eat_day()`,
  );
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* deposits and reconciliations                                                */
/* -------------------------------------------------------------------------- */

export interface DepositRow {
  id: string;
  deposit_number: string;
  source_account_name: string;
  bank_account_name: string;
  amount_ugx: number;
  deposit_date: string;
  bank_reference: string;
  status: string;
  created_by_name: string | null;
  transaction_id: string | null;
}

export async function listDeposits(): Promise<DepositRow[]> {
  const uid = await requireUser();
  return queryAsUser<DepositRow>(
    uid,
    `select d.id, d.deposit_number, s.name as source_account_name, b.name as bank_account_name,
            d.amount_ugx, d.deposit_date, d.bank_reference, d.status, d.created_by_name,
            d.transaction_id
       from public.bank_deposits d
       join public.financial_accounts s on s.id = d.source_account_id
       join public.financial_accounts b on b.id = d.bank_account_id
      order by d.created_at desc limit 50`,
  );
}

export interface ReconciliationRow {
  id: string;
  reconciliation_number: string;
  account_name: string;
  account_id: string;
  reconciliation_date: string;
  system_balance_ugx: number;
  actual_balance_ugx: number;
  difference_ugx: number;
  status: string;
  notes: string | null;
  reconciled_by_name: string | null;
}

export async function listReconciliations(): Promise<ReconciliationRow[]> {
  const uid = await requireUser();
  return queryAsUser<ReconciliationRow>(
    uid,
    `select id, reconciliation_number, account_name, account_id, reconciliation_date,
            system_balance_ugx, actual_balance_ugx, difference_ugx, status, notes,
            reconciled_by_name
       from public.reconciliations order by created_at desc limit 50`,
  );
}

/* -------------------------------------------------------------------------- */
/* expenses                                                                    */
/* -------------------------------------------------------------------------- */

export interface ExpenseRow {
  id: string;
  expense_number: string;
  category_id: string;
  category_name: string;
  description: string;
  amount_ugx: number;
  expense_date: string;
  payee: string | null;
  status: string;
  reference: string | null;
  notes: string | null;
  created_by_name: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  paid_by_name: string | null;
  paid_at: string | null;
  paid_from_account_name: string | null;
  payment_reference: string | null;
  financial_transaction_id: string | null;
  financial_transaction_number: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  payment_reversal_reason: string | null;
  payment_account_id: string | null;
  recurring_expense_id: string | null;
  created_at: string;
  created_by: string | null;
}

const EXPENSE_COLUMNS = `
  id, expense_number, category_id, category_name, description, amount_ugx, expense_date,
  payee, status, reference, notes, created_by_name, reviewed_by_name, reviewed_at,
  review_notes, approved_by_name, approved_at, rejected_at, rejection_reason,
  paid_by_name, paid_at, paid_from_account_name, payment_reference,
  financial_transaction_id, financial_transaction_number, cancelled_at, cancel_reason,
  payment_reversal_reason, payment_account_id, recurring_expense_id, created_at, created_by`;

export async function listExpenses(status: string, search: string): Promise<ExpenseRow[]> {
  const uid = await requireUser();
  return queryAsUser<ExpenseRow>(
    uid,
    `select ${EXPENSE_COLUMNS} from public.expenses
      where ($1 = 'all' or status = $1)
        and ($2 = '' or description ilike '%' || $2 || '%'
                     or expense_number ilike '%' || $2 || '%'
                     or coalesce(payee, '') ilike '%' || $2 || '%')
      order by expense_date desc, created_at desc limit 100`,
    [status, search.trim()],
  );
}

export async function getExpense(id: string): Promise<ExpenseRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<ExpenseRow>(
    uid, `select ${EXPENSE_COLUMNS} from public.expenses where id = $1`, [id]);
  return rows[0] ?? null;
}

export interface CategoryRow {
  id: string;
  name: string;
  active: boolean;
  is_default: boolean;
}

export async function listExpenseCategories(): Promise<CategoryRow[]> {
  const uid = await requireUser();
  return queryAsUser<CategoryRow>(
    uid, `select id, name, active, is_default from public.expense_categories order by name`);
}

export interface RecurringRow {
  id: string;
  name: string;
  category_name: string;
  expected_amount_ugx: number;
  frequency: string;
  next_due_date: string;
  reminder_days_before: number;
  payee: string | null;
  active: boolean;
  last_generated_at: string | null;
}

export async function listRecurringExpenses(): Promise<RecurringRow[]> {
  const uid = await requireUser();
  return queryAsUser<RecurringRow>(
    uid,
    `select id, name, category_name, expected_amount_ugx, frequency, next_due_date,
            reminder_days_before, payee, active, last_generated_at
       from public.recurring_expenses order by active desc, next_due_date`,
  );
}

/* -------------------------------------------------------------------------- */
/* inventory                                                                   */
/* -------------------------------------------------------------------------- */

export interface ItemRow {
  id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  description: string | null;
  is_consumable: boolean;
  quantity: number;
  minimum_stock: number;
  reorder_level: number;
  stock_status: string;
  preferred_supplier_id: string | null;
  preferred_supplier_name: string | null;
  last_unit_cost_ugx: number | null;
  active: boolean;
  last_movement_at: string | null;
  last_counted_at: string | null;
  last_counted_quantity: number | null;
}

const ITEM_COLUMNS = `
  id, sku, name, category, unit, description, is_consumable, quantity, minimum_stock,
  reorder_level, stock_status, preferred_supplier_id, preferred_supplier_name,
  last_unit_cost_ugx, active, last_movement_at, last_counted_at, last_counted_quantity`;

export async function listItems(search: string, status: string): Promise<ItemRow[]> {
  const uid = await requireUser();
  return queryAsUser<ItemRow>(
    uid,
    `select ${ITEM_COLUMNS} from public.inventory_items
      where ($1 = '' or name ilike '%' || $1 || '%' or sku ilike '%' || $1 || '%'
                     or category ilike '%' || $1 || '%')
        and ($2 = 'all' or stock_status = $2)
      order by case stock_status when 'out_of_stock' then 0 when 'low' then 1 else 2 end, name
      limit 200`,
    [search.trim(), status],
  );
}

export async function getItem(id: string): Promise<ItemRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<ItemRow>(
    uid, `select ${ITEM_COLUMNS} from public.inventory_items where id = $1`, [id]);
  return rows[0] ?? null;
}

export interface MovementRow {
  id: string;
  movement_number: string;
  item_id: string;
  item_name: string;
  sku: string;
  unit: string;
  type: string;
  quantity: number;
  quantity_change: number;
  quantity_before: number;
  quantity_after: number;
  reason: string | null;
  reason_code: string | null;
  reference: string | null;
  purchase_id: string | null;
  job_number: string | null;
  worker_name: string | null;
  unit_cost_ugx: number | null;
  approved_by: string | null;
  status: string;
  reversed_by_id: string | null;
  created_at: string;
  created_by_name: string | null;
}

const MOVEMENT_COLUMNS = `
  id, movement_number, item_id, item_name, sku, unit, type, quantity, quantity_change,
  quantity_before, quantity_after, reason, reason_code, reference, purchase_id,
  job_number, worker_name, unit_cost_ugx, approved_by, status, reversed_by_id,
  created_at, created_by_name`;

export async function listMovementsForItem(itemId: string): Promise<MovementRow[]> {
  const uid = await requireUser();
  return queryAsUser<MovementRow>(
    uid,
    `select ${MOVEMENT_COLUMNS} from public.stock_movements
      where item_id = $1 order by created_at desc limit 100`,
    [itemId],
  );
}

export async function listStockMovements(type: string): Promise<MovementRow[]> {
  const uid = await requireUser();
  return queryAsUser<MovementRow>(
    uid,
    `select ${MOVEMENT_COLUMNS} from public.stock_movements
      where ($1 = 'all' or type = $1) order by created_at desc limit 100`,
    [type],
  );
}

export interface SupplierRow {
  id: string;
  supplier_number: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  active: boolean;
  purchase_count: number;
  total_purchased_ugx: number;
  last_purchase_at: string | null;
}

const SUPPLIER_COLUMNS = `
  id, supplier_number, name, contact_person, phone, email, address, notes, active,
  purchase_count, total_purchased_ugx, last_purchase_at`;

export async function listSuppliers(search = ''): Promise<SupplierRow[]> {
  const uid = await requireUser();
  return queryAsUser<SupplierRow>(
    uid,
    `select ${SUPPLIER_COLUMNS} from public.suppliers
      where ($1 = '' or name ilike '%' || $1 || '%'
                     or coalesce(contact_person, '') ilike '%' || $1 || '%')
      order by active desc, name limit 100`,
    [search.trim()],
  );
}

export async function getSupplier(id: string): Promise<SupplierRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<SupplierRow>(
    uid, `select ${SUPPLIER_COLUMNS} from public.suppliers where id = $1`, [id]);
  return rows[0] ?? null;
}

export interface PurchaseRow {
  id: string;
  purchase_number: string;
  supplier_id: string;
  supplier_name: string;
  purchase_date: string;
  supplier_reference: string | null;
  total_ugx: number;
  line_count: number;
  status: string;
  payment_status: string;
  notes: string | null;
  approved_at: string | null;
  received_by_name: string | null;
  received_at: string | null;
  paid_at: string | null;
  financial_transaction_id: string | null;
  financial_transaction_number: string | null;
  cancel_reason: string | null;
  payment_reversal_reason: string | null;
  created_by_name: string | null;
  created_at: string;
}

const PURCHASE_COLUMNS = `
  id, purchase_number, supplier_id, supplier_name, purchase_date, supplier_reference,
  total_ugx, line_count, status, payment_status, notes, approved_at, received_by_name,
  received_at, paid_at, financial_transaction_id, financial_transaction_number,
  cancel_reason, payment_reversal_reason, created_by_name, created_at`;

export async function listPurchases(status: string): Promise<PurchaseRow[]> {
  const uid = await requireUser();
  return queryAsUser<PurchaseRow>(
    uid,
    `select ${PURCHASE_COLUMNS} from public.inventory_purchases
      where ($1 = 'all' or status = $1) order by created_at desc limit 100`,
    [status],
  );
}

export async function getPurchase(id: string): Promise<PurchaseRow | null> {
  const uid = await requireUser();
  const rows = await queryAsUser<PurchaseRow>(
    uid, `select ${PURCHASE_COLUMNS} from public.inventory_purchases where id = $1`, [id]);
  return rows[0] ?? null;
}

export interface PurchaseLine {
  id: string;
  item_id: string;
  name: string;
  sku: string;
  unit: string;
  quantity: number;
  unit_cost_ugx: number;
  line_total_ugx: number;
}

export async function listPurchaseLines(purchaseId: string): Promise<PurchaseLine[]> {
  const uid = await requireUser();
  return queryAsUser<PurchaseLine>(
    uid,
    `select id, item_id, name, sku, unit, quantity, unit_cost_ugx, line_total_ugx
       from public.inventory_purchase_items where purchase_id = $1 order by name`,
    [purchaseId],
  );
}

/** The threshold above which a stock-out needs a manager, for the warning. */
export async function highValueThreshold(): Promise<number> {
  const uid = await requireUser();
  const rows = await queryAsUser<{ threshold: number }>(
    uid, `select app.high_value_threshold_ugx() as threshold`);
  return Number(rows[0].threshold);
}
