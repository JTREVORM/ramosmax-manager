#!/usr/bin/env node
/**
 * Phase A exit criterion: the sign-in page renders and is responsive at all
 * four breakpoints, and the authenticated shell shows the right navigation
 * presentation for each.
 *
 * Checks that actually matter on a phone:
 *   - no horizontal page scroll (the classic mobile failure);
 *   - the primary action is reachable without scrolling;
 *   - touch targets are at least 44px;
 *   - the right navigation presentation is visible per breakpoint;
 *   - every destination stays reachable from the drawer on a small screen.
 *
 * Usage: build and start the app on port 3100, then
 *   CHROMIUM_PATH=/path/to/chromium node scripts/check-responsive.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import pg from 'pg';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres:devonly@127.0.0.1:5432/ramosmax_dev';
const OUT = process.env.SHOT_DIR ?? '.responsive';

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, label: 'base  <640px' },
  { name: 'tablet', width: 820, height: 1180, label: 'sm/md 640-1024px' },
  { name: 'laptop', width: 1280, height: 800, label: 'lg    1024-1440px' },
  { name: 'desktop', width: 1600, height: 900, label: 'xl    >1440px' },
];

let failures = 0;

function check(passed, message) {
  if (passed) {
    console.log(`    ok    ${message}`);
  } else {
    failures += 1;
    console.error(`    FAIL  ${message}`);
  }
}

const pageOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function checkSignIn(page, viewport) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: `${OUT}/login-${viewport.name}.png`, fullPage: true });

  check(await page.getByRole('heading', { name: 'RamosMAX' }).isVisible(), 'sign-in page renders');

  const controls = [
    ['phone number field', page.getByLabel('Phone number')],
    ['password field', page.getByLabel('Password', { exact: true })],
    ['sign-in button', page.getByRole('button', { name: 'Sign in' })],
  ];
  for (const [label, locator] of controls) {
    check(await locator.isVisible(), `${label} visible`);
  }

  check((await pageOverflow(page)) <= 0, 'no horizontal scroll');

  const submit = await page.getByRole('button', { name: 'Sign in' }).boundingBox();
  const height = submit ? Math.round(submit.height) : 0;
  check(height >= 44, `submit button is ${height}px tall (>=44)`);

  // Nobody should have to scroll to sign in.
  check(
    Boolean(submit) && submit.y + submit.height <= viewport.height,
    'sign-in button is above the fold',
  );

  // Validation works before any server exists.
  await page.getByLabel('Phone number').fill('0552123456');
  await page.getByRole('button', { name: 'Sign in' }).click();
  check(await page.locator('#phone-error').isVisible(), 'rejects an invalid phone number');

  // A well-formed but unknown number must clear the client-side error and be
  // answered by the SERVER with the generic credential message.
  await page.getByLabel('Phone number').fill('0772 123 456');
  await page.getByLabel('Password', { exact: true }).fill('Str0ng!Pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForSelector('#sign-in-error', { timeout: 15_000 });
  check(!(await page.locator('#phone-error').isVisible()), 'accepts a valid Ugandan phone number');
}

/**
 * The shell is behind authentication, so sign in with the development
 * administrator first. That also means these checks exercise the real
 * permission-driven navigation rather than a placeholder.
 */
