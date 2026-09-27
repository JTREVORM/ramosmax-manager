#!/usr/bin/env node
/**
 * Applies every migration, in order, to a Supabase project.
 *
 * It does NOT drop anything, it does NOT seed anything, and it records what it
 * has applied in `app.schema_migrations`, so running it again applies only
 * what is new.
 *
 * Usage:
 *   SUPABASE_DB_URL='postgres://postgres:...@db.<ref>.supabase.co:5432/postgres' \
 *     node scripts/apply-migrations.mjs
 *
 * Add --seed to also apply the DEVELOPMENT seed. It refuses to do that unless
 * the target has no users yet, so a seeded fake account can never appear in a
 * project that is already being used.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
const seed = process.argv.includes('--seed');

if (!url) {
  console.error(
    'Set SUPABASE_DB_URL to the project connection string\n' +
    '  (Supabase dashboard → Project Settings → Database → Connection string → URI).',
  );
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  // Supabase requires TLS; its certificate chain is not in Node's store.
  ssl: /supabase\.(co|com)/.test(url) ? { rejectUnauthorized: false } : undefined,
});
await client.connect();

try {
  await client.query(`create schema if not exists app`);
  await client.query(`
    create table if not exists app.schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now())`);

  const { rows: done } = await client.query(`select filename from app.schema_migrations`);
  const applied = new Set(done.map((r) => r.filename));

  const files = readdirSync(join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql'))
    .sort();
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skipped  ${file}  (already applied)`);
      continue;
    }
    const sql = readFileSync(join(root, 'supabase/migrations', file), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query(`insert into app.schema_migrations (filename) values ($1)`, [file]);
      await client.query('commit');
      console.log(`  applied  ${file}`);
      count += 1;
    } catch (e) {
      await client.query('rollback');
      console.error(`  FAILED   ${file}\n           ${e.message}`);
      process.exit(1);
    }
  }

  if (seed) {
    const { rows: users } = await client.query(`
      select count(*)::int as n from information_schema.tables
       where table_schema = 'public' and table_name = 'users'`);
    const existing = users[0].n === 0
      ? 0
      : Number((await client.query(`select count(*)::int as n from public.users`)).rows[0].n);
    if (existing > 0) {
      console.error(
        `\nRefusing to seed: this project already has ${existing} users.\n` +
        'The development seed creates fictitious accounts and must only ever go\n' +
        'into an empty development project.',
      );
      process.exit(1);
    }
    for (const file of readdirSync(join(root, 'supabase/seed')).sort()) {
      await client.query(readFileSync(join(root, 'supabase/seed', file), 'utf8'));
      console.log(`  seeded   ${file}`);
    }
  }

  console.log(`\n${count} migration(s) applied; ${files.length} total on record.`);
} finally {
  await client.end();
}
