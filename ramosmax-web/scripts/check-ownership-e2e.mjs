#!/usr/bin/env node
/**
 * The shareholder, share and dividend workflows, driven through the real
 * browser against the real database.
 *
 *   Admin A:  create a share class and two shareholders
 *   Admin A:  link one shareholder to a sign-in
 *   Admin A:  request an issue of shares -> NOTHING moves
 *   Admin B:  approve it -> ownership, a contribution, a ledger entry
 *   Admin A:  request a transfer; Admin B approves -> ownership follows the ledger
 *   Admin A:  a dividend run -> calculate -> declare
 *   Admin B:  approve -> distribute -> reverse one payment
 *   Shareholder: sees THEIR OWN record and nothing else
 *   Manager:  sees register totals, never a phone number
 *   Offline:  a share payment is refused outright, never queued
 *
 * Every figure is read back from the DATABASE, because the point of this
 * workstream is that the browser never decides who owns what.
 *
 * Run it LAST and reset afterwards: calculating a dividend locks the record
 * date for good, and a lock on today's date closes the share ledger to
 * everything that follows — including the database suites.
 */
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres:devonly@127.0.0.1:5432/ramosmax_dev';
const PASSWORD = 'DevP@ssw0rd!';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const SHAREHOLDER_UID = '00000000-0000-4000-8000-000000000005';

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

