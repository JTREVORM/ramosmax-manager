#!/usr/bin/env node
/**
 * Parses every migration with the real PostgreSQL grammar (libpg-query, the
 * actual Postgres parser compiled to WASM), so a syntax error cannot reach a
 * database. This is not a linter — it is the same parser the server uses.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'libpg-query';
const { parse, loadModule } = pg;

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../supabase/migrations');
await loadModule();
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error('No migrations found.');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const sql = readFileSync(join(dir, file), 'utf8');
  try {
    const tree = await parse(sql);
    const n = tree.stmts?.length ?? 0;
    console.log(`  OK    ${file}  (${n} statements)`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${file}`);
    console.error(`        ${e.message}`);
  }
}

console.log(
  failed === 0
    ? `\nAll ${files.length} migrations parse against the PostgreSQL grammar.`
    : `\n${failed} of ${files.length} migrations failed to parse.`,
);
process.exit(failed === 0 ? 0 : 1);