async function signIn(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Phone number').fill('0772000001');
  await page.getByLabel('Password', { exact: true }).fill('DevP@ssw0rd!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 15_000 });
}

async function checkShell(page, viewport) {
  await signIn(page);
  await page.screenshot({ path: `${OUT}/shell-${viewport.name}.png` });

  const sidebar = page.getByRole('navigation', { name: 'Main' });
  const bottomBar = page.getByRole('navigation', { name: 'Primary' });
  const menuButton = page.getByRole('button', { name: 'Open menu' });

  if (viewport.width >= 1024) {
    check(await sidebar.isVisible(), 'desktop sidebar visible');
    check(!(await bottomBar.isVisible()), 'bottom bar hidden on desktop');
    check(!(await menuButton.isVisible()), 'hamburger hidden on desktop');
  } else {
    check(!(await sidebar.isVisible()), 'desktop sidebar hidden on small screen');
    check(await bottomBar.isVisible(), 'bottom bar visible');
    check(await menuButton.isVisible(), 'menu button visible');

    await menuButton.click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    check(await drawer.isVisible(), 'drawer opens');

    const destinations = await drawer.getByRole('link').count();
    check(destinations >= 20, `drawer exposes ${destinations} destinations`);

    await page.keyboard.press('Escape');
    check(!(await drawer.isVisible()), 'Escape closes the drawer');
  }

  check((await pageOverflow(page)) <= 0, 'shell has no horizontal scroll');
}

/**
 * The Phase C screens at every breakpoint. The checks that matter on a phone:
 * no horizontal scroll, and the data-dense screens rendering as CARDS rather
 * than a table that must be scrolled sideways.
 */
async function checkOperations(page, viewport) {
  const screens = [
    ['/customers', 'Customers'],
    ['/vehicles', 'Vehicles'],
    ['/services', 'Services'],
    ['/jobs', 'Jobs'],
    ['/new-service', 'New service'],
  ];

  for (const [path, title] of screens) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    const heading = await page.getByRole('heading', { level: 1 }).first().textContent();
    check(heading.trim() === title, `${path} renders`);
    check((await pageOverflow(page)) <= 0, `${path} has no horizontal scroll`);
    await page.screenshot({ path: `${OUT}/ops-${viewport.name}-${path.slice(1)}.png` });
  }

  // The table/card switch: a table on a wide screen, cards on a phone.
  await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded' });
  const table = page.getByRole('table').first();
  const list = page.getByRole('list', { name: 'Customers' }).first();
  if (viewport.width >= 768) {
    check(await table.isVisible(), 'customers render as a table on a wide screen');
    check(!(await list.isVisible()), 'the card list is hidden on a wide screen');
  } else {
    check(await list.isVisible(), 'customers render as cards on a phone');
    check(!(await table.isVisible()), 'the table is hidden on a phone');
  }

  // Touch targets on the busiest form.
  await page.goto(`${BASE}/customers/new`, { waitUntil: 'domcontentloaded' });
  const submit = await page.getByRole('button', { name: 'Add customer' }).boundingBox();
  check(submit !== null && submit.height >= 44, 'the form submit meets the 44px touch target');
  check((await pageOverflow(page)) <= 0, 'the customer form has no horizontal scroll');
}

/**
 * An invoice with money still owing, so the payment panel can be measured at
 * every breakpoint. Reuses one if the database already has it; otherwise it
 * drives the same RPCs the application does, as the seeded manager and worker,
 * so this script does not depend on another script having run first.
 */
async function unpaidInvoice(db) {
  const MANAGER = '00000000-0000-4000-8000-000000000002';
  const WORKER = '00000000-0000-4000-8000-000000000004';

  const asUser = async (uid, sql, params = []) => {
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
  };

  const { rows: open } = await db.query(
    `select id from public.invoices
      where status = 'active' and outstanding_ugx > 0 order by created_at limit 1`,
  );
  if (open.length > 0) return open[0].id;

  const plate = `URS ${Math.floor(Math.random() * 900 + 100)}Z`;
  const customer = (
    await asUser(MANAGER, `select app.create_customer($1, $2) as id`, [
      'Responsive Fixture Customer',
      `+2567729903${Math.floor(Math.random() * 90 + 10)}`,
    ])
  ).rows[0].id;
  const vehicle = (
    await asUser(MANAGER, `select app.create_vehicle($1, $2, $3, $4, null, null, $5) as id`, [
      plate,
      'Vitz',
      'Blue',
      'Toyota',
      customer,
    ])
  ).rows[0].id;
  const service = (await db.query(`select id from public.services where name = 'Body Wash'`))
    .rows[0].id;
  const job = (
    await asUser(MANAGER, `select app.create_service_intake($1, $2) as id`, [vehicle, [service]])
  ).rows[0].id;

  const { rows: orders } = await db.query(
    `select id from public.worker_orders where service_intake_id = $1`,
    [job],
  );
  for (const order of orders) {
    await asUser(MANAGER, `select app.assign_worker_order($1, $2)`, [order.id, WORKER]);
    for (const action of ['accept', 'start', 'complete']) {
      await asUser(WORKER, `select app.update_worker_order_status($1, $2)`, [order.id, action]);
    }
  }
  return (await asUser(MANAGER, `select app.create_invoice($1) as id`, [job])).rows[0].id;
}

