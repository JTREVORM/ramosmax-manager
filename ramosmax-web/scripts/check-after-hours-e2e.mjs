#!/usr/bin/env node
/**
 * The after-hours and cash-handover workflows, driven through the real
 * browser against the real database.
 *
 *   Manager: authorise a worker for the evening, with a float
 *   Worker:  start a session, take cash and mobile money, watch the amount
 *            they owe rise — and be unable to change it
 *   Worker:  close the session; the amount to hand over is frozen
 *   Worker:  declare what they are handing over
 *   Manager: count it, come up short, open a discrepancy
 *   Manager: review it, resolve it, report a loss and align the account
 *   Worker:  see their own record and nothing else
 *   Offline: starting a session is refused outright, never queued
 *
 * Run it after the billing script and before the responsive script. Every
 * figure is read back from the DATABASE, because the point of this workstream
 * is that the browser never decides what anybody owes.
 */
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres:devonly@127.0.0.1:5432/ramosmax_dev';
const PASSWORD = 'DevP@ssw0rd!';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const MANAGER = '00000000-0000-4000-8000-000000000002';
const CASHIER = '00000000-0000-4000-8000-000000000003';
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
  `select (select count(*) from public.after_hours_access) as auths,
          (select count(*) from public.cash_handovers) as handovers`,
);
if (Number(existing[0].auths) > 0 || Number(existing[0].handovers) > 0) {
  console.error(
    `\n  This script needs a database with no after-hours history yet` +
      ` (found ${existing[0].auths} authorisations). Run: npm run db:reset`,
  );
  process.exit(1);
}

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
const num = (v) => Number(v ?? 0);
const balance = async (code) =>
  num((await one(`select balance_ugx from public.financial_accounts where code = $1`, [code]))
    .balance_ugx);

async function ledgerAgrees() {
  const { rows } = await db.query(`
    select a.code from public.financial_accounts a
     left join public.financial_transaction_entries e on e.account_id = a.id
     group by a.id, a.code, a.balance_ugx
    having a.balance_ugx <> coalesce(sum(e.delta_ugx), 0)`);
  return rows.length === 0;
}

/** An invoice with money owing, built through the real flow. */
async function invoiceFor(plate, serviceName) {
  const service = (await one(`select id from public.services where name = $1`, [serviceName])).id;
  const vehicle = (await one(
    `insert into public.vehicles (number_plate, normalized_plate, model, colour, customer_id)
     values ($1, app.plate_key($1), 'Model', 'Colour',
             (select id from public.customers order by customer_number limit 1))
     returning id`, [plate])).id;
  const intake = (await asUser(CASHIER,
    `select app.create_service_intake($1, array[$2::uuid]) as id`, [vehicle, service])).rows[0].id;
  const { rows: orders } = await db.query(
    `select id from public.worker_orders where service_intake_id = $1`, [intake]);
  for (const order of orders) {
    await asUser(MANAGER, `select app.assign_worker_order($1, $2)`, [order.id, WORKER]);
    for (const action of ['accept', 'start', 'complete']) {
      await asUser(WORKER, `select app.update_worker_order_status($1, $2)`, [order.id, action]);
    }
  }
  return (await asUser(CASHIER, `select app.create_invoice($1) as id`, [intake])).rows[0].id;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? undefined });

async function selectByText(page, selector, text) {
  const label = (
    await page.locator(`${selector} option`).filter({ hasText: text }).first().textContent()
  ).trim();
  await page.selectOption(selector, { label });
}

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

const manager = await signIn('0772000002');
const admin = await signIn('0772000001');
const worker = await signIn('0772000004', { width: 390, height: 844 });

