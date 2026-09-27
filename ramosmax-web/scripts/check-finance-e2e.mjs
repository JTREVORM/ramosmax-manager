#!/usr/bin/env node
/**
 * The Phase E workflows, driven through the real browser against the real
 * database.
 *
 *   Admin:    opening balance -> a second bank account
 *   Cashier:  a cash customer payment  -> account, ledger, daily summary
 *   Manager:  cash -> awaiting banking -> bank deposit -> balances
 *             account A -> transfer -> account B, atomically
 *             expense -> review -> approve -> pay -> account deduction
 *   Admin:    reverse the expense payment -> money back, expense approved
 *   Manager:  supplier -> purchase -> receive + pay -> stock up, cash down
 *             stock out -> remaining quantity; high-value needs approval
 *   Cashier:  sees no balance anywhere, but may still take a payment
 *
 * Every money and stock assertion is read back from the DATABASE.
 */
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres:devonly@127.0.0.1:5432/ramosmax_dev';
const PASSWORD = 'DevP@ssw0rd!';
const PLATE = 'UEH 901G';
const CUSTOMER = 'E2E Finance Customer';
const PHONE_DIGITS = '772990301';
const ITEM = 'E2E Foam Shampoo';
const SUPPLIER = 'E2E Chemicals Ltd';

const MANAGER = '00000000-0000-4000-8000-000000000002';
const WORKER = '00000000-0000-4000-8000-000000000004';

let failures = 0;
const check = (passed, message) => {
  if (passed) console.log(`    ok    ${message}`);
  else {
    failures += 1;
    console.error(`    FAIL  ${message}`);
  }
};

const db = new pg.Client({ connectionString: DB });
await db.connect();

// This script asserts ABSOLUTE balances, because the point of it is that the
// business's money adds up. It therefore needs a database where no money has
// moved yet — run it straight after `npm run db:reset`, not after another
// workflow script.
const { rows: existing } = await db.query(
  `select (select count(*) from public.customers where phone_number = $1) as customer,
          (select count(*) from public.financial_transactions) as ledger`,
  [`+256${PHONE_DIGITS}`],
);
if (Number(existing[0].customer) > 0 || Number(existing[0].ledger) > 0) {
  console.error(
    `\n  This script needs a database where no money has moved` +
    ` (found ${existing[0].ledger} ledger entries). Run: npm run db:reset`,
  );
  process.exit(1);
}

/** Calls a function the way PostgREST would, for steps already covered elsewhere. */
async function asUser(uid, sql, params = []) {
  await db.query('begin');
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: uid, role: 'authenticated' }),
    ]);
    await db.query('set local role authenticated');
    const result = await db.query(sql, params);
    await db.query('commit');
    return result;
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}

const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const account = (code) =>
  one(`select id, balance_ugx, awaiting_banking_ugx from public.financial_accounts where code = $1`,
    [code]);
const balance = async (code) => Number((await account(code)).balance_ugx);
const awaiting = async (code) => Number((await account(code)).awaiting_banking_ugx);
const stockOf = (name) =>
  one(`select quantity, stock_status from public.inventory_items where name = $1`, [name]);

/** For every account, the balance must equal the sum of its ledger movements. */
async function ledgerAgrees() {
  const { rows } = await db.query(`
    select a.code from public.financial_accounts a
      left join public.financial_transaction_entries e on e.account_id = a.id
     group by a.id, a.code, a.balance_ugx
    having a.balance_ugx <> coalesce(sum(e.delta_ugx), 0)`);
  return rows.length === 0;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? undefined });

async function signIn(phone, viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Phone number').fill(phone);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 15_000 });
  page.on('dialog', (d) => d.accept());
  return { context, page };
}

const admin = await signIn('0772000001');
const manager = await signIn('0772000002');
const cashier = await signIn('0772000003', { width: 390, height: 844 });