/**
 * The Phase D money screens at every breakpoint. These carry the densest data
 * in the system — amounts, statuses, dates and actions — so the card/table
 * switch and the absence of sideways scroll matter most here.
 *
 * It expects the Phase D workflow script to have run against this database, so
 * there is a real invoice to open rather than an empty state.
 */
async function checkBilling(page, viewport, invoiceId) {
  const screens = [
    ['/invoices', 'Invoices'],
    ['/payments', 'Payments'],
    ['/receipts', 'Receipts'],
    ['/credit', 'Credit'],
    ['/loyalty', 'Loyalty'],
  ];

  for (const [path, title] of screens) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    const heading = await page.getByRole('heading', { level: 1 }).first().textContent();
    check(heading.trim() === title, `${path} renders`);
    check((await pageOverflow(page)) <= 0, `${path} has no horizontal scroll`);
    await page.screenshot({ path: `${OUT}/money-${viewport.name}-${path.slice(1)}.png` });
  }

  // Money tables must become cards on a phone: an amount column pushed off the
  // right edge is how a cashier reads the wrong figure.
  await page.goto(`${BASE}/invoices`, { waitUntil: 'domcontentloaded' });
  const table = page.getByRole('table').first();
  const list = page.getByRole('list', { name: 'Invoices' }).first();
  if (viewport.width >= 768) {
    check(await table.isVisible(), 'invoices render as a table on a wide screen');
    check(!(await list.isVisible()), 'the invoice card list is hidden on a wide screen');
  } else {
    check(await list.isVisible(), 'invoices render as cards on a phone');
    check(!(await table.isVisible()), 'the invoice table is hidden on a phone');
  }

  // Both presentations are in the DOM; only one is visible at this width.
  const invoiceLink = page.locator('a[href^="/invoices/"]:visible').first();
  check((await invoiceLink.count()) === 1, 'an invoice row is reachable from the list');

  // The invoice with money still owing, so the payment panel is there to measure.
  await page.goto(`${BASE}/invoices/${invoiceId}`, { waitUntil: 'domcontentloaded' });
  check((await pageOverflow(page)) <= 0, 'the invoice detail has no horizontal scroll');
  await page.screenshot({ path: `${OUT}/money-${viewport.name}-invoice.png`, fullPage: true });

  const pay = page.getByRole('button', { name: 'Take payment' });
  if ((await pay.count()) > 0) {
    // 44px is a TOUCH requirement, applied by the coarse-pointer rule in
    // globals.css. A mouse-driven desktop keeps the compact button.
    const minimum = viewport.width < 1024 ? 44 : 32;
    const box = await pay.first().boundingBox();
    const height = box ? Math.round(box.height) : 0;
    check(height >= minimum, `the payment action is ${height}px tall (>=${minimum})`);
    await pay.first().click();
    await page.waitForTimeout(300);
    const amount = await page.locator('input[name="amount_ugx"]').boundingBox();
    check(
      amount !== null && amount.height >= 44,
      'the amount field meets the 44px touch target at every size',
    );
    check((await pageOverflow(page)) <= 0, 'the open payment panel has no horizontal scroll');
    await page.screenshot({ path: `${OUT}/money-${viewport.name}-payment.png`, fullPage: true });
  } else {
    check(false, 'the invoice offers a payment action');
  }

  // The receipt is the one screen a customer sees; it must read well narrow.
  await page.goto(`${BASE}/receipts`, { waitUntil: 'domcontentloaded' });
  const receiptLink = page.locator('a[href^="/receipts/RMX-RCP-"]:visible').first();
  if ((await receiptLink.count()) > 0) {
    await receiptLink.click();
    await page.waitForURL(/\/receipts\/RMX-RCP-/, { timeout: 15_000 });
    check((await pageOverflow(page)) <= 0, 'the receipt has no horizontal scroll');
    await page.screenshot({ path: `${OUT}/money-${viewport.name}-receipt.png`, fullPage: true });
  } else {
    check(false, 'a receipt exists to open (run scripts/check-billing-e2e.mjs first)');
  }
}

