#!/usr/bin/env node
/**
 * The Phase D money workflow, driven through the real browser against the real
 * database.
 *
 *   Cashier:  customer -> vehicle -> services -> job
 *   Manager:  assign -> (worker completes) -> create invoice -> discount
 *   Cashier:  partial payment -> receipt -> final payment -> loyalty earned
 *   Admin:    reverse a payment -> the balance and the points come back
 *   Cashier:  pay again -> redeem a loyalty reward -> put on credit
 *   Manager:  cancel the invoice -> the reward is returned
 *
 * Every assertion about money is read back from the DATABASE, not from the
 * page: the page is where a person looks, the database is where the truth is.
 *
 * The offline rule is exercised for real, with the browser context switched
 * offline mid-flow: the payment must be refused outright and nothing queued.
 */
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres:devonly@127.0.0.1:5432/ramosmax_dev';
const PASSWORD = 'DevP@ssw0rd!';
const PLATE = 'UEG 701F';
const CUSTOMER = 'E2E Billing Customer';
const PHONE_DIGITS = '772990201';

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

const { rows: existing } = await db.query(
  `select count(*)::int as n from public.customers where phone_number = $1`,
  [`+256${PHONE_DIGITS}`],
);
if (existing[0].n > 0) {
  console.error('\n  This script needs a fresh database. Run: npm run db:reset');
  process.exit(1);
}

/**
 * Calls a function the way PostgREST would: as `authenticated`, with the
 * caller's claims set. Used only to drive steps whose browser path Phase C
 * already covers, and to re-send a payment the browser has already sent.
 */
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
const invoiceState = (id) =>
  one(
    `select invoice_number, subtotal_ugx, discount_ugx, total_ugx, paid_ugx,
            outstanding_ugx, payment_status, status, on_credit
       from public.invoices where id = $1`,
    [id],
  );
const loyaltyState = (vehicleId) =>
  one(
    `select coalesce(a.points_balance, 0) as points,
            (select count(*)::int from public.loyalty_rewards r
              where r.vehicle_id = $1 and r.status = 'available') as available
       from public.loyalty_accounts a where a.vehicle_id = $1`,
    [vehicleId],
  );

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? undefined });

async function signIn(phone, viewport = { width: 390, height: 844 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Phone number').fill(phone);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 15_000 });
  // Every confirmation in this phase is a real window.confirm; accept it.
  page.on('dialog', (d) => d.accept());
  return { context, page };
}

const cashier = await signIn('0772000003');
const manager = await signIn('0772000002', { width: 1280, height: 800 });
const admin = await signIn('0772000001', { width: 1280, height: 800 });

// ---------------------------------------------------------------------------
console.log('\n  cashier: a job to bill');
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
  await page.getByLabel('Model').fill('Premio');
  await page.getByLabel('Colour').fill('White');
  await page.getByLabel('Make').fill('Toyota');
  await page.selectOption('#customer_id', {
    label: (
      await page.locator('#customer_id option').filter({ hasText: CUSTOMER }).first().textContent()
    ).trim(),
  });
  await page.getByRole('button', { name: 'Register vehicle' }).click();
  await page.waitForURL(/\/new-service\?vehicle=/, { timeout: 15_000 });

  // Body Wash 15,000 + Interior Vacuum 10,000. Both qualify for loyalty.
  await page.getByLabel('Body Wash', { exact: true }).check();
  await page.getByLabel('Interior Vacuum', { exact: true }).check();
  await page.getByRole('button', { name: 'Start service' }).click();
  await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  check(true, 'a job was created for the new vehicle');
}

const jobId = cashier.page.url().split('/').pop();
const vehicleId = (
  await one(`select vehicle_id from public.service_intakes where id = $1`, [jobId])
).vehicle_id;