// ---------------------------------------------------------------------------
console.log('\n  manager: authorising somebody for the evening');
let authorizationId;
{
  const { page } = manager;
  await page.goto(`${BASE}/after-hours?tab=authorisations`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Authorise somebody' }).click();
  await selectByText(page, '#ah-staff', 'Test Worker');
  await page.selectOption('#ah-hours', '8');
  await page.locator('#ah-float').fill('50000');
  await page.locator('#ah-reason').fill('Covering the evening shift');
  await page.getByRole('button', { name: 'Authorise', exact: true }).last().click();
  await page.waitForTimeout(2500);

  const auth = await one(
    `select id, authorization_number, status, opening_float_ugx, permissions, granted
       from public.after_hours_access where staff_uid = $1`, [WORKER]);
  authorizationId = auth?.id;
  check(/^RMX-AH-\d{6}$/.test(auth?.authorization_number ?? ''), 'the authorisation was written');
  check(auth?.status === 'active', 'and is in force');
  check(num(auth?.opening_float_ugx) === 50_000, 'with the float the manager chose');
  check(
    auth?.permissions.includes('after_hours.operate')
      && auth?.permissions.includes('after_hours.cash.collect'),
    'granting the shift permissions',
  );
  check(
    !auth?.permissions.some((p) => /payroll|users|finance|settings|reverse|dividend|share/.test(p)),
    'and nothing that would make them an administrator for the night',
  );

  const live = (await one(`select app.effective_permissions($1) as p`, [WORKER])).p;
  check(live.includes('after_hours.operate'), 'the worker now holds the shift permissions');
  check(live.includes('invoices.create'), 'and may raise an invoice');
  check(!live.includes('payments.reverse'), 'but still cannot reverse a payment');

  const grants = await one(
    `select count(*)::int as n from public.temporary_grants
      where authorization_id = $1 and revoked_at is null`, [authorizationId]);
  check(grants.n > 0, 'as ordinary temporary grants, which end by themselves');
}

// ---------------------------------------------------------------------------
console.log('\n  worker: the shift itself');
let sessionId;
{
  const { page } = worker;
  await page.goto(`${BASE}/my-after-hours`, { waitUntil: 'domcontentloaded' });
  const body = await page.locator('body').textContent();
  check(/You are authorised/.test(body), 'the worker sees their authorisation');

  await page.getByRole('button', { name: 'Start session' }).first().click();
  await page.getByRole('button', { name: 'Start session' }).last().click();
  await page.waitForTimeout(2500);

  const session = await one(
    `select id, session_number, status, opening_float_ugx, expected_cash_ugx
       from public.after_hours_sessions where staff_uid = $1`, [WORKER]);
  sessionId = session?.id;
  check(/^RMX-AHS-\d{6}$/.test(session?.session_number ?? ''), 'the session opened');
  check(num(session?.opening_float_ugx) === 50_000, 'taking the float into their hands');
  check(num(session?.expected_cash_ugx) === 50_000, 'which is theirs to hand back');

  const custody = await one(
    `select kind, cash_delta_ugx from public.after_hours_cash where session_id = $1`, [sessionId]);
  check(custody?.kind === 'opening_float', 'and a custody entry explains it');

  // A second session is impossible.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const after = await page.locator('body').textContent();
  check(!/Start session/.test(after), 'the screen no longer offers a second session');
  const count = await one(
    `select count(*)::int as n from public.after_hours_sessions where staff_uid = $1`, [WORKER]);
  check(count.n === 1, 'and only one session exists');
}

// ---------------------------------------------------------------------------
console.log('\n  worker: taking money, into one ledger');
{
  const cashInvoice = await invoiceFor('UBA 101Z', 'Full Valet');
  const momoInvoice = await invoiceFor('UBA 102Z', 'Body Wash');
  const bankInvoice = await invoiceFor('UBA 103Z', 'Body Wash');

  const before = await balance('cash_at_hand');
  const { rows: countBefore } = await db.query(
    `select count(*)::int as n from public.financial_transactions`);

  const { page } = worker;
  await page.goto(`${BASE}/invoices/${cashInvoice}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Take payment' }).click();
  await page.locator('input[name="amount_ugx"]').fill('30000');
  await page.getByRole('button', { name: /^Record payment|^Take payment$/ }).last().click();
  await page.waitForTimeout(2500);

  const payment = await one(
    `select is_after_hours, after_hours_session_number, method, amount_ugx
       from public.payments where invoice_id = $1`, [cashInvoice]);
  check(payment?.is_after_hours === true, 'the payment is tagged with the session');
  check(num(payment?.amount_ugx) === 30_000, 'for the amount taken');

  const { rows: countAfter } = await db.query(
    `select count(*)::int as n from public.financial_transactions`);
  check(countAfter[0].n - countBefore[0].n === 1, 'and posted ONE entry to the same ledger');
  check(await balance('cash_at_hand') === before + 30_000, 'the money reached Cash at Hand');
  check(await ledgerAgrees(), 'every account still agrees with its ledger');

  const session = await one(
    `select cash_collected_ugx, expected_cash_ugx from public.after_hours_sessions where id = $1`,
    [sessionId]);
  check(num(session?.expected_cash_ugx) === 80_000, 'the worker now holds UGX 80,000');

  // Mobile money is recorded but never enters their hands.
  await asUser(WORKER, `select * from app.record_payment($1, 15000, 'airtel_merchant', $2, 'REF-1')`,
    [momoInvoice, `e2e-momo-${Date.now()}`]);
  const afterMomo = await one(
    `select non_cash_collected_ugx, expected_cash_ugx from public.after_hours_sessions where id = $1`,
    [sessionId]);
  check(num(afterMomo?.non_cash_collected_ugx) === 15_000, 'mobile money is recorded');
  check(num(afterMomo?.expected_cash_ugx) === 80_000, 'and never enters the custody figure');

  // Bank is off after hours.
  let refused = null;
  try {
    await asUser(WORKER, `select * from app.record_payment($1, 15000, 'bank', $2, 'REF-2')`,
      [bankInvoice, `e2e-bank-${Date.now()}`]);
  } catch (e) {
    refused = e.message;
  }
  check(/not allowed after hours/i.test(refused ?? ''), 'a bank payment is refused after hours');
}

// ---------------------------------------------------------------------------
console.log('\n  worker: the amount owed is read-only, and frozen at the close');
let handoverId;
{
  const { page } = worker;
  await page.goto(`${BASE}/my-after-hours`, { waitUntil: 'domcontentloaded' });
  const body = await page.locator('body').textContent();
  check(/UGX 80,000/.test(body), 'the worker can see what they owe');
  const fields = await page.locator('input[name="expected_cash_ugx"]').count();
  check(fields === 0, 'and there is no field anywhere to change it');

  await page.getByRole('button', { name: 'Close my session' }).click();
  await page.getByRole('button', { name: 'Close session' }).last().click();
  await page.waitForTimeout(2500);

  const handover = await one(
    `select id, handover_number, status, expected_cash_ugx from public.cash_handovers
      where session_id = $1`, [sessionId]);
  handoverId = handover?.id;
  check(/^RMX-HO-\d{6}$/.test(handover?.handover_number ?? ''), 'a handover was created');
  check(num(handover?.expected_cash_ugx) === 80_000, 'freezing what the payments say');

  // Recalculated from the payments, not the running total.
  const recomputed = await one(
    `select 50000 + coalesce(sum(amount_ugx) filter
             (where method = 'cash' and status <> 'reversed'), 0)::bigint as expected
       from public.payments where after_hours_session_id = $1`, [sessionId]);
  check(num(recomputed?.expected) === 80_000, 'and agreeing with the payments themselves');

  let frozen = null;
  try {
    await db.query(`update public.cash_handovers set expected_cash_ugx = 1 where id = $1`,
      [handoverId]);
  } catch (e) {
    frozen = e.message;
  }
  check(/cannot be changed/i.test(frozen ?? ''), 'nothing can change it afterwards');
}

// ---------------------------------------------------------------------------
console.log('\n  the handover: declared by one person, counted by another');
let discrepancyId;
{
  const { page } = worker;
  await page.goto(`${BASE}/my-after-hours`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Hand it over' }).click();
  await page.locator('#my-declared').fill('80000');
  await page.getByRole('button', { name: 'Submit handover' }).click();
  await page.waitForTimeout(2500);

  const submitted = await one(
    `select status, declared_amount_ugx from public.cash_handovers where id = $1`, [handoverId]);
  check(submitted?.status === 'submitted', 'the worker handed it over');
  check(num(submitted?.declared_amount_ugx) === 80_000, 'declaring what they say they gave');

  // The worker cannot count their own cash.
  await page.goto(`${BASE}/after-hours/handover/${handoverId}`, { waitUntil: 'domcontentloaded' });
  const ownBody = await page.locator('body').textContent();
  check(
    /Somebody else has to count this cash/.test(ownBody),
    'and is told plainly that somebody else counts it',
  );
  check(
    (await page.getByRole('button', { name: 'Count and receive' }).count()) === 0,
    'with no way to count it themselves',
  );

  const beforeCount = await balance('cash_at_hand');
  const { rows: ledgerBefore } = await db.query(
    `select count(*)::int as n from public.financial_transactions`);

  const mgr = manager.page;
  await mgr.goto(`${BASE}/after-hours/handover/${handoverId}`, { waitUntil: 'domcontentloaded' });
  await mgr.getByRole('button', { name: 'Count and receive' }).click();
  await mgr.locator('#ho-actual').fill('75000');
  await mgr.locator('#ho-explanation').fill('Five thousand missing from the float');
  await mgr.getByRole('button', { name: 'Record the count' }).click();
  await mgr.waitForTimeout(2500);

  const counted = await one(
    `select status, actual_amount_ugx, difference_ugx, discrepancy_id
       from public.cash_handovers where id = $1`, [handoverId]);
  discrepancyId = counted?.discrepancy_id;
  check(counted?.status === 'discrepancy', 'the count opened a discrepancy');
  check(num(counted?.difference_ugx) === -5_000, 'of exactly the difference');

  // Custody, not money: the handover posts nothing.
  const { rows: ledgerAfter } = await db.query(
    `select count(*)::int as n from public.financial_transactions`);
  check(ledgerAfter[0].n === ledgerBefore[0].n, 'and posted nothing to the ledger');
  check(await balance('cash_at_hand') === beforeCount, 'moving no balance at all');

  const d = await one(
    `select discrepancy_number, kind, status, expected_cash_ugx from public.cash_discrepancies
      where id = $1`, [discrepancyId]);
  check(/^RMX-AHD-\d{6}$/.test(d?.discrepancy_number ?? ''), 'the discrepancy has a reference');
  check(d?.kind === 'shortage', 'recorded as a shortage');
  check(d?.status === 'open', 'and open for somebody to review');
}

// ---------------------------------------------------------------------------
console.log('\n  the discrepancy: reviewed, resolved, and never deducted');
{
  const mgr = manager.page;
  await mgr.goto(`${BASE}/after-hours/discrepancy/${discrepancyId}`, { waitUntil: 'domcontentloaded' });
  await mgr.getByRole('button', { name: 'Put under review' }).click();
  await mgr.locator('#d-review-notes').fill('Asked the worker what happened');
  await mgr.getByRole('button', { name: 'Put under review' }).last().click();
  await mgr.waitForTimeout(2500);
  check(
    (await one(`select status from public.cash_discrepancies where id = $1`, [discrepancyId]))
      .status === 'under_review',
    'the manager put it under review',
  );

  // The worker cannot review their own.
  const wrk = worker.page;
  await wrk.goto(`${BASE}/after-hours/discrepancy/${discrepancyId}`, { waitUntil: 'domcontentloaded' });
  const ownBody = await wrk.locator('body').textContent();
  check(
    /You cannot review or resolve a difference on your own handover/.test(ownBody),
    'and the worker cannot review their own',
  );

  const before = await balance('cash_at_hand');
  // Relative, not absolute: the workforce script may have scheduled a
  // deduction for this same person. What matters is that resolving a
  // shortage adds NONE.
  const deductionsBefore = (await one(
    `select count(*)::int as n from public.salary_deductions where staff_uid = $1`, [WORKER])).n;
  const adm = admin.page;
  await adm.goto(`${BASE}/after-hours/discrepancy/${discrepancyId}`, { waitUntil: 'domcontentloaded' });
  await adm.getByRole('button', { name: 'Close it' }).click();
  await adm.selectOption('#d-outcome', 'resolved');
  await adm.locator('#d-resolution').fill('Short at the count; recovering and aligning the account');
  await adm.locator('input[name="recover_from_worker"]').check();
  await adm.locator('input[name="post_adjustment"]').check();
  await adm.getByRole('button', { name: 'Close the discrepancy' }).click();
  await adm.waitForTimeout(3000);

  const resolved = await one(
    `select status, outcome, loss_number, adjustment_transaction_number
       from public.cash_discrepancies where id = $1`, [discrepancyId]);
  check(resolved?.status === 'resolved', 'the Administrator closed it');
  check(/^RMX-LOSS-\d{6}$/.test(resolved?.loss_number ?? ''), 'reporting a loss incident');
  check(/^RMX-TXN-/.test(resolved?.adjustment_transaction_number ?? ''), 'and posting the adjustment');

  const incident = await one(
    `select status, amount_ugx, staff_uid, deduction_id, recovered_ugx, source_type
       from public.loss_incidents where loss_number = $1`, [resolved.loss_number]);
  check(incident?.status === 'reported', 'the incident starts at reported, like any other');
  check(num(incident?.amount_ugx) === 5_000, 'for exactly the shortage');
  check(incident?.staff_uid === WORKER, 'about the worker who held the cash');
  check(incident?.source_type === 'cash_discrepancy', 'and says where it came from');

  // NOTHING has been taken from anybody.
  check(incident?.deduction_id === null, 'no salary deduction was created');
  check(num(incident?.recovered_ugx) === 0, 'and nothing has been recovered');
  const deductions = await one(
    `select count(*)::int as n from public.salary_deductions where staff_uid = $1`, [WORKER]);
  check(deductions.n === deductionsBefore, 'and the worker gained no deduction from it');

  check(await balance('cash_at_hand') === before - 5_000, 'the adjustment took exactly the shortage');
  check(await ledgerAgrees(), 'and the ledger still agrees with every balance');

  const handover = await one(
    `select status from public.cash_handovers where id = $1`, [handoverId]);
  check(handover?.status === 'reconciled', 'the handover is reconciled');
}

// ---------------------------------------------------------------------------
console.log('\n  the worker sees their own night, and nobody else’s');
{
  const { page } = worker;
  await page.goto(`${BASE}/my-after-hours`, { waitUntil: 'domcontentloaded' });
  const body = await page.locator('body').textContent();
  check(/RMX-HO-/.test(body), 'their own handover is there');
  check(/UGX 5,000 short/.test(body), 'with the difference stated plainly');
  check(
    /Nothing is taken from your pay/.test(body),
    'and the screen says nothing is taken from their pay',
  );

  await page.goto(`${BASE}/after-hours`, { waitUntil: 'domcontentloaded' });
  check(page.url().endsWith('/module-unavailable'), 'the dashboard is not theirs to open');

  const register = await asUser(WORKER,
    `select count(*)::int as n from public.cash_handovers where staff_uid <> $1`, [WORKER]);
  check(num(register.rows[0].n) === 0, 'and no other handover is readable at the table');
}

// ---------------------------------------------------------------------------
console.log('\n  offline: a session is refused outright, never queued');
{
  const { page, context } = worker;
  // The authorisation is still live, so another session could be started.
  await asUser(ADMIN, `select * from app.authorize_after_hours($1, null, 'Second shift', $2,
     null, null, 0, 4)`, [WORKER, `e2e-second-${Date.now()}`]).catch(() => {});
  await page.goto(`${BASE}/my-after-hours`, { waitUntil: 'domcontentloaded' });

  const before = await one(
    `select count(*)::int as n from public.after_hours_sessions where staff_uid = $1`, [WORKER]);
  await page.getByRole('button', { name: 'Start session' }).first().click();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Start session' }).last().click();
  await page.waitForSelector('[data-form-error]', { timeout: 15_000 });
  const message = await page.locator('[data-form-error]').first().textContent();
  check(/internet connection/i.test(message), 'the session is refused while offline');
  check(/Nothing was sent/i.test(message), 'and says plainly that nothing was sent');
  const after = await one(
    `select count(*)::int as n from public.after_hours_sessions where staff_uid = $1`, [WORKER]);
  check(after.n === before.n, 'nothing was written');
  await context.setOffline(false);
}

await manager.context.close();
await admin.context.close();
await worker.context.close();
await browser.close();
await db.end();

console.log(
  failures === 0
    ? '\nAll after-hours workflow checks passed.'
    : `\n${failures} after-hours workflow check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