/**
 * At least one expense and one stocked item, so the Phase E screens have
 * something to show. Reuses what is there; otherwise drives the same RPCs the
 * application does, as the seeded manager.
 */
async function moneyFixtures(db) {
  const MANAGER = '00000000-0000-4000-8000-000000000002';
  const asUser = async (uid, sql, params = []) => {
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
  };
  const unique = Math.random().toString(36).slice(2, 8);

  let expense = (await db.query(`select id from public.expenses order by created_at limit 1`))
    .rows[0];
  if (!expense) {
    expense = (
      await asUser(
        MANAGER,
        `select expense_id as id from app.create_expense('utilities', $1, 250000, current_date, $2,
                                                        'A Vendor', null, null, null, true)`,
        [`Responsive fixture ${unique}`, `resp-exp-${unique}`],
      )
    ).rows[0];
  }

  let item = (await db.query(`select id from public.inventory_items order by created_at limit 1`))
    .rows[0];
  if (!item) {
    const supplier = (
      await asUser(MANAGER, `select supplier_id as id from app.create_supplier($1)`, [
        `Responsive Supplier ${unique}`,
      ])
    ).rows[0];
    item = (
      await asUser(
        MANAGER,
        `select item_id as id from app.create_inventory_item($1, 'chemicals', 'litre', 2, 4, null,
                                                            true, $2, 12000, null, 25)`,
        [`Responsive Item ${unique}`, supplier.id],
      )
    ).rows[0];
  }

  return { expense: expense.id, item: item.id };
}

/**
 * The Phase E screens at every breakpoint: finance, expenses and inventory are
 * the densest data in the system, and a manager reads them on a phone.
 */
async function checkPhaseE(page, viewport, fixtures) {
  const screens = [
    ['/finance', 'Finance'],
    ['/transactions', 'Transactions'],
    ['/reconciliation', 'Reconciliation'],
    ['/finance/transfers', 'Transfers'],
    ['/finance/banking', 'Banking'],
    ['/expenses', 'Expenses'],
    ['/expenses/new', 'Record expense'],
    ['/expenses/recurring', 'Recurring expenses'],
    ['/expenses/categories', 'Expense categories'],
    ['/inventory', 'Inventory'],
    ['/inventory/items/new', 'New item'],
    ['/inventory/suppliers', 'Suppliers'],
    ['/inventory/purchases', 'Purchases'],
    ['/inventory/purchases/new', 'New purchase'],
    ['/inventory/movements', 'Stock movements'],
  ];

  for (const [path, title] of screens) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    const heading = await page.getByRole('heading', { level: 1 }).first().textContent();
    check(heading.trim() === title, `${path} renders`);
    check((await pageOverflow(page)) <= 0, `${path} has no horizontal scroll`);
  }
  await page.goto(`${BASE}/finance`, { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: `${OUT}/phaseE-${viewport.name}-finance.png`, fullPage: true });

  // Detail screens.
  for (const [path, label] of [
    [`/expenses/${fixtures.expense}`, 'the expense detail'],
    [`/inventory/items/${fixtures.item}`, 'the item detail'],
  ]) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    check((await pageOverflow(page)) <= 0, `${label} has no horizontal scroll`);
    await page.screenshot({
      path: `${OUT}/phaseE-${viewport.name}-${label.split(' ')[1]}.png`,
      fullPage: true,
    });
  }

  // The ledger is the widest table in the system: cards on a phone, table above.
  await page.goto(`${BASE}/transactions`, { waitUntil: 'domcontentloaded' });
  const table = page.getByRole('table').first();
  const list = page.getByRole('list', { name: 'Transactions' }).first();
  if (viewport.width >= 768) {
    check(await table.isVisible(), 'the ledger is a table on a wide screen');
    check(!(await list.isVisible()), 'the ledger card list is hidden on a wide screen');
  } else {
    check(await list.isVisible(), 'the ledger renders as cards on a phone');
    check(!(await table.isVisible()), 'the ledger table is hidden on a phone');
  }

  // A money form on a phone must still be usable.
  await page.goto(`${BASE}/finance/transfers`, { waitUntil: 'domcontentloaded' });
  const amount = await page.locator('input[name="amount_ugx"]').boundingBox();
  check(
    amount !== null && amount.height >= 44,
    'the transfer amount field meets the 44px touch target',
  );
  const submit = await page.getByRole('button', { name: 'Transfer' }).boundingBox();
  check(submit !== null && submit.height >= 44, 'the transfer submit meets the 44px touch target');
  check((await pageOverflow(page)) <= 0, 'the transfer form has no horizontal scroll');
  await page.screenshot({ path: `${OUT}/phaseE-${viewport.name}-transfer.png`, fullPage: true });
}

