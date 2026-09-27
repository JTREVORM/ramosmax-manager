#!/usr/bin/env node
/**
 * Performance and build quality.
 *
 * The budgets here are set for the machine this actually runs on: a cheap
 * Android phone on Ugandan mobile data. A dashboard that ships a megabyte of
 * JavaScript is a dashboard nobody opens at the gate.
 *
 * It also checks the thing that matters more than any budget: that no secret
 * reached the browser bundle.
 */
import { chromium } from 'playwright';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
const PASSWORD = 'DevP@ssw0rd!';

let failures = 0;
const check = (passed, message) => {
  if (passed) console.log(`    ok    ${message}`);
  else {
    failures += 1;
    console.error(`    FAIL  ${message}`);
  }
};

const kb = (bytes) => Math.round(bytes / 1024);

// ---------------------------------------------------------------------------
console.log('\n  the browser bundle carries no secret');
{
  const chunks = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.js')) chunks.push(path);
    }
  };
  walk('.next/static');

  // Every value that must never leave the server.
  const secrets = [
    ['service-role key', process.env.SUPABASE_SERVICE_ROLE_KEY],
    ['VAPID private key', process.env.VAPID_PRIVATE_KEY],
    ['session secret', process.env.SESSION_SECRET],
    ['delivery secret', process.env.NOTIFICATION_CRON_SECRET],
    ['database password', 'devonly'],
  ].filter(([, value]) => value);

  let leaked = 0;
  const names = [];
  for (const path of chunks) {
    const source = readFileSync(path, 'utf8');
    for (const [label, value] of secrets) {
      if (source.includes(value)) {
        leaked += 1;
        names.push(`${label} in ${path}`);
      }
    }
    // The variable names themselves must not be referenced from the client.
    for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'VAPID_PRIVATE_KEY',
      'NOTIFICATION_CRON_SECRET', 'SESSION_SECRET']) {
      if (source.includes(name)) {
        leaked += 1;
        names.push(`${name} referenced in ${path}`);
      }
    }
  }
  check(chunks.length > 0, `${chunks.length} client chunks were built`);
  check(leaked === 0, leaked === 0 ? 'no secret reached the browser' : names.join('; '));

  const total = chunks.reduce((sum, path) => sum + statSync(path).size, 0);
  check(true, `client JavaScript on disk: ${kb(total)} KB across ${chunks.length} chunks`);
}

// ---------------------------------------------------------------------------
console.log('\n  the screens people open most, measured');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? undefined });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.getByLabel('Phone number').fill('0772000001');
await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL(`${BASE}/`, { timeout: 15_000 });

/** Bytes over the wire and time to a usable screen, warm. */
async function measure(path) {
  let bytes = 0;
  const onResponse = async (response) => {
    try {
      const length = Number(response.headers()['content-length'] ?? 0);
      bytes += length || (await response.body().catch(() => Buffer.alloc(0))).byteLength;
    } catch {
      /* a response that went away is not a measurement */
    }
  };
  page.on('response', onResponse);
  const started = Date.now();
  await page.goto(`${BASE}${path}`, { waitUntil: 'load' });
  const loaded = Date.now() - started;
  page.off('response', onResponse);
  return { bytes, loaded };
}

// Warm the caches first: the question is what a returning phone pays, and
// every member of staff opens RamosMAX many times a day.
await measure('/');

const BUDGETS = [
  ['/', 'Dashboard', 250, 3000],
  ['/jobs', 'Jobs', 250, 3000],
  ['/invoices', 'Invoices', 250, 3000],
  ['/my-after-hours', 'My after-hours', 250, 3000],
  ['/reports?report=financial', 'Money in and out', 350, 4000],
  ['/notifications', 'Notices', 250, 3000],
];

for (const [path, label, budgetKb, budgetMs] of BUDGETS) {
  const { bytes, loaded } = await measure(path);
  check(kb(bytes) <= budgetKb, `${label}: ${kb(bytes)} KB over the wire (budget ${budgetKb} KB)`);
  check(loaded <= budgetMs, `${label}: ready in ${loaded} ms (budget ${budgetMs} ms)`);
}

// ---------------------------------------------------------------------------
console.log('\n  build quality');
{
  // No business data is cached: RamosMAX reads are online reads.
  const sw = readFileSync('public/sw.js', 'utf8');
  check(!/caches\.open|cache\.put|CacheStorage/.test(sw),
    'the service worker caches no business data');
  check(/showNotification/.test(sw), 'and does show push notices');

  // An authenticated page must never be storable by a shared cache. Measured
  // from INSIDE the page, so the session cookie is actually sent — a signed-out
  // request only ever sees the redirect to the sign-in page.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  for (const path of ['/', '/invoices', '/payroll', '/my-shares', '/reports']) {
    const header = await page.evaluate(async (p) => {
      const response = await fetch(p, { credentials: 'same-origin' });
      return response.headers.get('cache-control') ?? '';
    }, path);
    check(
      /no-store/.test(header) && /private/.test(header) && !/s-maxage/.test(header),
      `${path} is never stored by a shared cache (${header || 'no cache-control'})`,
    );
  }
}

await context.close();
await browser.close();

console.log(
  failures === 0
    ? '\nAll performance and build-quality checks passed.'
    : `\n${failures} performance or build-quality check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
