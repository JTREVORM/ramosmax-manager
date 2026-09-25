'use server';

import { revalidatePath } from 'next/cache';
import { callRpc } from './operations';
import type { ActionResult } from './operations-actions';

/**
 * Server Actions for finance, expenses and inventory.
 *
 * Each forwards to ONE SECURITY DEFINER function and returns what the database
 * said. No balance, total, quantity or status is decided here: a Server Action
 * is as untrusted as the browser where money and stock are concerned.
 */

async function run(fn: string, params: unknown[], revalidate: string[]): Promise<ActionResult> {
  try {
    const rows = await callRpc<Record<string, unknown>>(fn, params);
    for (const path of revalidate) revalidatePath(path);
    const first = rows[0] ? Object.values(rows[0])[0] : undefined;
    return { ok: true, id: typeof first === 'string' ? first : undefined };
  } catch (e) {
    return {
      ok: false,
      message: ((e as Error).message ?? 'Something went wrong.').replace(/^error:\s*/i, ''),
    };
  }
}

const text = (form: FormData, key: string): string | null => {
  const value = form.get(key);
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
};

const money = (form: FormData, key: string): number | null => {
  const value = text(form, key);
  if (value === null) return null;
  const digits = value.replace(/[\s,]/g, '');
  return /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
};

const FINANCE = ['/finance', '/transactions', '/reconciliation'];

/* ---------------------------------------------------------------- accounts */

export async function createAccountAction(form: FormData): Promise<ActionResult> {
  return run('create_financial_account', [
    text(form, 'name'), text(form, 'type'), text(form, 'provider'),
    text(form, 'account_number'), text(form, 'notes'), money(form, 'opening_balance_ugx') ?? 0,
  ], FINANCE);
}

export async function updateAccountAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('account_id'));
  const active = form.get('active');
  return run('update_financial_account', [
    id, text(form, 'name'), text(form, 'provider'), text(form, 'account_number'),
    text(form, 'notes'), active === null ? null : active === 'true', text(form, 'reason'),
  ], [...FINANCE, `/finance/accounts/${id}`]);
}

export async function recordOpeningBalanceAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('account_id'));
  return run('record_opening_balance', [id, money(form, 'amount_ugx'), text(form, 'reason')],
    [...FINANCE, `/finance/accounts/${id}`]);
}

/* --------------------------------------------------------------- movements */

export async function transferFundsAction(form: FormData): Promise<ActionResult> {
  return run('transfer_funds', [
    text(form, 'from_account_id'), text(form, 'to_account_id'), money(form, 'amount_ugx'),
    text(form, 'reason'), text(form, 'request_id'), text(form, 'transfer_date'),
    text(form, 'reference'), text(form, 'description'),
  ], [...FINANCE, '/finance/transfers', '/finance/banking']);
}

export async function recordDepositAction(form: FormData): Promise<ActionResult> {
  return run('record_bank_deposit', [
    text(form, 'source_account_id'), text(form, 'bank_account_id'), money(form, 'amount_ugx'),
    text(form, 'bank_reference'), text(form, 'request_id'), text(form, 'deposit_date'),
    text(form, 'description'),
  ], [...FINANCE, '/finance/banking']);
}

export async function reconcileAccountAction(form: FormData): Promise<ActionResult> {
  return run('reconcile_account', [
    text(form, 'account_id'), money(form, 'actual_balance_ugx'), text(form, 'request_id'),
    text(form, 'reconciliation_date'), text(form, 'notes'),
  ], FINANCE);
}

export async function recordAdjustmentAction(form: FormData): Promise<ActionResult> {
  return run('record_account_adjustment', [
    text(form, 'account_id'), text(form, 'direction'), money(form, 'amount_ugx'),
    text(form, 'reason'), text(form, 'request_id'), text(form, 'reconciliation_id'),
  ], FINANCE);
}

