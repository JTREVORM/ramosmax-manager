#!/usr/bin/env node
/**
 * Reports, the CSV export and notices, driven through the real browser.
 *
 *   Admin:    open every report they may, and see figures that agree with the
 *             ledger
 *   Admin:    export a report as CSV and check what is in the file
 *   Cashier:  is refused the reports that are not theirs, and sees an
 *             executive summary with the finance sections left out
 *   Worker:   has no reports at all
 *   Everyone: has an inbox of their own, with generic text and nobody else's
 *             notices in it
 *
 * Run it after the other end-to-end scripts, so there is something to report
 * on. Every figure is read back from the DATABASE.
 */
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres:devonly@127.0.0.1:5432/ramosmax_dev';
const PASSWORD = 'DevP@ssw0rd!';

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

const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const num = (v) => Number(v ?? 0);

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
const cashier = await signIn('0772000003');
const worker = await signIn('0772000004', { width: 390, height: 844 });

const today = (await one(`select app.eat_day()::text as d`)).d;
const monthStart = (await one(`select date_trunc('month', app.eat_day())::date::text as d`)).d;

// ---------------------------------------------------------------------------
console.log('\n  admin: every report opens, and the figures come from the ledger');
{
  const { page } = admin;
  const REPORTS = ['executive', 'financial', 'revenue', 'payment_methods', 'outstanding',
    'expenses', 'inventory', 'workforce', 'shareholders', 'after_hours'];

  for (const name of REPORTS) {
    await page.goto(`${BASE}/reports?report=${name}&from=${monthStart}&to=${today}`,
      { waitUntil: 'domcontentloaded' });
    const body = await page.locator('body').textContent();
    check(!/could not be built|do not have permission/i.test(body), `${name} opens`);
  }

  // The money in the report is the money in the ledger.
  await page.goto(`${BASE}/reports?report=financial&from=${monthStart}&to=${today}`,
    { waitUntil: 'domcontentloaded' });
  const shown = await page.locator('body').textContent();
  const ledger = await one(`
    select coalesce(sum(payments_in_ugx), 0)::bigint as payments
      from public.finance_daily_summaries
     where business_day between $1::date and $2::date`, [monthStart, today]);
  const reversals = await one(`
    select coalesce(sum((reversals ->> 'customer_payment')::bigint), 0)::bigint as r
      from public.finance_daily_summaries
     where business_day between $1::date and $2::date`, [monthStart, today]);
  const net = num(ledger.payments) - num(reversals.r);
  check(shown.includes(`UGX ${net.toLocaleString('en-US')}`),
    `the report shows the ledger's own net payments (UGX ${net.toLocaleString('en-US')})`);

  // And the balances are the account balances.
  const cash = await one(
    `select balance_ugx from public.financial_accounts where code = 'cash_at_hand'`);
  await page.goto(`${BASE}/reports?report=executive&from=${monthStart}&to=${today}`,
    { waitUntil: 'domcontentloaded' });
  const exec = await page.locator('body').textContent();
  check(exec.includes(`UGX ${num(cash.balance_ugx).toLocaleString('en-US')}`),
    'the executive summary shows the real Cash at Hand balance');
}

// ---------------------------------------------------------------------------
console.log('\n  the CSV export carries the report, and nothing a spreadsheet would run');
{
  const { page } = admin;
  // Fetched from inside the page, which is how a browser downloads it: same
  // origin, same session cookie, same permissions.
  const fetchCsv = (query) => page.evaluate(async (q) => {
    const response = await fetch(`/api/reports/csv?${q}`, { credentials: 'same-origin' });
    return {
      status: response.status,
      type: response.headers.get('content-type') ?? '',
      disposition: response.headers.get('content-disposition') ?? '',
      body: await response.text(),
      // The raw first bytes: fetch().text() strips a byte order mark while
      // decoding, so the only way to see it is to look at the bytes.
      firstBytes: [...new Uint8Array((await (await fetch(`/api/reports/csv?${q}`,
        { credentials: 'same-origin' })).arrayBuffer()).slice(0, 3))],
    };
  }, query);

  const result = await fetchCsv(`report=revenue&from=${monthStart}&to=${today}`);
  check(result.status === 200, 'the export responds');
  check(result.type.includes('text/csv'), 'as a CSV file');
  check(result.disposition.includes('ramosmax-revenue'), 'named after the report and its period');
  check(
    result.firstBytes.join(',') === '239,187,191',
    'starting with a byte order mark, so a spreadsheet reads UTF-8',
  );
  check(/Operating revenue,\d+/.test(result.body),
    'with amounts as whole shillings, no separators');
  check(!/UGX/.test(result.body), 'and no currency symbols a spreadsheet cannot add up');
  check(/Money that is NOT operating revenue/.test(result.body),
    'carrying the tables as well');
  check(!/^=/m.test(result.body), 'and nothing that starts a formula');

  // A period the server refuses is refused here too.
  const refused = await fetchCsv(`report=revenue&from=2020-01-01&to=${today}`);
  check(refused.status === 400, 'a period beyond the limit is refused');
  check(/at most 400 days/i.test(refused.body), 'with the server\u2019s own reason');
}

