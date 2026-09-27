#!/usr/bin/env node
/**
 * The Phase F workflows, driven through the real browser against the real
 * database.
 *
 *   Manager:  record a late arrival -> verify -> allowance calculated
 *   Manager:  DEDUCT the late allowance -> approve -> pay -> account, ledger
 *   Admin:    set a salary (a version, effective-dated)
 *   Manager:  report a loss -> review
 *   Admin:    approve a recovery -> Manager schedules it
 *   Manager:  create a payroll -> prepare -> submit -> review
 *   Admin:    approve -> pay -> account, ledger, deductions applied,
 *             payslips visible -> lock
 *   Worker:   sees their OWN payslip only, and no colleague's pay
 *   Offline:  a payroll payment is refused outright, never queued
 *
 * Every figure is read back from the DATABASE, because the point of Phase F is
 * that the browser never decides anyone's pay.
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

// This script asserts ABSOLUTE figures, so it needs a database where no pay
// has been worked out yet.
const { rows: existing } = await db.query(
  `select (select count(*) from public.payroll) as payroll,
          (select count(*) from public.attendance) as attendance`,
);
if (Number(existing[0].payroll) > 0 || Number(existing[0].attendance) > 0) {
  console.error(
    `\n  This script needs a database with no attendance or payroll yet` +
      ` (found ${existing[0].attendance} attendance records). Run: npm run db:reset`,
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
  num(
    (await one(`select balance_ugx from public.financial_accounts where code = $1`, [code]))
      .balance_ugx,
  );

/** For every account, the balance must equal the sum of its ledger movements. */
async function ledgerAgrees() {
  const { rows } = await db.query(`
    select a.code from public.financial_accounts a
     left join public.financial_transaction_entries e on e.account_id = a.id
     group by a.id, a.code, a.balance_ugx
    having a.balance_ugx <> coalesce(sum(e.delta_ugx), 0)`);
  return rows.length === 0;
}

// Two recent working days (Mon–Sat) in the same month, inside the backdating
// window: one late arrival and one on-time arrival.
const when = await one(`
  with days as (
    select g.d::date as d
      from generate_series(date_trunc('month', app.eat_day())::date, app.eat_day() - 1,
                           interval '1 day') g(d)
     where extract(isodow from g.d) between 1 and 6
     order by g.d desc limit 2)
  select max(d)::text as day, min(d)::text as second_day,
         extract(year from max(d))::int as year, extract(month from max(d))::int as month
    from days`);
if (when.second_day === when.day) {
  console.error('\n  This script needs two working days in the current month. Try again tomorrow.');
  process.exit(1);
}

// The business needs money before it can pay anyone. An opening balance can
// only be recorded once, so on a database another script has already used,
// the money goes in as an adjustment instead.
const { rows: opened } = await db.query(
  `select opening_balance_recorded as done
     from public.financial_accounts where code = 'cash_at_hand'`);
await asUser(
  ADMIN,
  opened[0].done
    ? `select app.record_account_adjustment(
         (select id from public.financial_accounts where code = 'cash_at_hand'),
         'in', 5000000, 'E2E float', $1)`
    : `select * from app.record_opening_balance(
         (select id from public.financial_accounts where code = 'cash_at_hand'),
         5000000, 'E2E float')`,
  opened[0].done ? [`e2e-float-${Date.now()}`] : [],
);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? undefined });

/** Chooses the first option whose text contains `text`. */
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

const admin = await signIn('0772000001');
const manager = await signIn('0772000002');
const worker = await signIn('0772000004', { width: 390, height: 844 });

