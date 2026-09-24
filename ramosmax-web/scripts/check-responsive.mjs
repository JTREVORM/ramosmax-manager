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

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
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

async function main() {
  mkdirSync(OUT, { recursive: true });

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

    await context.close();
  }

  await checkDarkMode(browser);
  await browser.close();

  console.log(
    failures === 0
      ? '\nAll responsive checks passed.'
      : `\n${failures} responsive check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