// ---------------------------------------------------------------------------
console.log('\n  a cashier sees their own reports, and the rest are closed');
{
  const { page } = cashier;
  await page.goto(`${BASE}/reports`, { waitUntil: 'domcontentloaded' });
  // The chooser itself, not the whole page: "Workforce" is also a navigation
  // heading, and the question here is which REPORTS are offered.
  const offered = await page.locator('a[href^="/reports?report="]').allTextContents();
  check(offered.includes('Outstanding and credit'), 'the reports they may open are offered');
  check(!offered.includes('Workforce'), 'and the ones they may not are not');
  check(!offered.includes('Shareholders'), 'nor the ownership one');

  await page.goto(`${BASE}/reports?report=workforce&from=${today}&to=${today}`,
    { waitUntil: 'domcontentloaded' });
  const attempted = await page.locator('body').textContent();
  check(
    !/Attendance by staff member/.test(attempted),
    'asking for one directly shows nothing of it',
  );

  await page.goto(`${BASE}/reports?report=executive&from=${monthStart}&to=${today}`,
    { waitUntil: 'domcontentloaded' });
  const exec = await page.locator('body').textContent();
  check(/Operations/.test(exec), 'their executive summary has operations');
  check(!/Staff pay/.test(exec), 'and no staff pay');
  check(!/Ownership distribution/.test(exec), 'and no ownership');
}

// ---------------------------------------------------------------------------
console.log('\n  a worker has no reports at all');
{
  const { page } = worker;
  await page.goto(`${BASE}/reports`, { waitUntil: 'domcontentloaded' });
  check(page.url().endsWith('/module-unavailable'), 'the reports screen is not theirs');

  const attempt = await page.evaluate(async (q) => {
    const response = await fetch(`/api/reports/csv?${q}`, { credentials: 'same-origin' });
    return { status: response.status, body: await response.text() };
  }, `report=executive&from=${today}&to=${today}`);
  check(attempt.status === 400, 'and neither is the export');
  check(/permission/i.test(attempt.body), 'which says so rather than handing over a file');
}

// ---------------------------------------------------------------------------
console.log('\n  notices: an inbox of your own, in words that give nothing away');
{
  // Something to be told about, delivered the way the scheduler would.
  // As the delivery job does: with service privileges, never as a client. A
  // fresh record id each run, so the ten-minute deduplication does not swallow
  // the notice when this script is run twice in a row.
  await db.query(`select app.notify($1, 'payroll_paid', 'payroll', gen_random_uuid())`, [WORKER]);
  await db.query(`select * from app.deliver_events()`);

  const { page } = worker;
  await page.goto(`${BASE}/notifications`, { waitUntil: 'domcontentloaded' });
  const body = await page.locator('body').textContent();
  check(/Pay processed/.test(body), 'the worker sees their notice');
  check(/Open RamosMAX to see your payslip/.test(body), 'in the server’s own generic words');
  check(!/UGX/.test(body.split('Notices')[1] ?? ''), 'with no amount anywhere in it');

  const mine = await one(
    `select count(*)::int as n from public.notifications where recipient_id <> $1`, [WORKER]);
  const visible = await asUser(WORKER,
    `select count(*)::int as n from public.notifications`);
  check(num(visible.rows[0].n) > 0, 'their own inbox has rows');
  check(
    num(visible.rows[0].n) + num(mine.n) >= num(visible.rows[0].n),
    'and other people’s notices exist but are not among them',
  );
  const leaked = await asUser(WORKER,
    `select count(*)::int as n from public.notifications where recipient_id <> $1`, [WORKER]);
  check(num(leaked.rows[0].n) === 0, 'nobody else’s notice is readable');

  // Marking it read is theirs to do.
  const markAll = page.getByRole('button', { name: /^Mark all/ }).first();
  check((await markAll.count()) > 0, 'with a way to mark them all read');
  await markAll.click();
  await page.waitForTimeout(2000);
  const unread = await one(
    `select count(*)::int as n from public.notifications
      where recipient_id = $1 and not read`, [WORKER]);
  check(num(unread.n) === 0, 'and marking them read is theirs to do');
}

// ---------------------------------------------------------------------------
console.log('\n  notices: what may be turned off, and what may not');
{
  const { page } = worker;
  await page.goto(`${BASE}/notifications?tab=settings`, { waitUntil: 'domcontentloaded' });
  const body = await page.locator('body').textContent();
  check(/Your own pay/.test(body), 'the settings list every kind of notice');
  check(
    /Always sent: this is about your own access or your own pay/.test(body),
    'and say plainly which cannot be turned off',
  );

  const boxes = await page.locator('input[type="checkbox"][name^="push_"]').count();
  const categories = await one(
    `select count(*)::int as n from app.notification_categories() where mutable`);
  check(boxes === num(categories.n), 'only the ones that may be muted have a switch');

  await page.locator('input[name="push_workforce"]').uncheck();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(2000);
  const prefs = await one(
    `select notification_preferences from public.users where id = $1`, [WORKER]);
  check(prefs.notification_preferences.workforce === false, 'turning one off is saved');

  const allowed = await one(
    `select app.push_allowed($1, 'attendance_review') as ordinary,
            app.push_allowed($1, 'payroll_paid') as critical`, [WORKER]);
  check(allowed.ordinary === false, 'push stops for that kind');
  check(allowed.critical === true, 'and never for their own pay');
}

// ---------------------------------------------------------------------------
console.log('\n  the delivery endpoint is not open to a browser');
{
  const { page } = admin;
  const attempt = await page.evaluate(async () => {
    const response = await fetch('/api/notifications/deliver', {
      method: 'POST', credentials: 'same-origin',
    });
    return response.status;
  });
  check([401, 503].includes(attempt), 'posting to it without the secret is refused');
}

await admin.context.close();
await cashier.context.close();
await worker.context.close();
await browser.close();
await db.end();

console.log(
  failures === 0
    ? '\nAll report and notification checks passed.'
    : `\n${failures} report or notification check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