// This script asserts ABSOLUTE ownership figures, so it needs a database where
// no shares have been issued yet.
const { rows: existing } = await db.query(
  `select (select count(*) from public.share_transactions) as txns,
          (select count(*) from public.shareholders) as shareholders,
          (select count(*) from public.dividends) as dividends`,
);
if (
  Number(existing[0].txns) > 0 ||
  Number(existing[0].shareholders) > 0 ||
  Number(existing[0].dividends) > 0
) {
  console.error(
    `\n  This script needs a database with no ownership history yet` +
      ` (found ${existing[0].shareholders} shareholders). Run: npm run db:reset`,
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

/** Ownership must be the ledger, re-added. Nothing is allowed to drift. */
async function ownershipMatchesLedger() {
  const { rows } = await db.query(`
    select h.shareholder_id, h.class_id, h.shares,
           coalesce((
             select sum((l ->> 'deltaShares')::bigint)
               from public.share_transactions t, jsonb_array_elements(t.lines) l
              where t.applied and t.class_id = h.class_id
                and (l ->> 'shareholderId')::uuid = h.shareholder_id), 0) as from_ledger
      from public.shareholdings h`);
  return rows.every((r) => num(r.shares) === num(r.from_ledger));
}

// The business needs money before anyone can be paid a dividend. Another
// script may already have opened this account, in which case its float stands.
if (
  num((await one(`select opening_balance_recorded::int as done
                    from public.financial_accounts where code = 'cash_at_hand'`)).done) === 0
) {
  await asUser(
    ADMIN,
    `select * from app.record_opening_balance(
       (select id from public.financial_accounts where code = 'cash_at_hand'), 8000000, 'E2E float')`,
  );
}

// A second Administrator, because nobody approves their own request. The
// password hash is the same development one the seed uses.
await db.query(`
    with u as (
      insert into auth.users (email, encrypted_password, email_confirmed_at)
      values (app.new_sign_in_identity(), crypt($1, gen_salt('bf')), now())
      returning id)
    insert into public.users (id, phone_number, full_name, role, active)
    select u.id, '+256772000099', 'Second Administrator', 'admin', true from u
    returning id`,
  [PASSWORD],
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
const approver = await signIn('0772000099');
const manager = await signIn('0772000002');
const holder = await signIn('0772000005', { width: 390, height: 844 });

// ---------------------------------------------------------------------------
console.log('\n  admin: a share class carries the value every issue is priced at');
{
  const { page } = admin;
  await page.goto(`${BASE}/shares?tab=classes`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'New class' }).click();
  await page.locator('#class-code').fill('ORDINARY');
  await page.locator('#class-name').fill('Ordinary shares');
  await page.locator('#class-value').fill('100000');
  await page.getByRole('button', { name: 'Create class' }).click();
  await page.waitForTimeout(2000);

  const klass = await one(`select id, code, value_per_share_ugx, active from public.share_classes`);
  check(klass?.code === 'ORDINARY', 'the class was created');
  check(num(klass?.value_per_share_ugx) === 100_000, 'at UGX 100,000 a share');
  check(klass?.active === true, 'and it is active');
}

// ---------------------------------------------------------------------------
console.log('\n  admin: shareholders are people, with a reference of their own');
let amina;
let brian;
{
  const { page } = admin;
  for (const [name, phone] of [
    ['Amina Nakato', '0772900001'],
    ['Brian Okello', '0772900002'],
  ]) {
    await page.goto(`${BASE}/shareholders?tab=people`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add shareholder' }).first().click();
    await page.locator('#full_name').fill(name);
    await page.locator('#phone_number').fill(phone);
    await page.getByRole('button', { name: 'Add shareholder' }).last().click();
    await page.waitForTimeout(2000);
  }

  const { rows } = await db.query(
    `select id, shareholder_number, full_name, total_shares from public.shareholders
      order by shareholder_number`,
  );
  amina = rows.find((r) => r.full_name === 'Amina Nakato');
  brian = rows.find((r) => r.full_name === 'Brian Okello');
  check(rows.length === 2, 'both shareholders were created');
  check(/^RMX-SHR-\d{6}$/.test(amina?.shareholder_number ?? ''), 'with an RMX-SHR reference');
  check(num(amina?.total_shares) === 0, 'and no shares until some are issued');

  // Brian signs in as the seeded shareholder account.
  await page.goto(`${BASE}/shareholders/${brian.id}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Link sign-in' }).click();
  await selectByText(page, '#uid', 'Test Shareholder');
  await page.getByRole('button', { name: 'Save link' }).click();
  await page.waitForTimeout(2000);
  const linked = await one(`select linked_uid from public.shareholders where id = $1`, [brian.id]);
  check(linked?.linked_uid === SHAREHOLDER_UID, "Brian's record is linked to a sign-in");
}

// ---------------------------------------------------------------------------
console.log('\n  admin: an issue is a REQUEST — nothing moves until a second person agrees');
let issue;
{
  const { page } = admin;
  const before = await balance('cash_at_hand');

  await page.goto(`${BASE}/shares`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Issue shares' }).click();
  await selectByText(page, '#issue-sh', 'Amina Nakato');
  await selectByText(page, '#issue-class', 'ORDINARY');
  await page.locator('#issue-shares').fill('300');
  await selectByText(page, '#issue-account', 'Cash at Hand');
  await page.locator('#issue-amount').fill('30000000');
  await page.getByRole('button', { name: 'Request issue' }).click();
  await page.waitForTimeout(2500);

  issue = await one(
    `select id, transaction_number, status, applied, shares, committed_ugx, paid_ugx
       from public.share_transactions order by created_at desc limit 1`,
  );
  check(/^RMX-SHR-TXN-\d{6}$/.test(issue?.transaction_number ?? ''), 'the request was recorded');
  check(issue?.status === 'pending_approval', 'it waits for approval');
  check(issue?.applied === false, 'and it has NOT been applied');
  check(
    num((await one(`select total_shares from public.shareholders where id = $1`, [amina.id]))
      .total_shares) === 0,
    'no ownership moved',
  );
  check((await balance('cash_at_hand')) === before, 'and no money moved');
  check(
    num((await one(`select count(*)::int as n from public.share_contributions`)).n) === 0,
    'no payment was recorded either',
  );
}

// ---------------------------------------------------------------------------
console.log('\n  a second Administrator approves, and then ownership and money move together');
{
  const { page } = approver;
  const before = await balance('cash_at_hand');
  const day = await one(
    `select payments_in_ugx, share_capital_ugx from public.finance_daily_summaries
      where business_day = app.eat_day()`,
  );

  await page.goto(`${BASE}/shares/txn/${issue.id}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('button', { name: 'Approve transaction' }).click();
  await page.waitForTimeout(2500);

  const posted = await one(`select status, applied, paid_ugx from public.share_transactions where id = $1`,
    [issue.id]);
  check(posted?.status === 'posted' && posted?.applied === true, 'the entry was applied');

  const holding = await one(
    `select shares, committed_ugx, paid_ugx from public.shareholdings
      where shareholder_id = $1 and class_code = 'ORDINARY'`,
    [amina.id],
  );
  check(num(holding?.shares) === 300, 'Amina owns 300 shares');
  check(num(holding?.committed_ugx) === 30_000_000, 'committed at the class value');
  check(num(holding?.paid_ugx) === 30_000_000, 'and paid in full');

  const percent = await one(`select ownership_percent from public.shareholders where id = $1`,
    [amina.id]);
  check(num(percent?.ownership_percent) === 100, 'she owns 100% while she is the only holder');

  check((await balance('cash_at_hand')) === before + 30_000_000, 'the money reached the account');
  check(await ledgerAgrees(), 'and every account still agrees with its ledger');

  const entry = await one(
    `select entry_type, amount_ugx, category_id from public.financial_transactions
      where entry_type = 'share_capital_contribution' order by created_at desc limit 1`,
  );
  check(num(entry?.amount_ugx) === 30_000_000, 'it is one entry in the SAME ledger');
  check(entry?.category_id === null, 'carrying no expense category');

  const summary = await one(
    `select payments_in_ugx, share_capital_ugx from public.finance_daily_summaries
      where business_day = app.eat_day()`,
  );
  check(
    num(summary?.share_capital_ugx) - num(day?.share_capital_ugx) === 30_000_000,
    'the day counts it as share capital',
  );
  check(
    num(summary?.payments_in_ugx) === num(day?.payments_in_ugx),
    'and never as revenue',
  );
}

// ---------------------------------------------------------------------------
console.log('\n  a transfer moves ownership between two people, and ownership is the ledger');
{
  const beforeMoney = await balance('cash_at_hand');

  // Brian needs shares of his own first.
  const { page } = admin;
  await page.goto(`${BASE}/shares`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Issue shares' }).click();
  await selectByText(page, '#issue-sh', 'Brian Okello');
  await selectByText(page, '#issue-class', 'ORDINARY');
  await page.locator('#issue-shares').fill('100');
  await selectByText(page, '#issue-account', 'Cash at Hand');
  await page.locator('#issue-amount').fill('10000000');
  await page.getByRole('button', { name: 'Request issue' }).click();
  await page.waitForTimeout(2500);

  const brianIssue = await one(
    `select id from public.share_transactions where status = 'pending_approval'
      order by created_at desc limit 1`,
  );
  await approver.page.goto(`${BASE}/shares/txn/${brianIssue.id}`, { waitUntil: 'domcontentloaded' });
  await approver.page.getByRole('button', { name: 'Approve', exact: true }).click();
  await approver.page.getByRole('button', { name: 'Approve transaction' }).click();
  await approver.page.waitForTimeout(2500);

  await page.goto(`${BASE}/shares`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Transfer' }).click();
  await selectByText(page, '#from-sh', 'Amina Nakato');
  await selectByText(page, '#to-sh', 'Brian Okello');
  await selectByText(page, '#transfer-class', 'ORDINARY');
  await page.locator('#transfer-shares').fill('100');
  await page.locator('#transfer-reason').fill('Agreed sale between shareholders');
  await page.getByRole('button', { name: 'Request transfer' }).click();
  await page.waitForTimeout(2500);

  const transfer = await one(
    `select id from public.share_transactions where type = 'shares_transferred'
      order by created_at desc limit 1`,
  );
  await approver.page.goto(`${BASE}/shares/txn/${transfer.id}`, { waitUntil: 'domcontentloaded' });
  await approver.page.getByRole('button', { name: 'Approve', exact: true }).click();
  await approver.page.getByRole('button', { name: 'Approve transaction' }).click();
  await approver.page.waitForTimeout(2500);

  const { rows } = await db.query(
    `select s.full_name, s.total_shares, s.ownership_percent from public.shareholders s
      order by s.shareholder_number`,
  );
  const a = rows.find((r) => r.full_name === 'Amina Nakato');
  const b = rows.find((r) => r.full_name === 'Brian Okello');
  check(num(a?.total_shares) === 200, 'Amina is left with 200');
  check(num(b?.total_shares) === 200, 'Brian holds 200');
  check(num(a?.ownership_percent) === 50 && num(b?.ownership_percent) === 50, 'each owns half');
  check(await ownershipMatchesLedger(), 'every holding equals the sum of its ledger lines');
  check(
    (await balance('cash_at_hand')) === beforeMoney + 10_000_000,
    'only the issue moved money — a transfer between shareholders moves none',
  );
}

// ---------------------------------------------------------------------------
console.log('\n  offline: a share payment is refused outright, never queued');
{
  const { page } = admin;
  await page.goto(`${BASE}/shares`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Issue shares' }).click();
  await selectByText(page, '#issue-sh', 'Amina Nakato');
  await selectByText(page, '#issue-class', 'ORDINARY');
  await page.locator('#issue-shares').fill('10');
  await selectByText(page, '#issue-account', 'Cash at Hand');
  await page.locator('#issue-amount').fill('1000000');

  const before = await balance('cash_at_hand');
  const countBefore = num(
    (await one(`select count(*)::int as n from public.share_transactions`)).n,
  );
  await admin.context.setOffline(true);
  await page.getByRole('button', { name: 'Request issue' }).click();
  await page.waitForSelector('[data-form-error]', { timeout: 15_000 });
  const message = await page.locator('[data-form-error]').first().textContent();
  check(/internet connection/i.test(message), 'the request is refused while offline');
  check(/Nothing was sent/i.test(message), 'and says plainly that nothing was sent');
  check(
    num((await one(`select count(*)::int as n from public.share_transactions`)).n) === countBefore,
    'nothing was written',
  );
  check((await balance('cash_at_hand')) === before, 'and no money moved');
  await admin.context.setOffline(false);
}

// ---------------------------------------------------------------------------
console.log('\n  a dividend: calculated on the server, declared, approved by someone else');
let dividendId;
{
  const { page } = admin;
  await page.goto(`${BASE}/dividends`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Start a dividend run' }).click();
  await page.locator('#div-period').fill('2026');
  await page.locator('#div-pool').fill('1000001');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await page.waitForTimeout(2500);

  const draft = await one(
    `select id, dividend_number, status, record_locked from public.dividends
      order by created_at desc limit 1`,
  );
  dividendId = draft.id;
  check(/^RMX-DIV-\d{6}$/.test(draft?.dividend_number ?? ''), 'the run was created');
  check(draft?.status === 'draft', 'as a draft');
  check(draft?.record_locked === false, 'with the record date still open');

  await page.goto(`${BASE}/dividends/${dividendId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Calculate', exact: true }).click();
  await page.getByRole('button', { name: 'Calculate allocations' }).click();
  await page.waitForTimeout(2500);

  const calculated = await one(
    `select status, allocated_ugx, unallocated_ugx, allocation_count, record_locked,
            eligible_shares from public.dividends where id = $1`,
    [dividendId],
  );
  check(calculated?.allocation_count === 2, 'both shareholders were allocated');
  check(num(calculated?.eligible_shares) === 400, 'against the 400 shares in issue');
  check(num(calculated?.allocated_ugx) === 1_000_000, 'allocating UGX 1,000,000');
  check(num(calculated?.unallocated_ugx) === 1, 'and reporting the odd shilling as unallocated');
  check(calculated?.record_locked === true, 'the record date is now locked');

  const { rows: allocations } = await db.query(
    `select net_ugx, gross_ugx, shares_at_record_date, ownership_percent_at_record_date
       from public.dividend_allocations where dividend_id = $1 and current`,
    [dividendId],
  );
  check(
    allocations.every((a) => Number.isInteger(num(a.net_ugx))),
    'every allocation is a whole shilling',
  );
  check(
    allocations.every((a) => num(a.shares_at_record_date) === 200),
    'each allocation froze the shares held at the record date',
  );

  // A locked record date closes the ledger behind it.
  let refused = null;
  try {
    await asUser(
      ADMIN,
      `select * from app.issue_shares($1, 'ORDINARY', 5, $2, app.eat_day()::date, 'account',
         500000, (select id from public.financial_accounts where code = 'cash_at_hand'))`,
      [amina.id, `e2e-locked-${Date.now()}`],
    );
  } catch (e) {
    refused = e.message;
  }
  check(/fixed by a calculated dividend/i.test(refused ?? ''), 'and shuts the ledger behind it');

  await page.goto(`${BASE}/dividends/${dividendId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Declare', exact: true }).click();
  await page.getByRole('button', { name: 'Declare', exact: true }).last().click();
  await page.waitForTimeout(2500);
  check(
    (await one(`select status from public.dividends where id = $1`, [dividendId])).status ===
      'declared',
    'the dividend was declared',
  );
}

// ---------------------------------------------------------------------------
console.log('\n  approval, distribution and a non-destructive reversal');
{
  const { page } = approver;
  await page.goto(`${BASE}/dividends/${dividendId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
  await page.getByRole('button', { name: 'Approve', exact: true }).last().click();
  await page.waitForTimeout(2500);
  check(
    (await one(`select status from public.dividends where id = $1`, [dividendId])).status ===
      'approved',
    'a second Administrator approved it',
  );

  const before = await balance('cash_at_hand');
  const day = await one(
    `select expenses_paid_ugx, dividends_paid_ugx from public.finance_daily_summaries
      where business_day = app.eat_day()`,
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Distribute' }).click();
  await selectByText(page, '#div-pay-account', 'Cash at Hand');
  await page.getByRole('button', { name: /^Pay UGX/ }).click();
  await page.waitForTimeout(3000);

  const paid = await one(
    `select status, paid_ugx, paid_count, outstanding_ugx from public.dividends where id = $1`,
    [dividendId],
  );
  check(paid?.status === 'paid', 'the dividend was paid in full');
  check(num(paid?.paid_ugx) === 1_000_000, 'for exactly the allocated total');
  check((await balance('cash_at_hand')) === before - 1_000_000, 'and that much left the account');
  check(await ledgerAgrees(), 'the ledger still agrees with every balance');

  const { rows: entries } = await db.query(
    `select entry_type, amount_ugx, category_id from public.financial_transactions
      where entry_type = 'dividend_payment'`,
  );
  check(entries.length === 2, 'each shareholder got their own ledger entry');
  check(entries.every((e) => e.category_id === null), 'none of them is an expense');

  const summary = await one(
    `select expenses_paid_ugx, dividends_paid_ugx from public.finance_daily_summaries
      where business_day = app.eat_day()`,
  );
  check(
    num(summary?.dividends_paid_ugx) - num(day?.dividends_paid_ugx) === 1_000_000,
    "the day counts it as owners' money",
  );
  check(
    num(summary?.expenses_paid_ugx) === num(day?.expenses_paid_ugx),
    'and never as an operating expense',
  );

  // Reversal must put the allocation back without deleting anything.
  const allocation = await one(
    `select id, allocation_number, shareholder_name, net_ugx from public.dividend_allocations
      where dividend_id = $1 and current and payment_status = 'paid' limit 1`,
    [dividendId],
  );
  const beforeReversal = await balance('cash_at_hand');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Reverse a payment' }).click();
  await selectByText(page, '#div-rev-allocation', allocation.shareholder_name);
  await page.locator('#div-rev-reason').fill('Paid to the wrong mobile money number');
  await page.getByRole('button', { name: 'Reverse payment' }).click();
  await page.waitForTimeout(3000);

  const after = await one(
    `select payment_status, net_ugx from public.dividend_allocations where id = $1`,
    [allocation.id],
  );
  check(after?.payment_status === 'unpaid', 'the allocation is payable again');
  check(num(after?.net_ugx) === num(allocation.net_ugx), 'its amount was not touched');
  check(
    (await balance('cash_at_hand')) === beforeReversal + num(allocation.net_ugx),
    'the money came back',
  );
  check(
    num((await one(`select count(*)::int as n from public.financial_transactions
                     where entry_type = 'reversal'`)).n) >= 1,
    'and a reversing entry was posted rather than a row deleted',
  );
  check(
    num((await one(`select count(*)::int as n from public.dividend_allocations
                     where dividend_id = $1`, [dividendId])).n) >= 2,
    'no allocation was deleted',
  );
}

// ---------------------------------------------------------------------------
console.log('\n  a shareholder sees their own record — and nothing else at all');
{
  const { page } = holder;
  await page.goto(`${BASE}/my-shares`, { waitUntil: 'domcontentloaded' });
  const body = await page.locator('body').textContent();
  check(/Brian Okello/.test(body), 'Brian sees his own record');
  check(/200/.test(body), 'with his own shares');
  check(!/Amina/.test(body), 'and no other shareholder appears anywhere on it');

  for (const path of ['/shareholders', '/shares', '/dividends']) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    check(
      page.url().endsWith('/module-unavailable'),
      `a shareholder cannot open ${path}`,
    );
  }

  // Below the screen: the register itself is closed to the role.
  const denied = await asUser(SHAREHOLDER_UID, `select count(*)::int as n from public.share_register`);
  check(num(denied.rows[0].n) === 0, 'and the register returns nothing to them at the table');
}

// ---------------------------------------------------------------------------
console.log('\n  a manager with shareholder reporting sees totals, never contact details');
{
  const { page } = manager;
  await page.goto(`${BASE}/shareholders`, { waitUntil: 'domcontentloaded' });
  const body = await page.locator('body').textContent();
  check(/Amina Nakato/.test(body), 'the register names who owns what');
  check(!/0772900001/.test(body), 'but never shows a phone number');

  const rows = await asUser(
    '00000000-0000-4000-8000-000000000002',
    `select count(*)::int as n from public.shareholders`,
  );
  check(num(rows.rows[0].n) === 0, 'and the shareholders table itself stays closed to them');

  await page.goto(`${BASE}/shares`, { waitUntil: 'domcontentloaded' });
  check(page.url().endsWith('/module-unavailable'), 'the share ledger is not theirs to read');
}

await admin.context.close();
await approver.context.close();
await manager.context.close();
await holder.context.close();
await browser.close();
await db.end();

console.log(
  failures === 0
    ? '\nAll ownership workflow checks passed.'
    : `\n${failures} ownership workflow check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