async function checkDarkMode(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: `${OUT}/login-phone-dark.png`, fullPage: true });

  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  console.log(`\n  dark mode: body background ${background}`);
  check(background === 'rgb(18, 16, 22)', 'dark tokens applied');

  await context.close();
}

/**
 * Workforce fixtures: a salary, an attendance record with its allowance, a
 * payroll and a loss incident — created through the real functions, as the
 * people who may.
 */
async function workforceFixtures(db) {
  const ADMIN = '00000000-0000-4000-8000-000000000001';
  const MANAGER = '00000000-0000-4000-8000-000000000002';
  const WORKER = '00000000-0000-4000-8000-000000000004';
  const asUser = async (uid, sql, params = []) => {
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
  };
  const unique = Math.random().toString(36).slice(2, 8);
  const first = async (sql, params) => (await db.query(sql, params)).rows[0];

  const when = await first(`
    select g.d::date::text as day, extract(year from g.d)::int as year,
           extract(month from g.d)::int as month
      from generate_series(date_trunc('month', app.eat_day())::date, app.eat_day() - 1,
                           interval '1 day') g(d)
     where extract(isodow from g.d) between 1 and 6
     order by g.d desc limit 1`);

  if (
    !(await first(`select staff_uid from public.salary_profiles where staff_uid = $1`, [WORKER]))
  ) {
    await asUser(ADMIN, `select * from app.set_salary_profile($1, 600000, '2020-01-01')`, [WORKER]);
  }

  let attendance = await first(
    `select id from public.attendance where staff_uid = $1 order by business_day desc limit 1`,
    [WORKER],
  );
  if (!attendance) {
    attendance = (
      await asUser(
        MANAGER,
        `select attendance_id as id from app.record_attendance($1, 'present', $2::date,
         (($2::date + time '08:45') at time zone 'Africa/Kampala'))`,
        [WORKER, when.day],
      )
    ).rows[0];
    await asUser(MANAGER, `select app.verify_attendance(array[$1]::uuid[], 'approve')`, [
      attendance.id,
    ]);
    await asUser(MANAGER, `select * from app.calculate_allowances($1::date)`, [when.day]);
  }

  let payroll = await first(`select id from public.payroll order by created_at limit 1`);
  if (!payroll) {
    payroll = (
      await asUser(MANAGER, `select payroll_id as id from app.create_payroll('monthly', $1, $2)`, [
        when.year,
        when.month,
      ])
    ).rows[0];
    await asUser(MANAGER, `select * from app.prepare_payroll($1)`, [payroll.id]);
  }

  let incident = await first(`select id from public.loss_incidents order by created_at limit 1`);
  if (!incident) {
    incident = (
      await asUser(
        MANAGER,
        `select incident_id as id from app.create_loss_incident('damaged_equipment', 300000,
         'Responsive fixture', $1, $2)`,
        [`resp-loss-${unique}`, WORKER],
      )
    ).rows[0];
  }

  const deduction = await first(`select id from public.salary_deductions limit 1`);

  return {
    attendance: attendance.id,
    payroll: payroll.id,
    incident: incident.id,
    deduction: deduction?.id ?? null,
    staff: WORKER,
  };
}