// ---------------------------------------------------------------------------
console.log('\n  the job cannot be invoiced before it is finished');
{
  const { page } = manager;
  await page.goto(`${BASE}/jobs/${jobId}`, { waitUntil: 'domcontentloaded' });
  const body = await page.textContent('body');
  check(!/Create invoice/.test(body), 'no invoice action is offered on an unfinished job');

  let refused = '';
  try {
    await asUser(MANAGER, `select app.create_invoice($1)`, [jobId]);
  } catch (e) {
    refused = e.message;
  }
  check(/not complete|completed/i.test(refused), `the RPC refuses it too (${refused.slice(0, 48)})`);
}

// Assignment and the work itself are Phase C, and already covered in the
// browser by check-operations-e2e. Drive them directly to reach the money.
{
  const { rows: orders } = await db.query(
    `select id from public.worker_orders where service_intake_id = $1 order by order_number`,
    [jobId],
  );
  for (const order of orders) {
    await asUser(MANAGER, `select app.assign_worker_order($1, $2)`, [order.id, WORKER]);
    for (const action of ['accept', 'start', 'complete']) {
      await asUser(WORKER, `select app.update_worker_order_status($1, $2)`, [order.id, action]);
    }
  }
  const job = await one(`select status from public.service_intakes where id = $1`, [jobId]);
  check(job.status === 'completed', 'the job is completed and ready to invoice');
}

// ---------------------------------------------------------------------------
console.log('\n  manager: create the invoice from the finished job');
{
  const { page } = manager;
  await page.goto(`${BASE}/jobs/${jobId}`, { waitUntil: 'domcontentloaded' });
  check(
    (await page.textContent('body')).includes('Ready to invoice'),
    'the finished job offers invoicing',
  );
  await page.getByRole('button', { name: 'Create invoice' }).click();
  await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  check(true, 'creating the invoice opens it');
}

const invoiceId = manager.page.url().split('/').pop();
{
  const inv = await invoiceState(invoiceId);
  check(/^RMX-INV-\d{6}$/.test(inv.invoice_number), `an invoice number was allocated (${inv.invoice_number})`);
  check(Number(inv.subtotal_ugx) === 25000, 'the subtotal comes from the job price snapshot');
  check(Number(inv.total_ugx) === 25000, 'the total is computed by the database');
  check(inv.payment_status === 'unpaid', 'the invoice starts unpaid');

  const body = await manager.page.textContent('body');
  check(body.includes('UGX 25,000'), 'the invoice shows the total');

  // A second invoice for the same job is refused.
  let refused = '';
  try {
    await asUser(MANAGER, `select app.create_invoice($1)`, [jobId]);
  } catch (e) {
    refused = e.message;
  }
  check(/already/i.test(refused), 'a second invoice for the same job is refused');
}

// ---------------------------------------------------------------------------
console.log('\n  cashier: may take payment, may not discount or void');
{
  const { page } = cashier;
  await page.goto(`${BASE}/invoices/${invoiceId}`, { waitUntil: 'domcontentloaded' });
  const body = await page.textContent('body');
  check(body.includes('Take payment'), 'the cashier is offered Take payment');
  check(!body.includes('Apply discount'), 'the cashier is not offered a discount');
  check(!body.includes('Cancel invoice'), 'the cashier is not offered a cancellation');

  // Knowing the RPC name changes nothing.
  let refused = '';
  try {
    await asUser(
      (await one(`select id from public.users where phone_number = '+256772000003'`)).id,
      `select app.apply_invoice_discount($1, 'percentage', 10, 'promotional')`,
      [invoiceId],
    );
  } catch (e) {
    refused = e.message;
  }
  check(/permission|not allowed|denied/i.test(refused), 'and the RPC refuses the cashier directly');
}

