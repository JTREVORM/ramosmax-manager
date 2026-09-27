#!/usr/bin/env node
/**
 * End-to-end authentication checks against the real development database.
 *
 * These drive an actual browser through the real sign-in route, the real
 * database functions and the real session cookie. They cover what unit tests
 * cannot: redirects, cookie flags, session restoration after a refresh, and
 * the forced password change.
 */
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres:devonly@127.0.0.1:5432/ramosmax_dev';
const PASSWORD = 'DevP@ssw0rd!';

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

// Make the run deterministic: a previous crashed run must not leave a seed
// account flagged for a password change or deactivated.
async function normaliseSeed() {
  await db.query(`
    update public.users
       set must_change_password = false,
           active               = true,
           access_expires_at    = null,
           password_changed_at  = null
     where phone_number like '+25677200000%'`);
  await db.query(
    `
    update auth.users set encrypted_password = crypt($1, gen_salt('bf'))
     where id in (select id from public.users where phone_number like '+25677200000%')`,
    [PASSWORD],
  );
  await db.query(`delete from app.login_throttle`);
}

await normaliseSeed();

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? undefined });

async function freshPage() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  return { context, page: await context.newPage() };
}

async function signIn(page, phone, password = PASSWORD) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Phone number').fill(phone);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

// ---------------------------------------------------------------------------
console.log('\n  unauthenticated access');
{
  const { context, page } = await freshPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  check(page.url().includes('/login'), 'the dashboard redirects to sign-in');

  await page.goto(`${BASE}/payroll`, { waitUntil: 'domcontentloaded' });
  check(page.url().includes('next=%2Fpayroll'), 'the intended destination is remembered');
  await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n  invalid credentials');
{
  const { context, page } = await freshPage();
  await signIn(page, '0772000001', 'WrongPassword1!');
  await page.waitForSelector('#sign-in-error');
  const message = await page.locator('#sign-in-error').textContent();
  check(message.includes('Incorrect phone number or password'), 'generic failure message');

  await signIn(page, '0772999999', PASSWORD);
  await page.waitForSelector('#sign-in-error');
  const unknown = await page.locator('#sign-in-error').textContent();
  check(
    unknown.trim() === message.trim(),
    'an UNKNOWN number gives the identical message, revealing nothing',
  );
  await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n  successful sign-in and session');
{
  const { context, page } = await freshPage();
  await signIn(page, '0772000001');
  await page.waitForURL(`${BASE}/`, { timeout: 10_000 });
  check(true, 'administrator reaches the dashboard');

  const cookie = (await context.cookies()).find((c) => c.name === 'ramosmax_session');
  check(Boolean(cookie), 'a session cookie is set');
  check(cookie?.httpOnly === true, 'the session cookie is httpOnly (not readable by JavaScript)');
  check(cookie?.sameSite === 'Lax', 'the session cookie is SameSite=Lax');

  const exposed = await page.evaluate(() => document.cookie);
  check(!exposed.includes('ramosmax_session'), 'document.cookie does not expose the session');

  const storage = await page.evaluate(() =>
    JSON.stringify({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    }),
  );
  check(storage === '{"local":[],"session":[]}', 'no credentials are left in browser storage');

  // Session restoration on refresh and on reopening the app.
  await page.reload({ waitUntil: 'domcontentloaded' });
  check(page.url() === `${BASE}/`, 'the session survives a refresh');

  const reopened = await context.newPage();
  await reopened.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  check(reopened.url() === `${BASE}/`, 'the session is restored in a newly opened tab');
  await reopened.close();

  // A signed-in person should not see the sign-in page again.
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  check(page.url() === `${BASE}/`, 'sign-in redirects away when already signed in');

  await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n  role-appropriate navigation');
{
  for (const [phone, role, expected, forbidden] of [
    ['0772000004', 'worker', 'My Jobs', 'Payroll'],
    ['0772000003', 'cashier', 'Invoices', 'Payroll'],
    ['0772000005', 'shareholder', 'My Shareholding', 'Shareholders'],
  ]) {
    const { context, page } = await freshPage();
    await signIn(page, phone);
    await page.waitForURL(`${BASE}/`, { timeout: 10_000 });
    await page.getByRole('button', { name: 'Open menu' }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    const shown = await drawer.getByRole('link', { name: expected }).count();
    const hidden = await drawer.getByRole('link', { name: forbidden, exact: true }).count();
    check(shown > 0, `${role} sees "${expected}"`);
    check(hidden === 0, `${role} does NOT see "${forbidden}"`);
    await context.close();
  }
}

// ---------------------------------------------------------------------------
console.log('\n  sign out');
{
  const { context, page } = await freshPage();
  await signIn(page, '0772000001');
  await page.waitForURL(`${BASE}/`, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/, { timeout: 10_000 });
  check(true, 'sign out returns to the sign-in page');

  const cookie = (await context.cookies()).find((c) => c.name === 'ramosmax_session');
  check(!cookie || cookie.value === '', 'the session cookie is cleared');

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  check(page.url().includes('/login'), 'the dashboard is no longer reachable');
  await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n  forced password change');
{
  await db.query(
    `update public.users set must_change_password = true where phone_number = '+256772000003'`,
  );
  const { context, page } = await freshPage();
  await signIn(page, '0772000003');
  await page.waitForURL(/change-password/, { timeout: 10_000 });
  check(true, 'a temporary password sends the person to the change screen');

  // The forced change cannot be skipped by navigating directly.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  check(page.url().includes('change-password'), 'the forced change cannot be skipped by URL');

  await page.getByLabel('Temporary password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('New password', { exact: true }).fill('Fresh!Start9');
  await page.getByLabel('Confirm new password').fill('Fresh!Start9');
  await page.getByRole('button', { name: 'Change password' }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 10_000 });
  check(true, 'after changing it, the dashboard opens');

  const { rows } = await db.query(
    `select must_change_password from public.users where phone_number = '+256772000003'`,
  );
  check(rows[0].must_change_password === false, 'the forced flag is cleared in the database');

  const audit = await db.query(
    `select count(*)::int as n from public.audit_logs
      where action = 'password.changed'
        and description = 'Temporary password replaced at sign-in'`,
  );
  check(Number(audit.rows[0].n) >= 1, 'the change is audited');

  await context.close();

  // Restore the seed password for repeat runs.
  await db.query(
    `update auth.users set encrypted_password = crypt($1, gen_salt('bf'))
      where id = (select id from public.users where phone_number = '+256772000003')`,
    [PASSWORD],
  );
}

// ---------------------------------------------------------------------------
console.log('\n  deactivated and expired accounts');
{
  await db.query(`update public.users set active = false where phone_number = '+256772000006'`);
  const { context, page } = await freshPage();
  await signIn(page, '0772000006');
  await page.waitForSelector('#sign-in-error');
  const message = await page.locator('#sign-in-error').textContent();
  check(message.includes('account is inactive'), 'a deactivated account is refused at sign-in');
  await context.close();
  await db.query(`update public.users set active = true where phone_number = '+256772000006'`);

  await db.query(
    `update public.users set access_expires_at = now() - interval '1 day'
      where phone_number = '+256772000006'`,
  );
  const second = await freshPage();
  await signIn(second.page, '0772000006');
  await second.page.waitForSelector('#sign-in-error');
  const expired = await second.page.locator('#sign-in-error').textContent();
  check(
    expired.includes('access period has ended'),
    'an expired access period is refused, distinctly',
  );
  await second.context.close();
  await db.query(
    `update public.users set access_expires_at = null where phone_number = '+256772000006'`,
  );
}

// ---------------------------------------------------------------------------
console.log('\n  sign-in throttle');
{
  await db.query(`delete from app.login_throttle`);
  const { context, page } = await freshPage();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await signIn(page, '0772000002', 'WrongPassword1!');
    await page.waitForSelector('#sign-in-error');
  }
  await signIn(page, '0772000002', PASSWORD);
  await page.waitForSelector('#sign-in-error');
  const message = await page.locator('#sign-in-error').textContent();
  check(
    message.includes('Too many sign-in attempts'),
    'the 6th attempt is throttled even with the CORRECT password',
  );
  await context.close();
  await db.query(`delete from app.login_throttle`);
}

// ---------------------------------------------------------------------------
console.log('\n  session revocation after a password change');
{
  const first = await freshPage();
  await signIn(first.page, '0772000004');
  await first.page.waitForURL(`${BASE}/`, { timeout: 10_000 });

  // A second device changes the password.
  const second = await freshPage();
  await signIn(second.page, '0772000004');
  await second.page.waitForURL(`${BASE}/`, { timeout: 10_000 });
  await second.page.goto(`${BASE}/change-password`, { waitUntil: 'domcontentloaded' });
  await second.page.getByLabel('Current password', { exact: true }).fill(PASSWORD);
  await second.page.getByLabel('New password', { exact: true }).fill('Rotated!Pass7');
  await second.page.getByLabel('Confirm new password').fill('Rotated!Pass7');
  await second.page.getByRole('button', { name: 'Change password' }).click();
  await second.page.waitForURL(`${BASE}/`, { timeout: 10_000 });
  check(true, 'the changing device stays signed in');

  // The first device's session was issued before the change.
  await first.page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  check(first.page.url().includes('/login'), 'the OTHER session is ended');

  await first.context.close();
  await second.context.close();
  await db.query(
    `update auth.users set encrypted_password = crypt($1, gen_salt('bf'))
      where id = (select id from public.users where phone_number = '+256772000004')`,
    [PASSWORD],
  );
  await db.query(
    `update public.users set password_changed_at = null where phone_number = '+256772000004'`,
  );
}

// ---------------------------------------------------------------------------
console.log('\n  deactivated mid-session');
{
  const { context, page } = await freshPage();
  await signIn(page, '0772000006');
  await page.waitForURL(`${BASE}/`, { timeout: 10_000 });

  // An administrator deactivates the account while they are using the app.
  await db.query(`update public.users set active = false where phone_number = '+256772000006'`);

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  check(page.url().includes('access-denied'), 'the next request lands on access-denied');
  const body = await page.textContent('body');
  check(body.includes('account is inactive'), 'the reason is explained');

  await db.query(`update public.users set active = true where phone_number = '+256772000006'`);
  await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n  expired mid-session');
{
  const { context, page } = await freshPage();
  await signIn(page, '0772000006');
  await page.waitForURL(`${BASE}/`, { timeout: 10_000 });

  await db.query(
    `update public.users set access_expires_at = now() - interval '1 minute'
      where phone_number = '+256772000006'`,
  );

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  check(page.url().includes('access-denied'), 'an ended access period lands on access-denied');
  const body = await page.textContent('body');
  check(body.includes('access period has ended'), 'the ended period is named, not "inactive"');

  await db.query(
    `update public.users set access_expires_at = null where phone_number = '+256772000006'`,
  );
  await context.close();
}

// ---------------------------------------------------------------------------
console.log('\n  PWA installability');
{
  const { context, page } = await freshPage();
  const response = await page.goto(`${BASE}/manifest.webmanifest`, {
    waitUntil: 'domcontentloaded',
  });
  check(response.ok(), 'the manifest is served');
  const manifest = JSON.parse(await page.textContent('body'));
  check(manifest.display === 'standalone', 'it declares standalone display');
  check(manifest.start_url === '/', 'it declares a start URL');
  check(
    manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'),
    'it provides a maskable 512px icon',
  );
  for (const icon of manifest.icons) {
    const iconResponse = await page.goto(`${BASE}${icon.src}`);
    check(iconResponse.ok(), `icon ${icon.src} is served`);
  }
  // An installed PWA opens at start_url with no session: it must not error.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  check(page.url().includes('/login'), 'a cold PWA launch shows the sign-in page');
  await context.close();
}

await normaliseSeed();
await browser.close();
await db.end();

console.log(
  failures === 0
    ? '\nAll authentication checks passed.'
    : `\n${failures} authentication check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
