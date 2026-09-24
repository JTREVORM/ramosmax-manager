#!/usr/bin/env node
/**
 * Rebuilds the RamosMAX development database from nothing: platform bootstrap,
 * every migration in order, then the development seed.
 *
 * DEVELOPMENT ONLY. It refuses to run against anything that does not look like
 * a local development database, so it can never be pointed at production.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:devonly@127.0.0.1:5432/postgres';
const DB = process.env.PGDATABASE_DEV ?? 'ramosmax_dev';

// Refuse anything that is not plainly a local development target.
const host = new URL(ADMIN_URL).hostname;
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.error(`Refusing to reset a non-local database (host: ${host}).`);
  process.exit(1);
}
if (!/dev|test/i.test(DB)) {
  console.error(`Refusing to reset a database whose name is not clearly development: ${DB}`);
  process.exit(1);
}

const run = async (url, fn) => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

await run(ADMIN_URL, async (client) => {
  await client.query(`drop database if exists ${DB} with (force)`);
  await client.query(`create database ${DB}`);
});

const devUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${DB}`);

const files = [
  join(root, 'supabase/local/00_platform_bootstrap.sql'),
  ...readdirSync(join(root, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(root, 'supabase/migrations', f)),
  join(root, 'supabase/seed/dev_accounts.sql'),
  join(root, 'supabase/seed/dev_operations.sql'),
];

await run(devUrl, async (client) => {
  for (const file of files) {
    const label = file.replace(`${root}/`, '');
    try {
      await client.query(readFileSync(file, 'utf8'));
      console.log(`  applied  ${label}`);
    } catch (e) {
      console.error(`  FAILED   ${label}`);
      console.error(`           ${e.message}`);
      process.exit(1);
    }
  }
});

console.log(`\nDevelopment database "${DB}" rebuilt.`);