export async function reverseTransactionAction(form: FormData): Promise<ActionResult> {
  return run('reverse_financial_transaction',
    [text(form, 'transaction_id'), text(form, 'reason')],
    [...FINANCE, '/expenses', '/inventory', '/finance/banking']);
}

/* ---------------------------------------------------------------- expenses */

const EXPENSES = ['/expenses'];

export async function createExpenseAction(form: FormData): Promise<ActionResult> {
  return run('create_expense', [
    text(form, 'category_id'), text(form, 'description'), money(form, 'amount_ugx'),
    text(form, 'expense_date'), text(form, 'request_id'), text(form, 'payee'),
    text(form, 'payment_account_id'), text(form, 'reference'), text(form, 'notes'),
    form.get('submit') === 'true',
  ], EXPENSES);
}

export async function updateExpenseAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('expense_id'));
  return run('update_expense', [
    id, text(form, 'category_id'), text(form, 'description'), money(form, 'amount_ugx'),
    text(form, 'expense_date'), text(form, 'payee'), text(form, 'payment_account_id'),
    text(form, 'reference'), text(form, 'notes'), text(form, 'reason'),
  ], [...EXPENSES, `/expenses/${id}`]);
}

export async function updateExpenseStatusAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('expense_id'));
  return run('update_expense_status',
    [id, text(form, 'action'), text(form, 'reason'), text(form, 'notes')],
    [...EXPENSES, `/expenses/${id}`]);
}

export async function payExpenseAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('expense_id'));
  return run('pay_expense', [
    id, text(form, 'account_id'), text(form, 'request_id'),
    text(form, 'reference'), text(form, 'payment_date'),
  ], [...EXPENSES, `/expenses/${id}`, ...FINANCE]);
}

export async function createCategoryAction(form: FormData): Promise<ActionResult> {
  return run('create_expense_category', [text(form, 'name')], ['/expenses/categories']);
}

export async function updateCategoryAction(form: FormData): Promise<ActionResult> {
  const active = form.get('active');
  return run('update_expense_category', [
    text(form, 'category_id'), text(form, 'name'),
    active === null ? null : active === 'true', text(form, 'reason'),
  ], ['/expenses/categories']);
}

export async function createRecurringAction(form: FormData): Promise<ActionResult> {
  return run('create_recurring_expense', [
    text(form, 'name'), text(form, 'category_id'), money(form, 'expected_amount_ugx'),
    text(form, 'frequency'), text(form, 'next_due_date'), text(form, 'payee'),
    text(form, 'payment_account_id'), Number(form.get('reminder_days_before') ?? 3),
    text(form, 'notes'),
  ], ['/expenses/recurring']);
}

export async function updateRecurringAction(form: FormData): Promise<ActionResult> {
  const active = form.get('active');
  return run('update_recurring_expense', [
    text(form, 'recurring_id'), text(form, 'name'), money(form, 'expected_amount_ugx'),
    text(form, 'next_due_date'),
    form.get('reminder_days_before') === null ? null : Number(form.get('reminder_days_before')),
    text(form, 'payee'), text(form, 'payment_account_id'), text(form, 'notes'),
    active === null ? null : active === 'true', text(form, 'reason'),
  ], ['/expenses/recurring']);
}

/* --------------------------------------------------------------- inventory */

const INVENTORY = ['/inventory'];

export async function createItemAction(form: FormData): Promise<ActionResult> {
  return run('create_inventory_item', [
    text(form, 'name'), text(form, 'category'), text(form, 'unit'),
    Number(form.get('minimum_stock') ?? 0), Number(form.get('reorder_level') ?? 0),
    text(form, 'description'), form.get('is_consumable') !== 'false',
    text(form, 'preferred_supplier_id'), money(form, 'last_unit_cost_ugx'),
    text(form, 'sku'), Number(form.get('opening_quantity') ?? 0),
  ], INVENTORY);
}

