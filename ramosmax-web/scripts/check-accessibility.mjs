#!/usr/bin/env node
/**
 * Accessibility.
 *
 * Every screen in the product is audited with axe-core against WCAG 2.1 A and
 * AA, at phone width and at desktop width, in light and in dark. A serious or
 * critical violation fails the run.
 *
 * This is not a formality for RamosMAX: the people using it are on cheap
 * phones in bright sunlight, often one-handed, and a form they cannot label
 * or a contrast they cannot read is a payment recorded wrongly.
 *
 * Run it after the end-to-end scripts, so the screens have data on them.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres:devonly@127.0.0.1:5432/ramosmax_dev';
const PASSWORD = 'DevP@ssw0rd!';
const AXE = readFileSync('node_modules/axe-core/axe.min.js', 'utf8');

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
const one = async (sql) => (await db.query(sql)).rows[0];

const ids = await one(`
  select (select id from public.invoices order by created_at desc limit 1) as invoice,
         (select id from public.service_intakes order by created_at desc limit 1) as intake,
         (select id from public.after_hours_sessions order by opened_at desc limit 1) as session,
         (select id from public.cash_handovers order by created_at desc limit 1) as handover,
         (select id from public.share_transactions order by created_at desc limit 1) as txn,
         (select id from public.dividends order by created_at desc limit 1) as dividend`);

/** Every screen a person can reach, with the widest one of each shape. */
const SCREENS = [
  ['/login', 'Sign in', true],
  ['/', 'Dashboard'],
  ['/customers', 'Customers'],
  ['/vehicles', 'Vehicles'],
  ['/services', 'Services'],
  ['/jobs', 'Jobs'],
  ['/new-service', 'New service'],
  ['/invoices', 'Invoices'],
  ['/payments', 'Payments'],
  ['/receipts', 'Receipts'],
  ['/credit', 'Credit'],
  ['/loyalty', 'Loyalty'],
  ['/finance', 'Finance'],
  ['/expenses', 'Expenses'],
  ['/inventory', 'Inventory'],
  ['/transactions', 'Transactions'],
  ['/reconciliation', 'Reconciliation'],
  ['/attendance', 'Attendance'],
  ['/allowances', 'Allowances'],
  ['/payroll', 'Payroll'],
  ['/losses', 'Losses'],
  ['/shareholders', 'Shareholders'],
  ['/shares', 'Shares'],
  ['/dividends', 'Dividends'],
  ['/my-shares', 'My shareholding'],
  ['/after-hours', 'After-hours'],
  ['/my-after-hours', 'My after-hours'],
  ['/reports', 'Reports'],
  ['/reports?report=financial', 'Reports (money in and out)'],
  ['/notifications', 'Notices'],
  ['/notifications?tab=settings', 'Notice settings'],
  ['/users', 'Users'],
  ['/settings', 'Settings'],
  ['/audit', 'Audit'],
];

if (ids.invoice) SCREENS.push([`/invoices/${ids.invoice}`, 'Invoice detail']);
if (ids.intake) SCREENS.push([`/jobs/${ids.intake}`, 'Job detail']);
if (ids.session) SCREENS.push([`/after-hours/session/${ids.session}`, 'Session detail']);
if (ids.handover) SCREENS.push([`/after-hours/handover/${ids.handover}`, 'Handover detail']);
if (ids.txn) SCREENS.push([`/shares/txn/${ids.txn}`, 'Share transaction']);
if (ids.dividend) SCREENS.push([`/dividends/${ids.dividend}`, 'Dividend detail']);

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, colorScheme: 'light' },
  { name: 'phone-dark', width: 390, height: 844, colorScheme: 'dark' },
  { name: 'desktop', width: 1440, height: 900, colorScheme: 'light' },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? undefined });

async function audit(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(250);
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () =>
    window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      resultTypes: ['violations'],
    }));
}

let audited = 0;
for (const viewport of VIEWPORTS) {
  console.log(`\n  ${viewport.name} (${viewport.width}px, ${viewport.colorScheme})`);
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: viewport.colorScheme,
    hasTouch: viewport.width < 1024,
  });
  const page = await context.newPage();

  // Sign in as the Administrator, who can reach every screen.
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Phone number').fill('0772000001');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 15_000 });

  for (const [path, label, signedOut] of SCREENS) {
    if (signedOut) continue;
    const result = await audit(page, path);
    const serious = result.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    audited += 1;
    check(
      serious.length === 0,
      `${label} — ${serious.length === 0
        ? 'no serious or critical issues'
        : serious.map((v) => `${v.id} (${v.nodes.length})`).join(', ')}`,
    );
  }
  await context.close();
}

// The sign-in page, which nobody is signed in for.
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const result = await audit(page, '/login');
  const serious = result.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  audited += 1;
  check(
    serious.length === 0,
    `Sign in — ${serious.length === 0 ? 'no serious or critical issues'
      : serious.map((v) => `${v.id} (${v.nodes.length})`).join(', ')}`,
  );
  await context.close();
}

await browser.close();
await db.end();

console.log(
  failures === 0
    ? `\n${audited} screen audits passed (WCAG 2.1 A and AA, axe-core).`
    : `\n${failures} of ${audited} screen audits found serious or critical issues.`,
);
process.exit(failures === 0 ? 0 : 1);