/**
 * The Phase F screens at every breakpoint. Attendance and allowances are used
 * on the forecourt, on a phone, by the people they are about.
 */
async function checkPhaseF(page, viewport, fixtures) {
  const screens = [
    ['/attendance', 'Attendance'],
    ['/attendance?view=verify', 'Attendance'],
    ['/allowances', 'Allowances & pay'],
    ['/allowances?view=unpaid', 'Allowances & pay'],
    ['/allowances?view=mine', 'Allowances & pay'],
    ['/payroll', 'Payroll'],
    ['/payroll?tab=salaries', 'Payroll'],
    ['/payroll?tab=deductions', 'Payroll'],
    ['/payroll?tab=policy', 'Payroll'],
    ['/payroll?tab=reports', 'Payroll'],
    ['/losses', 'Loss incidents'],
  ];

  for (const [path, title] of screens) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    const heading = await page.getByRole('heading', { level: 1 }).first().textContent();
    check(heading.trim() === title, `${path} renders`);
    check((await pageOverflow(page)) <= 0, `${path} has no horizontal scroll`);
  }

  for (const [path, label] of [
    [`/attendance/${fixtures.attendance}`, 'attendance-detail'],
    [`/payroll/run/${fixtures.payroll}`, 'payroll-run'],
    [`/payroll/salary/${fixtures.staff}`, 'salary-history'],
    [`/losses/${fixtures.incident}`, 'loss-detail'],
    ...(fixtures.deduction ? [[`/payroll/deduction/${fixtures.deduction}`, 'deduction']] : []),
  ]) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    check((await pageOverflow(page)) <= 0, `the ${label} screen has no horizontal scroll`);
    await page.screenshot({ path: `${OUT}/phaseF-${viewport.name}-${label}.png`, fullPage: true });
  }

  // A payroll run is the densest workforce table: cards on a phone, table above.
  await page.goto(`${BASE}/payroll/run/${fixtures.payroll}`, { waitUntil: 'domcontentloaded' });
  const table = page.getByRole('table').first();
  const list = page.getByRole('list', { name: 'Payslips' }).first();
  if (viewport.width >= 768) {
    check(await table.isVisible(), 'the payslips are a table on a wide screen');
    check(!(await list.isVisible()), 'the payslip card list is hidden on a wide screen');
  } else {
    check(await list.isVisible(), 'the payslips render as cards on a phone');
    check(!(await table.isVisible()), 'the payslip table is hidden on a phone');
  }

  // Clocking in must be a big, obvious target on a phone.
  await page.goto(`${BASE}/attendance`, { waitUntil: 'domcontentloaded' });
  const clock = await page
    .getByRole('button', { name: /^Clock (in|out)$/ })
    .first()
    .boundingBox();
  check(clock !== null && clock.height >= 44, 'the clock-in button meets the 44px touch target');
  await page.screenshot({ path: `${OUT}/phaseF-${viewport.name}-attendance.png`, fullPage: true });
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  const invoiceId = await unpaidInvoice(db);
  const moneyIds = await moneyFixtures(db);
  const workforceIds = await workforceFixtures(db);

  const browser = await chromium.launch({
    // The sandbox ships a pinned Chromium; use it rather than downloading one.
    executablePath: process.env.CHROMIUM_PATH ?? undefined,
  });

  for (const viewport of VIEWPORTS) {
    console.log(`\n  ${viewport.name} (${viewport.width}x${viewport.height})  ${viewport.label}`);
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      hasTouch: viewport.width < 1024,
    });
    const page = await context.newPage();

    await checkSignIn(page, viewport);
    await checkShell(page, viewport);
    await checkOperations(page, viewport);
    await checkBilling(page, viewport, invoiceId);
    await checkPhaseE(page, viewport, moneyIds);
    await checkPhaseF(page, viewport, workforceIds);

    await context.close();
  }

  await checkDarkMode(browser);
  await browser.close();
  await db.end();

  console.log(
    failures === 0
      ? '\nAll responsive checks passed.'
      : `\n${failures} responsive check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