export async function updateItemAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('item_id'));
  const active = form.get('active');
  const number = (key: string) =>
    form.get(key) === null || form.get(key) === '' ? null : Number(form.get(key));
  return run('update_inventory_item', [
    id, text(form, 'name'), text(form, 'category'), text(form, 'unit'),
    number('minimum_stock'), number('reorder_level'), text(form, 'description'),
    form.get('is_consumable') === null ? null : form.get('is_consumable') !== 'false',
    text(form, 'preferred_supplier_id'), money(form, 'last_unit_cost_ugx'),
    active === null ? null : active === 'true', text(form, 'reason'),
  ], [...INVENTORY, `/inventory/items/${id}`]);
}

export async function recordMovementAction(form: FormData): Promise<ActionResult> {
  const item = String(form.get('item_id'));
  return run('record_stock_movement', [
    item, text(form, 'type'), Number(form.get('quantity')), text(form, 'reason'),
    text(form, 'request_id'), text(form, 'reason_code'), text(form, 'reference'),
    money(form, 'unit_cost_ugx'), text(form, 'intake_id'), text(form, 'worker_id'),
  ], [...INVENTORY, `/inventory/items/${item}`, '/inventory/movements']);
}

export async function adjustStockAction(form: FormData): Promise<ActionResult> {
  const item = String(form.get('item_id'));
  return run('adjust_stock', [
    item, Number(form.get('counted_quantity')), text(form, 'reason'), text(form, 'request_id'),
  ], [...INVENTORY, `/inventory/items/${item}`, '/inventory/movements']);
}

export async function reverseMovementAction(form: FormData): Promise<ActionResult> {
  const item = String(form.get('item_id'));
  return run('reverse_stock_movement', [text(form, 'movement_id'), text(form, 'reason')],
    [...INVENTORY, `/inventory/items/${item}`, '/inventory/movements']);
}

export async function createSupplierAction(form: FormData): Promise<ActionResult> {
  return run('create_supplier', [
    text(form, 'name'), text(form, 'contact_person'), text(form, 'phone'),
    text(form, 'email'), text(form, 'address'), text(form, 'notes'),
  ], ['/inventory/suppliers']);
}

export async function updateSupplierAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('supplier_id'));
  const active = form.get('active');
  return run('update_supplier', [
    id, text(form, 'name'), text(form, 'contact_person'), text(form, 'phone'),
    text(form, 'email'), text(form, 'address'), text(form, 'notes'),
    active === null ? null : active === 'true', text(form, 'reason'),
  ], ['/inventory/suppliers', `/inventory/suppliers/${id}`]);
}

export async function createPurchaseAction(form: FormData): Promise<ActionResult> {
  // The browser sends WHAT was bought and at what unit cost. The server
  // prices every line and computes the total; nothing here adds anything up.
  const lines = JSON.parse(String(form.get('items') ?? '[]')) as unknown;
  return run('create_purchase', [
    text(form, 'supplier_id'), JSON.stringify(lines), text(form, 'request_id'),
    text(form, 'purchase_date'), text(form, 'supplier_reference'), text(form, 'notes'),
  ], ['/inventory/purchases', ...INVENTORY]);
}

export async function updatePurchaseStatusAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('purchase_id'));
  return run('update_purchase_status', [id, text(form, 'action'), text(form, 'reason')],
    ['/inventory/purchases', `/inventory/purchases/${id}`]);
}

export async function receivePurchaseAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('purchase_id'));
  return run('receive_purchase', [
    id, text(form, 'request_id'), text(form, 'pay_from_account_id'), text(form, 'reference'),
  ], ['/inventory/purchases', `/inventory/purchases/${id}`, ...INVENTORY, ...FINANCE]);
}

export async function payPurchaseAction(form: FormData): Promise<ActionResult> {
  const id = String(form.get('purchase_id'));
  return run('pay_purchase', [
    id, text(form, 'account_id'), text(form, 'request_id'), text(form, 'reference'),
  ], ['/inventory/purchases', `/inventory/purchases/${id}`, ...FINANCE]);
}