// ---------------------------------------------------------------------------
console.log('\n  manager: a discount, previewed and applied');
{
  const { page } = manager;
  await page.goto(`${BASE}/invoices/${invoiceId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Apply discount' }).click();

  // Above the Phase 9 threshold the counter is warned before anything is sent.
  await page.locator('input[name="discount_value"]').fill('30');
  await page.waitForTimeout(250);
  check(
    (await page.textContent('body')).includes('Above 25%'),
    'a discount above 25% warns that a manager must approve it',
  );

  await page.locator('input[name="discount_value"]').fill('10');
  await page.waitForTimeout(250);
  check(
    (await page.textContent('body')).includes('UGX 2,500 off'),
    'the preview rounds 10% of 25,000 to 2,500',
  );
  await page.getByRole('button', { name: 'Apply discount', exact: true }).last().click();
  await page.waitForTimeout(2000);

  const inv = await invoiceState(invoiceId);
  check(Number(inv.discount_ugx) === 2500, 'the server applied the same 2,500');
  check(Number(inv.total_ugx) === 22500, 'the total fell to 22,500');
  check(Number(inv.outstanding_ugx) === 22500, 'the outstanding balance followed');
}

// ---------------------------------------------------------------------------
console.log('\n  offline: a payment is refused, never queued');
{
  const { page, context } = cashier;
  await page.goto(`${BASE}/invoices/${invoiceId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Take payment' }).click();
  await page.locator('input[name="amount_ugx"]').fill('10000');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.waitForSelector('[data-form-error]', { timeout: 15_000 });
  const message = await page.locator('[data-form-error]').first().textContent();
  check(/internet connection/i.test(message), 'the offline payment is refused outright');
  check(/Nothing was sent/i.test(message), 'and the person is told nothing was sent');
  await context.setOffline(false);

  const { rows } = await db.query(`select count(*)::int as n from public.payments where invoice_id = $1`, [
    invoiceId,
  ]);
  check(rows[0].n === 0, 'nothing was queued: no payment exists');
}

// ---------------------------------------------------------------------------
console.log('\n  cashier: a part payment');
{
  const { page } = cashier;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Take payment' }).click();

  const prefilled = await page.locator('input[name="amount_ugx"]').inputValue();
  check(prefilled === '22500', 'the amount defaults to the outstanding balance');

  await page.locator('input[name="amount_ugx"]').fill('30000');
  await page.waitForTimeout(200);
  check(
    (await page.textContent('body')).includes('more than the outstanding balance'),
    'an overpayment is flagged before it is sent',
  );

  await page.locator('input[name="amount_ugx"]').fill('10000');
  const requestId = await page.locator('input[name="request_id"]').inputValue();
  check(/^[0-9a-f-]{36}$/.test(requestId), 'the form carries one request id');

  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.waitForTimeout(2500);

  const inv = await invoiceState(invoiceId);
  check(Number(inv.paid_ugx) === 10000, 'the payment was recorded');
  check(Number(inv.outstanding_ugx) === 12500, '12,500 remains outstanding');
  check(inv.payment_status === 'partially_paid', 'the invoice is partially paid');

  const payment = await one(
    `select p.id, p.amount_ugx, p.request_id, p.financial_transaction_id, r.receipt_number
       from public.payments p join public.receipts r on r.payment_id = p.id
      where p.invoice_id = $1`,
    [invoiceId],
  );
  check(payment.financial_transaction_id !== null, 'the payment is posted to the ledger');
  check(/^RMX-RCP-/.test(payment.receipt_number), 'a receipt was issued in the same transaction');

  const ledger = await one(
    `select t.amount_ugx, t.direction, a.balance_ugx
       from public.financial_transactions t join public.financial_accounts a on a.id = t.account_id
      where t.id = $1`,
    [payment.financial_transaction_id],
  );
  check(Number(ledger.amount_ugx) === 10000 && ledger.direction === 'in', 'the ledger entry matches the payment');

  // The same request id, sent again: the first result, not a second charge.
  const again = await asUser(
    (await one(`select id from public.users where phone_number = '+256772000003'`)).id,
    `select * from app.record_payment($1, 10000, 'cash', $2)`,
    [invoiceId, payment.request_id],
  );
  check(again.rows[0].payment_id === payment.id, 'a retry with the same request id returns the first payment');
  const after = await invoiceState(invoiceId);
  check(Number(after.paid_ugx) === 10000, 'and charges nothing further');

  await page.reload({ waitUntil: 'domcontentloaded' });
  const body = await page.textContent('body');
  check(body.includes('Partially paid'), 'the page shows the invoice as partially paid');
  check(body.includes('UGX 12,500'), 'and shows the remaining balance');
  check(body.includes(payment.receipt_number), 'the receipt number is linked from the invoice');
}

// ---------------------------------------------------------------------------
console.log('\n  the receipt');
const receiptNumber = (
  await one(`select r.receipt_number from public.receipts r where r.invoice_id = $1`, [invoiceId])
).receipt_number;
{
  const { page } = cashier;
  await page.goto(`${BASE}/receipts/${receiptNumber}`, { waitUntil: 'domcontentloaded' });
  const body = await page.textContent('body');
  check(body.includes(receiptNumber), 'the receipt opens by its number');
  check(body.includes('UGX 10,000'), 'it shows the payment');
  check(body.includes('UGX 12,500'), 'it shows the balance after the payment');
  check(body.includes(PLATE), 'it shows the vehicle');
  check(body.includes(CUSTOMER), 'it shows the customer');
  check((await page.getByRole('button', { name: /Share/ }).count()) === 1, 'it offers Share / print');
}

// ---------------------------------------------------------------------------
console.log('\n  cashier: settle the balance, and the points are earned');
{
  const { page } = cashier;
  await page.goto(`${BASE}/invoices/${invoiceId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Take payment' }).click();
  await page.selectOption('#method', 'mtn_merchant');
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.waitForSelector('[data-form-error]', { timeout: 15_000 });
  check(
    /reference/i.test(await page.locator('[data-form-error]').first().textContent()),
    'a mobile-money payment without a reference is refused',
  );

  await page.locator('input[name="reference"]').fill('MTN-E2E-0001');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.waitForTimeout(2500);

  const inv = await invoiceState(invoiceId);
  check(Number(inv.paid_ugx) === 22500, 'the invoice is fully paid');
  check(Number(inv.outstanding_ugx) === 0, 'nothing is outstanding');
  check(inv.payment_status === 'paid', 'the status is paid');

  const loyalty = await loyaltyState(vehicleId);
  check(loyalty.points === 40, 'two qualifying services earned 40 points on full payment');
}

// ---------------------------------------------------------------------------
console.log('\n  admin: reverse a payment; the balance and the points come back');
{
  const { page } = admin;
  await page.goto(`${BASE}/invoices/${invoiceId}`, { waitUntil: 'domcontentloaded' });
  check((await page.textContent('body')).includes('Reverse'), 'the admin is offered a reversal');

  const cashierPage = cashier.page;
  await cashierPage.goto(`${BASE}/invoices/${invoiceId}`, { waitUntil: 'domcontentloaded' });
  check(
    (await cashierPage.getByRole('button', { name: 'Reverse', exact: true }).count()) === 0,
    'the cashier is not',
  );

  await page.getByRole('button', { name: 'Reverse', exact: true }).last().click();
  await page.locator('input[name="reason"]').last().fill('Customer disputed the mobile money entry');
  await page.getByRole('button', { name: 'Reverse payment' }).click();
  await page.waitForTimeout(2500);

  const inv = await invoiceState(invoiceId);
  check(Number(inv.paid_ugx) === 10000, 'the reversed amount left the invoice');
  check(Number(inv.outstanding_ugx) === 12500, 'the balance came back');
  check(inv.payment_status === 'partially_paid', 'the invoice is partially paid again');

  const reversed = await one(
    `select count(*)::int as n from public.payments
      where invoice_id = $1 and status = 'reversed'`,
    [invoiceId],
  );
  check(reversed.n === 1, 'the payment is kept and marked reversed, not deleted');

  const receipts = await one(
    `select count(*)::int as n from public.receipts
      where invoice_id = $1 and status = 'reversed'`,
    [invoiceId],
  );
  check(receipts.n === 1, 'its receipt is kept and marked reversed');

  const entries = await one(
    `select count(*)::int as n from public.financial_transactions
      where entry_type = 'reversal' and reverses_id is not null`,
  );
  check(entries.n >= 1, 'the money was taken back out of the account with a reversal entry');

  const loyalty = await loyaltyState(vehicleId);
  check(loyalty.points === 0, 'the loyalty points were taken back');
}

// ---------------------------------------------------------------------------
console.log('\n  cashier: pay again; the points are earned again');
{
  const { page } = cashier;
  await page.goto(`${BASE}/invoices/${invoiceId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Take payment' }).click();
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.waitForTimeout(2500);

  const inv = await invoiceState(invoiceId);
  check(inv.payment_status === 'paid', 'the invoice is paid again');
  const loyalty = await loyaltyState(vehicleId);
  check(loyalty.points === 40, 'and the points are earned again');
}

// ---------------------------------------------------------------------------
console.log('\n  manager: a loyalty correction unlocks a reward');
{
  const { page } = manager;
  await page.goto(`${BASE}/loyalty/${vehicleId}`, { waitUntil: 'domcontentloaded' });
  const body = await page.textContent('body');
  check(body.includes('40'), 'the vehicle ledger shows the balance');
  check(/earned/i.test(body), 'the earning entry is in the ledger');

  await page.getByRole('button', { name: 'Adjust points' }).click();
  await page.locator('input[name="points"]').fill('200');
  await page.locator('input[name="reason"]').last().fill('Goodwill for the disputed payment');
  await page.getByRole('button', { name: 'Apply adjustment' }).click();
  await page.waitForTimeout(2500);

  const loyalty = await loyaltyState(vehicleId);
  check(loyalty.points === 240, 'the adjustment was applied to the balance');
  check(loyalty.available === 1, 'crossing the threshold unlocked exactly one reward');

  const sum = await one(
    `select coalesce(sum(points), 0)::int as total from public.loyalty_transactions where vehicle_id = $1`,
    [vehicleId],
  );
  check(sum.total === 240, 'the ledger sums to the balance');
}

// ---------------------------------------------------------------------------
console.log('\n  a second visit: the reward is redeemed on the next invoice');
let secondInvoice;
{
  const { page } = cashier;
  await page.goto(`${BASE}/new-service?vehicle=${vehicleId}`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Full Valet', { exact: true }).check();
  await page.getByRole('button', { name: 'Start service' }).click();
  await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const secondJob = page.url().split('/').pop();

  const { rows: orders } = await db.query(
    `select id from public.worker_orders where service_intake_id = $1`,
    [secondJob],
  );
  for (const order of orders) {
    await asUser(MANAGER, `select app.assign_worker_order($1, $2)`, [order.id, WORKER]);
    for (const action of ['accept', 'start', 'complete']) {
      await asUser(WORKER, `select app.update_worker_order_status($1, $2)`, [order.id, action]);
    }
  }

  await page.goto(`${BASE}/jobs/${secondJob}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Create invoice' }).click();
  await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  secondInvoice = page.url().split('/').pop();

  const body = await page.textContent('body');
  check(body.includes('Use loyalty reward'), 'the available reward is offered on the new invoice');

  await page.getByRole('button', { name: 'Use loyalty reward' }).click();
  await page.waitForTimeout(300);
  check(
    (await page.textContent('body')).includes('25% off — UGX 22,500'),
    'the reward previews 25% of 90,000 as 22,500',
  );
  await page.getByRole('button', { name: 'Use the reward' }).click();
  await page.waitForTimeout(2500);

  const inv = await invoiceState(secondInvoice);
  check(Number(inv.discount_ugx) === 22500, 'the server applied exactly the previewed amount');
  check(Number(inv.total_ugx) === 67500, 'the total fell to 67,500');

  const loyalty = await loyaltyState(vehicleId);
  check(loyalty.points === 40, '200 points were consumed by the redemption');
  check(loyalty.available === 0, 'no reward remains available');

  const discount = await one(
    `select source, reason_code from public.discounts where invoice_id = $1 and status = 'active'`,
    [secondInvoice],
  );
  check(discount.source === 'loyalty_reward', 'the redemption is recorded as a loyalty discount');
}

// ---------------------------------------------------------------------------
console.log('\n  cashier: the customer leaves owing; credit is not cash');
{
  const { page } = cashier;
  // Relative, not absolute: another script may have put money in this account
  // before this one ran. What matters is that credit moves NONE.
  const cashBefore = Number(
    (await one(`select balance_ugx from public.financial_accounts where code = 'cash_at_hand'`))
      .balance_ugx,
  );
  await page.goto(`${BASE}/invoices/${secondInvoice}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Put on credit' }).click();
  await page.locator('input[name="reason"]').last().fill('Regular customer, paying on Friday');
  await page.getByRole('button', { name: 'Put on credit', exact: true }).last().click();
  await page.waitForTimeout(2500);

  const inv = await invoiceState(secondInvoice);
  check(inv.on_credit === true, 'the invoice is marked on credit');
  check(inv.payment_status === 'credit', 'the status is credit');
  check(Number(inv.paid_ugx) === 0, 'no money was received');

  const cash = await one(
    `select balance_ugx from public.financial_accounts where code = 'cash_at_hand'`,
  );
  check(Number(cash.balance_ugx) === cashBefore, 'putting an invoice on credit moved no cash');

  await page.goto(`${BASE}/credit`, { waitUntil: 'domcontentloaded' });
  const body = await page.textContent('body');
  check(body.includes(PLATE), 'the invoice appears on the receivables screen');
  check(body.includes('UGX 67,500'), 'with the amount owed');
}

// ---------------------------------------------------------------------------
console.log('\n  manager: cancelling the invoice returns the reward');
{
  const { page } = manager;
  await page.goto(`${BASE}/invoices/${secondInvoice}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Cancel invoice' }).click();
  await page.locator('input[name="reason"]').last().fill('Job redone under warranty');
  await page.getByRole('button', { name: 'Cancel invoice', exact: true }).last().click();
  await page.waitForTimeout(2500);

  const inv = await invoiceState(secondInvoice);
  check(inv.status === 'cancelled', 'the invoice is cancelled, not deleted');
  check(inv.payment_status === 'cancelled', 'and reports itself cancelled');
  check(Number(inv.discount_ugx) === 0, 'the reward discount was removed');

  const loyalty = await loyaltyState(vehicleId);
  check(loyalty.points === 240, 'the 200 points came back');
  check(loyalty.available === 1, 'and the reward is available again');
}

// ---------------------------------------------------------------------------
console.log('\n  the money screens are closed to a worker');
{
  const worker = await signIn('0772000004');
  const { page } = worker;
  for (const path of ['/invoices', '/payments', '/receipts', '/credit', '/loyalty']) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    check(page.url().includes('module-unavailable'), `the worker is turned away from ${path}`);
  }

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Open menu' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  for (const hidden of ['Invoices', 'Payments', 'Receipts', 'Credit', 'Loyalty']) {
    check(
      (await drawer.getByRole('link', { name: hidden, exact: true }).count()) === 0,
      `the worker's menu does not offer ${hidden}`,
    );
  }
  await worker.context.close();
}

// ---------------------------------------------------------------------------
console.log('\n  payments and receipts lists');
{
  const { page } = manager;
  await page.goto(`${BASE}/payments`, { waitUntil: 'domcontentloaded' });
  const payments = await page.textContent('body');
  check(payments.includes('UGX 10,000'), 'the payments screen lists the part payment');
  check(payments.includes('Reversed'), 'and marks the reversed one');

  await page.goto(`${BASE}/receipts`, { waitUntil: 'domcontentloaded' });
  check((await page.textContent('body')).includes(receiptNumber), 'the receipts screen lists the receipt');
}

await cashier.context.close();
await manager.context.close();
await admin.context.close();
await browser.close();
await db.end();

console.log(
  failures === 0
    ? '\nAll Phase D workflow checks passed.'
    : `\n${failures} Phase D workflow check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