// ---------------------------------------------------------------------------
console.log('\n  admin: a salary is a version, effective from a date');
{
  const { page } = admin;
  await page.goto(`${BASE}/payroll?tab=salaries`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Set a salary' }).click();
  await page.selectOption('#salary-staff', { label: 'Test Worker' });
  await page.locator('input[name="basic_salary_ugx"]').fill('600000');
  await page.locator('input[name="effective_from"]').fill('2020-01-01');
  await page.getByRole('button', { name: 'Save salary' }).click();
  await page.waitForTimeout(2000);

  const profile = await one(
    `select basic_salary_ugx, version, allowance_eligible from public.salary_profiles
      where staff_uid = $1`,
    [WORKER],
  );
  check(num(profile?.basic_salary_ugx) === 600_000, 'the salary was saved');
  check(profile?.version === 1, 'as version 1');

  const history = await one(
    `select count(*)::int as n from public.salary_history where staff_uid = $1`,
    [WORKER],
  );
  check(history.n === 1, 'and a salary history row was written');

  // A cashier needs a salary too, to prove privacy between two people.
  await asUser(ADMIN, `select * from app.set_salary_profile($1, 900000, '2020-01-01')`, [CASHIER]);
}

// ---------------------------------------------------------------------------
console.log('\n  manager: a late arrival is recorded, and the SERVER decides it is late');
let attendanceId;
{
  const { page } = manager;
  await page.goto(`${BASE}/attendance`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Record for a staff member' }).click();
  await selectByText(page, '#staff_uid', 'Test Worker');
  await page.locator('#business_day').fill(when.day);
  await page.locator('#clock_in_time').fill('08:45');
  await page.getByRole('button', { name: 'Record attendance' }).click();
  await page.waitForTimeout(2000);

  const record = await one(
    `select id, minutes_late, late, arrival_status, verification_status, reporting_time::text
       from public.attendance where staff_uid = $1 and business_day = $2::date`,
    [WORKER, when.day],
  );
  attendanceId = record?.id;
  check(record?.minutes_late === 45, 'the server worked out 45 minutes late');
  check(record?.late === true && record?.arrival_status === 'late', 'and marked the arrival late');
  check(record?.reporting_time === '08:00:00', 'the policy in force was copied onto the record');
  check(record?.verification_status === 'pending', 'it waits for verification');

  // A second record for the same person and day is impossible.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Record for a staff member' }).click();
  await selectByText(page, '#staff_uid', 'Test Worker');
  await page.locator('#business_day').fill(when.day);
  await page.locator('#clock_in_time').fill('09:00');
  await page.getByRole('button', { name: 'Record attendance' }).click();
  await page.waitForSelector('[data-form-error]', { timeout: 15_000 });
  const message = await page.locator('[data-form-error]').first().textContent();
  check(/already has attendance/i.test(message), 'a second record for the same day is refused');

  const count = await one(
    `select count(*)::int as n from public.attendance where staff_uid = $1 and business_day = $2::date`,
    [WORKER, when.day],
  );
  check(count.n === 1, 'and only one record exists');
}

// ---------------------------------------------------------------------------
console.log('\n  manager: verification, then the allowance');
let allowanceId;
{
  const { page } = manager;
  await page.goto(`${BASE}/attendance/${attendanceId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('button', { name: 'Approve attendance' }).click();
  await page.waitForTimeout(2000);

  const verified = await one(
    `select status, verification_status from public.attendance where id = $1`,
    [attendanceId],
  );
  check(verified.verification_status === 'approved', 'the attendance was approved');
  check(verified.status === 'late', 'and its status records that they were late');

  await page.goto(`${BASE}/allowances`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Calculate for a day' }).click();
  await page.locator('#calc-day').fill(when.day);
  await page.getByRole('button', { name: 'Calculate', exact: true }).click();
  await page.waitForTimeout(2000);

  const allowance = await one(
    `select id, calculated_amount_ugx, status, suggested_decision, suggested_deduction_ugx,
            approved_amount_ugx
       from public.worker_allowances where staff_uid = $1 and business_day = $2::date`,
    [WORKER, when.day],
  );
  allowanceId = allowance?.id;
  check(
    num(allowance?.calculated_amount_ugx) === 5_000,
    'an allowance of UGX 5,000 was calculated',
  );
  check(allowance?.status === 'calculated', 'and waits for a decision');
  check(allowance?.suggested_decision === 'deduct', 'the policy suggests a deduction');
  check(allowance?.approved_amount_ugx === null, 'being late did not decide anything by itself');
}

// ---------------------------------------------------------------------------
console.log('\n  manager: DEDUCT, then pay the allowance');
{
  const { page } = manager;
  const before = await balance('cash_at_hand');

  await page.goto(`${BASE}/allowances`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Deduct', exact: true }).click();
  await page.locator('input[name="reason"]').last().fill('Forty-five minutes late');
  await page.getByRole('button', { name: 'Apply deduction' }).click();
  await page.waitForTimeout(2000);

  const decided = await one(
    `select status, decision, deduction_ugx, approved_amount_ugx
       from public.worker_allowances where id = $1`,
    [allowanceId],
  );
  check(decided.decision === 'deduct', 'the decision was recorded');
  check(num(decided.deduction_ugx) === 2_500, 'the policy deduction was applied');
  check(num(decided.approved_amount_ugx) === 2_500, 'and UGX 2,500 remains payable');

  await page.goto(`${BASE}/allowances?view=unpaid`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Pay allowances', exact: true }).first().click();
  await selectByText(page, '#account', 'Cash at Hand');
  await page.getByRole('button', { name: 'Pay allowances' }).last().click();
  await page.waitForTimeout(2500);

  const paid = await one(
    `select status, paid_via, financial_transaction_id from public.worker_allowances where id = $1`,
    [allowanceId],
  );
  check(paid.status === 'paid' && paid.paid_via === 'direct', 'the allowance was paid');
  check((await balance('cash_at_hand')) === before - 2_500, 'and the money left the account');

  const entry = await one(
    `select entry_type, amount_ugx from public.financial_transactions where id = $1`,
    [paid.financial_transaction_id],
  );
  check(entry.entry_type === 'allowance_payment', 'one allowance_payment ledger entry was posted');
  check(num(entry.amount_ugx) === 2_500, 'for exactly what was approved');
  check(await ledgerAgrees(), 'every account still agrees with its ledger');
}

// ---------------------------------------------------------------------------
console.log('\n  a second day, approved and left for the payroll to pay');
{
  const { page } = manager;
  await page.goto(`${BASE}/attendance`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Record for a staff member' }).click();
  await selectByText(page, '#staff_uid', 'Test Worker');
  await page.locator('#business_day').fill(when.second_day);
  await page.locator('#clock_in_time').fill('07:55');
  await page.getByRole('button', { name: 'Record attendance' }).click();
  await page.waitForTimeout(2000);

  const second = await one(
    `select id, arrival_status from public.attendance
      where staff_uid = $1 and business_day = $2::date`,
    [WORKER, when.second_day],
  );
  check(second?.arrival_status === 'on_time', 'an early arrival is on time');

  await page.goto(`${BASE}/attendance/${second.id}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('button', { name: 'Approve attendance' }).click();
  await page.waitForTimeout(2000);

  await page.goto(`${BASE}/allowances`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Calculate for a day' }).click();
  await page.locator('#calc-day').fill(when.second_day);
  await page.getByRole('button', { name: 'Calculate', exact: true }).click();
  await page.waitForTimeout(2000);

  await page.goto(`${BASE}/allowances`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Pay in full', exact: true }).first().click();
  await page.getByRole('button', { name: 'Pay in full' }).last().click();
  await page.waitForTimeout(2000);

  const allowance = await one(
    `select status, approved_amount_ugx, paid_via from public.worker_allowances
      where staff_uid = $1 and business_day = $2::date`,
    [WORKER, when.second_day],
  );
  check(allowance?.status === 'approved', 'the allowance was approved in full');
  check(num(allowance?.approved_amount_ugx) === 5_000, 'at UGX 5,000');
  check(allowance?.paid_via === null, 'and is still unpaid, for the payroll to carry');
}

// ---------------------------------------------------------------------------
console.log('\n  a loss is reported, reviewed, decided and scheduled — and deducts nothing yet');
let incidentId;
{
  const { page } = manager;
  await page.goto(`${BASE}/losses`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Report a loss' }).click();
  await page.locator('#loss-amount').fill('300000');
  await page.locator('#loss-date').fill(when.day);
  await selectByText(page, '#loss-staff', 'Test Worker');
  await page.locator('#loss-description').fill('A polisher was dropped');
  await page.getByRole('button', { name: 'Report loss' }).click();
  await page.waitForTimeout(2000);

  const incident = await one(
    `select id, status, outstanding_ugx, visible_to_staff from public.loss_incidents
      where staff_uid = $1`,
    [WORKER],
  );
  incidentId = incident?.id;
  check(incident?.status === 'reported', 'the incident was recorded');
  check(num(incident?.outstanding_ugx) === 0, 'and nothing is owed');
  check(incident?.visible_to_staff === false, 'the staff member cannot see it yet');

  const deductions = await one(
    `select count(*)::int as n from public.salary_deductions where staff_uid = $1`,
    [WORKER],
  );
  check(deductions.n === 0, 'reporting a loss created no deduction');

  await page.goto(`${BASE}/losses/${incidentId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Put under review' }).click();
  await page.getByRole('button', { name: 'Put under review' }).last().click();
  await page.waitForTimeout(2000);
  check(
    (await one(`select status from public.loss_incidents where id = $1`, [incidentId])).status ===
      'under_review',
    'a manager put it under review',
  );

  // The decision is an Administrator's.
  const { page: adminPage } = admin;
  await adminPage.goto(`${BASE}/losses/${incidentId}`, { waitUntil: 'domcontentloaded' });
  await adminPage.getByRole('button', { name: 'Approve a recovery' }).click();
  await adminPage.locator('#recovery').fill('150000');
  await adminPage.locator('#approve-reason').fill('Careless handling');
  await adminPage.getByRole('button', { name: 'Approve', exact: true }).last().click();
  await adminPage.waitForTimeout(2000);

  const decided = await one(
    `select status, approved_recovery_ugx, outstanding_ugx, visible_to_staff
       from public.loss_incidents where id = $1`,
    [incidentId],
  );
  check(decided.status === 'approved', 'an Administrator approved a recovery');
  check(num(decided.approved_recovery_ugx) === 150_000, 'of UGX 150,000');
  check(decided.visible_to_staff === true, 'and the staff member may now see it');

  await page.goto(`${BASE}/losses/${incidentId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Schedule recovery' }).click();
  await page.locator('#instalment').fill('50000');
  await page.locator('#start-date').fill('2020-01-01');
  await page.getByRole('button', { name: 'Schedule recovery' }).last().click();
  await page.waitForTimeout(2000);

  const deduction = await one(
    `select type, status, total_amount_ugx, instalment_ugx, remaining_ugx, recovered_ugx
       from public.salary_deductions where loss_incident_id = $1`,
    [incidentId],
  );
  check(deduction?.type === 'loss_recovery', 'one loss-recovery deduction was scheduled');
  check(num(deduction?.instalment_ugx) === 50_000, 'at UGX 50,000 per payroll');
  check(num(deduction?.recovered_ugx) === 0, 'and still nothing has been recovered');
}

// ---------------------------------------------------------------------------
console.log('\n  payroll: prepare -> submit -> review -> approve -> pay -> lock');
let payrollId;
{
  const { page } = manager;
  await page.goto(`${BASE}/payroll`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Create a payroll' }).click();
  await page.selectOption('#month', String(when.month));
  await page.selectOption('#year', String(when.year));
  await page.getByRole('button', { name: 'Create payroll' }).click();
  await page.waitForTimeout(2000);

  const created = await one(`select id, status from public.payroll limit 1`);
  payrollId = created.id;
  check(created.status === 'draft', 'the payroll starts as a draft');

  await page.goto(`${BASE}/payroll/run/${payrollId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Prepare', exact: true }).click();
  await page.getByRole('button', { name: 'Work out the pay' }).click();
  await page.waitForTimeout(2500);

  const item = await one(
    `select basic_salary_ugx, allowances_ugx, gross_ugx, loss_recoveries_ugx,
            total_deductions_ugx, net_ugx, payment_status, visible_to_staff
       from public.payroll_items where payroll_id = $1 and staff_uid = $2 and current`,
    [payrollId, WORKER],
  );
  check(num(item?.basic_salary_ugx) === 600_000, 'the payslip carries the basic salary');
  check(num(item?.allowances_ugx) === 5_000, 'plus the approved, unpaid allowance');
  check(num(item?.gross_ugx) === 605_000, 'gross = basic + allowances');
  check(num(item?.loss_recoveries_ugx) === 50_000, 'the loss instalment is planned');
  check(num(item?.net_ugx) === 555_000, 'and net = gross − deductions');
  check(item?.visible_to_staff === false, 'the payslip is not yet visible to the staff member');

  const incidentNow = await one(
    `select recovered_ugx, outstanding_ugx from public.loss_incidents where id = $1`,
    [incidentId],
  );
  check(num(incidentNow.recovered_ugx) === 0, 'preparing the payroll recovered nothing');
  check(num(incidentNow.outstanding_ugx) === 150_000, 'the loss is still fully outstanding');

  await page.getByRole('button', { name: 'Submit for review' }).click();
  await page.getByRole('button', { name: 'Submit for review' }).last().click();
  await page.waitForTimeout(2000);

  // A manager may not approve, however hard they try.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const approveButtons = await page.getByRole('button', { name: 'Approve', exact: true }).count();
  check(approveButtons === 0, 'a manager is offered no approval button');
  const denied = await asUser(MANAGER, `select 1`).then(async () => {
    try {
      await asUser(MANAGER, `select app.update_payroll_status($1, 'approve')`, [payrollId]);
      return null;
    } catch (e) {
      return e.message;
    }
  });
  check(/Administrator|permission/i.test(denied ?? ''), 'and the database refuses them too');

  await page.getByRole('button', { name: 'Mark reviewed' }).click();
  await page.locator('#review-notes').fill('Checked line by line');
  await page.getByRole('button', { name: 'Mark reviewed' }).last().click();
  await page.waitForTimeout(2000);

  const { page: adminPage } = admin;
  await adminPage.goto(`${BASE}/payroll/run/${payrollId}`, { waitUntil: 'domcontentloaded' });
  await adminPage.getByRole('button', { name: 'Approve', exact: true }).click();
  await adminPage.getByRole('button', { name: 'Approve payroll' }).click();
  await adminPage.waitForTimeout(2000);
  check(
    (await one(`select status from public.payroll where id = $1`, [payrollId])).status ===
      'approved',
    'an Administrator approved it',
  );

  // Offline: the payment must be refused outright, never queued.
  const beforeOffline = await balance('cash_at_hand');
  await adminPage.getByRole('button', { name: 'Pay payroll' }).click();
  await selectByText(adminPage, '#pay-account', 'Cash at Hand');
  await admin.context.setOffline(true);
  await adminPage.getByRole('button', { name: /^Pay UGX/ }).click();
  await adminPage.waitForSelector('[data-form-error]', { timeout: 15_000 });
  const offlineMessage = await adminPage.locator('[data-form-error]').first().textContent();
  check(
    /internet connection/i.test(offlineMessage),
    'an offline payroll payment is refused outright',
  );
  check(/Nothing was sent/i.test(offlineMessage), 'and says plainly that nothing was sent');
  check((await balance('cash_at_hand')) === beforeOffline, 'no money moved');
  await admin.context.setOffline(false);

  const before = await balance('cash_at_hand');
  await adminPage.reload({ waitUntil: 'domcontentloaded' });
  await adminPage.getByRole('button', { name: 'Pay payroll' }).click();
  await selectByText(adminPage, '#pay-account', 'Cash at Hand');
  await adminPage.getByRole('button', { name: /^Pay UGX/ }).click();
  await adminPage.waitForTimeout(3000);

  const paid = await one(
    `select status, total_net_ugx, financial_transaction_number from public.payroll where id = $1`,
    [payrollId],
  );
  check(paid.status === 'paid', 'the payroll was paid');
  check(
    (await balance('cash_at_hand')) === before - num(paid.total_net_ugx),
    'and exactly the net pay left the account',
  );

  const entry = await one(
    `select entry_type, amount_ugx from public.financial_transactions
      where reference_id = $1 and entry_type = 'payroll_payment'`,
    [payrollId],
  );
  check(num(entry?.amount_ugx) === num(paid.total_net_ugx), 'one payroll_payment ledger entry');
  check(await ledgerAgrees(), 'every account still agrees with its ledger');

  const after = await one(
    `select recovered_ugx, outstanding_ugx, status from public.loss_incidents where id = $1`,
    [incidentId],
  );
  check(num(after.recovered_ugx) === 50_000, 'the loss recovery was applied by the PAYMENT');
  check(num(after.outstanding_ugx) === 100_000, 'leaving UGX 100,000 outstanding');
  check(after.status === 'partially_recovered', 'and the incident is partly recovered');

  const carried = await one(
    `select status, paid_via from public.worker_allowances
      where staff_uid = $1 and business_day = $2::date`,
    [WORKER, when.second_day],
  );
  check(
    carried.status === 'paid' && carried.paid_via === 'payroll',
    'the allowance the payroll carried is now paid through it',
  );

  const slip = await one(
    `select payment_status, visible_to_staff from public.payroll_items
      where payroll_id = $1 and staff_uid = $2 and current`,
    [payrollId, WORKER],
  );
  check(slip.payment_status === 'paid', 'the payslip is marked paid');
  check(slip.visible_to_staff === true, 'and is now visible to its staff member');

  const summary = await one(
    `select payroll_paid_ugx from public.finance_daily_summaries where business_day = app.eat_day()`,
  );
  check(num(summary?.payroll_paid_ugx) === num(paid.total_net_ugx), 'the day records the payroll');

  await adminPage.reload({ waitUntil: 'domcontentloaded' });
  await adminPage.getByRole('button', { name: 'Lock', exact: true }).click();
  await adminPage.getByRole('button', { name: 'Lock payroll' }).click();
  await adminPage.waitForTimeout(2000);
  check(
    (await one(`select status from public.payroll where id = $1`, [payrollId])).status === 'locked',
    'and it was locked',
  );

  let lockedError = null;
  try {
    await asUser(ADMIN, `select * from app.reverse_payroll_payment($1, 'Changing my mind')`, [
      payrollId,
    ]);
  } catch (e) {
    lockedError = e.message;
  }
  check(/locked/i.test(lockedError ?? ''), 'a locked payroll cannot be reversed');
}

// ---------------------------------------------------------------------------
console.log('\n  the worker sees their own pay, and nobody else’s');
{
  const { page } = worker;
  await page.goto(`${BASE}/allowances`, { waitUntil: 'domcontentloaded' });
  const body = await page.textContent('body');
  check(body.includes('UGX 555,000'), 'their own net pay is shown');
  check(!body.includes('900,000'), "and no colleague's salary appears");

  // Below the interface: the same rule, enforced by the database.
  const ownRows = await asUser(WORKER, `select staff_uid from public.payroll_items`);
  check(ownRows.rows.length === 1, 'the database returns exactly one payslip to them');
  check(ownRows.rows[0].staff_uid === WORKER, 'and it is their own');

  const salaries = await asUser(
    WORKER,
    `select staff_uid from public.salary_profiles where staff_uid = $1`,
    [CASHIER],
  );
  check(salaries.rows.length === 0, "a colleague's salary is invisible to them");

  const losses = await asUser(WORKER, `select id from public.loss_incidents`);
  check(losses.rows.length === 1, 'they see the incident about them, now that it is decided');

  await page.goto(`${BASE}/payroll`, { waitUntil: 'domcontentloaded' });
  check(page.url().includes('/module-unavailable'), 'and payroll itself is not open to them');
}

// ---------------------------------------------------------------------------
console.log('\n  Phases D and E still work after the workforce was added');
{
  const { page } = manager;
  await page.goto(`${BASE}/finance`, { waitUntil: 'domcontentloaded' });
  const body = await page.textContent('body');
  check(body.includes('Cash at Hand'), 'the finance screen still reads');

  await page.goto(`${BASE}/transactions`, { waitUntil: 'domcontentloaded' });
  const ledger = await page.textContent('body');
  check(/Payroll/i.test(ledger), 'and the payroll payment appears in the ledger');

  const reversalRefused = await asUser(ADMIN, `select 1`).then(async () => {
    const txn = await one(
      `select id from public.financial_transactions where entry_type = 'allowance_payment' limit 1`,
    );
    try {
      await asUser(ADMIN, `select app.reverse_financial_transaction($1, 'Trying the wrong door')`, [
        txn.id,
      ]);
      return null;
    } catch (e) {
      return e.message;
    }
  });
  check(
    /allowance|payroll|workforce/i.test(reversalRefused ?? ''),
    'staff pay cannot be reversed through the generic finance reversal',
  );
}

await admin.context.close();
await manager.context.close();
await worker.context.close();
await browser.close();
await db.end();

console.log(
  failures === 0
    ? '\nAll Phase F workflow checks passed.'
    : `\n${failures} Phase F workflow check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