// ---------------------------------------------------------------------------
console.log('\n  admin: the money the business starts with');
{
  const { page } = admin;
  const cash = await account('cash_at_hand');
  await page.goto(`${BASE}/finance/accounts/${cash.id}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Record opening balance' }).click();
  await page.locator('input[name="amount_ugx"]').fill('2000000');
  await page.locator('input[name="reason"]').last().fill('Float counted at go-live');
  await page.getByRole('button', { name: 'Record opening balance', exact: true }).last().click();
  await page.waitForTimeout(2000);

  check(await balance('cash_at_hand') === 2_000_000, 'the opening balance is on the account');
  check(await awaiting('cash_at_hand') === 0, 'an opening float is not counted as takings');

  const { rows } = await db.query(
    `select entry_type from public.financial_transactions where entry_type = 'opening_balance'`);
  check(rows.length === 1, 'and it posted one opening_balance ledger entry');

  // It can only be done once.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const again = await page.getByRole('button', { name: 'Record opening balance' }).count();
  check(again === 0, 'the action disappears once an opening balance exists');
}

// ---------------------------------------------------------------------------
console.log('\n  cashier: a cash payment reaches the account, the ledger and the day');
let invoiceId;
{
  const { page } = cashier;
  await page.goto(`${BASE}/customers/new`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Full name').fill(CUSTOMER);
  await page.getByLabel('Phone number').fill(`0${PHONE_DIGITS}`);
  await page.getByRole('button', { name: 'Add customer' }).click();
  await page.waitForURL(/\/customers\/[0-9a-f-]{36}$/, { timeout: 15_000 });

  await page.goto(`${BASE}/new-service`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Number plate').fill(PLATE);
  await page.waitForTimeout(700);
  await page.getByRole('link', { name: /Register/ }).click();
  await page.waitForURL(/\/vehicles\/new/, { timeout: 15_000 });
  await page.getByLabel('Model').fill('Harrier');
  await page.getByLabel('Colour').fill('Black');
  await page.getByLabel('Make').fill('Toyota');
  await page.selectOption('#customer_id', {
    label: (
      await page.locator('#customer_id option').filter({ hasText: CUSTOMER }).first().textContent()
    ).trim(),
  });
  await page.getByRole('button', { name: 'Register vehicle' }).click();
  await page.waitForURL(/\/new-service\?vehicle=/, { timeout: 15_000 });
  await page.getByLabel('Body Wash', { exact: true }).check();
  await page.getByRole('button', { name: 'Start service' }).click();
  await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 15_000 });

  const jobId = page.url().split('/').pop();
  const { rows: orders } = await db.query(
    `select id from public.worker_orders where service_intake_id = $1`, [jobId]);
  for (const order of orders) {
    await asUser(MANAGER, `select app.assign_worker_order($1, $2)`, [order.id, WORKER]);
    for (const action of ['accept', 'start', 'complete']) {
      await asUser(WORKER, `select app.update_worker_order_status($1, $2)`, [order.id, action]);
    }
  }

  await page.goto(`${BASE}/jobs/${jobId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Create invoice' }).click();
  await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  invoiceId = page.url().split('/').pop();

  const before = await balance('cash_at_hand');
  await page.getByRole('button', { name: 'Take payment' }).click();
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.waitForTimeout(2500);

  const after = await balance('cash_at_hand');
  check(after - before === 15_000, 'the cash payment raised the cash balance');
  check(await awaiting('cash_at_hand') === 15_000, 'and became cash awaiting banking');

  const entry = await one(
    `select t.entry_type, t.is_revenue, t.amount_ugx
       from public.financial_transactions t where t.entry_type = 'customer_payment'`);
  check(entry.is_revenue === true, 'the ledger entry is marked revenue');

  const day = await one(
    `select payments_in_ugx, transaction_count from public.finance_daily_summaries
      where business_day = app.eat_day()`);
  check(Number(day.payments_in_ugx) === 15_000, 'the day summary counted the payment');
  check(await ledgerAgrees(), 'every balance still equals its ledger');
}

// ---------------------------------------------------------------------------
console.log('\n  manager: banking the takings');
{
  const { page } = manager;
  await page.goto(`${BASE}/finance/banking`, { waitUntil: 'domcontentloaded' });
  const body = await page.textContent('body');
  check(body.includes('UGX 15,000'), 'the banking screen shows what is waiting');

  await page.locator('input[name="bank_reference"]').fill('SLIP-E2E-001');
  const prefilled = await page.locator('input[name="amount_ugx"]').inputValue();
  check(prefilled === '15000', 'the deposit is pre-filled with the waiting amount');
  await page.getByRole('button', { name: 'Record deposit' }).click();
  await page.waitForTimeout(2500);

  check(await awaiting('cash_at_hand') === 0, 'nothing is waiting once it is banked');
  check(await balance('stanbic_main') === 15_000, 'the bank account received it');
  check(await balance('cash_at_hand') === 2_000_000, 'and the cash account lost exactly that');

  const deposit = await one(
    `select deposit_number, status, transaction_id from public.bank_deposits`);
  check(/^RMX-BNK-\d{6}$/.test(deposit.deposit_number), `a deposit number was allocated (${deposit.deposit_number})`);
  check(deposit.transaction_id !== null, 'the deposit carries its ledger entry');

  const sides = await one(
    `select count(*)::int as n from public.financial_transaction_entries where transaction_id = $1`,
    [deposit.transaction_id]);
  check(sides.n === 2, 'one transaction, two account movements');
  check(await ledgerAgrees(), 'every balance still equals its ledger');
}

// ---------------------------------------------------------------------------
console.log('\n  manager: a transfer is atomic');
{
  const { page } = manager;
  await page.goto(`${BASE}/finance/transfers`, { waitUntil: 'domcontentloaded' });
  await page.selectOption('#from_account_id', { label: 'Cash at Hand' });
  await page.selectOption('#to_account_id', { label: 'Stanbic — Main' });
  await page.locator('input[name="amount_ugx"]').fill('500000');
  await page.locator('input[name="reason"]').fill('Banking the float');
  await page.getByRole('button', { name: 'Transfer' }).click();
  await page.waitForTimeout(2500);

  check(await balance('cash_at_hand') === 1_500_000, 'the source lost the money');
  check(await balance('stanbic_main') === 515_000, 'the destination gained it');

  const transfer = await one(
    `select id, transaction_number from public.financial_transactions
      where entry_type = 'account_transfer'`);
  check(/^RMX-TXN-\d{6}$/.test(transfer.transaction_number), 'one transaction number for the transfer');

  // An overdraft is refused and moves nothing.
  await page.goto(`${BASE}/finance/transfers`, { waitUntil: 'domcontentloaded' });
  await page.selectOption('#from_account_id', { label: 'Cash at Hand' });
  await page.selectOption('#to_account_id', { label: 'Stanbic — Main' });
  await page.locator('input[name="amount_ugx"]').fill('99000000');
  await page.locator('input[name="reason"]').fill('More than we hold');
  await page.getByRole('button', { name: 'Transfer' }).click();
  await page.waitForSelector('[data-form-error]', { timeout: 15_000 });
  const message = await page.locator('[data-form-error]').first().textContent();
  check(/available/i.test(message), 'an overdraft is refused with what is available');
  check(await balance('cash_at_hand') === 1_500_000, 'and nothing moved');
  check(await ledgerAgrees(), 'every balance still equals its ledger');
}

// ---------------------------------------------------------------------------
console.log('\n  offline: money and stock are refused, never queued');
{
  const { page, context } = manager;
  const cashBefore = await balance('cash_at_hand');

  await page.goto(`${BASE}/finance/transfers`, { waitUntil: 'domcontentloaded' });
  await page.selectOption('#from_account_id', { label: 'Cash at Hand' });
  await page.selectOption('#to_account_id', { label: 'Stanbic — Main' });
  await page.locator('input[name="amount_ugx"]').fill('10000');
  await page.locator('input[name="reason"]').fill('Offline attempt');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Transfer' }).click();
  await page.waitForSelector('[data-form-error]', { timeout: 15_000 });
  const message = await page.locator('[data-form-error]').first().textContent();
  check(/internet connection/i.test(message), 'an offline transfer is refused outright');
  check(/Nothing was sent/i.test(message), 'and the person is told nothing was sent');
  await context.setOffline(false);

  check(await balance('cash_at_hand') === cashBefore, 'nothing was queued: the balance is unchanged');
  const transfers = await one(
    `select count(*)::int as n from public.financial_transactions
      where entry_type = 'account_transfer' and amount_ugx = 10000`);
  check(transfers.n === 0, 'and no transfer exists');
}

// ---------------------------------------------------------------------------
console.log('\n  manager: an expense moves money only when it is paid');
let expenseId;
{
  const { page } = manager;
  await page.goto(`${BASE}/expenses/new`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="description"]').fill('Umeme bill, September');
  await page.selectOption('#category_id', { label: 'Utilities' });
  await page.locator('input[name="amount_ugx"]').fill('450000');
  await page.locator('input[name="payee"]').fill('Umeme Ltd');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await page.waitForURL(/\/expenses\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  expenseId = page.url().split('/').pop();

  const before = await balance('cash_at_hand');
  let expense = await one(`select status from public.expenses where id = $1`, [expenseId]);
  check(expense.status === 'pending_review', 'the expense is awaiting review');

  // Approval is refused before review.
  const approveCount = await page.getByRole('button', { name: 'Approve' }).count();
  check(approveCount === 0, 'Approve is not offered before the expense is reviewed');

  await page.getByRole('button', { name: 'Mark reviewed' }).click();
  await page.locator('input[name="notes"]').fill('Checked against the meter reading');
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).last().click();
  await page.waitForTimeout(2000);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.waitForTimeout(2000);

  expense = await one(`select status from public.expenses where id = $1`, [expenseId]);
  check(expense.status === 'approved', 'the expense is approved');
  check(await balance('cash_at_hand') === before, 'and still nothing has moved');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Pay expense' }).click();
  await page.selectOption('#account_id', { label: 'Cash at Hand' });
  await page.getByRole('button', { name: 'Pay expense', exact: true }).last().click();
  await page.waitForTimeout(2500);

  check(await balance('cash_at_hand') === before - 450_000, 'paying it took the money out');
  const paid = await one(
    `select status, financial_transaction_number from public.expenses where id = $1`, [expenseId]);
  check(paid.status === 'paid', 'the expense is paid');
  check(/^RMX-TXN-/.test(paid.financial_transaction_number ?? ''), 'and carries its ledger entry');

  const day = await one(
    `select expenses_paid_ugx, purchases_paid_ugx from public.finance_daily_summaries
      where business_day = app.eat_day()`);
  check(Number(day.expenses_paid_ugx) === 450_000, 'the day summary counted the expense');
  check(await ledgerAgrees(), 'every balance still equals its ledger');
}

// ---------------------------------------------------------------------------
console.log('\n  admin: reversing the payment puts it back');
{
  const { page } = admin;
  const txn = await one(
    `select financial_transaction_id as id from public.expenses where id = $1`, [expenseId]);
  const before = await balance('cash_at_hand');

  await page.goto(`${BASE}/transactions/${txn.id}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Reverse this transaction' }).click();
  await page.locator('input[name="reason"]').last().fill('Paid from the wrong account');
  await page.getByRole('button', { name: 'Reverse transaction' }).click();
  await page.waitForTimeout(2500);

  check(await balance('cash_at_hand') === before + 450_000, 'the money came back');
  const expense = await one(
    `select status, financial_transaction_id, payment_reversal_reason
       from public.expenses where id = $1`, [expenseId]);
  check(expense.status === 'approved', 'the expense went back to approved');
  check(expense.financial_transaction_id === null, 'and no longer names a payment');
  check(/wrong account/i.test(expense.payment_reversal_reason ?? ''), 'the reason is kept');

  const kept = await one(
    `select status from public.financial_transactions where id = $1`, [txn.id]);
  check(kept.status === 'reversed', 'the original entry is kept and marked reversed');
  check(await ledgerAgrees(), 'every balance still equals its ledger');
}

// ---------------------------------------------------------------------------
console.log('\n  manager: a supplier, a purchase and the stock it brings');
let itemId;
{
  const { page } = manager;
  await page.goto(`${BASE}/inventory/suppliers`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'New supplier' }).click();
  await page.locator('input[name="name"]').fill(SUPPLIER);
  await page.locator('input[name="contact_person"]').fill('Sarah N');
  await page.locator('input[name="phone"]').fill('0772 111 222');
  await page.getByRole('button', { name: 'Add supplier' }).click();
  await page.waitForTimeout(2500);

  const supplier = await one(`select supplier_number from public.suppliers where name = $1`, [SUPPLIER]);
  check(/^RMX-SUP-\d{6}$/.test(supplier.supplier_number), `the supplier was numbered (${supplier.supplier_number})`);

  await page.goto(`${BASE}/inventory/items/new`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="name"]').fill(ITEM);
  await page.selectOption('#category', 'soaps_shampoo');
  await page.selectOption('#unit', 'litre');
  await page.locator('input[name="minimum_stock"]').fill('5');
  await page.locator('input[name="reorder_level"]').fill('10');
  await page.locator('input[name="last_unit_cost_ugx"]').fill('15000');
  await page.getByRole('button', { name: 'Create item' }).click();
  await page.waitForURL(/\/inventory\/items\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  itemId = page.url().split('/').pop();

  const item = await one(`select sku, quantity, stock_status from public.inventory_items where id = $1`, [itemId]);
  check(/^RMX-SOAP-\d{3,}$/.test(item.sku), `the SKU came from the category (${item.sku})`);
  check(item.stock_status === 'out_of_stock', 'a new item with no stock is out of stock');

  const cashBefore = await balance('cash_at_hand');
  const expensesBefore = Number((await one(
    `select expenses_paid_ugx from public.finance_daily_summaries where business_day = app.eat_day()`
  )).expenses_paid_ugx);
  await page.goto(`${BASE}/inventory/purchases/new`, { waitUntil: 'domcontentloaded' });
  await page.selectOption('#supplier_id', { label: SUPPLIER });
  await page.getByLabel('Item 1').selectOption({ label: `${ITEM} (${item.sku})` });
  await page.locator('input[type="number"]').first().fill('20');
  await page.getByRole('button', { name: 'Raise purchase' }).click();
  await page.waitForURL(/\/inventory\/purchases\/[0-9a-f-]{36}$/, { timeout: 15_000 });

  const purchase = await one(
    `select purchase_number, total_ugx, status from public.inventory_purchases`);
  check(Number(purchase.total_ugx) === 300_000, 'the SERVER priced the purchase at 20 × 15,000');
  check(purchase.status === 'approved', 'a manager may approve their own purchase');

  await page.getByRole('button', { name: 'Receive stock' }).click();
  await page.getByLabel(/Pay UGX 300,000 at the same time/).check();
  await page.selectOption('#pay_from_account_id', { label: 'Cash at Hand' });
  await page.getByRole('button', { name: 'Receive stock', exact: true }).last().click();
  await page.waitForTimeout(3000);

  check((await stockOf(ITEM)).quantity === 20, 'the stock arrived');
  check(await balance('cash_at_hand') === cashBefore - 300_000, 'and the money left in the same act');

  const day = await one(
    `select expenses_paid_ugx, purchases_paid_ugx from public.finance_daily_summaries
      where business_day = app.eat_day()`);
  check(Number(day.purchases_paid_ugx) === 300_000, 'it counted as a stock purchase');
  // Stock is never an operating expense, so the expense total does not move.
  check(Number(day.expenses_paid_ugx) === expensesBefore, 'and NOT as an expense');

  const expenses = await one(`select count(*)::int as n from public.expenses`);
  check(expenses.n === 1, 'no expense record was created for the stock');
  check(await ledgerAgrees(), 'every balance still equals its ledger');
}

// ---------------------------------------------------------------------------
console.log('\n  stock going out, and the high-value rule');
{
  const { page } = manager;
  await page.goto(`${BASE}/inventory/items/${itemId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Use / stock out' }).click();
  await page.selectOption('#type', 'usage');
  await page.locator('input[name="quantity"]').fill('6');
  await page.locator('input[name="reason"]').last().fill('Used on UEH 901G');
  await page.getByRole('button', { name: 'Record movement' }).click();
  await page.waitForTimeout(2500);

  check((await stockOf(ITEM)).quantity === 14, 'the quantity fell by exactly what was used');

  // 14 × 15,000 = 210,000, which is over the 200,000 threshold.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Use / stock out' }).click();
  await page.selectOption('#type', 'stock_out');
  await page.locator('input[name="quantity"]').fill('14');
  await page.waitForTimeout(300);
  const warning = await page.textContent('body');
  check(/threshold/i.test(warning), 'a high-value stock-out is flagged before it is sent');

  await page.locator('input[name="reason"]').last().fill('Whole drum contaminated');
  await page.selectOption('#reason_code', 'damaged');
  await page.getByRole('button', { name: 'Record movement' }).click();
  await page.waitForTimeout(2500);

  check((await stockOf(ITEM)).quantity === 0, 'an authorised person may do it');
  const approved = await one(
    `select approved_by from public.stock_movements
      where type = 'stock_out' order by created_at desc limit 1`);
  check(approved.approved_by !== null, 'and the approver is recorded on the movement');

  const event = await one(
    `select type from public.inventory_events order by created_at desc limit 1`);
  check(event.type === 'out_of_stock', 'an out-of-stock event was raised');

  // Stock is never queued either.
  await asUser(MANAGER, `select * from app.record_stock_movement($1, 'stock_in', 4, 'Restock', $2)`,
    [itemId, 'e2e-offline-restk']);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Use / stock out' }).click();
  await page.locator('input[name="quantity"]').fill('2');
  await page.locator('input[name="reason"]').last().fill('Offline attempt');
  await manager.context.setOffline(true);
  await page.getByRole('button', { name: 'Record movement' }).click();
  await page.waitForSelector('[data-form-error]', { timeout: 15_000 });
  const offline = await page.locator('[data-form-error]').first().textContent();
  check(/internet connection/i.test(offline), 'an offline stock movement is refused outright');
  await manager.context.setOffline(false);
  check((await stockOf(ITEM)).quantity === 4, 'and the quantity did not move');
}

{
  // A worker who may record usage but not adjust stock cannot do the same.
  const { rows } = await db.query(
    `update public.users set permissions = array['inventory.view', 'inventory.stock.out']
      where id = $1 returning id`, [WORKER]);
  void rows;
  await asUser(MANAGER, `select * from app.record_stock_movement($1, 'stock_in', 20, 'Restock', $2)`,
    [itemId, 'e2e-restock-0001']);
  const held = (await stockOf(ITEM)).quantity;

  let refused = '';
  try {
    await asUser(WORKER, `select * from app.record_stock_movement($1, 'stock_out', 14, 'Damaged', $2, 'damaged')`,
      [itemId, 'e2e-worker-out-01']);
  } catch (e) {
    refused = e.message;
  }
  check(/manager/i.test(refused), `a worker is refused the high-value stock-out (${refused.slice(0, 40)})`);
  check((await stockOf(ITEM)).quantity === held, 'and the stock did not move');

  await db.query(`update public.users set permissions = '{}' where id = $1`, [WORKER]);
}

// ---------------------------------------------------------------------------
console.log('\n  the cashier sees no balances, and can still take payments');
{
  const { page } = cashier;
  for (const path of ['/finance', '/transactions', '/reconciliation', '/inventory']) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    check(page.url().includes('module-unavailable'), `the cashier is turned away from ${path}`);
  }

  await page.goto(`${BASE}/expenses`, { waitUntil: 'domcontentloaded' });
  check(!page.url().includes('module-unavailable'), 'but may see the expenses they record');

  await page.goto(`${BASE}/invoices/${invoiceId}`, { waitUntil: 'domcontentloaded' });
  const body = await page.textContent('body');
  check(!/2,000,000|1,050,000|Total funds/.test(body), 'no account balance appears on their screens');
}

// ---------------------------------------------------------------------------
console.log('\n  reconciliation derives its own figures');
{
  const { page } = manager;
  const held = await balance('cash_at_hand');
  await page.goto(`${BASE}/reconciliation`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Reconcile an account' }).click();
  await page.selectOption('#account_id', { label: 'Cash at Hand' });
  await page.locator('input[name="actual_balance_ugx"]').fill(String(held - 20_000));
  await page.waitForTimeout(300);
  const preview = await page.textContent('body');
  check(/Difference/.test(preview), 'the difference is previewed before saving');

  await page.getByRole('button', { name: 'Record the count' }).click();
  await page.waitForTimeout(2500);

  const record = await one(
    `select reconciliation_number, system_balance_ugx, difference_ugx, status
       from public.reconciliations order by created_at desc limit 1`);
  check(Number(record.system_balance_ugx) === held, 'the system figure came from the server');
  check(Number(record.difference_ugx) === -20_000, 'the difference was computed by the database');
  check(record.status === 'discrepancy', 'and the reconciliation is open');
  check(await balance('cash_at_hand') === held, 'recording a count changed no balance');

  const { page: adminPage } = admin;
  await adminPage.goto(`${BASE}/reconciliation`, { waitUntil: 'domcontentloaded' });
  await adminPage.getByRole('button', { name: 'Close a difference' }).click();
  await adminPage.locator('input[name="reason"]').last().fill('Counted short at close of day');
  await adminPage.getByRole('button', { name: 'Record adjustment' }).click();
  await adminPage.waitForTimeout(2500);

  const closed = await one(
    `select status from public.reconciliations order by created_at desc limit 1`);
  check(closed.status === 'adjusted', 'an adjustment closed it');
  check(await balance('cash_at_hand') === held - 20_000, 'and the balance now matches the count');
  check(await ledgerAgrees(), 'every balance still equals its ledger');
}

// ---------------------------------------------------------------------------
console.log('\n  Phase D still works after the finance model was extended');
{
  const { page } = cashier;
  await page.goto(`${BASE}/invoices`, { waitUntil: 'domcontentloaded' });
  const body = await page.textContent('body');
  check(body.includes('UGX 15,000'), 'the invoice list still reads correctly');

  const receipt = await one(`select receipt_number from public.receipts limit 1`);
  await page.goto(`${BASE}/receipts/${receipt.receipt_number}`, { waitUntil: 'domcontentloaded' });
  check((await page.textContent('body')).includes(receipt.receipt_number), 'the receipt still opens');
}

await admin.context.close();
await manager.context.close();
await cashier.context.close();
await browser.close();
await db.end();

console.log(
  failures === 0
    ? '\nAll Phase E workflow checks passed.'
    : `\n${failures} Phase E workflow check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
