#!/usr/bin/env node
/**
 * The Phase C workflow, driven through the real browser against the real
 * database:
 *
 *   Cashier: register customer -> register vehicle -> plate search ->
 *            select services -> create the job
 *   Manager: assign a worker
 *   Worker:  accept -> start -> pause -> resume -> complete
 *            -> the job reports ready to invoice, and stops there.
 *
 * It also checks the worker/customer-phone boundary in the UI itself.
 */
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres:devonly@127.0.0.1:5432/ramosmax_dev';
const PASSWORD = 'DevP@ssw0rd!';
const PLATE = 'UEE 424E';

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

// This script needs a FRESH development database (npm run db:reset). It does
// not clean up after itself on purpose: RamosMAX never deletes a customer,
// vehicle or job, and a test script must not be the one exception that
// pretends otherwise.
const { rows: existing } = await db.query(
  `select count(*)::int as n from public.customers where phone_number = '+256772990001'`,
);
if (existing[0].n > 0) {
  console.error('\n  This script needs a fresh database. Run: npm run db:reset');
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? undefined });

async function signIn(phone, viewport = { width: 390, height: 844 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Phone number').fill(phone);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 15_000 });
  return { context, page };
}

// ---------------------------------------------------------------------------
console.log('\n  cashier: register a customer');
const cashier = await signIn('0772000003');
{
  const { page } = cashier;
  await page.goto(`${BASE}/customers/new`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Full name').fill('E2E Workflow Customer');
  await page.getByLabel('Phone number').fill('0772 990 001');
  await page.getByRole('button', { name: 'Add customer' }).click();
  await page.waitForURL(/\/customers\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  check(true, 'customer created and opened');

  const body = await page.textContent('body');
  check(/RMX-CUS-\d{6}/.test(body), 'a customer number was allocated');
  check(body.includes('+256 772 990 001'), 'the phone number was normalised to E.164');

  // A duplicate phone number must be refused with the server's own wording.
  await page.goto(`${BASE}/customers/new`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Full name').fill('Duplicate Phone');
  await page.getByLabel('Phone number').fill('0772990001');
  await page.getByRole('button', { name: 'Add customer' }).click();
  await page.waitForSelector('[data-form-error]', { timeout: 15_000 });
  const message = await page.locator('[data-form-error]').first().textContent();
  check(
    message.includes('A customer with this phone number already exists'),
    'a duplicate phone number is refused',
  );
}

// ---------------------------------------------------------------------------
console.log('\n  cashier: plate-first intake');
{
  const { page } = cashier;
  await page.goto(`${BASE}/new-service`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Number plate').fill(PLATE);
  await page.waitForTimeout(700);
  const empty = await page.textContent('body');
  check(empty.includes('No vehicle with that plate'), 'an unknown plate offers registration');

  await page.getByRole('link', { name: /Register/ }).click();
  await page.waitForURL(/\/vehicles\/new/, { timeout: 15_000 });
  const prefilled = await page.getByLabel('Number plate').inputValue();
  check(prefilled.toUpperCase().replace(/\s/g, '') === 'UEE424E', 'the plate is pre-filled');

  await page.getByLabel('Model').fill('Noah');
  await page.getByLabel('Colour').fill('Pearl');
  await page.getByLabel('Make').fill('Toyota');
  await page.selectOption('#customer_id', {
    label: (
      await page
        .locator('#customer_id option')
        .filter({ hasText: 'E2E Workflow Customer' })
        .first()
        .textContent()
    ).trim(),
  });
  await page.getByRole('button', { name: 'Register vehicle' }).click();

  // Registering from the intake flow returns to service selection.
  await page.waitForURL(/\/new-service\?vehicle=/, { timeout: 15_000 });
  check(true, 'registration returns to service selection');

  const heading = await page.textContent('h1');
  check(heading.trim() === PLATE, 'the plate was normalised to its display form');

  // Select two services and read the indicative total.
  const boxes = page.locator('input[type="checkbox"]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  const total = await page.textContent('body');
  check(/Indicative total/.test(total), 'an indicative total is shown at the counter');

  await page.getByRole('button', { name: 'Start service' }).click();
  await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  check(true, 'the job was created and opened');

  const job = await page.textContent('body');
  check(/RMX-JOB-\d{6}/.test(job), 'a job number was allocated');
  check(job.includes('Price at intake'), 'the price snapshot is shown');
  check(job.includes('Unassigned'), 'the worker orders start unassigned');
}

const jobUrl = cashier.page.url();
const jobId = jobUrl.split('/').pop();

// A second job for the same vehicle must be refused.
{
  const { page } = cashier;
  await page.goto(`${BASE}/new-service`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Number plate').fill(PLATE);
  await page.waitForTimeout(700);
  await page
    .getByRole('link', { name: new RegExp(PLATE) })
    .first()
    .click()
    .catch(() => {});
  await page.waitForTimeout(500);
  if (page.url().includes('vehicle=')) {
    await page.locator('input[type="checkbox"]').first().check();
    await page.getByRole('button', { name: 'Start service' }).click();
    await page.waitForSelector('[data-form-error]', { timeout: 15_000 });
    const message = await page.locator('[data-form-error]').first().textContent();
    check(
      message.includes('already has a service in progress'),
      'a second open job for the same vehicle is refused',
    );
  } else {
    check(false, 'could not reopen the vehicle to test the duplicate job rule');
  }
}

// ---------------------------------------------------------------------------
console.log('\n  manager: assign the work');
const manager = await signIn('0772000002', { width: 1280, height: 800 });
{
  const { page } = manager;
  await page.goto(`${BASE}/jobs/${jobId}`, { waitUntil: 'domcontentloaded' });
  // `name` matching is substring-based by default, and "Assign" would also
  // match "Reassign". Exact matching is required here.
  // `name` matching is substring-based by default, and "Assign" would also
  // match "Reassign". Exact matching is required here.
  const count = await page.getByRole('button', { name: 'Assign', exact: true }).count();
  check(count === 2, `both worker orders offer Assign (found ${count})`);

  // One order at a time: opening both panels at once would leave two pickers
  // on the page, which is exactly the ambiguity a real user never creates.
  for (let i = 0; i < count; i += 1) {
    const card = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: 'Assign', exact: true }) })
      .first();
    await card.getByRole('button', { name: 'Assign', exact: true }).click();
    await card.locator('select[name="worker_id"]').selectOption({ label: 'Test Worker' });
    await card.getByRole('button', { name: 'Assign worker', exact: true }).click();
    await page.waitForTimeout(1500);
  }

  const assigned = await page.textContent('body');
  check(assigned.includes('Test Worker'), 'the orders are assigned to the worker');
}

// ---------------------------------------------------------------------------
console.log('\n  worker: carry out the work');
const worker = await signIn('0772000004');
{
  const { page } = worker;
  await page.goto(`${BASE}/my-jobs`, { waitUntil: 'domcontentloaded' });
  const body = await page.textContent('body');
  check(body.includes(PLATE), 'the worker sees the assigned job');
  check(body.includes('2 to do') || body.includes('to do'), 'the worker sees a to-do count');

  // The worker must NOT see the customer's phone number anywhere.
  check(
    !body.includes('990 001') && !body.includes('990001'),
    'My Jobs shows no customer phone number',
  );

  // Cards are identified by their ORDER NUMBER, which never changes. Scoping
  // by a button would be wrong: the button disappears the moment it is
  // clicked, and the locator would then re-resolve to a different card.
  const { rows: orderRows } = await db.query(
    `select order_number from public.worker_orders
      where service_intake_id = $1 order by order_number`,
    [jobId],
  );
  const orderNumbers = orderRows.map((r) => r.order_number);
  check(orderNumbers.length === 2, 'the job has two worker orders');

  const cardFor = (orderNumber) =>
    page.getByRole('listitem').filter({ hasText: orderNumber }).first();

  /**
   * One action on one card. The card's action button and the form's submit
   * button share a label by design — the person sees one verb throughout — so
   * both clicks are scoped to the same card.
   */
  async function act(orderNumber, label, fill) {
    const card = cardFor(orderNumber);
    await card.getByRole('button', { name: label, exact: true }).click();
    if (fill) await fill(card);
    await card.getByRole('button', { name: label, exact: true }).click();
    await page.waitForTimeout(1400);
  }

  for (const orderNumber of orderNumbers) await act(orderNumber, 'Accept job');
  check((await page.textContent('body')).includes('Accepted'), 'both orders are accepted');

  for (const orderNumber of orderNumbers) await act(orderNumber, 'Start work');
  check((await page.textContent('body')).includes('In progress'), 'work is in progress');

  // Pause and resume the first order.
  {
    const card = cardFor(orderNumbers[0]);
    await card.getByRole('button', { name: 'Pause', exact: true }).click();
    await card.getByLabel('Why are you pausing?').fill('Waiting for water');
    await card.getByRole('button', { name: 'Pause work', exact: true }).click();
    await page.waitForTimeout(1400);
  }
  check(
    (await page.textContent('body')).includes('Waiting for water'),
    'the pause reason is shown',
  );

  await act(orderNumbers[0], 'Resume work');
  check(
    !(await page.textContent('body')).includes('Waiting for water'),
    'resuming clears the pause reason',
  );

  for (const orderNumber of orderNumbers) await act(orderNumber, 'Mark complete');

  const finished = await page.textContent('body');
  check(finished.includes('Finished'), 'completed work moves to Finished');
}

// ---------------------------------------------------------------------------
console.log('\n  the job is ready to invoice, and stops there');
{
  const { rows } = await db.query(
    `select status, completed_at from public.service_intakes where id = $1`,
    [jobId],
  );
  check(rows[0].status === 'completed', 'the job is completed in the database');
  check(rows[0].completed_at !== null, 'a completion time was recorded');

  const { page } = manager;
  await page.goto(`${BASE}/jobs/${jobId}`, { waitUntil: 'domcontentloaded' });
  const body = await page.textContent('body');
  check(body.includes('ready to invoice'), 'the job reports itself ready to invoice');
  check(body.includes('next phase'), 'and says invoicing is not in this phase');
  check(!/Create invoice/i.test(body), 'no invoicing action is offered');
}

// ---------------------------------------------------------------------------
console.log('\n  worker isolation in the UI');
{
  const { page } = worker;

  for (const path of ['/customers', '/jobs']) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    check(page.url().includes('module-unavailable'), `the worker is turned away from ${path}`);
  }

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Open menu' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  for (const hidden of ['Customers', 'Jobs', 'Payroll', 'Finance']) {
    const found = await drawer.getByRole('link', { name: hidden, exact: true }).count();
    check(found === 0, `the worker's menu does not offer ${hidden}`);
  }
  for (const shown of ['My Jobs', 'Vehicles', 'Services']) {
    const found = await drawer.getByRole('link', { name: shown, exact: true }).count();
    check(found === 1, `the worker's menu offers ${shown}`);
  }
  await page.keyboard.press('Escape');

  // Plate look-up works, and shows the owner's name but never their phone.
  await page.goto(`${BASE}/vehicles?q=UEE424E`, { waitUntil: 'domcontentloaded' });
  const list = await page.textContent('body');
  check(list.includes(PLATE), 'the worker can look up a plate');
  check(list.includes('E2E Workflow Customer'), 'the owner name is shown on the job card');
  check(
    !list.includes('990 001') && !list.includes('990001'),
    'the vehicle list shows no phone number',
  );

  // ...and the vehicle detail page likewise.
  const { rows } = await db.query(
    `select id from public.vehicles where normalized_plate = 'UEE424E'`,
  );
  await page.goto(`${BASE}/vehicles/${rows[0].id}`, { waitUntil: 'domcontentloaded' });
  const detail = await page.textContent('body');
  check(detail.includes('E2E Workflow Customer'), 'the owner name is shown on the vehicle');
  check(
    !detail.includes('990 001') && !detail.includes('990001'),
    'the vehicle detail shows no phone number',
  );
  check(
    !/Open customer|customers\//.test(await page.content()),
    'no link into the customer record is offered to a worker',
  );
}

// ---------------------------------------------------------------------------
console.log('\n  the cashier, who may see customers, does see the phone number');
{
  const { page } = cashier;
  await page.goto(`${BASE}/customers?q=E2E`, { waitUntil: 'domcontentloaded' });
  const body = await page.textContent('body');
  check(body.includes('990 001'), 'the cashier sees the phone number');
}

await cashier.context.close();
await manager.context.close();
await worker.context.close();
await browser.close();
await db.end();

console.log(
  failures === 0
    ? '\nAll Phase C workflow checks passed.'
    : `\n${failures} Phase C workflow check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
